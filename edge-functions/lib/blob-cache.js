// Blob 缓存层：缓存 release zip 等大文件，边缘节点加速读取
// 全自动：满了删除最老的文件，无需人工干预

import { getStore } from "@edgeone/pages-blob";

const STORE_NAME = "github-cache";
// Dual-threshold eviction: entry count AND total bytes. list() does not return sizes,
// so setCached records the content length in each meta entry and eviction sums it up.
// 双阈值淘汰：条数与总字节数。list() 不返回大小，写入时把 content-length 记进 meta，
// 淘汰时汇总计算。
const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB cap / 500MB 空间上限（额度 1GB 的一半）

// 生成缓存 hash：URL 的 SHA-256
async function urlHash(url) {
  const encoder = new TextEncoder();
  const data = encoder.encode(url);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// 查找已存在的缓存。命中时 body 以流返回（stream 类型），调用方直接把它接进
// Response——省掉整个文件的 arrayBuffer 物化拷贝，这是命中路径上最大的单项 CPU
// 开销（4MB 拷贝 vs 建立流引用）。找已存在缓存失败时返回 null，走源站。
export async function findCached(url) {
  try {
    const store = getStore(STORE_NAME);
    const hash = await urlHash(url);

    // Read metadata (JSON) / 读元数据（JSON）
    const metaKey = `meta/${hash}`;
    const meta = await store.get(metaKey, { type: "json", consistency: "strong" });
    if (!meta) return null;

    // Read body as a stream (binary-exact; default type "text" corrupts zip bytes).
    // Streaming skips the full-buffer copy in the function — the single biggest CPU
    // item on the cache-hit path. Fall back to arrayBuffer if the runtime refuses.
    // body 以流读取（字节精确；默认 text 会把 zip 字节解码坏）。流式跳过函数内的
    // 全量缓冲拷贝。运行时不支持时回退 arrayBuffer。
    const bodyKey = `body/${hash}`;
    let body;
    try {
      body = await store.get(bodyKey, { type: "stream", consistency: "strong" });
    } catch (e) {
      body = null;
    }
    if (!body) {
      body = await store.get(bodyKey, { type: "arrayBuffer", consistency: "strong" });
    }
    if (!body) return null;

    return { body, contentType: meta.contentType };
  } catch (e) {
    // 缓存查询失败，返回 null，走源站
    return null;
  }
}

// 写入缓存（自动淘汰最老的）
export async function setCached(bodyBuffer, contentType, url) {
  try {
    const store = getStore(STORE_NAME);
    const hash = await urlHash(url);

    // 先淘汰，再写入
    await evictIfNeeded(store);

    // 写入元数据（记录体积，供按空间淘汰用）
    const metaKey = `meta/${hash}`;
    const meta = { url, contentType, timestamp: Date.now(), size: bodyBuffer.byteLength };
    await store.setJSON(metaKey, meta);

    // 写入缓存体（ArrayBuffer 才能保持二进制完整）
    const bodyKey = `body/${hash}`;
    await store.set(bodyKey, bodyBuffer);

    return true;
  } catch (e) {
    // 缓存写入失败不影响主流程
    return false;
  }
}

// 淘汰最老的条目，直到条数与总空间都回到阈值内
async function evictIfNeeded(store) {
  try {
    // 列出所有元数据
    const { blobs } = await store.list({ prefix: "meta/" });
    
    // 读取所有元数据并解析时间戳
    const metas = [];
    for (const blob of blobs) {
      try {
        const meta = await store.get(blob.key, { type: "json" });
        if (meta) {
          metas.push({ ...meta, key: blob.key });
        }
      } catch (e) {
        // 跳过损坏的元数据（体积按 0 计）
      }
    }
    
    // 双阈值判定：条数与总字节数任一超限都需要淘汰
    let totalBytes = 0;
    for (const m of metas) totalBytes += m.size || 0;
    if (metas.length <= MAX_FILES && totalBytes <= MAX_TOTAL_BYTES) return;
    
    // 按时间戳排序（最老的在前）
    metas.sort((a, b) => a.timestamp - b.timestamp);
    
    // 从最老开始删，直到条数与空间双双回到阈值内
    let i = 0;
    while (i < metas.length && (metas.length - i > MAX_FILES || totalBytes > MAX_TOTAL_BYTES)) {
      const meta = metas[i];
      totalBytes -= meta.size || 0;
      i++;
      try {
        const hash = meta.key.replace(/^meta\//, "");
        // 删除元数据
        await store.delete(meta.key);
        // 删除缓存体
        await store.delete(`body/${hash}`);
      } catch (e) {
        // 删除失败，跳过
      }
    }
  } catch (e) {
    // 淘汰失败不影响主流程
  }
}

// 判断是否应该缓存（只对 release download 启用）
export function shouldCache(url) {
  return url.includes("/releases/download/");
}
