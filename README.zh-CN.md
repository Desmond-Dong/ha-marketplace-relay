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
[1] 门禁层（不涉及任何环境变量）
    ├─ User-Agent 必须含 "HomeAssistantMarketplace"，否则 403
    └─ 目标域名必须在 GitHub 白名单内，否则 403
        ▼
[2] URL 归一化与重映射
    ├─ 修复折叠的协议头：https:/ → https://
    └─ raw.githubusercontent.com/<o>/<r>/<ref>/<path>
         被透明重映射到官方 Contents API：
         api.github.com/repos/<o>/<r>/contents/<path>?ref=<ref>
         并附 Accept: application/vnd.github.raw（返回文件本体而非 JSON）
        ▼
[3] 组装上游请求
    ├─ 显式设置 Host 头为目标域名（EdgeOne 运行时按 Host 路由，
    │   缺失会导致所有上游请求失败）
    ├─ 剥离逐跳头与客户端的 authorization 头
    └─ fetch() 使用 redirect: follow；body 流式转发
        ▼
[4] 上游：仅 GitHub 官方域名（白名单）
    ├─ api.github.com        — API 调用；此处附加共享池 token
    ├─ github.com            — 页面与 release 下载（302 → objects CDN，匿名）
    ├─ codeload.github.com   — 源码包（匿名）
    ├─ objects.githubusercontent.com — release 资产 CDN（匿名）
        ▼
[5] 响应回传客户端
    ├─ 状态码原样透传（GitHub 的 404 就是 404）
    ├─ 剥离逐跳头；支持 Range 断点（206）
    └─ body 流式转发——函数 CPU 不随文件体积增长
```

### 共享 token 用在哪里 / Token usage

- **仅 `api.github.com` 请求附加 token。** 从共享池取一个 token，以
  `Authorization: Bearer <token>` 附加，把限额从 60 次/时提升到 5,000 次/时。
  token 只存在于边缘函数内存中（缓存 30 分钟；被拒立即作废，下个请求自动换新）。
  token 明文永不下发客户端、不写日志、不用于下载类端点。
- **下载类端点保持匿名**（不消耗 API 配额）：release 下载、源码包、objects CDN。
- **重映射 raw 文件会消耗共享池 API 配额**：raw 请求经 Contents API（认证）转发，
  这是 EdgeOne 出口唯一可靠的 raw 路径。
- **`/share/device/*` 端点**（token 共享页）代表页面访客与 GitHub OAuth Device Flow 通信；
  签发的 token 经 `/user` 验证后只留在服务端。
- **`GET /api/token/get`** 返回一条池内记录，JSON 结构与 `tokenhub.hacs.vip/api/token/get`
  完全一致（`{"data": {...}}`，含 `id` / `created_at` / `updated_at` / `type` / `login` /
  `token` / `use_count` / `remaining` / `expired_at` / `deleted_at` / `usage`），现有消费方
  只改 URL 即可切换。数据源为本项目自建 KV 池（命名空间 `marketplace`），池空或 KV 异常
  时回退 tokenhub。token 定期经 `rate_limit` 验活，返回剩余额度最高的一条。
- **`GET /api/token/stats`** 返回池的脱敏统计（login / 使用次数 / 最近验活的剩余额度 /
  状态）与存储用量（记录数 / 估算字节），供贡献者页与首页展示；不含 token 明文，
  `remaining` 只在保鲜期内有值、绝不过期展示。KV 的真实配额平台不向运行时暴露，
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
| 响应体 | 逐字节流式透传 |

## 请求要求

- 请求头 `User-Agent` 必须包含 `HomeAssistantMarketplace`
- 仅允许 `github.com` 及其子域

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
- [x] `GET /api/token/get` —— 与 tokenhub 结构完全一致的池端点（自建 KV 池优先，tokenhub 回退）
- [x] Device Flow 成功后接入 KV 池入库（按 login 去重，重复分享原地更新 token；Device Flow 会话同样迁入 KV，跨 isolate 可靠）
- [x] `GET /api/token/stats` —— 贡献者页的脱敏池统计（login / 使用次数 / 剩余额度 / 状态，无 token 明文）
- [ ] 管理端点 `export` / `import`（AdminKey 鉴权），用于 KV 备份与恢复（暂缓）

## README

[English](README.md)
