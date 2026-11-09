// Shared GitHub token fetch & cache / GitHub 共享 token 获取与缓存
// Edge Functions shared module / Edge Functions 共享模块
//
// Primary source / 主源: this project's own KV pool (namespace `marketplace`,
// see lib/kv-pool.js) — tokens shared by page visitors via the Device Flow.
// Fallback source / 回退源: HACS China tokenhub shared pool
//   https://tokenhub.hacs.vip/api/token/get
//
// isolate-level memory cache for 30 minutes; a rejected token is dropped immediately
// and the next request fetches a fresh one (the pool rotates many tokens).
// isolate 内存缓存 30 分钟；token 被拒立即作废，下个请求换新的（池内多 token 轮换）。

import { poolKv, nowStr, pickTokenRecord } from './kv-pool.js';

export const TOKENHUB_API = 'https://tokenhub.hacs.vip/api/token/get';

// Cache TTL / 缓存有效期
const TOKEN_CACHE_TTL_MS = 30 * 60 * 1000;
// Cooldown after a rejection, to avoid hammering the pool API during upstream failures
// 被拒后的冷却期，防止上游故障时打爆池接口
const RETRY_COOLDOWN_MS = 10 * 1000;

// isolate-level cache (globals live as long as the isolate) / isolate 级缓存（全局变量随 isolate 存活）
// poolKey remembers which pool record the cached token came from, so a rejection can
// prune/refresh that exact record in KV. / poolKey 记录缓存 token 来自哪条池记录，
// 被拒时可以精准回写那条 KV 记录。
const tokenCache = { token: null, fetchedAt: 0, rejectedAt: 0, poolKey: null };

function markRejected() {
  tokenCache.token = null;
  tokenCache.fetchedAt = 0;
  tokenCache.rejectedAt = Date.now();
}

// Called when upstream returns 401/403: drop the memory cache AND write back to the
// pool record immediately — without this, the record's 10-min quota freshness would
// keep serving the same dead token for up to 10 minutes.
//   status 401 → token revoked/bad: mark the record disabled in KV right away
//   status 403 → quota likely exhausted: clear freshness so the next pick revalidates
//   (a re-share via insertPoolRecord revives disabled records)
// 上游返回 401/403 时调用：除清内存缓存外，立即回写池内那条记录——否则记录的 10 分钟
// 保鲜额度会让同一枚失效 token 继续被选中长达 10 分钟。
//   401 → token 被吊销/失效：立刻在 KV 中停用该记录
//   403 → 额度大概率耗尽：清保鲜期，下次选取强制重新验活
//   （insertPoolRecord 的重复分享可复活已停用记录）
export function invalidateGithubToken(status, context) {
  const kvb = poolKv();
  if (kvb && tokenCache.poolKey) {
    const key = tokenCache.poolKey;
    const writeback = (async () => {
      try {
        const raw = await kvb.get(key, 'json');
        if (!raw) return;
        // 401 means revoked/invalid → prune. 403 is almost always quota exhaustion, which
        // recovers by itself: only clear freshness so the next pick re-checks it.
        // Never disable a token merely for hitting its hourly quota.
        // 401 才是吊销/无效 → 停用。403 基本是额度耗尽，会自行恢复：只清保鲜期让下次
        // 选取重新验活。仅因一小时额度用完绝不停用 token。
        if (status === 401) raw.disabled = true;
        raw.checked_at = 0;
        raw.updated_at = nowStr();
        await kvb.put(key, JSON.stringify(raw));
      } catch (e) {
        // best-effort bookkeeping / 回写尽力而为
      }
    })();
    // EdgeOne keeps the event alive for waitUntil tasks — the writeback must not be
    // cut off when the response returns before it finishes. / 响应先于回写完成返回时，
    // 依赖 waitUntil 让运行时保活这次写入。
    if (context && typeof context.waitUntil === 'function') {
      context.waitUntil(writeback);
    }
  }
  console.warn(`[token] rejected (${status}), cache dropped`);
  markRejected();
}

// Within cooldown, skip pool requests entirely; after cooldown, fetching resumes automatically
// 冷却期内直接放弃请求池接口，冷却过后自动恢复拉取
function inCooldown() {
  return tokenCache.rejectedAt && Date.now() - tokenCache.rejectedAt < RETRY_COOLDOWN_MS;
}

// Returns a token or null (null = anonymous requests, 60/hour)
// 返回 token 或 null（null = 匿名请求，60 次/时）
export async function getGithubToken(excludeTokens) {
  const now = Date.now();
  const skipping = excludeTokens && excludeTokens.size > 0;
  // A cached token that was just rejected must not be handed out again in the same
  // request; otherwise the cache serves it and the retry is pointless.
  // 本次请求刚被拒的 token 不能再从缓存返回，否则重试毫无意义。
  if (!skipping && tokenCache.token && now - tokenCache.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return tokenCache.token;
  }
  if (!skipping && inCooldown()) {
    // Cooldown only guards the fallback when nothing works right now; a retry that
    // explicitly excludes rejected tokens still deserves a fresh pick.
    // 冷却期只在「暂时无路可走」时生效；明确排除已拒 token 的重试仍应取新 token。
    return null;
  }

  // Primary: own KV pool (visitor-shared tokens; pickTokenRecord revalidates stale
  // entries and counts a use). / 主源：自建 KV 池（页面访客共享的 token；
  // pickTokenRecord 负责过期验活与使用计数）。
  const kvb = poolKv();
  if (kvb) {
    try {
      const picked = await pickTokenRecord(kvb, excludeTokens);
      if (picked && picked.rec && picked.rec.token) {
        tokenCache.token = picked.rec.token;
        tokenCache.fetchedAt = now;
        tokenCache.poolKey = picked.key;
        return tokenCache.token;
      }
    } catch (e) {
      // KV unavailable: fall back / KV 异常：回退
    }
  }
  tokenCache.poolKey = null;

  // Fallback: tokenhub while our pool is empty or KV errors out
  // 回退：自建池为空或 KV 异常时走 tokenhub
  try {
    const res = await fetch(TOKENHUB_API, {
      headers: { 'User-Agent': 'HomeAssistantMarketplace' },
    });
    if (res.ok) {
      const data = await res.json();
      const token = data && data.data && data.data.token;
      if (token && !(excludeTokens && excludeTokens.has(token))) {
        tokenCache.token = token;
        tokenCache.fetchedAt = now;
        return token;
      }
    }
  } catch (e) {
    console.warn('[token] tokenhub unreachable', e && e.message);
    // tokenhub unreachable / tokenhub 不可达
  }
  console.warn('[token] no token available -> anonymous');
  return null;
}
