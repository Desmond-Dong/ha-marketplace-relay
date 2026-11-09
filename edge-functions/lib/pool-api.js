// Shared token pool public API endpoints / 共享 token 池公开 API 端点
//
// Handlers live in lib/ and are routed from [[default]].js — the EdgeOne function
// bundler cannot resolve '../../' imports from api/ subdirectory files (build log:
// "Could not resolve ../../lib/kv-pool.js"), so EVERY shared module must sit in lib/
// and every entry file imports with './'. URLs are unchanged.
// 处理器放在 lib/、由 [[default]].js 路由——EdgeOne 打包器解析不了 api/ 子目录文件
// 里的 '../../' 导入（构建日志：Could not resolve ../../lib/kv-pool.js），因此共享
// 模块必须全部位于 lib/、入口文件一律 './' 一级导入。URL 保持不变。
//
// GET /api/token/get  — one pool record, tokenhub-compatible JSON shape
// GET /api/token/stats — masked pool stats (contributors page + home page usage line)
//
// Data source / 数据源: self-hosted KV pool (namespace `marketplace`), tokenhub
// fallback while the pool is empty. / 自建 KV 池（命名空间 marketplace），池空回退 tokenhub。

import { TOKENHUB_API } from './github-token.js';
import { poolKv, pickTokenRecord, toTokenhubShape, loadPool, QUOTA_TTL_MS } from './kv-pool.js';

const noStoreHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { ...noStoreHeaders } });
}

function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ---- GET /api/token/get ----
// Response shape / 返回结构:
// { "data": { "id", "created_at", "updated_at", "type": "github", "login", "token",
//             "use_count", "remaining", "expired_at": "", "deleted_at": null,
//             "usage": ..., "usages": null } }
// Selection: highest remaining quota among freshly revalidated entries; dead tokens
// are marked disabled and pruned. / 选取：验活通过的记录里剩余额度最高者；失效自动
// 停用剔除。
export async function getTokenRecord(env) {
  void env; // no env needed today; kept for handler-signature uniformity / 当前无需环境变量，签名统一保留
  const kvb = poolKv();
  if (kvb) {
    try {
      const picked = await pickTokenRecord(kvb);
      if (picked) {
        return json(200, { data: toTokenhubShape(picked.id, picked.rec) });
      }
    } catch (e) {
      // KV errors fall through to tokenhub fallback / KV 异常落到 tokenhub 回退
    }
  }

  // Fallback: proxy a tokenhub record verbatim (already the same shape), but strip
  // third-party usage metadata (contains tokenhub's user_ip — never forward other
  // services' access logs). / 回退：转发 tokenhub 记录（结构一致），但剥除 usage 元数据
  // （内含 tokenhub 侧 user_ip——绝不转发第三方服务的访问日志）。
  try {
    const res = await fetch(TOKENHUB_API, {
      headers: { 'User-Agent': 'HomeAssistantMarketplace' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.data && data.data.token) {
        const d = data.data;
        const clean = {
          id: d.id,
          created_at: d.created_at,
          updated_at: d.updated_at,
          type: d.type,
          login: d.login,
          token: d.token,
          use_count: d.use_count,
          remaining: d.remaining,
          expired_at: d.expired_at || '',
          deleted_at: null,
          usage: null,
          usages: null,
        };
        return json(200, { data: clean });
      }
    }
  } catch (e) { /* tokenhub unreachable / tokenhub 不可达 */ }
  return json(503, { error: 'pool unavailable' });
}

// ---- GET /api/token/stats ----
// Masked fields only: login (public by design), use count, last-known remaining
// quota (null outside the freshness window — never shown stale), status. No token
// material, no IPs. Storage usage is measured from the records themselves (record
// count + approximate bytes). The real platform quota is NOT exposed to the runtime;
// the optional KV_QUOTA_MB env var supplies the denominator for the percentage.
// 只含脱敏字段：login（本就是公开信息）、使用次数、保鲜期内最近验活的剩余额度
// （否则为 null，绝不过期展示）、状态。无 token 明文、无 IP。存储用量由记录本身
// 测得（条数 + 估算字节）。平台真实配额不向运行时暴露——可选环境变量 KV_QUOTA_MB
// 提供百分比分母。
export async function getPoolStats(env) {
  const kvb = poolKv();
  if (!kvb) {
    return json(200, { count: 0, contributors: [], storage: { records: 0, bytes: 0, quota_bytes: null } });
  }
  try {
    const entries = await loadPool(kvb);
    const now = Date.now();
    const contributors = entries
      .map((e) => {
        const fresh = e.rec.checked_at && now - e.rec.checked_at < QUOTA_TTL_MS;
        return {
          login: e.rec.login || 'anonymous',
          use_count: e.rec.use_count || 0,
          remaining: !e.rec.disabled && fresh ? (e.rec.remaining || 0) : null,
          status: e.rec.disabled ? 'disabled' : 'active',
        };
      })
      .sort((a, b) => b.use_count - a.use_count);

    // Approximate stored bytes: JSON value body + key name per record (token strings
    // and logins are ASCII, so string length ≈ byte length). / 估算存储字节：每条记录
    // 的 JSON 值体 + 键名（token 与 login 均为 ASCII，字符串长度≈字节数）。
    let bytes = 0;
    for (const e of entries) bytes += JSON.stringify(e.rec).length + e.key.length;

    const quotaMb = Number(env && env.KV_QUOTA_MB);
    const quotaBytes = Number.isFinite(quotaMb) && quotaMb > 0 ? Math.round(quotaMb * 1024 * 1024) : null;

    return json(200, {
      count: contributors.length,
      contributors,
      storage: { records: entries.length, bytes, quota_bytes: quotaBytes },
    });
  } catch (e) {
    return json(502, { error: 'kv error' });
  }
}
