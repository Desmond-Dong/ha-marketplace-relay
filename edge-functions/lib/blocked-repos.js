// KV-driven repo lists: blocklist AND allowlist / KV 驱动的仓库名单：排除 + 白名单
//
// Two keys in the same KV namespace as the token pool, each a JSON array of patterns,
// matched case-insensitively. Pattern forms:
//   "owner/repo"  — exact repo
//   "owner/*"     — every repo of that owner
//   "*vpn*"       — substring: matches anywhere in "owner/repo" (owner OR repo part)
//   "nvidia*" / "*vpn" — prefix / suffix
//   blocked_repos — repos to always reject
//   allow_repos   — when non-empty, ONLY these repos are served (strict allowlist mode);
//                   empty / missing / malformed = allow everything (default)
// Both keys are console-editable and take effect within LIST_TTL_MS (60 s) — no redeploy.
// Cache is per-isolate with a 60 s TTL; per-request cost is one in-memory array scan,
// and only one isolate per 60 s actually hits KV. Any KV error degrades safely:
// blocklist -> nothing blocked, allowlist -> everything allowed.
//
// 两个键与 token 池同在 KV 命名空间 `marketplace`，JSON 数组、不区分大小写。模式形态：
//   "owner/repo" 精确整仓；"owner/*" 该 owner 全部；"*vpn*" 子串（owner/repo 任意位置命中）；
//   "nvidia*" 前缀 / "*vpn" 后缀
//   blocked_repos — 恒拒绝名单
//   allow_repos   — 非空时进入严格白名单模式（只放行名单内仓库）；
//                   空 / 缺失 / 格式非法 = 全放行（默认）
// 两键均在控制台编辑，最多 LIST_TTL_MS（60 秒）生效，无需重新部署。
// 读取带 isolate 内 60 秒缓存：每请求只是一次内存比对，每 60 秒只有一个请求真正
// 访问 KV。KV 异常一律安全降级：黑名单按「无排除」、白名单按「全放行」。

import { poolKv } from './kv-pool.js';

export const BLOCKLIST_KEY = 'blocked_repos';
export const ALLOWLIST_KEY = 'allow_repos';
const LIST_TTL_MS = 60 * 1000;

const cache = {
  blocked: { list: null, fetchedAt: 0 },
  allowed: { list: null, fetchedAt: 0 },
};

function parseList(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// Load one list (cached). Never throws — KV problems degrade per key semantics.
// 加载单个名单（带缓存）。任何异常都按该键的语义安全降级。
async function getList(key, slot) {
  const now = Date.now();
  if (slot.list && now - slot.fetchedAt < LIST_TTL_MS) return slot.list;
  const kvb = poolKv();
  if (!kvb) return [];
  let list = [];
  try {
    const raw = await kvb.get(key);
    list = parseList(raw);
  } catch (e) {
    list = [];
  }
  slot.list = list;
  slot.fetchedAt = now;
  return list;
}

export function getBlockedRepos() {
  return getList(BLOCKLIST_KEY, cache.blocked);
}

export function getAllowedRepos() {
  return getList(ALLOWLIST_KEY, cache.allowed);
}

// Match "owner/repo" against the list; "owner/*" blocks the whole owner.
// 检查 "owner/repo" 是否被排除；"owner/*" 覆盖整个 owner。
export function isRepoBlocked(list, owner, repo) {
  if (!list || !list.length || !owner) return false;
  const o = String(owner || '').toLowerCase();
  const r = String(repo || '').toLowerCase();
  if (!o) return false;
  const target = `${o}/${r}`;
  for (const pat0 of list) {
    const pat = String(pat0 || '').trim().toLowerCase();
    if (!pat) continue;
    // Substring wildcard: *vpn* / *nvidia* — match anywhere in owner/repo.
    // 子串通配：只要出现在 owner/repo 任意位置即命中。
    if (pat.includes('*')) {
      // "owner/*" handled by the generic path below too, but keep it fast here.
      // Turn each pattern into a regex: * → .* , escape the rest.
      const rxSrc = pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      let rx;
      try {
        rx = new RegExp(`^${rxSrc}$`);
      } catch (e) {
        continue; // malformed pattern never breaks the gate / 坏模式绝不影响判定
      }
      if (rx.test(target)) return true;
      continue;
    }
    if (pat === `${o}/*` || pat === `${o}/`) return true;
    if (pat === target) return true;
  }
  return false;
}

// Extract owner/repo from any allowlisted GitHub URL form:
//   raw.githubusercontent.com/<o>/<r>/...
//   github.com/<o>/<r>/...
//   api.github.com/repos/<o>/<r>/...
//   codeload.github.com/<o>/<r>/...
// 从各类白名单 GitHub URL 形态中提取 owner/repo。
export function ownerRepoOf(hostname, pathname) {
  const segs = pathname.replace(/^\/+/, '').split('/');
  if (hostname === 'api.github.com') {
    // /repos/<o>/<r>/... — the only api form the service remaps to
    if (segs[0] === 'repos' && segs.length >= 3) return { owner: segs[1], repo: segs[2] };
    return null;
  }
  if (segs.length >= 2) return { owner: segs[0], repo: segs[2] ? segs[1] : segs[1] };
  return null;
}

// Combined gate: blocked wins over allowed; empty allowlist = allow all.
// 组合判定：先黑名单后白名单；白名单为空 = 全放行。
// Returns { blocked, allowed } — caller answers 403 when blocked===true or allowed===false.
// 返回 { blocked, allowed }——blocked===true 或 allowed===false 时调用方回 403。
export async function checkRepo(owner, repo) {
  const [blocked, allowed] = await Promise.all([getBlockedRepos(), getAllowedRepos()]);
  const isBlocked = isRepoBlocked(blocked, owner, repo);
  const isAllowed = !allowed || allowed.length === 0 || isRepoBlocked(allowed, owner, repo);
  return { blocked: isBlocked, allowed: isAllowed };
}

// Test helper used by lib self-checks (also keeps the module shape explicit).
export function resetBlocklistCacheForTests() {
  cache.blocked = { list: null, fetchedAt: 0 };
  cache.allowed = { list: null, fetchedAt: 0 };
}
