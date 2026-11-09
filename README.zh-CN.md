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
    └─ 文件类型黑名单（镜像 / 安装包 / 视频 / 虚拟机磁盘）          → 命中 403
        ▼
[3] URL 归一化与重映射
    ├─ 修复被折叠的协议头：https:/ → https://
    └─ raw.githubusercontent.com/<o>/<r>/<ref>/<path>
         透明改走官方 Contents API：
         api.github.com/repos/<o>/<r>/contents/<path>?ref=<ref>
         并附 Accept: application/vnd.github.raw（返回文件本体而非 JSON）
        ▼
[4] 边缘缓存查询（仅 release 资产，且请求不带 Range）
    ├─ 命中 → 直接返回缓存副本，x-cache: HIT（不触达上游）
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
    ├─ 可缓存的 release 资产（体积在上限内）：
    │   先写入边缘缓存，再回传，x-cache: MISS
    └─ 其余响应：逐字节流式透传，函数 CPU 不随文件体积增长
```

### 边缘缓存 / Edge cache

release 资产是 Marketplace 更新时最大、最集中的流量。本服务对这类下载做边缘侧缓存，
全自动、无需任何人工操作：

- **只缓存 release 资产**（`/releases/download/` 路径）。API 调用、页面与源码包不进缓存。
- **只缓存完整请求**。带 `Range` 头的断点续传请求直接转发上游，不读也不写缓存。
- **只缓存体积在上限内的文件**。超出上限的大文件一律流式透传——先整体读入内存会超出
  边缘函数的内存预算，反而拖垮下载。
- **容量按文件数管理**。写入新文件时若已达上限，自动删除最老的缓存项，无需人工清理。
- **响应头 `x-cache`** 标识本次结果：`HIT` 来自缓存，`MISS` 由上游取得并写入缓存。

缓存是纯加速层：任何缓存异常都会退化为直接访问上游，不影响下载本身的正确性。

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
  不会被试两次；最多换 4 次，仍不行则退回匿名调用。真正的权限 403（仓库被限制等）原样
  返回客户端，不会把整个池试一遍。
- **额度耗尽 ≠ 失效**：一小时配额用完的 token 只在本小时剩余时间内跳过，重置后自动回到
  候选；只有明确的 401 才在池内停用。个别 token 不可用不会让用户请求变成失败。
- **重映射 raw 文件会消耗共享池 API 配额**：raw 请求经 Contents API（认证）转发，
  这是 EdgeOne 出口唯一可靠的 raw 路径。
- **`/share/device/*` 端点**（token 共享页）代表页面访客与 GitHub OAuth Device Flow 通信；
  签发的 token 经 `/user` 验证后只留在服务端。
- **不提供任何对外发放 token 的端点**：token 明文绝不出边缘节点，服务在进程内直接取用
  池内 token（`lib/github-token.js` → `pickTokenRecord`），不存在可泄露 token 的 HTTP 接口。
- **`GET /api/token/stats`** 返回池的脱敏统计（login / 使用次数 / 最后已知的剩余额度 /
  状态）与存储用量（记录数 / 估算字节），供贡献者页与首页展示；不含 token 明文。
  `remaining` 是服务真正取用该 token 时记录的最后一个值，为了渲染这张表不会再额外
  探测——服务空闲时不产生任何 API 调用，页面始终显示最后一次已知数字。KV 的真实
  配额平台不向运行时暴露，
  在控制台把环境变量 `KV_QUOTA_MB` 设为命名空间实际容量后，页面才会显示百分比，
  未配置时只显示绝对用量。

### 透传与改写的边界 / Pass-through vs. rewriting

| 环节 | 行为 |
|---|---|
| URL 路径 | 服务前缀；解析内层 GitHub URL 后原样透传（白名单域名）或重映射（raw → Contents API） |
| 请求方法 | 原样透传 |
| 查询参数 | 原样透传（内层 URL 的查询参数随外层请求传递） |
| 请求体 | 流式透传，不做修改 |
| 响应状态码 | 原样透传 |
| 响应头 | 剥离逐跳头，附加 CORS，其余透传 |
| 响应体 | 逐字节流式透传；可缓存的 release 资产先写入边缘缓存再回传 |

## 请求要求

- 请求头 `User-Agent` 必须包含 `HomeAssistantMarketplace` 或 `HomeAssistant`
- 仅允许 Marketplace 流程实际使用的 GitHub 主机：`api.github.com`、`github.com`、`www.github.com`、`codeload.github.com`、`raw.githubusercontent.com`（改写为 Contents API）、`objects` / `release-assets` 资产 CDN
- 不放行 `gist.github.com` / `gist.githubusercontent.com`——HACS 与 Marketplace 不从 gist 取内容，白名单每多一个主机就多一块可被借道访问的面
- 每 IP 限流：600 次 / 小时

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

## 规划

- [x] 将共享 GitHub token 池从外部 tokenhub 迁移到本项目自建的 EdgeOne Pages KV 池（页面访客可自愿分享 token；贡献者页仅展示脱敏统计——账号名 / 使用次数 / 剩余额度；token 明文不出边缘节点）。**KV 已开通并完成接线（命名空间 `marketplace`）；tokenhub 保留为池空时的回退源。**
- [x] GitHub OAuth Device Flow 一键分享 token：访客点击页面按钮，在 github.com/login/device 授权一个零 scope 的 OAuth App，token 自动入池（token 不经过浏览器；每位访客独立设备码；失效 token 定期验活自动剔除）
- [x] Device Flow 成功后接入 KV 池入库（按 login 去重，重复分享原地更新 token；Device Flow 会话同样迁入 KV，跨 isolate 可靠）
- [x] `GET /api/token/stats` —— 贡献者页的脱敏池统计（login / 使用次数 / 剩余额度 / 状态，无 token 明文）
- [x] release 资产边缘缓存：只缓存完整请求、按文件数自动淘汰最老项，纯加速层不影响正确性
- [ ] 管理端点 `export` / `import`（AdminKey 鉴权），用于 KV 备份与恢复（暂缓）

## README

[English](README.md)
