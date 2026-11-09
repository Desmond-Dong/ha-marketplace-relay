// Blob 缓存层：缓存 release zip 等大文件，边缘节点加速读取
// 全自动：满了删除最老的文件，无需人工干预

import { getStore } from "@edgeone/pages-blob";

const STORE_NAME = "github-cache";
const MAX_FILES = 50; // 最多缓存 50 个文件（按数量淘汰，因为 list 不返回 size）

// 生成缓存 hash：URL 的 SHA-256
async function urlHash(url) {
  const encoder = new TextEncoder();
  const data = encoder.encode(url);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// 查找已存在的缓存
export async function findCached(url) {
  try {
    const store = getStore(STORE_NAME);
    const hash = await urlHash(url);

    // Read metadata (JSON) / 读元数据（JSON）
    const metaKey = `meta/${hash}`;
    const meta = await store.get(metaKey, { type: "json", consistency: "strong" });
    if (!meta) return null;

    // Read body as binary: default type is "text", which corrupts zip bytes
    // 以二进制读 body：默认 type 是 text，会把 zip 字节解码坏
    const bodyKey = `body/${hash}`;
    const body = await store.get(bodyKey, { type: "arrayBuffer", consistency: "strong" });
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

    // 写入元数据
    const metaKey = `meta/${hash}`;
    const meta = { url, contentType, timestamp: Date.now() };
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

// 淘汰最老的文件，直到文件数 < 阈值
async function evictIfNeeded(store) {
  try {
    // 列出所有元数据
    const { blobs } = await store.list({ prefix: "meta/" });
    if (blobs.length <= MAX_FILES) return;
    
    // 读取所有元数据并解析时间戳
    const metas = [];
    for (const blob of blobs) {
      try {
        const meta = await store.get(blob.key, { type: "json" });
        if (meta) {
          metas.push({ ...meta, key: blob.key });
        }
      } catch (e) {
        // 跳过损坏的元数据
      }
    }
    
    if (metas.length <= MAX_FILES) return;
    
    // 按时间戳排序（最老的在前）
    metas.sort((a, b) => a.timestamp - b.timestamp);
    
    // 删除最老的，直到文件数 < 阈值
    const toDelete = metas.length - MAX_FILES;
    for (let i = 0; i < toDelete; i++) {
      const meta = metas[i];
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
