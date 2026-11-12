# ha-marketplace-relay / Home Assistant Marketplace 服务桥接

运行在 EdgeOne Pages 边缘节点的 Home Assistant Marketplace 服务桥接。

## 用法

把完整 GitHub URL 拼在本服务域名后面即可：

```
https://<your-domain>/https://api.github.com/rate_limit
https://<your-domain>/https://github.com/owner/repo/releases/download/v1.0.0/asset.zip
https://<your-domain>/https://raw.githubusercontent.com/owner/repo/main/file.txt
```

## 请求流程 / 从请求到响应

```
Home Assistant Marketplace
        │  GET https://<域名>/https://api.github.com/…
        ▼
[1] 边缘函数入口
    ├─ OPTIONS              → 204（CORS 预检）
    ├─ /share/device/*      → 设备码流程处理器
    ├─ /api/token/stats     → 脱敏池统计
    └─ 其他非服务路径       → 静态页面；无匹配则 404
        ▼  /https://… 形式的服务请求
[2] 门禁层（不涉及任何凭据）
    ├─ User-Agent 含 "HomeAssistantMarketplace" 或 "HomeAssistant"   → 否则 403
    ├─ 每 IP 600 次 / 小时（滑动窗口）                              → 超出 429
    ├─ 目标域名必须在 GitHub 官方白名单内                           → 否则 403
    ├─ 仓库排除名单（KV 键 `blocked_repos`，控制台可编辑）          → 命中 403
    └─ 文件类型黑名单（镜像 / 安装包 / 视频 / 虚拟机磁盘）          → 命中 403
        ▼
[3] URL 归一化与重映射
    ├─ 修复被折叠的协议头：https:/ → https://
    └─ raw.githubusercontent.com/<o>/<r>/<ref>/<path>
         透明改走官方 Contents API：
         api.github.com/repos/<o>/<r>/contents/<path>?ref=<ref>
         并附 Accept: application/vnd.github.raw（返回文件本体而非 JSON）
        ▼
[4] Blob 缓存查询（仅 release 资产，且请求不带 Range）
    ├─ 键 = 精确上游 URL 的 SHA-256；每条缓存两个 Blob 键：
    │      meta/<hash>（JSON：url / contentType / timestamp）
    │      body/<hash>（原始字节，必须按 arrayBuffer 读回——按 text 读会破坏二进制）
    ├─ 命中 → 直接返回缓存字节，x-cache: HIT（不触达上游）
    └─ 未命中 → 继续走上游
        ▼
[5] 上游请求
    ├─ 显式设置 Host 头为目标域名（EdgeOne 运行时按 Host 路由，
    │   缺失会导致所有上游请求失败）
    ├─ 剥离逐跳头与客户端自带的 authorization
    ├─ api.github.com 请求附加共享池 token（下载类端点保持匿名）
    └─ redirect: manual + 逐跳白名单校验（最多 5 跳）
        ▼
[6] 上游：仅 GitHub 官方域名
    ├─ api.github.com                — API；此处使用共享池 token
    ├─ github.com                    — 页面与 release 下载（302 → 资产 CDN）
    ├─ codeload.github.com           — 源码包
    └─ objects / release-assets      — release 资产 CDN
        ▼
[7] 回传客户端
    ├─ 状态码原样透传（GitHub 的 404 就是 404）
    ├─ 剥离逐跳头；附 CORS；支持 Range 断点（206）
    ├─ 可缓存的 release 资产（2xx、无 Range、声明长度 ≤ 4MB）：
    │   整体读入内存 → 写入 Blob → 才回传，x-cache: MISS。
    │   写入必须在响应前完成：fire-and-forget 的写会在响应发出后函数被
    │   冻结时丢失（实测每次都是 MISS）
    ├─ 上游 HTML：同样整体缓冲（EdgeOne 出口上的 HTML 流中断会表现为不透明的
    │   545 / 504），读取失败整体重试一次
    └─ 其余响应：逐字节流式透传，函数 CPU 不随文件体积增长
```

### Blob 缓存 / Blob cache

release 资产是 Marketplace 更新时最大、最集中的流量，本服务把这类下载缓存在
EdgeOne Pages Blob 中，全自动、无需任何人工操作。

**缓存什么**

- **只缓存 release 资产**——上游 URL 必须含 `/releases/download/`。API 调用、
  HTML 页面、源码包与资产 CDN 链接一律不进缓存。
- **只缓存完整请求**——带 `Range` 的请求直接转发上游，既不读也不写缓存，
  断点续传永远拿到真实字节。
- **只缓存 2xx 且声明长度 0 < size ≤ 4MB 的响应。** 写缓存必须先把整个 body
  读入内存；把 19MB 的 release zip 缓冲下来会超出边缘内存/CPU 预算，边缘直接
  返回 504，不是加速而是拖垮。大文件走流式，Range 能力不变。

**一条缓存怎么存**

每个 URL 两个 Blob 键，键名取自精确上游 URL 的 SHA-256：

```
meta/<sha256>   JSON   { url, contentType, timestamp }
body/<sha256>   二进制字节
```

- `meta` 按 `json` 读、`body` 按 `arrayBuffer` 读。存储默认读类型是 `text`，
  会把 zip 字节按 UTF-8 解码破坏——显式的 `arrayBuffer` 是二进制下载保持
  字节一致的关键。
- 读取请求强一致性，一个节点写入的记录立即可见。
- 写入在**响应返回之前**完成。fire-and-forget 的写会在响应发出后函数被冻结时
  丢失（实测表现为每次请求都是 `MISS`），所以第一次 `MISS` 响应会等 Blob
  写入落盘再回。

**容量——按文件数管理**

store 名 `github-cache`，上限 `MAX_FILES = 50`。每次写入前列出 `meta/` 前缀，
超过上限时按 `timestamp` 从老到新删除，同时删 `meta/<hash>` 与 `body/<hash>`，
直到数量回到上限。无需人工清理，也不做体积记账（list 不返回 size）。

**响应头与失败行为**

- `x-cache: HIT`——来自 Blob，未触达上游。
- `x-cache: MISS`——从上游取得并在返回前写入 Blob。
- 任何缓存异常（读、写、list、淘汰、绑定缺失）都静默退化为直接访问上游。
  缓存是纯加速层：只能让下载更快，绝不会让下载出错。

### 上游可用性 / Upstream resilience

- EdgeOne 节点到 `github.com`、`api.github.com` 的连通性偶发抖动。主链路遇到瞬时失败
  会重试一次；设备码流程对 GitHub 的三次调用各自带退避重试。
- 重定向不盲目跟随：每一跳都校验白名单，越界即拒绝，防止任何上游开放重定向被利用。

### 共享 token 用在哪里 / Token usage

- **仅 `api.github.com` 请求附加 token。** 从共享池取一个 token，以
  `Authorization: Bearer <token>` 附加，把限额从 60 次/时提升到 5,000 次/时。
  token 只存在于边缘函数内存中（缓存 30 分钟；被拒立即作废，下个请求自动换新）。
  token 明文永不下发客户端、不写日志、不用于下载类端点。
- **下载类端点保持匿名**（不消耗 API 配额）：release 下载、源码包、objects CDN。
- **token 不可用时自动换新并重试**：`api.github.com` 返回 401（被吊销）或 403 且确实是额度
  用尽时，服务丢弃这枚 token、立即换池内下一枚并重试同一请求，同一枚 token 在一次请求内
  不会被试两次（最多取用 4 次），仍不行则退回匿名调用。这次拒绝同时立即回写 KV
  （401 → 记录停用；403 → 清保鲜期让下次选取强制复检）：否则 10 分钟的保鲜窗口内会
  持续发出同一枚失效 token。真正的权限 403（仓库被限制等）原样返回客户端，不会把
  整个池试一遍。
- **额度耗尽 ≠ 失效**：一小时配额用完的 token 只在本小时剩余时间内跳过，重置后自动回到
  候选；只有明确的 401 才在池内停用。个别 token 不可用不会让用户请求变成失败。
- **重映射 raw 文件会消耗共享池 API 配额**：raw 请求经 Contents API（认证）转发，
  这是 EdgeOne 出口唯一可靠的 raw 路径。
- **`/share/device/*` 端点**（token 共享页）代表页面访客与 GitHub OAuth Device Flow 通信；
  签发的 token 经 `/user` 验证后只留在服务端。
- **不提供任何对外发放 token 的端点**：token 明文绝不出边缘节点，服务在进程内直接取用
  池内 token（`lib/github-token.js` → `pickTokenRecord`），不存在可泄露 token 的 HTTP 接口。
- **选取是轮换而非打穿单个贡献者**：优先剩余额度最高的 token，但评分加 ±250 抖动
  （相对 5000 的额度微不足道）。额度相近的 token 因此轮流出勤；严格取最大会把每个
  请求都压在恰好排在首位的那个人身上。
- **使用次数与剩余次数共用同一个小时窗**：每次服务请求把中选 token 本地已知的
  `remaining` 减一；`use_count` 只统计当前小时窗——GitHub 在小时边界重置配额时计数
  也同步归零，因此「本小时调用 + 本小时剩余」恒 ≤ 5000（差额是 token 主人在本服务
  之外用同一 token 消耗的部分）。
- **`GET /api/token/stats`** 返回池的脱敏统计（login / 本小时调用数 / 最后已知的剩余额度 /
  状态）与存储用量（记录数 / 估算字节），供贡献者页与首页展示；不含 token 明文。
  `remaining` 由**受限的主动验活**刷新：超过 10 分钟未验的记录会用 `/rate_limit`
  探一次（该端点不计入核心配额），每次调用最多 10 条、每条在每个保鲜窗口内最多
  探一次（结果回写 KV），因此狂刷此端点也不会狂打 GitHub。探测结果为
  `unreachable` 时保持原值不动。KV 的真实配额平台不向运行时暴露，在控制台把
  环境变量 `KV_QUOTA_MB` 设为命名空间实际容量后，页面才会显示百分比，未配置时
  只显示绝对用量。
- **分享的 token 不是「尽力而为」地保存**：Device Flow 拿到的 token 最多重试 4 次
  写入，每次写入后回读校验；只有记录确认可读才向页面报告完成。若仍然写不进去，
  会话保留，下一次页面轮询用同一枚 token 重试入库（不会重新向 GitHub 取 token——
  那只会得到 `expired`，把授权彻底丢掉）。连续多次失败后页面才显示错误。
- **`/user` 查询失败绝不丢弃 token**：访客已经完成授权，而 EdgeOne 出口到
  `api.github.com` 偶发抖动。此时按 token 派生键入库，login 留待后续补充；只有请求
  过程中明确的 401 才算 token 真失效。

### 透传与改写的边界 / Pass-through vs. rewriting

| 环节 | 行为 |
|---|---|
| URL 路径 | 服务前缀；解析内层 GitHub URL 后原样透传（白名单域名）或重映射（raw → Contents API） |
| 请求方法 | 原样透传 |
| 查询参数 | 原样透传（内层 URL 的查询参数随外层请求传递） |
| 请求体 | 流式透传，不做修改 |
| 响应状态码 | 原样透传 |
| 响应头 | 剥离逐跳头，附加 CORS，其余透传 |
| 响应体 | 逐字节流式透传；可缓存的 release 资产（≤ 4MB 的完整请求）整体缓冲、写入 Blob 后再回传 |

## 返回码速查

所有 JSON 错误响应统一为 `{"error":"<code>"}` 并带 CORS 头；成功响应逐字节透传自 GitHub
（或由 Blob 缓存直接回源）。所有门禁拒绝刻意共用同一个响应体——服务不透露具体是哪道门拦的。

### 服务请求（`/https://…`）

| 状态码 | 含义 | 产生方 |
|---|---|---|
| 200 | 成功，完整 body。缓存命中同样是 200——`x-cache: HIT` / `MISS` 头区分来源 | 服务 / 上游 |
| 204 | CORS 预检（`OPTIONS`） | 服务 |
| 206 | `Range` 断点续传的部分内容 | 透传 |
| 403 | `{"error":"not allowed"}`——以下之一：UA 门禁未过（UA 不含 `HomeAssistant`）、目标域名不在 7 域名白名单、仓库命中 `blocked_repos`、严格模式下仓库不在 `allow_repos`、文件类型黑名单命中、GitHub 自身的权限 403（原样透传） | 门禁 / 上游 |
| 404 | `{"error":"not found"}`——GitHub 判定仓库 / 分支 / 文件不存在（原样透传）；或服务路径且无匹配静态页 | 上游 / 服务 |
| 429 | `{"error":"too many requests"}`——每 IP 限流（600 次 / 时），或共享池重试后 GitHub 配额仍然耗尽（透传） | 服务 / 上游 |
| 500 | 仅诊断用——请求带 `x-diag: 1` 头时返回真实错误信息（临时手段，后续移除） | 服务 |
| 502 | `{"error":"upstream error"}`——上游请求失败、重定向跳出白名单、或未捕获的内部错误（所有异常都收拢到这里） | 服务 |
| 545 | EdgeOne 的不透明「script error」。正常情况下不该出现——所有 handler 错误都会映射为 502；若见到即为平台级问题（冷启动 / 打包），与客户端无关 | 平台 |

其余上游状态码原样透传（301/302 在内部由重定向处理器消费，客户端不会直接看到）。

### 辅助端点

| 端点 | 成功 | 错误 |
|---|---|---|
| `POST /share/device/start` | `200 {user_code, verification_uri, expires_in, interval}` | `403 not allowed`（缺 host 头）· `429 too many requests`（start 限流）· `502 upstream error` · `503 service unavailable`（OAuth 应用未配置） |
| `POST /share/device/poll` | `200 {status: pending \| ok \| expired \| denied}`——`ok` 附带 `login` / `avatar_url` / `stored`；中间态标记：`slow_down`、`storing`、`reused` | `403 not allowed` · `404 not found`（session 格式非法）· `502 upstream error` / `storage unavailable` · `503 service unavailable` |
| `GET /api/token/stats` | `200` 脱敏共享池统计（无任何 token 明文） | `502 {"error":"kv error"}` |

`/https://…` 前缀之外的路径回落到静态页面（首页 / 贡献者 / 共享 Token）；无匹配页面时返回
`404 {"error":"not found"}`。

## 请求要求

- 请求头 `User-Agent` 必须包含 `HomeAssistantMarketplace` 或 `HomeAssistant`
- 仅允许 Marketplace 流程实际使用的 GitHub 主机，共 7 个：`api.github.com`、`github.com`、`www.github.com`、`codeload.github.com`、`raw.githubusercontent.com`（改写为 Contents API）、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`。重定向的每一跳都按同一集合校验。
- 不放行 `gist.github.com` / `gist.githubusercontent.com`——HACS 与 Marketplace 不从 gist 取内容，白名单每多一个主机就多一块可被借道访问的面
- 每 IP 限流：600 次 / 小时

### 仓库排除名单 / Repo blocklist

命中排除名单的仓库请求在任何上游调用之前即被 403 拒绝——覆盖该仓库的 release 下载、
源码包、raw 文件、API 调用与资产 CDN 重定向。名单存于 KV，直接在控制台编辑，
无需重新部署：

- **键**：`marketplace` KV 命名空间里的 `blocked_repos`
- **值**：JSON 数组，模式不区分大小写

```json
[
  "owner/bad-repo",
  "spam-user/*"
]
```

- `owner/repo`——排除该仓库的全部请求形态。
- `owner/*`——排除该 owner 名下所有仓库。
- 通配符：含 `*` 的模式对完整 `owner/repo` 字符串匹配——`*vpn*`（子串）、`nvidia*`（前缀）、
  `*vpn`（后缀）；不区分大小写。写坏的模式只会被跳过，不会致命。

**语义**

- 编辑后 **60 秒**内生效（isolate 内缓存；每 isolate 每 60 秒最多读一次 KV，
  单请求成本只是一次内存数组比对）。
- 键缺失、为空或格式非法 = **不排除任何仓库**——写坏名单绝不会拖垮服务；
  KV 读取异常同样安全降级。
- 检查发生在缓存查询与任何上游跳之前：被排除仓库不产生任何上游流量。
- 想恢复某仓库，删除对应条目（或整个键）即可，同样 60 秒内生效。

## 部署

1. 在 EdgeOne Makers 连接本仓库，加速区域选「全球可用区（含中国大陆）」
2. 构建命令留空，输出目录 `public`
3. 分支：`main` 对应生产环境（push 自动构建），`dev` 对应预览环境（手动构建）
4. 绑定已备案的自定义域名

服务本身无需任何环境变量。启用 token 共享端点时，函数读取
`Client_ID` / `Client_Secret`（Device Flow 用的 OAuth App）。

KV 池使用 EdgeOne Pages KV：命名空间 `marketplace`，绑定变量名同为
`marketplace`（函数以全局变量访问，不在 env 上）。可选环境变量
`KV_QUOTA_MB`：设为 KV 命名空间的实际容量（MB），首页即按百分比显示存储
用量；不设置则只显示绝对用量。

release 资产缓存使用 EdgeOne Pages Blob：store 名 `github-cache`，与 KV 在同一处
创建并绑定（Blob 通过 `getStore("github-cache")` 访问，不走环境变量也不走全局）。
键、体积、过期都无需手工配置：store 最多保留 50 条，写入时自动淘汰最老项。
`@edgeone/pages-blob` 是 npm 依赖（`^0.0.18`），必须以**静态顶层 import** 引入——
在请求路径里用动态 `import()` 会让整个边缘函数崩溃，表现为全站 545 而不是缓存未命中。

## 规划

- [x] 将共享 GitHub token 池从外部 tokenhub 迁移到本项目自建的 EdgeOne Pages KV 池（页面访客可自愿分享 token；贡献者页仅展示脱敏统计——账号名 / 使用次数 / 剩余额度；token 明文不出边缘节点）。**KV 已开通并完成接线（命名空间 `marketplace`）；tokenhub 保留为池空时的回退源。**
- [x] GitHub OAuth Device Flow 一键分享 token：访客点击页面按钮，在 github.com/login/device 授权一个零 scope 的 OAuth App，token 自动入池（token 不经过浏览器；每位访客独立设备码；失效 token 定期验活自动剔除）
- [x] Device Flow 成功后接入 KV 池入库（按 login 去重，重复分享原地更新 token；Device Flow 会话同样迁入 KV，跨 isolate 可靠）
- [x] `GET /api/token/stats` —— 贡献者页的脱敏池统计（login / 使用次数 / 剩余额度 / 状态，无 token 明文）
- [x] release 资产 Blob 缓存：SHA-256 键的 `meta`/`body` 双键、二进制精确读写、响应前写入、只缓存 ≤ 4MB 的完整请求、按文件数自动淘汰最老项，纯加速层不影响正确性
- [x] 共享 token 加权轮换——额度相近的 token 轮流出勤，不再由单个贡献者吸收全部流量；每次服务请求同步扣减该 token 本地已知的剩余额度
- [x] Device Flow 入库保证——写入重试 + 回读校验，失败时保留会话并重新入库，绝不把还能落盘的授权报成失败
- [x] 控制台可编辑的仓库排除名单——KV 键 `blocked_repos`，支持 `owner/repo` 与 `owner/*`，在上游调用前 403，60 秒缓存，键缺失/损坏安全降级
- [ ] 管理端点 `export` / `import`（AdminKey 鉴权），用于 KV 备份与恢复（暂缓）

## README

[English](README.md)
