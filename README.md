# ha-marketplace-relay

Home Assistant Marketplace service bridge running on EdgeOne Pages edge nodes.

## Usage

Append the full GitHub URL after this service's domain:

```
https://<your-domain>/https://api.github.com/rate_limit
https://<your-domain>/https://github.com/owner/repo/releases/download/v1.0.0/asset.zip
https://<your-domain>/https://raw.githubusercontent.com/owner/repo/main/file.txt
```

## How a request flows / Request pipeline

```
Home Assistant Marketplace
        │  GET https://<your-domain>/https://api.github.com/…
        ▼
[1] Edge function entry
    ├─ OPTIONS              → 204 (CORS preflight)
    ├─ /share/device/*      → Device Flow handlers
    ├─ /api/token/stats     → masked pool stats
    └─ other non-service paths → static pages; 404 when nothing matches
        ▼  requests shaped as /https://…
[2] Gatekeeping (no credentials involved)
    ├─ User-Agent contains "HomeAssistantMarketplace" or "HomeAssistant" → 403 otherwise
    ├─ 600 requests / IP / hour (sliding window)                         → 429 beyond
    ├─ Target host must be in the GitHub allowlist                       → 403 otherwise
    └─ File-type blocklist (disk images / installers / video / VM disks) → 403 on match
        ▼
[3] URL normalization & remapping
    ├─ Collapsed scheme repaired: https:/ → https://
    └─ raw.githubusercontent.com/<o>/<r>/<ref>/<path>
         is transparently remapped to the official Contents API
         api.github.com/repos/<o>/<r>/contents/<path>?ref=<ref>
         with Accept: application/vnd.github.raw (file bytes, not JSON)
        ▼
[4] Edge cache lookup (release assets only, no Range header)
    ├─ Hit  → cached copy returned directly, x-cache: HIT (upstream untouched)
    └─ Miss → continue upstream
        ▼
[5] Upstream request
    ├─ Explicit Host header set to the target host (the EdgeOne runtime routes by
    │   Host; omitting it fails every upstream call)
    ├─ Hop-by-hop headers and client-supplied authorization stripped
    ├─ api.github.com requests carry a shared-pool token (downloads stay anonymous)
    └─ redirect: manual with a per-hop allowlist check (max 5 hops)
        ▼
[6] Upstream: GitHub official hosts only
    ├─ api.github.com                — API; shared-pool token used here
    ├─ github.com                    — pages and release downloads (302 → asset CDN)
    ├─ codeload.github.com           — source archives
    └─ objects / release-assets      — release asset CDN
        ▼
[7] Response back to the client
    ├─ Status code passed through unchanged (GitHub's 404 stays 404)
    ├─ Hop-by-hop headers stripped; CORS added; Range supported (206)
    ├─ Cacheable release assets (within the size limit):
    │   written to the edge cache first, then returned with x-cache: MISS
    └─ Everything else: streamed byte-for-byte — function CPU does not scale with size
```

### Edge cache / 边缘缓存

Release assets are the largest and most concentrated traffic of a Marketplace update,
so this service caches those downloads at the edge. Fully automatic, no manual steps:

- **Only release assets** (`/releases/download/` paths). API calls, pages and source
  archives are never cached.
- **Only full requests.** Range requests (resumable downloads) go straight upstream and
  neither read nor write the cache.
- **Only files within the size limit.** Larger files are always streamed through —
  buffering them whole would exceed the edge function memory budget and hurt the download
  instead of helping it.
- **Capacity is managed by file count.** When a new entry arrives at the cap, the oldest
  cached item is dropped automatically; nothing to clean up by hand.
- **The `x-cache` response header** states the outcome: `HIT` served from cache, `MISS`
  fetched from upstream and written to the cache.

The cache is a pure acceleration layer: any cache failure degrades to a direct upstream
fetch and never affects download correctness.

### Upstream resilience / 上游可用性

- Connectivity from EdgeOne nodes to `github.com` / `api.github.com` fluctuates. The main
  main service path retries once on a transient failure; each of the three GitHub calls in the
  Device Flow carries backoff retries.
- Redirects are never followed blindly: every hop is checked against the allowlist and
  anything outside it is rejected, so no upstream open redirect can be exploited.

### Where the shared token is used / Token usage

- **`api.github.com` requests only.** A token drawn from the shared pool is attached as
  `Authorization: Bearer <token>` to lift the rate limit from 60 to 5,000 requests/hour.
  The token lives only inside the edge function's memory (30-minute cache; a rejected
  token is dropped immediately and the next request fetches a fresh one).
  Raw tokens are never sent to the client, never logged, and never used for download
  endpoints.
- **Download endpoints stay anonymous for public repos** (they don't consume the
  API quota): release downloads, source archives, and the objects CDN.
- **A rejected token is swapped and the request retried.** When `api.github.com`
  answers 401 (revoked) or 403 that is genuinely quota exhaustion, the service drops
  that token, immediately picks the next one from the pool and replays the same request.
  A token is never tried twice within one request; up to 4 swaps are attempted, after
  which the request falls back to an anonymous call. A real permission 403 (restricted
  repo, forbidden resource) is returned to the client unchanged instead of burning
  through the pool.
- **Exhausted quota is not death.** A token that used up its hourly quota is skipped
  only until its reset; it returns to the candidate set automatically. Only a definite
  401 disables a record. One unusable token therefore never turns a user request into a
  failure.
- **Note on remapped raw files:** although raw.githubusercontent.com itself serves
  anonymous downloads for public repos, this service remaps raw requests to the
  Contents API (api.github.com), so those requests DO consume the shared pool's
  authenticated API quota. Direct raw downloads through the service would fail anyway
  (EdgeOne egress cannot reach raw's Fastly hosts).
- **`/share/device/*` endpoints** (token sharing page) talk to GitHub's OAuth Device
  Flow on behalf of the visitor; the issued token is validated via `/user` and stays
  on the server side.
- **No public token-issuing endpoint.** Token material never leaves the edge node for
  external callers: the service consumes the pool in-process
  (`lib/github-token.js` → `pickTokenRecord`), so no HTTP surface can hand out tokens.
- **`GET /api/token/stats`** returns masked pool stats (login / use count / last-known
  remaining quota / status) plus storage usage (record count / approximate bytes) for
  the contributors page and the home page. No raw tokens; `remaining` is the last value
  observed when the service actually used that token — it is never re-probed just to
  render the table, so an idle service makes no API calls and the last known number
  stays visible. EdgeOne does not expose the real
  KV quota to the runtime — set the `KV_QUOTA_MB` env var to the namespace's actual
  cap to get a percentage; without it only absolute usage is shown.

### Transparent pass-through vs. rewriting / 透传与改写

| Aspect | Behavior |
|---|---|
| URL path | Service-style prefix; the inner GitHub URL is parsed, then either passed through as-is (allowlist hosts) or remapped (raw → Contents API) |
| Method | Passed through unchanged |
| Query string | Passed through (the outer request's search rides on the inner URL) |
| Request body | Streamed through unchanged |
| Response status | Passed through unchanged |
| Response headers | Hop-by-hop stripped; CORS added; the rest passed through |
| Response body | Streamed through byte-for-byte; cacheable release assets are written to the edge cache before being returned |

## Requirements

- `User-Agent` must contain `HomeAssistantMarketplace` or `HomeAssistant`
- Only the GitHub hosts the Marketplace flow actually uses: `api.github.com`, `github.com`, `www.github.com`, `codeload.github.com`, `raw.githubusercontent.com` (remapped to the Contents API), and the `objects` / `release-assets` asset CDNs
- `gist.github.com` / `gist.githubusercontent.com` are NOT allowed — HACS and the Marketplace never fetch gist content, and every extra host is one more surface reachable through the service
- Per-IP rate limit: 600 requests/hour

## Deployment

1. Connect this repository to EdgeOne Makers, acceleration region: "Global (including Chinese mainland)"
2. Leave the build command empty; output directory: `public`
3. Branches: `main` → production (auto-build on push), `dev` → preview (manual build)
4. Bind an ICP-filed custom domain

No service-related environment variables are required. The token-sharing endpoints read
`Client_ID` / `Client_Secret` (OAuth App for the Device Flow) when enabled.

The KV pool uses EdgeOne Pages KV: namespace `marketplace`, bound with the variable
name `marketplace` (functions access it as a global — it is not on env). Optional env
var `KV_QUOTA_MB`: set it to the namespace's real capacity (MB) and the home page shows
storage usage as a percentage; without it only absolute usage is shown.

## Roadmap

- [x] Migrate the shared GitHub token pool from the external tokenhub to an EdgeOne Pages KV pool hosted in this project (visitors can voluntarily share tokens on the page; the contributors page shows only masked stats — login / use count / remaining quota; raw tokens never leave the edge). **KV is provisioned and wired up (namespace `marketplace`); tokenhub stays as the fallback while the pool is empty.**
- [x] One-click token sharing via GitHub OAuth Device Flow: visitors click a button on the page, authorize a zero-scope OAuth App at github.com/login/device, and their token joins the pool automatically (no token ever touches the browser; per-visitor independent device codes; dead tokens auto-pruned via periodic revalidation)
- [x] Wire the Device Flow success path into the KV pool insert (deduped by login — a re-share updates the record in place; device-flow sessions live in KV too, reliable across isolates)
- [x] `GET /api/token/stats` — masked pool stats for the contributors page (login / use count / remaining / status, no raw tokens)
- [x] Edge cache for release assets: full requests only, oldest entries auto-evicted by file count, pure acceleration with no effect on correctness
- [ ] Admin endpoints `export` / `import` (AdminKey auth) for KV backup & restore (deferred)

## README

[中文文档](README.zh-CN.md)
