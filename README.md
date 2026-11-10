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
    ├─ Repo blocklist (KV key `blocked_repos`, console-editable)         → 403 on match
    └─ File-type blocklist (disk images / installers / video / VM disks) → 403 on match
        ▼
[3] URL normalization & remapping
    ├─ Collapsed scheme repaired: https:/ → https://
    └─ raw.githubusercontent.com/<o>/<r>/<ref>/<path>
         is transparently remapped to the official Contents API
         api.github.com/repos/<o>/<r>/contents/<path>?ref=<ref>
         with Accept: application/vnd.github.raw (file bytes, not JSON)
        ▼
[4] Blob cache lookup (release assets only, no Range header)
    ├─ Key  = SHA-256 of the exact upstream URL; two Blob keys per entry:
    │        meta/<hash> (JSON: url / contentType / timestamp)
    │        body/<hash> (raw bytes, read back as arrayBuffer — text would corrupt it)
    ├─ Hit  → cached bytes returned directly, x-cache: HIT (upstream untouched)
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
    ├─ Cacheable release assets (2xx, no Range, ≤ 4 MB declared length):
    │   the whole body is buffered, written to Blob, and only then returned
    │   with x-cache: MISS — a fire-and-forget write would be dropped when the
    │   edge freezes the function right after the response is sent
    ├─ Upstream HTML: buffered too (a broken HTML stream over the EdgeOne egress
    │   surfaces as an opaque 545/504); retried once on a read failure
    └─ Everything else: streamed byte-for-byte — function CPU does not scale with size
```

### Blob cache / Blob 缓存

Release assets are the largest and most concentrated traffic of a Marketplace update, so
this service caches those downloads in EdgeOne Pages Blob. Fully automatic, no manual steps.

**What gets cached**

- **Only release assets** — the upstream URL must contain `/releases/download/`. API calls,
  HTML pages, source archives and asset-CDN URLs are never cached.
- **Only full requests** — a request carrying `Range` goes straight upstream and neither
  reads nor writes the cache. Resumable downloads therefore always see live bytes.
- **Only 2xx responses with a declared length of 0 < size ≤ 4 MB.** Caching needs the whole
  body in memory first; buffering a 19 MB release zip exceeds the edge memory/CPU budget and
  the edge answers 504 instead of speeding anything up. Large assets stream through with
  Range support intact.

**How an entry is stored**

Two Blob keys per cached URL, keyed by the SHA-256 of the exact upstream URL:

```
meta/<sha256>   JSON  { url, contentType, timestamp }
body/<sha256>   binary bytes
```

- `meta` is read back as `json`, `body` as `arrayBuffer`. The store's default read type is
  `text`, which decodes zip bytes as UTF-8 and corrupts them — the explicit `arrayBuffer`
  type is what keeps binary downloads byte-exact.
- Reads request strong consistency, so a record written on one node is visible immediately.
- The write completes **before** the response is returned. A fire-and-forget write is lost
  when the edge freezes the function as soon as the response is sent (observed: `MISS` on
  every single request), so the first `MISS` response waits for the Blob write to land.

**Capacity — managed by file count**

Store `github-cache`, cap `MAX_FILES = 50`. Before each write the store is listed under
`meta/`; when it is over the cap the oldest entries (by `timestamp`) are deleted, both
`meta/<hash>` and `body/<hash>`, until the count is back at the cap. Nothing to clean up by
hand, no size accounting to drift.

**Header and failure behaviour**

- `x-cache: HIT` — served from Blob, upstream untouched.
- `x-cache: MISS` — fetched upstream and written to Blob before returning.
- Any cache exception (read, write, list, eviction, missing binding) degrades silently to a
  direct upstream fetch. The cache is a pure acceleration layer: it can make a download
  faster, never wrong.

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
  A token is never tried twice within one request (4 pick attempts at most), after
  which the request falls back to an anonymous call. The rejection is also written back
  to KV immediately (401 → record disabled, 403 → freshness cleared so the next pick
  re-checks): otherwise the 10-minute freshness window would keep handing out the same
  dead token. A real permission 403 (restricted repo, forbidden resource) is returned to
  the client unchanged instead of burning through the pool.
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
- **Picks rotate instead of draining one contributor.** The token with the most
  remaining quota is preferred, but the score is jittered by ±250 (negligible against a
  5,000 quota). Near-equal tokens therefore take turns; a strict max would concentrate
  every request on whoever happens to be at the top.
- **Uses and remaining stay symmetric.** Every proxied request decrements the picked
  token's locally known `remaining` by one, so the contributors table does not show
  "1,200 calls but 4,900 left" between two GitHub snapshots.
- **`GET /api/token/stats`** returns masked pool stats (login / use count / last-known
  remaining quota / status) plus storage usage (record count / approximate bytes) for
  the contributors page and the home page. No raw tokens. `remaining` is refreshed by a
  **bounded proactive revalidation**: records stale for more than 10 minutes are probed
  via `/rate_limit` (which does NOT count against the core quota), at most 10 per call,
  each record at most once per freshness window (written back to KV), so repeatedly
  requesting this endpoint cannot hammer GitHub. A record whose probe fails as
  `unreachable` keeps its previous value untouched. EdgeOne does not expose the real KV
  quota to the runtime — set the `KV_QUOTA_MB` env var to the namespace's actual cap to
  get a percentage; without it only absolute usage is shown.
- **Saving a shared token is not best-effort.** A Device Flow token is persisted with up
  to 4 write attempts and a read-back verification after each; the flow is reported as
  complete only after the record is verifiably readable. If the write still fails, the
  session is kept and the next page poll retries the insert with the same token (it is
  never re-requested from GitHub, which would return `expired` and lose the
  authorization). Only after repeated failures does the page show an error.
- **A failed `/user` lookup never discards a token.** The visitor completed the
  authorization; EdgeOne egress to `api.github.com` is intermittent. The record is stored
  keyed by a token-derived key and the login is attributed later; only a definite 401
  during the request means the token is truly invalid.

### Transparent pass-through vs. rewriting / 透传与改写

| Aspect | Behavior |
|---|---|
| URL path | Service-style prefix; the inner GitHub URL is parsed, then either passed through as-is (allowlist hosts) or remapped (raw → Contents API) |
| Method | Passed through unchanged |
| Query string | Passed through (the outer request's search rides on the inner URL) |
| Request body | Streamed through unchanged |
| Response status | Passed through unchanged |
| Response headers | Hop-by-hop stripped; CORS added; the rest passed through |
| Response body | Streamed through byte-for-byte; cacheable release assets (≤ 4 MB, full requests) are buffered, written to Blob, then returned |

## Requirements

- `User-Agent` must contain `HomeAssistantMarketplace` or `HomeAssistant`
- Only the GitHub hosts the Marketplace flow actually uses — 7 in total: `api.github.com`, `github.com`, `www.github.com`, `codeload.github.com`, `raw.githubusercontent.com` (remapped to the Contents API), `objects.githubusercontent.com`, `release-assets.githubusercontent.com`. Every redirect hop is checked against the same set.
- `gist.github.com` / `gist.githubusercontent.com` are NOT allowed — HACS and the Marketplace never fetch gist content, and every extra host is one more surface reachable through the service
- Per-IP rate limit: 600 requests/hour

### Repo blocklist / 仓库排除名单

Requests targeting a blocked repository are rejected with 403 before any upstream call —
covering release downloads, source archives, raw files, API calls and asset-CDN redirects
for that repo. The list lives in KV, so you edit it in the console, no redeploy:

- **Key**: `blocked_repos` in the `marketplace` KV namespace
- **Value**: a JSON array of patterns (case-insensitive)

```json
[
  "owner/bad-repo",
  "spam-user/*"
]
```

- `owner/repo` blocks that whole repository (every URL form).
- `owner/*` blocks every repository under that owner.

**Semantics**

- Edits take effect within **60 seconds** (per-isolate cache; at most one KV read per 60 s
  per isolate, so the per-request cost is one in-memory array scan).
- A missing, empty or malformed key means **nothing is blocked** — a broken list can never
  take the service down. Any KV read error degrades the same way.
- The check runs before the cache lookup and before any upstream hop: a blocked repo
  generates no upstream traffic at all.
- To stop blocking a repo, remove the entry (or the whole key) — again effective within
  60 seconds.

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

The release-asset cache uses EdgeOne Pages Blob, store name `github-cache`, created and
bound in the same place as KV (Blob is read through `getStore("github-cache")`, not
through an env var or a global). No manual provisioning of keys, sizes or expiry: the
store keeps at most 50 entries and evicts the oldest on write. `@edgeone/pages-blob` is
an npm dependency (`^0.0.18`) and must be a **static top-level import** — a dynamic
`import()` inside the request path crashes the whole edge function, which surfaces as a
site-wide 545 rather than a cache miss.

## Roadmap

- [x] Migrate the shared GitHub token pool from the external tokenhub to an EdgeOne Pages KV pool hosted in this project (visitors can voluntarily share tokens on the page; the contributors page shows only masked stats — login / use count / remaining quota; raw tokens never leave the edge). **KV is provisioned and wired up (namespace `marketplace`); tokenhub stays as the fallback while the pool is empty.**
- [x] One-click token sharing via GitHub OAuth Device Flow: visitors click a button on the page, authorize a zero-scope OAuth App at github.com/login/device, and their token joins the pool automatically (no token ever touches the browser; per-visitor independent device codes; dead tokens auto-pruned via periodic revalidation)
- [x] Wire the Device Flow success path into the KV pool insert (deduped by login — a re-share updates the record in place; device-flow sessions live in KV too, reliable across isolates)
- [x] `GET /api/token/stats` — masked pool stats for the contributors page (login / use count / remaining / status, no raw tokens)
- [x] Blob cache for release assets: SHA-256 keyed `meta`/`body` pair, binary-exact reads, write-before-respond, full requests ≤ 4 MB only, oldest entries auto-evicted by file count, pure acceleration with no effect on correctness
- [x] Weighted rotation across pooled tokens — near-equal tokens take turns instead of one contributor absorbing all traffic; every proxied request decrements that token's locally known remaining quota
- [x] Guaranteed token persistence in the Device Flow — retried writes with read-back verification, session kept and re-inserted on failure, so an authorization is never reported as failed when it could still land
- [x] Console-editable repo blocklist — KV key `blocked_repos`, `owner/repo` or `owner/*` patterns, 403 before any upstream call, 60 s cache, safe-degrade on missing/broken key
- [ ] Admin endpoints `export` / `import` (AdminKey auth) for KV backup & restore (deferred)

## README

[中文文档](README.zh-CN.md)
