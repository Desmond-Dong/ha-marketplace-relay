// GitHub reverse proxy (gh-proxy style) / GitHub 全站反向代理（gh-proxy 风格）
// EdgeOne Pages Edge Function
//
// Usage / 用法: append the full GitHub URL after this service's domain
// 把完整 GitHub URL 拼在本服务域名后面
//   /https://api.github.com/<path>                    -> API (shared-pool token auto-attached / 自动附共享池 token)
//   /https://github.com/<owner>/<repo>/releases/...   -> release assets, follows 302 / release 资产（跟随 302）
//   /https://raw.githubusercontent.com/<...>          -> repo files / 仓库文件
//   /https://codeload.github.com/<...>                -> source archives / 源码包
//   /https://gist.githubusercontent.com/<...>         -> gist files / gist 文件
//
// Auth / 鉴权: UA must contain HomeAssistantMarketplace; non-GitHub hosts rejected
// UA 须含 HomeAssistantMarketplace；非 GitHub 域名拒绝
//
// Downloads are streamed (no buffering) with Range resume support; no accept-encoding is sent.
// 下载流式转发（不缓冲），支持 Range 断点续传；不声明 accept-encoding。

import { getGithubToken, invalidateGithubToken } from './lib/github-token.js';
import { startDeviceFlow, pollDeviceFlow } from './lib/device-flow.js';
import { getPoolStats } from './lib/pool-api.js';
import { findCached, setCached, shouldCache } from './lib/blob-cache.js';

// Upstream hosts allowed through the proxy / 允许代理的上游域名
// NOTE: raw.githubusercontent.com (Fastly 185.199.x) is unreachable from EdgeOne egress,
// so /https://raw.githubusercontent.com/... URLs are transparently remapped to the official
// Contents API on api.github.com (reachable; raw media type returns file bytes).
// 注：EdgeOne 出口连不上 Fastly 托管的 raw.githubusercontent.com，
// raw 路径自动改走 api.github.com 上的官方 Contents API（可达；raw 媒体类型返回文件本体）
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

// UA whitelist: only requests containing one of these substrings pass / UA 白名单：只放行包含任一子串的请求
const ALLOWED_UA_SUBSTRINGS = ['HomeAssistantMarketplace', 'HomeAssistant'];

// Blocked file extensions / 屏蔽的文件类型黑名单
// The HA Marketplace only downloads repo archives (.zip), release assets named by
// hacs.json, and source files (.js/.yaml/.json). Everything below is impossible in
// that flow — requests for them are treated as storage-abuse and rejected.
// Marketplace 只会下载仓库归档(.zip)、hacs.json 点名的 release 资产和源文件
// (.js/.yaml/.json)。以下类型在该流程中不可能出现，出现即视为把代理当网盘用，拒绝。
// NOTE: intentionally NOT blocked: .zip (repo archives & release assets are the
// legitimate channel), .js/.yaml/.json (actual Marketplace content), small media
// (png/svg/gif used by themes), .py (integration source inside archives only).
// 注意：不拦 .zip（仓库归档与 release 资产是正当通道）、.js/.yaml/.json（Marketplace
// 真实内容）、小体积图片（主题可能用 png/svg/gif）、.py（集成源码只在归档内）。
const BLOCKED_EXTENSIONS = new Set([
  // disk images & archives / 磁盘镜像与压缩包
  '.iso', '.dmg', '.img', '.tar', '.7z', '.rar', '.bz2', '.xz',
  // installers & packages / 安装包
  '.apk', '.exe', '.msi', '.deb', '.rpm',
  // video / 视频（不含 .ts——TypeScript 源码共用该扩展名，插件源码树可能包含）
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv',
  // heavy media & assets / 大体积媒体与资产
  '.psd', '.ai', '.tiff',
  // vm disks / 虚拟机磁盘
  '.vmdk', '.qcow2',
]);
// True when the request path points at a single blocked file / 请求路径命中黑名单时返回 true
function blockedFileRequest(pathname) {
  const path = pathname.toLowerCase();
  for (const ext of BLOCKED_EXTENSIONS) {
    if (path.endsWith(ext)) return true;
  }
  return false;
}

// Per-IP rate limit for the proxy path / 代理主链路的每 IP 限流
// Sliding 1h window, 600 req/IP: an HA Marketplace install pulls a handful of API calls
// plus one archive per update; 600/h is far above any real client but caps scripted
// abuse from burning the shared token pool. / 滑动 1 小时窗口，每 IP 600 次：正常
// Marketplace 安装只有少量 API 调用加一次归档下载，600 远高于真实客户端，足以拦脚本刷量
const RATE_LIMIT_WINDOW_MS = 3600 * 1000;
const RATE_LIMIT_MAX = 600;
// Upper bound for a body that goes through the Blob cache path / 走 Blob 缓存路径的 body 体积上限
// Buffering above this blows the edge function memory budget (observed 504 on a 19 MB zip).
// 超过该值的缓冲会超边缘函数内存预算（19MB zip 实测 504）。
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const rateBuckets = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const wins = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (wins.length >= RATE_LIMIT_MAX) return true;
  wins.push(now);
  rateBuckets.set(ip, wins);
  if (rateBuckets.size > 10000) {
    for (const [k, v] of rateBuckets) if (v.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) rateBuckets.delete(k);
  }
  return false;
}

// Hop-by-hop and proxy-internal request headers, not forwarded upstream
// 逐跳头 + 代理自身头，不透传给上游
// NOTE: the upstream fetch MUST carry an explicit Host header — the EdgeOne runtime routes
// by Host instead of deriving it from the URL; omitting it fails every upstream request (site-wide 502).
// 注：上游 fetch 必须显式带 Host 头——EdgeOne 运行时按 Host 路由而非从 URL 派生，
// 缺失会导致所有上游请求失败（全站 502）
const STRIP_REQ_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'accept-encoding', 'x-forwarded-for',
  'x-forwarded-proto', 'x-forwarded-host', 'cf-connecting-ip',
  'x-real-ip', 'eo-connecting-ip', 'authorization',
]);

// Hop-by-hop / platform-injected response headers, not forwarded to the client
// 逐跳头 + 平台注入的响应头，不透传给客户端
const STRIP_RES_HEADERS = new Set([
  'connection', 'transfer-encoding', 'content-encoding', 'content-length',
  'content-type',
]);

// Uniform JSON error; details are deliberately vague to avoid leaking proxy internals
// 统一 JSON 错误；信息刻意模糊，避免暴露代理内部逻辑
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

// CORS headers for browser clients / 浏览器客户端的 CORS 头
function withCors(headers) {
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-headers', 'authorization, content-type, range');
  headers.set('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('access-control-expose-headers', 'content-length, content-range, etag, last-modified');
  return headers;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: withCors(new Headers()) });
  }

  // Token-sharing Device Flow endpoints (before the UA gate: they are browser-facing pages' APIs,
  // guarded by same-origin referer checks inside the handlers)
  // Token 共享的 Device Flow 端点（放在 UA 门禁之前：这是给浏览器页面用的 API，
  // 由 handler 内部的同源 referer 校验保护）
  if (url.pathname === '/share/device/start' && request.method === 'POST') {
    return startDeviceFlow(request, env);
  }
  if (url.pathname === '/share/device/poll' && request.method === 'POST') {
    return pollDeviceFlow(request, env);
  }

  // Shared-pool public API (moved out of api/ subdirectory files: the bundler cannot
  // resolve '../../' imports there — handlers live in lib/pool-api.js; URLs unchanged)
  // 共享池公开 API（从 api/ 子目录迁出：打包器无法解析那里的 '../../' 导入——处理器
  // 在 lib/pool-api.js；URL 不变）
  if (url.pathname === '/api/token/stats' && request.method === 'GET') {
    return getPoolStats(env);
  }

  // Non-proxy paths that look like pages should fall through to static assets
  // (the catch-all below only handles /https://... prefixed proxy requests)
  // 看起来是页面的非代理路径继续走静态资源（下方 catch-all 只处理 /https://… 前缀的代理请求）
  if (!/^https?:/i.test(url.pathname.slice(1))) {
    // context.next() throws when no static asset matches (EdgeOne returns 545 / "Error return
    // from script"); turn that into a clean 404 instead of a fake function error.
    // context.next() 在无匹配静态资源时会抛错（EdgeOne 返回 545 / "Error return from script"），
    // 这里兜底成正常 404，避免把不存在的路径伪装成函数故障。
    try {
      return await context.next();
    } catch (e) {
      return jsonError(404, 'not found');
    }
  }

  // UA whitelist check / UA 白名单校验
  const ua = request.headers.get('user-agent') || '';
  if (!ALLOWED_UA_SUBSTRINGS.some((s) => ua.includes(s))) {
    return jsonError(403, 'not allowed');
  }

  // Per-IP rate limit / 每 IP 限流（UA 门禁之后，只限通过门禁的代理请求）
  const clientIp = request.headers.get('x-forwarded-for') || request.headers.get('eo-connecting-ip') || 'unknown';
  if (rateLimited(clientIp)) {
    return jsonError(429, 'too many requests');
  }

  // ---- Target URL / 解析目标 URL: /https://github.com/... ----
  // Some HTTP clients collapse "//" into "/" in the path; repair the scheme first
  // 部分 HTTP 客户端会把路径里的 // 折叠成 /，先修复 scheme
  let raw = url.pathname.slice(1).replace(/^(https?):\/(?!\/)/i, '$1://');
  raw += url.search; // inner URL query rides on the outer request's search / 内层 URL 的查询参数在外层请求的 search 里
  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return jsonError(404, 'not found');
  }
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    return jsonError(403, 'not allowed');
  }

  // Blocked file types / 黑名单文件类型拦截
  // Applies to every path form: raw single files, API contents, GitHub blob paths and
  // release assets. Repo/source archives end in .zip which is not on the list, so the
  // legitimate Marketplace channel is unaffected.
  // 覆盖所有路径形态：raw 单文件、API contents、GitHub blob 路径与 release 资产。
  // 仓库归档是 .zip 不在名单里，Marketplace 正当通道不受影响。
  if (blockedFileRequest(target.pathname)) {
    return jsonError(403, 'not allowed');
  }

  // raw.githubusercontent.com remap / raw 域名改走官方 Contents API
  // Contents API lives on api.github.com (reachable) and serves file bytes with the raw media type.
  // Contents API 在可达的 api.github.com 上，附共享池 token 返回文件本体。
  let rawRemap = false;
  if (target.hostname === 'raw.githubusercontent.com') {
    const segs = target.pathname.replace(/^\/+/, '').split('/');
    if (segs.length >= 4) {
      const [owner, repo, ref, ...rest] = segs;
      const path = rest.map(encodeURIComponent).join('/');
      target = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      rawRemap = true;
    }
  }
  // Never forward proxy-internal params upstream / 代理内部参数不透传给上游
  target.searchParams.delete('key');

  // Blob cache: check if this request should be cached / Blob 缓存：检查是否应缓存此请求
  const cacheEnabled = shouldCache(target.toString());
  const rangeHeader = request.headers.get('range');
  const hasRange = !!rangeHeader;
  
  let cachedResult = null;
  if (cacheEnabled && !hasRange) {
    // Only cache full requests (no Range header)
    // 只缓存完整请求（无 Range 头）
    cachedResult = await findCached(target.toString());
    if (cachedResult) {
      // Cache hit / 缓存命中
      const resHeaders = new Headers();
      resHeaders.set('content-type', cachedResult.contentType || 'application/octet-stream');
      resHeaders.set('x-cache', 'HIT');
      withCors(resHeaders);
      return new Response(cachedResult.body, {
        status: 200,
        headers: resHeaders,
      });
    }
  }

  // ---- Upstream request headers / 构造上游请求头 ----
  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (!STRIP_REQ_HEADERS.has(k.toLowerCase())) {
      headers.set(k, v);
    }
  }
  // EdgeOne runtime routes the upstream fetch by the Host header (not derived from the URL);
  // without it every upstream request fails (site-wide 502). / EdgeOne 运行时按 Host 头路由上游
  // 请求（不会从 URL 派生），缺 Host 会导致所有上游请求失败（全站 502）
  headers.set('Host', target.host);
  headers.set('User-Agent', ua); // already whitelist-approved, forward as-is / 已过白名单，直接透传

  const isApi = target.hostname === 'api.github.com';
  if (isApi) {
    // raw remap → Contents API: request the raw media type to get file bytes, not JSON metadata
    // raw 重映射 → Contents API：用 raw 媒体类型拿文件本体而非 JSON 元数据
    headers.set('Accept', rawRemap ? 'application/vnd.github.raw' : (request.headers.get('accept') || 'application/vnd.github+json'));
    // API uses the shared token pool (download endpoints don't consume API quota)
    // API 走共享池 token（下载类端点不占 API 配额）
    const token = await getGithubToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  // ---- Upstream fetch with allowlisted redirect following / 带白名单校验的重定向跟随 ----
  // redirect:'manual' + per-hop ALLOWED_HOSTS check: GitHub 302s releases to its objects CDN,
  // but a hostile Location to a non-allowlisted host is rejected instead of followed blindly
  // (defense-in-depth against SSRF via any future open redirect on GitHub domains).
  // redirect:'manual' + 每跳校验 ALLOWED_HOSTS：GitHub 会把 release 302 到自家 objects CDN，
  // 但若 Location 指向白名单外域名则拒绝跟随，不再盲跟（防 GitHub 域未来出现开放重定向导致的 SSRF）。
  async function fetchUpstream(target, headers, method, body) {
    let current = target;
    for (let hop = 0; hop < 5; hop++) {
      // EdgeOne routes by the Host header: re-point it at every hop or the redirected
      // fetch lands on the previous host (site-wide failure). / EdgeOne 按 Host 头路由：
      // 每跳都要把 Host 改指当前目标，否则重定向请求会打到上一个主机（全站失败）。
      headers.set('Host', current.host);
      const res = await fetch(current, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        redirect: 'manual',
      });
      if (res.status < 300 || res.status >= 400) return res;
      const loc = res.headers.get('location');
      if (!loc) return res;
      let next;
      try {
        next = new URL(loc, current);
      } catch (e) {
        return jsonError(502, 'upstream error');
      }
      if (!ALLOWED_HOSTS.has(next.hostname)) {
        return jsonError(403, 'not allowed');
      }
      current = next;
    }
    return jsonError(502, 'upstream error');
  }

  let upstream;
  try {
    upstream = await fetchUpstream(target, headers, request.method, request.body);
  } catch (e) {
    // Single retry for transient upstream failures / 单次重试应对上游偶发失败
    try {
      upstream = await fetchUpstream(target, headers, request.method, request.body);
    } catch (e2) {
      return jsonError(502, 'upstream error');
    }
  }

  // Shared token rejected (quota exhausted / revoked): drop cache, next request fetches a fresh one.
  // Passing the status lets the pool layer prune the exact record (401) or force
  // revalidation (403) instead of serving the same dead token from its 10-min freshness.
  // 共享 token 被拒（额度尽/被吊销）：清缓存，下个请求换新 token。传入状态码让池层精准
  // 处理那条记录（401 停用 / 403 强制重新验活），避免 10 分钟保鲜期内反复拿到同一枚死 token
  if (isApi && (upstream.status === 401 || upstream.status === 403)) {
    invalidateGithubToken(upstream.status, context);
  }

  const resHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (!STRIP_RES_HEADERS.has(k.toLowerCase())) {
      resHeaders.set(k, v);
    }
  }
  // We stripped content-encoding (edge re-compresses); set a safe content-type by status.
  // Body was decoded by fetch, so no binary/charset mismatch can leak through.
  // content-type 已随 content-encoding 一并剥离（fetch 已解压 body），按状态码重置，避免边缘对解码后的 body 误判
  if (!resHeaders.has('content-type')) {
    resHeaders.set('content-type', upstream.status < 400 ? 'application/octet-stream' : 'text/plain');
  }
  withCors(resHeaders);

  // Stream the body through: function CPU doesn't grow with size (CPU limit excludes I/O wait)
  // 流式透传 body：函数 CPU 不随体积增长（CPU 限制不含 I/O 等待）

  // Blob write needs the whole body in memory first, so only small assets are cacheable;
  // buffering a 19 MB release zip here blows the edge memory/CPU budget and the edge answers 504.
  // Blob 写入必须先把整个 body 读进内存，因此只缓存小文件；把 19MB 的 release zip 缓冲下来
  // 会超出边缘内存/CPU 预算，边缘直接返回 504（实测大文件全量下载 504、Range 流式 206 正常）。
  const contentLength = Number(upstream.headers.get('content-length') || 0);
  const cacheable = cacheEnabled && !hasRange && !cachedResult
    && upstream.status >= 200 && upstream.status < 300
    && contentLength > 0 && contentLength <= MAX_CACHE_BYTES;

  // If cacheable and successful, write to Blob / 可缓存且成功时写入 Blob
  if (cacheable) {
    const contentType = resHeaders.get('content-type') || 'application/octet-stream';
    let bodyBuffer;
    try {
      bodyBuffer = await upstream.arrayBuffer();
    } catch (e) {
      // Buffer read failed → cannot cache, and the body is already consumed; report upstream error
      // 缓冲读取失败 → 无法缓存，body 也已被消费，按上游错误返回
      return jsonError(502, 'upstream error');
    }

    // Write to cache before responding: a fire-and-forget write is dropped when the edge
    // freezes the function right after the response is sent (observed: MISS on every request).
    // 响应前完成写入：fire-and-forget 的写会在响应发出后函数被冻结时丢失（实测每次都是 MISS）
    await setCached(bodyBuffer, contentType, target.toString()).catch(() => {});

    resHeaders.set('x-cache', 'MISS');
    return new Response(bodyBuffer, {
      status: upstream.status,
      headers: resHeaders,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  });
}
