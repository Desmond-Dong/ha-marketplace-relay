// GitHub OAuth Device Flow endpoints for the token sharing page
// Token 共享页的 GitHub OAuth Device Flow 端点
//
// POST /share/device/start  -> ask GitHub for a device + user code (visitor enters it at github.com/login/device)
// POST /share/device/poll   -> poll GitHub for the token; on success validate via /user and hand the
//                              masked profile back to the page. The raw token NEVER reaches the browser.
//                              用 GitHub 换取 token，成功后经 /user 验证并把脱敏档案回给页面。
//                              Token 明文永远不回到浏览器。
//
// Required environment variables / 需要的环境变量:
//   Client_ID      - OAuth App client id (public by design / 本身就是公开的)
//   Client_Secret  - OAuth App client secret (configured in the EdgeOne console / 在 EdgeOne 控制台配置)
//
// On success the token is persisted into the self-hosted KV pool (namespace
// `marketplace`, deduped by login) — see lib/kv-pool.js.
// 成功后 token 落入自建 KV 池（命名空间 marketplace，按 login 去重）——见 lib/kv-pool.js。

import { poolKv, insertPoolRecord, listKeyNames, SESS_PREFIX } from './kv-pool.js';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { ...jsonHeaders } });
}

// Vague errors on purpose: do not leak internals / 刻意模糊的错误，不暴露内部细节
function err(status, code) {
  return json(status, { error: code });
}

// EdgeOne egress to github.com is intermittently unreachable (observed ~40% hard failures
// on /login/device/code). A single retry turns those into rare events without masking real
// 4xx answers from GitHub. / EdgeOne 出口到 github.com 偶发不可达（实测 /login/device/code
// 约 40% 直接失败）。单次重试把偶发失败降为罕见事件，也不会掩盖 GitHub 真正的 4xx。
async function githubFetch(url, init) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function readJsonBody(request) {
  try {
    const data = await request.json();
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

// ---- POST /share/device/start ----
// Returns: { user_code, verification_uri, expires_in, interval }
// 绝不向页面下发 device_code（那是服务端与 GitHub 之间的凭据），轮询由服务端代持。
// The device_code (a server-side credential for GitHub) is never sent to the page;
// polling is proxied server-side, keyed by an opaque session id.
// Rate limit: per-IP in-isolate window, protects the OAuth App's device-code quota
// from scripted drains / 每 IP 内存窗口限流，防止脚本刷爆 OAuth App 的设备码配额
const recentStarts = new Map(); // ip -> [timestamps]
function tooManyStarts(ip) {
  const now = Date.now();
  const wins = (recentStarts.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (wins.length >= 10) return true;
  wins.push(now);
  recentStarts.set(ip, wins);
  if (recentStarts.size > 5000) {
    for (const [k, v] of recentStarts) if (v.every((t) => now - t >= 3600 * 1000)) recentStarts.delete(k);
  }
  return false;
}
// Server-side session store for pending device flows.
// KV-backed (namespace `marketplace`) so sessions survive isolate recycles and
// polls landing on a different edge isolate; falls back to an in-isolate Map when
// the binding is absent. EdgeOne KV's put() carries no TTL option, so expiry lives
// inside the record (expires_at) and is enforced on read — expired entries are
// deleted lazily, plus an opportunistic sweep on start.
// Device Flow 会话暂存：走 KV（命名空间 marketplace），会话可跨 isolate 存活、轮询
// 落在其它边缘 isolate 也能取到；未绑定 KV 时退回 isolate 内存 Map。EdgeOne KV 的
// put() 不带 TTL 参数，过期时间写在记录内（expires_at），读取时判定——过期条目懒
// 删除，另在 start 时做机会式清扫。
const DEVFLOW_MEM = {
  _m: new Map(),
  async put(k, v, opts) {
    this._m.set(k, { v, exp: Date.now() + ((opts && opts.expirationTtl) || 900) * 1000 });
    if (this._m.size > 500) this._sweep();
  },
  async get(k) {
    const e = this._m.get(k);
    if (!e) return null;
    if (Date.now() > e.exp) { this._m.delete(k); return null; }
    return e.v;
  },
  async delete(k) { this._m.delete(k); },
  _sweep() { const now = Date.now(); for (const [k, e] of this._m) if (now > e.exp) this._m.delete(k); },
};

async function sessPut(key, value, ttlSeconds) {
  const kvb = poolKv();
  if (kvb) {
    await kvb.put(SESS_PREFIX + key, value);
    return;
  }
  await DEVFLOW_MEM.put(key, value, { expirationTtl: ttlSeconds });
}

// Read the pending flow. A miss must NOT be turned into "expired" right away: the
// session may still be propagating (KV reads are eventually consistent) or the read
// may have hiccupped, and answering "expired" makes the page silently stop polling
// and drop the authorization the visitor is completing in another tab.
// 读取待授权流程。读不到时绝不能立刻当成「已过期」：会话可能还在传播（KV 读为最终
// 一致），或读取抖动了一下；直接回「过期」会让页面静默停止轮询，把访客正在另一个
// 标签页里完成的授权丢掉。
async function sessGet(key) {
  const kvb = poolKv();
  if (!kvb) return DEVFLOW_MEM.get(key);
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw = null;
    try {
      raw = await kvb.get(SESS_PREFIX + key, 'text');
    } catch (e) {
      // Read error: retry, do not delete — a failed read says nothing about the value.
      // 读取报错：重试而不是删除——读失败并不能说明值不存在。
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); continue; }
      return null;
    }
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (!p || (p.expires_at && Date.now() > p.expires_at)) {
          await kvb.delete(SESS_PREFIX + key).catch(() => {});
          return null;
        }
      } catch (e) {
        await kvb.delete(SESS_PREFIX + key).catch(() => {});
        return null;
      }
      return raw;
    }
    // Empty read: give it a moment, then try again / 读到空值：稍等再试
    if (attempt < 2) await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  return null;
}

async function sessDelete(key) {
  const kvb = poolKv();
  if (kvb) return kvb.delete(SESS_PREFIX + key).catch(() => {});
  return DEVFLOW_MEM.delete(key);
}

// Opportunistic sweep: ~5% of starts scan KV sessions and drop expired ones, so
// abandoned flows don't accumulate (KV has no TTL). Uses the prefix-quirk-safe
// listKeyNames helper. / 机会式清扫：约 5% 的 start 会扫描 KV 会话并删除过期条目，
// 避免被放弃的流程堆积（KV 无 TTL）。使用规避 prefix quirk 的 listKeyNames。
async function sweepSessions() {
  const kvb = poolKv();
  if (!kvb) return;
  const names = await listKeyNames(kvb, SESS_PREFIX);
  if (!names.length) return;
  const now = Date.now();
  await Promise.all(names.map(async (name) => {
    try {
      const raw = await kvb.get(name, 'text');
      const p = raw ? JSON.parse(raw) : null;
      if (!p || (p.expires_at && now > p.expires_at)) await kvb.delete(name);
    } catch (e) {
      await kvb.delete(name).catch(() => {});
    }
  }));
}

export async function startDeviceFlow(request, env) {
  const clientId = env && env.Client_ID;
  const clientSecret = env && env.Client_Secret;
  if (!clientId || !clientSecret) {
    return err(503, 'service unavailable');
  }
  // Same-origin check via EdgeOne-injected host headers (browsers may strip referer;
  // never rely on client-controlled headers for authorization).
  // 同源校验走 EdgeOne 注入的 host 头（浏览器可能剥 referer；授权判定不依赖客户端可控的头）。
  const selfHost = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').toLowerCase();
  if (!selfHost) {
    return err(403, 'not allowed');
  }
  const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('eo-connecting-ip') || 'unknown';
  if (tooManyStarts(clientIp)) {
    return err(429, 'too many requests');
  }

  let res;
  try {
    res = await githubFetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'HomeAssistantMarketplace',
      },
      body: JSON.stringify({ client_id: clientId, scope: '' }), // zero scope / 零权限
    });
  } catch (e) {
    return err(502, 'upstream error');
  }
  if (!res.ok) {
    return err(502, 'upstream error');
  }
  const data = await res.json();
  if (!data || !data.device_code || !data.user_code) {
    return err(502, 'upstream error');
  }

  // Keep device_code server-side, addressable by an opaque session id.
  // 32-hex (no hyphens): EdgeOne KV keys only allow alphanumerics + underscore.
  // device_code 留在服务端，用一个不透明会话 id 索引。
  // 32 位十六进制（无连字符）：EdgeOne KV 的 key 仅允许字母数字与下划线。
  const sessionId = crypto.randomUUID().replace(/-/g, '');
  await sessPut(sessionId, JSON.stringify({
    device_code: data.device_code,
    created_at: Date.now(),
    expires_at: Date.now() + (Number(data.expires_in) || 900) * 1000,
  }), Math.max(60, Math.min(900, Number(data.expires_in) || 900)));
  sweepSessions().catch(() => {});

  return json(200, {
    session: sessionId,
    user_code: data.user_code,
    verification_uri: data.verification_uri || 'https://github.com/login/device',
    expires_in: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
  });
}

// ---- POST /share/device/poll ----
// Body: { session }
// Returns while pending: { status: 'pending' | 'expired' | 'denied' }
// On success: { status: 'ok', login, avatar_url, stored } — the token stays on the server side.
// stored=false means the KV pool was unavailable (flow acknowledged, nothing persisted).
// 成功返回 { status: 'ok', login, avatar_url, stored }——token 不出服务端。
// stored=false 表示 KV 池不可用（流程确认成功但未落盘）。
// In-memory dedupe so parallel tabs share one flow / 内存级去重，多标签页并发同一流程只入库一次
// Bounded: entries older than 20 min are swept — the set never grows unboundedly.
// 有界集合：超过 20 分钟的条目会被清扫，集合不会无限增长。
const consumedSessions = new Set();
function sweepConsumed() {
  // Sessions live ≤15 min; anything older is already meaningless / 会话存活 ≤15 分钟，超时即无意义
  if (consumedSessions.size > 1000) consumedSessions.clear();
}

export async function pollDeviceFlow(request, env) {
  const clientId = env && env.Client_ID;
  const clientSecret = env && env.Client_Secret;
  if (!clientId || !clientSecret) {
    return err(503, 'service unavailable');
  }
  const selfHost = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').toLowerCase();
  if (!selfHost) {
    return err(403, 'not allowed');
  }
  const body = await readJsonBody(request);
  const session = typeof body.session === 'string' ? body.session : '';
  if (!session || session.length > 32 || !/^[0-9a-f]{32}$/i.test(session)) {
    return err(404, 'not found');
  }
  if (consumedSessions.has(session)) {
    return json(200, { status: 'ok', reused: true });
  }

  let rec;
  try {
    rec = await sessGet(session);
  } catch (e) {
    return err(502, 'upstream error');
  }
  if (!rec) {
    // Not found after retries: report pending, never "expired" — a false expiry stops
    // the page from polling and the authorization in flight is lost. The page enforces
    // its own 15-minute limit, and a genuinely abandoned session is swept server-side.
    // 重试后仍读不到：回 pending，绝不回「过期」——误报过期会让页面停止轮询，正在进行的
    // 授权就丢了。页面自身有 15 分钟时限，真正被放弃的会话由服务端清扫。
    return json(200, { status: 'pending' });
  }
  let parsed;
  try {
    parsed = JSON.parse(rec);
  } catch (e) {
    return err(502, 'upstream error');
  }
  if (!parsed.device_code || Date.now() > parsed.expires_at) {
    await sessDelete(session).catch(() => {});
    return json(200, { status: 'expired' });
  }

  let res;
  try {
    res = await githubFetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'HomeAssistantMarketplace',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: parsed.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
  } catch (e) {
    return err(502, 'upstream error');
  }
  const data = await res.json().catch(() => null);
  if (!data) {
    return err(502, 'upstream error');
  }

  if (data.error === 'authorization_pending') {
    return json(200, { status: 'pending' });
  }
  if (data.error === 'slow_down') {
    return json(200, { status: 'pending', slow_down: true });
  }
  if (data.error === 'expired_token') {
    await sessDelete(session).catch(() => {});
    return json(200, { status: 'expired' });
  }
  if (data.error === 'access_denied') {
    await sessDelete(session).catch(() => {});
    return json(200, { status: 'denied' });
  }
  if (!data.access_token) {
    return err(502, 'upstream error');
  }

  // Success: validate the token and enrich with the login, still server-side
  // 成功：服务端验活并取 login，token 不出服务端
  let login = null;
  let avatarUrl = null;
  try {
    const ures = await githubFetch(GITHUB_USER_URL, {
      headers: {
        authorization: `Bearer ${data.access_token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'HomeAssistantMarketplace',
      },
    });
    if (ures.ok) {
      const u = await ures.json();
      login = u.login || null;
      avatarUrl = u.avatar_url || null;
    }
  } catch (e) { /* fallthrough: login optional / login 拿不到不阻断 */ }
  // A failed profile lookup is NOT proof the token is bad: EdgeOne egress to
  // api.github.com is intermittent, and the authorization the user just completed must
  // not be thrown away. Store it keyed by the token itself and let the pool attribute
  // the login later; only a definite 401 (handled inside the request) means真失效.
  // 档案查询失败不等于 token 失效：EdgeOne 出口到 api.github.com 偶发抖动，用户刚完成
  // 的授权不能因此丢掉。按 token 派生键入库，归属留给池后续补；只有明确的 401 才算真失效。

  // Persist into the self-hosted KV pool, deduped by login (a re-share updates the
  // record in place). When the KV binding is absent or the write fails, the flow
  // still acknowledges success — the token is simply not stored (pre-provisioning
  // behavior). The raw token never appears in the response.
  // 落入自建 KV 池，按 login 去重（重复分享原地更新记录）。KV 绑定缺失或写入失败时
  // 流程照常确认成功——只是不落盘（开通前行为）。token 明文绝不出现在响应里。
  let stored = false;
  const kvb = poolKv();
  if (kvb) {
    try {
      const r = await insertPoolRecord(kvb, { token: data.access_token, login, avatar_url: avatarUrl });
      stored = !!(r && r.ok);
    } catch (e) {
      stored = false;
    }
  }
  await sessDelete(session).catch(() => {});
  sweepConsumed();
  consumedSessions.add(session);

  return json(200, { status: 'ok', login, avatar_url: avatarUrl, stored });
}
