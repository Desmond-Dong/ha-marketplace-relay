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
// Legacy keys were sequential decimals (pool_1); current keys are per-login hashes
// in base36 — the first 10 chars convert back to a stable display id. Both parse.
// 旧键型是十进制顺序号（pool_1）；现键型是按 login 的 base36 哈希——取前 10 位转回
// 稳定的展示用 id。两种都能解析。
export function poolIdOf(key) {
  const suffix = key.slice(POOL_PREFIX.length);
  if (/^[0-9]+$/.test(suffix)) {
    const n = Number(suffix);
    return Number.isFinite(n) && n >= 1 ? n : 0;
  }
  const n = parseInt(suffix.slice(0, 10), 36);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Deterministic 64-bit-ish key suffix for a login (two independent FNV-1a rounds,
// Math.imul keeps the multiplies in int32). Same login → same key forever: per-login
// dedupe holds by construction, not by scan-and-compare, so concurrent shares on
// different edge nodes can never overwrite each other.
// login 的确定性 64 位键后缀（两轮独立 FNV-1a，Math.imul 保证 int32 乘法）。同一
// login 永远映射同一个键：按 login 去重由构造保证而非扫描比对，不同边缘节点上的
// 并发分享绝不可能互相覆盖。
// Key suffix derived from the token itself, used when the login could not be resolved
// (GitHub /user hiccup right after authorization). Losing the authorization because of
// one failed profile lookup would throw away a token the user already granted.
// 由 token 本身派生的键后缀：授权后 /user 抖动、拿不到 login 时使用。因为一次档案查询
// 失败就丢掉用户已经授权好的 token，是不可接受的。
function tokenKey(token) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2166136261) >>> 0;
  }
  return 't' + h1.toString(36) + h2.toString(36);
}

function loginKey(login, attempt) {
  const s = attempt ? `${login}#${attempt}` : String(login);
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2166136261) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

// Enumerate key names under a prefix, working around a confirmed runtime quirk:
// list() WITH a prefix returns a result WITHOUT the keys array (verified live via
// /api/kv-diag); only option-less list() returns keys. Strategy: try prefix mode on
// the first page; when keys are missing, redo — and continue — without a prefix,
// filtering in JS. The mode locks for the whole pagination because the two cursors
// are not interchangeable. Works with both documented ListKey shapes (key/name).
// 枚举某前缀下的键名，规避实测确认的运行时 quirk：带 prefix 的 list() 返回值里没有
// keys 数组（经 /api/kv-diag 线上确认）；只有不带参数的 list() 才返回 keys。策略：
// 第一页先试 prefix 模式，缺 keys 就退回无 prefix 分页 + JS 侧过滤。模式在第一页
// 锁定整轮保持（两种游标不通用）。兼容文档里的两种 ListKey 形状（key/name）。
export async function listKeyNames(kvb, prefix) {
  const names = [];
  let cursor;
  let mode = 'auto';
  let pages = 0;
  do {
    // Hard page cap: a 6-record pool must never paginate forever — if the platform
    // misbehaves, bail out with whatever was collected. / 硬性翻页上限：6 条记录的池
    // 绝不允许无限翻页——平台行为异常时带着已收集的结果退出。
    if (++pages > 10) break;
    // Live-probed runtime contract: list options must NOT carry a cursor key with an
    // undefined value — the runtime strict-checks it and throws "cursor type invalid.
    // expect: 'string' get: 'undefined'". First page omits the key entirely; only a
    // non-empty string cursor from the previous page is sent. cursor is empty-string
    // when complete. Key elements are objects ({key} per the teo docs) but bare
    // strings are accepted too.
    // 线上实锤的运行时契约：list 选项绝不能带值为 undefined 的 cursor 键——运行时严格
    // 校验直接抛 "cursor type invalid. expect: 'string' get: 'undefined'"。首页完全
    // 不带该键；仅当上一页返回非空字符串 cursor 才续传。遍历完成时 cursor 为空字符串。
    // 键元素是对象（teo 文档的 {key}），裸字符串也兼容。
    const opts = mode === 'noprefix' ? { limit: 256 } : { prefix, limit: 256 };
    if (cursor) opts.cursor = cursor;
    let page = await kvb.list(opts);
    let rawKeys = page && Array.isArray(page.keys) ? page.keys : null;
    if (mode === 'auto' && !rawKeys) {
      mode = 'noprefix';
      const opts2 = { limit: 256 };
      if (cursor) opts2.cursor = cursor;
      page = await kvb.list(opts2);
      rawKeys = page && Array.isArray(page.keys) ? page.keys : [];
    }
    if (mode === 'auto') mode = 'prefix';
    for (const k of rawKeys || []) {
      // Accept every observed key shape: bare string, {key}, {name}. A shape this
      // code does not understand is recorded as '?' and skipped in loadPool instead
      // of silently vanishing. / 接受所有已观测键形状：裸字符串、{key}、{name}。
      // 无法识别的形状记为 '?' 由 loadPool 跳过，绝不静默消失。
      let n = null;
      if (typeof k === 'string') n = k;
      else if (k && typeof k.key === 'string') n = k.key;
      else if (k && typeof k.name === 'string') n = k.name;
      else n = '?';
      if (mode === 'prefix' || String(n).startsWith(prefix) || n === '?') names.push(String(n));
    }
    // cursor comes back as empty string when complete; only forward a non-empty
    // string. / cursor 遍历完成时为空字符串；仅续传非空字符串。
    cursor = page && !page.complete && typeof page.cursor === 'string' && page.cursor ? page.cursor : undefined;
  } while (cursor);
  return names;
}

// Load every pool record. The pool is small by design (human-shared tokens),
// so a full scan per pick is acceptable and keeps dedupe/revalidation simple.
// A stored record MUST be readable: a failed get propagates loudly (callers surface
// the error) instead of being skipped — silently dropping rows is what masked the
// key-shape bug in the first place.
// 读取全部池记录。池子天然小（人工分享的 token），全量扫描即可，去重与验活都简单。
// 已入库的记录必须可读：get 失败就大声抛出（由调用方呈现错误），绝不静默跳过——
// 正是「有错就跳过」把键形状 bug 掩盖了的。
export async function loadPool(kvb) {
  const names = await listKeyNames(kvb, POOL_PREFIX);
  if (!names.length) return [];
  const vals = await Promise.all(names.map(async (name) => {
    if (name === '?') return undefined; // unknown key shape: skip / 未知键形状：跳过
    // get() type variants differ across runtime versions; try both. / get() 的类型参数形态因运行时版本而异，两种都试。
    try {
      return await kvb.get(name, 'json');
    } catch (e1) {
      try {
        return await kvb.get(name, { type: 'json' });
      } catch (e2) {
        const t = await kvb.get(name);
        try { return t == null ? null : JSON.parse(t); } catch (_) { return t; }
      }
    }
  }));
  const entries = [];
  names.forEach((name, i) => {
    const rec = vals[i];
    if (rec && typeof rec === 'object') {
      entries.push({ key: name, id: poolIdOf(name), rec });
    }
  });
  return entries;
}

// Revalidate one token against GitHub /rate_limit.
// Returns a structured state, because these cases need different handling:
//   { state: 'ok', remaining, resetAt }      usable
//   { state: 'exhausted', remaining: 0 }     quota used up — NOT dead, recovers at reset
//   { state: 'dead' }                       401/403: revoked or invalid, prune it
//   { state: 'unreachable' }                 network hiccup — keep the record untouched
// 对单条 token 走 GitHub /rate_limit 验活。返回结构化状态，因为几种情况处理方式不同：
//   ok 可用 / exhausted 额度用尽（不是失效，重置后自动恢复）/ dead 401-403 已吊销 /
//   unreachable 网络抖动（记录保持原状）。
export async function revalidateQuota(rec) {
  try {
    const res = await fetch('https://api.github.com/rate_limit', {
      headers: {
        authorization: `Bearer ${rec.token}`,
        'user-agent': 'HomeAssistantMarketplace',
        accept: 'application/vnd.github+json',
      },
    });
    if (res.status === 401 || res.status === 403) return { state: 'dead' };
    if (!res.ok) return { state: 'unreachable' };
    const d = await res.json();
    const core = d && d.resources && d.resources.core;
    if (!core || typeof core.remaining !== 'number') return { state: 'unreachable' };
    const resetAt = core.reset ? core.reset * 1000 : 0;
    if (core.remaining <= 0) return { state: 'exhausted', remaining: 0, resetAt };
    return { state: 'ok', remaining: core.remaining, resetAt };
  } catch (e) {
    return { state: 'unreachable' };
  }
}

// Pick the usable record with the highest remaining quota. Stale entries are
// revalidated; dead ones are marked disabled (pruned from candidates; a re-share
// via insertPoolRecord revives them). The winner's use_count is incremented and
// persisted. Returns { key, id, rec } or null when the pool is empty.
// 在可用记录里选剩余额度最高的一条。过期条目重新验活；失效条目标记停用（剔出
// 候选，重新分享可复活）。中选记录 use_count +1 并回写。池空返回 null。
export async function pickTokenRecord(kvb, excludeTokens) {
  const entries = await loadPool(kvb);
  let best = null;
  let bestScore = -Infinity;
  for (const e of entries) {
    const raw = e.rec;
    if (!raw || !raw.token || raw.disabled) continue;
    // Skip tokens already rejected during this request / 跳过本次请求中已被拒的 token
    if (excludeTokens && excludeTokens.has(raw.token)) continue;

    const now = Date.now();
    // Exhausted quota recovers on its own at reset — never disable, just skip until then.
    // 额度耗尽会在重置后自行恢复——绝不停用，仅在重置前跳过。
    if (raw.reset_at && raw.reset_at > now && (raw.remaining || 0) <= 0) continue;

    const fresh = raw.checked_at && now - raw.checked_at < QUOTA_TTL_MS;
    let remaining;
    if (fresh && typeof raw.remaining === 'number' && raw.remaining > 0) {
      remaining = raw.remaining;
    } else {
      const v = await revalidateQuota(raw);
      if (v.state === 'dead') {
        console.warn('[kv] token dead (401/403), disabling record');
        // Revoked/invalid: mark disabled, prune from candidates. / 已吊销：标记停用，剔出候选。
        raw.disabled = true;
        raw.updated_at = nowStr();
        await kvb.put(e.key, JSON.stringify(raw));
        continue;
      }
      if (v.state === 'unreachable') {
        console.warn('[kv] revalidate unreachable, skipping this round');
        // Cannot verify right now: skip this round, keep the record as-is.
        // 暂时无法验证：本轮跳过，记录保持原状。
        continue;
      }
      raw.remaining = v.remaining;
      raw.checked_at = Date.now();
      raw.reset_at = v.resetAt || 0;
      raw.updated_at = nowStr();
      await kvb.put(e.key, JSON.stringify(raw));
      if (v.state === 'exhausted') continue;
      remaining = v.remaining;
    }
    // Weighted rotation: prefer the largest remaining quota, but jitter the score so
    // near-equal tokens take turns instead of one token being hammered until empty
    // (strict max kept concentrating every request on a single contributor). Jitter
    // scale ±250 is tiny against a 5000 quota, so the pool's total headroom is still
    // spent in the same order (largest first), just spread across its members.
    // 加权轮换：仍偏向剩余额度最高的 token，但给评分加抖动，让额度相近的 token
    // 轮流出勤，而不是把一条打到耗尽才换下一条（严格取最大会把请求集中在单个
    // 贡献者身上）。±250 相对 5000 的额度微不足道，池子的总可用额度依旧按
    // 「大的先用」的顺序消耗，只是均匀摊到每个成员。
    const score = remaining + (Math.random() * 500 - 250);
    if (score > bestScore) { best = e; bestScore = score; }
  }
  if (!best) {
    console.warn('[kv] pick: no usable token in pool');
    return null;
  }
  best.rec.use_count = (best.rec.use_count || 0) + 1;
  // Each proxied request consumes exactly one unit of the picked token's core quota:
  // decrement the locally known remaining so the table (uses vs remaining) stays
  // consistent between GitHub's own /rate_limit snapshots. / 每次代理请求恰好消耗
  // 中选 token 的 1 个核心配额：同步把本地已知的 remaining 减一，让「使用次数」与
  // 「剩余次数」在两次 GitHub 验活之间保持一致。
  if (typeof best.rec.remaining === 'number' && best.rec.remaining > 0) {
    best.rec.remaining -= 1;
  }
  best.rec.updated_at = nowStr();
  await kvb.put(best.key, JSON.stringify(best.rec));
  return { key: best.key, id: best.id, rec: best.rec };
}

// Insert (or update) the caller's record. The key is derived deterministically from
// the login, so this needs no scan and no id allocation: same login → same key
// (idempotent re-share that keeps created_at/use_count and revives a pruned record),
// different logins → different keys (concurrent shares on different nodes can never
// last-write-win over each other). A 64-bit hash collision with a DIFFERENT login is
// ~impossible; if it ever happened, the deterministic attempt suffix escapes it.
// 入库/更新。键由 login 确定性派生，无需扫描、无需分配 id：同一 login → 同一键
// （幂等重分享，保留 created_at/use_count，复活已停用记录）；不同 login → 不同键
// （不同节点上的并发分享绝无后写覆盖前写）。64 位哈希与其他 login 撞键概率约等于零；
// 万一发生，确定性的 attempt 后缀可以逃逸。
export async function insertPoolRecord(kvb, { token, login, avatar_url }) {
  const now = nowStr();
  for (let attempt = 0; attempt < 3; attempt++) {
    // Without a resolved login, key by the token so the record still lands and can be
    // attributed later; a login-keyed record is preferred once /user answers.
    // 拿不到 login 时按 token 派生键，记录照样落盘、之后还能补上归属；一旦 /user 有响应，
    // 就优先用按 login 派生的键。
    const key = POOL_PREFIX + (login ? loginKey(login, attempt) : tokenKey(token));
    let prev = null;
    try {
      prev = await kvb.get(key, 'json');
    } catch (e) {
      prev = null; // unreadable existing value → treat as absent, overwrite / 旧值读不出 → 视为不存在，覆盖
    }
    if (login && prev && typeof prev === 'object' && prev.login && prev.login !== login) {
      continue; // hash collision with a different login → escape via attempt suffix / 与其他 login 撞键 → 换后缀逃逸
    }
    const rec = {
      token,
      login: login || (prev && prev.login) || '',
      avatar_url: avatar_url || (prev && prev.avatar_url) || '',
      created_at: (prev && prev.created_at) || now,
      updated_at: now,
      use_count: (prev && prev.use_count) || 0,
      remaining: 0,
      checked_at: 0, // force revalidation on next pick / 下次选取强制验活
      // prev.disabled deliberately NOT carried: a re-share revives / 刻意不带 disabled：重分享即复活
    };
    // Persist with retries and read back. A write that throws, or that "succeeds"
    // without the value being readable, means the visitor's authorization did NOT land;
    // returning ok there would silently lose a token the user already granted.
    // 带重试地写入并回读校验。写报错、或写「成功」但读不回值，都说明访客的授权没有真正
    // 落盘；此时回 ok 就等于静默丢掉用户已经授权好的 token。
    for (let write = 0; write < 4; write++) {
      try {
        await kvb.put(key, JSON.stringify(rec));
      } catch (e) {
        console.warn(`[kv] put failed (attempt ${write + 1}): ${e && e.message}`);
        if (write < 3) { await sleep(120 * (write + 1)); continue; }
        return { ok: false, reason: 'put failed' };
      }
      // Verify (eventual consistency may need a beat) / 回读校验（最终一致需要一点时间）
      for (let check = 0; check < 3; check++) {
        await sleep(check === 0 ? 0 : 150 * check);
        let back = null;
        try {
          back = await kvb.get(key, 'json');
        } catch (e) {
          back = null;
        }
        if (back && typeof back === 'object' && back.token === rec.token) {
          console.log(`[kv] insert ok key=${key} reused=${!!prev} writes=${write + 1}`);
          return { ok: true, id: poolIdOf(key), reused: !!prev, key };
        }
      }
    }
    console.warn('[kv] insert verify failed after retries');
    return { ok: false, reason: 'verify failed' };
  }
  console.warn('[kv] key collision exhausted');
  return { ok: false, reason: 'key collision' };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
