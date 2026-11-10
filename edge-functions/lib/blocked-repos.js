// KV-driven repo blocklist / KV 驱动的仓库排除名单
//
// The list lives in the same KV namespace as the token pool, key `blocked_repos`,
// stored as a JSON array of patterns. Patterns are matched case-insensitively:
//   "owner/repo"  — block that whole repository (API, releases, source archives, raw)
//   "owner/*"     — block every repository of that owner
// Editing the key in the EdgeOne console takes effect within BLOCKLIST_TTL_MS (60 s) —
// no redeploy needed. A missing, empty or malformed key means "nothing blocked".
// The read is cached in-isolate for 60 s so per-request cost stays one in-memory map
// lookup; only one isolate per 60 s actually hits KV.
//
// 名单与 token 池同在 KV 命名空间 `marketplace`，键 `blocked_repos`，JSON 数组。
// 匹配不区分大小写：
//   "owner/repo" — 整仓排除（API、release、源码包、raw 全挡）
//   "owner/*"    — 该 owner 名下全部仓库排除
// 在 EdgeOne 控制台编辑该键，最多 BLOCKLIST_TTL_MS（60 秒）后全网生效——无需重新部署。
// 键缺失 / 为空 / 格式非法 = 不排除任何仓库。读取带 60 秒 isolate 内缓存，
// 每个请求的代价只是一次内存查询；每 60 秒只有一个请求真正访问 KV。

import { poolKv } from './kv-pool.js';

export const BLOCKLIST_KEY = 'blocked_repos';
const BLOCKLIST_TTL_MS = 60 * 1000;

let cache = { list: null, fetchedAt: 0 };

function parseList(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s) => String(s || '').trim().toLowerCase())
      .filter((s) => /^[a-z0-9-_.]+\/*(\*)?$/.test(s) || /^[a-z0-9-_.]+\/[a-z0-9-_.]+$/i.test(s));
  } catch (e) {
    return [];
  }
}

// Load the list (cached). Never throws — any KV problem means "no blocking".
// 加载名单（带缓存）。任何异常都按「无排除」处理，绝不影响正常请求。
export async function getBlockedRepos() {
  const now = Date.now();
  if (cache.list && now - cache.fetchedAt < BLOCKLIST_TTL_MS) return cache.list;
  const kvb = poolKv();
  if (!kvb) return [];
  let list = [];
  try {
    const raw = await kvb.get(BLOCKLIST_KEY);
    list = parseList(raw);
  } catch (e) {
    list = [];
  }
  cache = { list, fetchedAt: now };
  return list;
}

// Match "owner/repo" against the list; "owner/*" blocks the whole owner.
// 检查 "owner/repo" 是否被排除；"owner/*" 覆盖整个 owner。
export function isRepoBlocked(list, owner, repo) {
  if (!list || !list.length || !owner) return false;
  const o = String(owner || '').toLowerCase();
  const r = String(repo || '').toLowerCase();
  if (!o) return false;
  for (const pat of list) {
    if (pat === `${o}/*` || pat === `${o}/`) return true;
    if (pat === `${o}/${r}`) return true;
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

// Test helper used by lib self-checks (also keeps the module shape explicit).
export function resetBlocklistCacheForTests() {
  cache = { list: null, fetchedAt: 0 };
}
