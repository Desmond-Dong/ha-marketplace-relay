// Shared KV token pool access layer / 共享 token 池 KV 访问层
// Edge Functions shared module / Edge Functions 共享模块
//
// The KV namespace `marketplace` is bound in the EdgeOne Pages console with the
// variable name `marketplace` — functions access it as a GLOBAL variable (it is
// NOT on context.env). Tokenhub (https://tokenhub.hacs.vip) remains the fallback
// while the pool is empty or KV errors out.
// KV 命名空间 marketplace 在 EdgeOne Pages 控制台绑定，变量名同为 marketplace——
// 函数以全局变量方式访问（不在 context.env 上）。池空或 KV 异常时回退 tokenhub。
//
// Key charset: EdgeOne KV keys support alphanumerics + underscore only (no
// slashes/hyphens), so pool records use `pool_<n>` and device-flow sessions
// `sess_<32hex>`.
// EdgeOne KV 的 key 仅支持字母数字与下划线（无斜杠/连字符），池记录用 pool_<n>，
// Device Flow 会话用 sess_<32hex>。

// Key prefixes / 键前缀
export const POOL_PREFIX = 'pool_';
export const SESS_PREFIX = 'sess_';

// Quota freshness window: entries revalidated within this window skip the GitHub
// /rate_limit round-trip (bounds API calls; see pickTokenRecord).
// 额度保鲜期：窗口内免走 GitHub /rate_limit（限制 API 调用频次，见 pickTokenRecord）。
export const QUOTA_TTL_MS = 10 * 60 * 1000;

// Resolve the console KV binding / 解析控制台 KV 绑定
// `marketplace` is the live binding; TOKENPOOL_KV kept as a legacy alias from the
// pre-provisioning scaffolding. / marketplace 为现用绑定；TOKENPOOL_KV 保留作
// 开通前脚手架时期的旧别名。
export function poolKv() {
  if (typeof marketplace !== 'undefined' && marketplace) return marketplace;
  if (typeof TOKENPOOL_KV !== 'undefined' && TOKENPOOL_KV) return TOKENPOOL_KV;
  return null;
}

// tokenhub-style timestamp / tokenhub 风格的时间戳
export function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Numeric pool id encoded in the key / 键名中的数字池 id
export function poolIdOf(key) {
  const n = Number(key.slice(POOL_PREFIX.length));
  return Number.isFinite(n) && n >= 1 ? n : 0;
}

// Load every pool record. The pool is small by design (human-shared tokens),
// so a full scan per pick is acceptable and keeps dedupe/revalidation simple.
// 读取全部池记录。池子天然小（人工分享的 token），全量扫描即可，去重与验活都简单。
export async function loadPool(kvb) {
  const entries = [];
  let cursor;
  do {
    const page = await kvb.list({ prefix: POOL_PREFIX, limit: 256, cursor });
    if (page && Array.isArray(page.keys) && page.keys.length) {
      const vals = await Promise.all(page.keys.map((k) => kvb.get(k.name, 'json')));
      page.keys.forEach((k, i) => {
        const rec = vals[i];
        if (rec && typeof rec === 'object') {
          entries.push({ key: k.name, id: poolIdOf(k.name), rec });
        }
      });
    }
    cursor = page && !page.complete ? page.cursor : undefined;
  } while (cursor);
  return entries;
}

// Revalidate one token against GitHub /rate_limit; returns remaining quota,
// or null when dead (401/403, exhausted, or unreachable).
// 对单条 token 走 GitHub /rate_limit 验活；返回剩余额度，失效（401/403、耗尽、
// 不可达）返回 null。
export async function revalidateQuota(rec) {
  try {
    const res = await fetch('https://api.github.com/rate_limit', {
      headers: {
        authorization: `Bearer ${rec.token}`,
        'user-agent': 'HomeAssistantMarketplace',
        accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return null;
    const d = await res.json();
    const core = d && d.resources && d.resources.core;
    if (!core || core.remaining <= 0) return null;
    return core.remaining;
  } catch (e) {
    return null;
  }
}

// Pick the usable record with the highest remaining quota. Stale entries are
// revalidated; dead ones are marked disabled (pruned from candidates; a re-share
// via insertPoolRecord revives them). The winner's use_count is incremented and
// persisted. Returns { key, id, rec } or null when the pool is empty.
// 在可用记录里选剩余额度最高的一条。过期条目重新验活；失效条目标记停用（剔出
// 候选，重新分享可复活）。中选记录 use_count +1 并回写。池空返回 null。
export async function pickTokenRecord(kvb) {
  const entries = await loadPool(kvb);
  let best = null;
  for (const e of entries) {
    const raw = e.rec;
    if (!raw || !raw.token || raw.disabled) continue;
    const fresh = raw.checked_at && Date.now() - raw.checked_at < QUOTA_TTL_MS;
    let remaining = fresh ? raw.remaining : await revalidateQuota(raw);
    if (remaining == null) {
      // Dead token: mark disabled, prune from candidates. / 失效 token：标记停用，剔出候选。
      raw.disabled = true;
      raw.updated_at = nowStr();
      await kvb.put(e.key, JSON.stringify(raw));
      continue;
    }
    raw.remaining = remaining;
    raw.checked_at = Date.now();
    if (!fresh) await kvb.put(e.key, JSON.stringify(raw));
    if (!best || remaining > best.rec.remaining) best = e;
  }
  if (!best) return null;
  best.rec.use_count = (best.rec.use_count || 0) + 1;
  best.rec.updated_at = nowStr();
  await kvb.put(best.key, JSON.stringify(best.rec));
  return { key: best.key, id: best.id, rec: best.rec };
}

// Insert a shared token into the pool, deduped by login: a re-share updates the
// existing record in place (new token, revive if disabled, keep created_at and
// use_count). Returns { ok, id, reused } — ok:false means KV write failed.
// 按登录名去重入池：重复分享原地更新记录（换新 token、复活停用账号、保留
// created_at 与 use_count）。返回 { ok, id, reused }——ok:false 表示 KV 写入失败。
export async function insertPoolRecord(kvb, { token, login, avatar_url }) {
  const entries = await loadPool(kvb);
  const now = nowStr();
  const dup = entries.find((e) => e.rec.login && e.rec.login === login);
  if (dup) {
    dup.rec.token = token;
    if (avatar_url) dup.rec.avatar_url = avatar_url;
    dup.rec.disabled = false;
    dup.rec.remaining = 0;
    dup.rec.checked_at = 0; // force revalidation on next pick / 下次选取强制验活
    dup.rec.updated_at = now;
    try {
      await kvb.put(dup.key, JSON.stringify(dup.rec));
      return { ok: true, id: dup.id, reused: true };
    } catch (e) {
      return { ok: false };
    }
  }
  let next = 1;
  for (const e of entries) if (e.id >= next) next = e.id + 1;
  const rec = {
    token,
    login: login || '',
    avatar_url: avatar_url || '',
    created_at: now,
    updated_at: now,
    use_count: 0,
    remaining: 0,
    checked_at: 0,
  };
  try {
    await kvb.put(`${POOL_PREFIX}${next}`, JSON.stringify(rec));
    return { ok: true, id: next, reused: false };
  } catch (e) {
    return { ok: false };
  }
}

// tokenhub-shaped public record / tokenhub 形状的对外记录
export function toTokenhubShape(id, rec) {
  return {
    id,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    type: 'github',
    login: rec.login,
    token: rec.token,
    use_count: rec.use_count || 0,
    remaining: rec.remaining != null ? rec.remaining : 0,
    expired_at: rec.expired_at || '',
    deleted_at: null,
    usage: rec.usage || null,
    usages: null,
  };
}
