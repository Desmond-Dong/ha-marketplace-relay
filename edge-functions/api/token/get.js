// Shared token pool API — tokenhub-compatible / 共享 token 池 API —— tokenhub 兼容格式
//
// GET /api/token/get -> one token record for the Marketplace proxy, same JSON shape as
// https://tokenhub.hacs.vip/api/token/get so existing consumers can switch by URL alone.
// 返回一条 token 记录，JSON 结构与 tokenhub 完全一致，消费方只改 URL 即可切换。
//
// Response shape / 返回结构:
// {
//   "data": {
//     "id", "created_at", "updated_at", "type": "github", "login", "token",
//     "use_count", "remaining", "expired_at": "", "deleted_at": null,
//     "usage": { ... latest usage record or null ... }, "usages": null
//   }
// }
//
// Data source / 数据源: self-hosted KV pool — namespace `marketplace` bound with the
// variable name `marketplace` (per-login dedupe, best-remaining selection, dead tokens
// pruned) — falling back to tokenhub while the pool is empty.
// 数据源：自建 KV 池——命名空间 marketplace，绑定变量名 marketplace（按 login 去重、
// 选剩余额度最高者、失效自动剔除）——池空时回退 tokenhub。

import { TOKENHUB_API } from '../../lib/github-token.js';
import { poolKv, pickTokenRecord, toTokenhubShape } from '../../lib/kv-pool.js';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { ...jsonHeaders } });
}

export async function onRequestGet() {
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
