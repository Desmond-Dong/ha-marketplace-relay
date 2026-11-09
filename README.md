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
[1] Gatekeeping (no env vars involved)
    ├─ User-Agent must contain "HomeAssistantMarketplace"  → 403 otherwise
    └─ Target host must be in the GitHub allowlist         → 403 otherwise
        ▼
[2] URL normalization & remapping
    ├─ Collapsed scheme repaired:  https:/ → https://
    └─ raw.githubusercontent.com/<o>/<r>/<ref>/<path>
         is transparently remapped to the official Contents API
         api.github.com/repos/<o>/<r>/contents/<path>?ref=<ref>
         with Accept: application/vnd.github.raw (file bytes, not JSON)
        ▼
[3] Upstream request assembly
    ├─ Explicit Host header set to the target host (the EdgeOne runtime
    │   routes by Host; omitting it fails every upstream call)
    ├─ Hop-by-hop headers and client "authorization" stripped
    └─ fetch() with redirect: follow; body is streamed through
        ▼
[4] Upstream: GitHub official hosts only (allowlist)
    ├─ api.github.com        — API calls; a shared-pool token is attached here
    ├─ github.com            — pages & release downloads (302 → objects CDN, anonymous)
    ├─ codeload.github.com   — source archives (anonymous)
    ├─ objects.githubusercontent.com — release asset CDN (anonymous)
        ▼
[5] Response back to the client
    ├─ Status code is passed through unchanged (GitHub's 404 stays 404)
    ├─ Hop-by-hop headers stripped; Range requests supported (206)
    └─ Body streamed — function CPU does not scale with file size
```

### Where the shared token is used / Token usage

- **`api.github.com` requests only.** A token drawn from the shared pool is attached as
  `Authorization: Bearer <token>` to lift the rate limit from 60 to 5,000 requests/hour.
  The token lives only inside the edge function's memory (30-minute cache; a rejected
  token is dropped immediately and the next request fetches a fresh one).
  Raw tokens are never sent to the client, never logged, and never used for download
  endpoints.
- **Download endpoints stay anonymous for public repos** (they don't consume the
  API quota): release downloads, source archives, and the objects CDN.
- **Note on remapped raw files:** although raw.githubusercontent.com itself serves
  anonymous downloads for public repos, this service remaps raw requests to the
  Contents API (api.github.com), so those requests DO consume the shared pool's
  authenticated API quota. Direct raw downloads through the service would fail anyway
  (EdgeOne egress cannot reach raw's Fastly hosts).
- **`/share/device/*` endpoints** (token sharing page) talk to GitHub's OAuth Device
  Flow on behalf of the visitor; the issued token is validated via `/user` and stays
  on the server side.
- **`GET /api/token/get`** returns one pool record in the same JSON shape as
  `tokenhub.hacs.vip/api/token/get` (`{"data": {...}}` with `id` / `created_at` /
  `updated_at` / `type` / `login` / `token` / `use_count` / `remaining` / `expired_at` /
  `deleted_at` / `usage`), so existing consumers switch by changing the URL only.
  Primary source is this project's own KV pool (namespace `marketplace`); it falls
  back to tokenhub while the pool is empty. Tokens are revalidated against
  `rate_limit` and the entry with the most remaining quota wins.
- **`GET /api/token/stats`** returns masked pool stats (login / use count / last-known
  remaining quota / status) plus storage usage (record count / approximate bytes) for
  the contributors page and the home page. No raw tokens; `remaining` is only present
  within the freshness window and never shown stale. EdgeOne does not expose the real
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
| Response body | Streamed through, byte-for-byte |

## Requirements

- `User-Agent` must contain `HomeAssistantMarketplace`
- Only `github.com` and its subdomains are allowed

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
- [x] `GET /api/token/get` — tokenhub-compatible pool endpoint (same JSON shape; self-hosted KV pool primary, tokenhub fallback)
- [x] Wire the Device Flow success path into the KV pool insert (deduped by login — a re-share updates the record in place; device-flow sessions live in KV too, reliable across isolates)
- [x] `GET /api/token/stats` — masked pool stats for the contributors page (login / use count / remaining / status, no raw tokens)
- [ ] Admin endpoints `export` / `import` (AdminKey auth) for KV backup & restore (deferred)

## README

[中文文档](README.zh-CN.md)
