# 外部站点监测：独立探针与签名证据链

## 当前结论

本实现已经提供可部署的独立 Node.js 探针、HMAC 摄取端点、append-only 数据库 RPC、管理员只读端点和独立 React 面板，但当前本地状态仍是**未激活**。`20261003113000_external_site_monitor_ingestion.sql` 尚未应用，独立主机调度器、摄取密钥和真实外部样本也尚未配置，因此不能宣称 production external monitoring ready。

应用后台只读取已回传证据，绝不从应用服务器内部访问自己后再把 HTTP 200 冒充外部可用性。

## 影响链

1. 业务、数据与权限：独立主机执行只读探测；HMAC 专用密钥只允许探针写入；管理员以 `logs.view` 读取，不允许普通管理员伪造探针。
2. 组件：`ExternalSiteMonitorPanel` 显示 DNS、TLS、HTTPS、静态资源和登录入口 DOM；缺失来源显示 unavailable。
3. 样式：组件私有 CSS Module，深色指挥中心风格；最小字号 12px；支持 reduced-motion。
4. 路由：摄取为 `/api/internal/external-site-monitor/ingest`；读取为 `/api/admin/external-site-monitor`。
5. 存储与升级：复用 `domain_tls_probes` 的 append-only 证据表和 `domain_release_audits`；新迁移只添加 SECURITY DEFINER RPC，不改 Host 路由、DNS 或证书。

## 外部探针范围

每次运行最多执行：

- DNS：A/AAAA 解析，仅持久化数量和地址集合 SHA-256，不回传原始 IP。
- TLS：从经过公共地址校验并固定的 IP 握手，保留协议、证书指纹、SAN 集合摘要和到期时间。
- HTTPS：首页状态、延迟、内容类型和有限字节数；不保存响应正文。
- 静态资源：显式白名单或首页发现的同源脚本、样式、图标，最多 8 项。
- 登录入口：检查服务端 HTML 中的关键 DOM 文字或属性，默认 `/admin/superzhujunguo`；不输入账号密码、不登录、不提交表单。

“服务端 HTML DOM 通过”只能证明服务端响应中存在这些标记。它不证明客户端 JavaScript 已执行、React 已水合或登录交互可用。未来如需要浏览器级合成监控，应使用隔离的 Playwright worker，并采用更低频率和独立资源预算，不能篡改当前证据语义。

## SSRF 与出站边界

- CLI 不接受 `--target-origin` 或 `--ingest-endpoint` 任意 URL 参数。探测目标和摄取端点必须来自部署主机上的版本化配置白名单。
- DNS 解析后拒绝 loopback、RFC1918、CGNAT、link-local、文档地址、ULA、multicast 和其他 reserved 地址。
- TLS 和 HTTPS 请求固定到已经校验的公共 IP，并保留原始域名作为 SNI/证书校验名。
- HTTPS 只允许同域、同协议重定向；跨域重定向直接失败。
- 离线 fixture 与配置校验不会访问网络；本实现没有允许私网目标的生产开关。

## HMAC、重放和写入权限

摄取请求必须包含：

- `X-External-Probe-Timestamp`
- `X-External-Probe-Nonce`
- `X-External-Probe-Signature: v1=<hex>`
- `X-External-Probe-Key-Id`

签名输入为 `timestamp + "." + nonce + "." + sha256(rawBody)`。服务器使用 timing-safe compare，并拒绝超过 5 分钟的时间偏差。`keyId + timestamp + nonce` 生成耐久幂等键，数据库唯一约束阻止跨进程、跨实例重放；同一键不同证据视为碰撞并拒绝。

`EXTERNAL_SITE_MONITOR_INGEST_SECRET` 必须只存在于探针主机和应用服务端的受保护环境，不写入配置文件、日志、响应或 Git。建议使用至少 32 字节随机值，轮换时并行配置短暂双 key 需要单独扩展，当前版本只接受一个 active secret。

## 低资源频率

- 建议独立调度器每 5 分钟执行一次，并加入 0–30 秒抖动，避免整点尖峰。
- 每个观测点同一目标只允许一个在途运行；超时默认 8 秒。
- 应用读端点有 60 秒服务端缓存、同一管理员 30 秒最短间隔、single-flight 和 429 `Retry-After`。
- 页面隐藏或离线时取消请求并暂停；不使用 `setInterval`。
- 后台读端点外网调用为 0，业务写入为 0。

## 激活步骤

1. 审核并应用 `20261003113000_external_site_monitor_ingestion.sql`，确认 RPC 只有 `service_role` 可执行。
2. 在 `domain_hostnames` 登记要监测的正式域名；探针不能为未登记域名写入证据。
3. 在独立主机创建只读配置白名单，示例结构见 `scripts/fixtures/external-site-monitor-worker-config.json`；示例域名只用于合同测试。
4. 在独立主机和应用服务端配置相同的 `EXTERNAL_SITE_MONITOR_INGEST_SECRET`，应用端另设 `EXTERNAL_SITE_MONITOR_EXPECTED_SCHEDULER_ID`。
5. 使用 systemd timer、Cron 或独立调度平台每 5 分钟运行 worker；只有显式 `--send` 才摄取。
6. 首次真实外部样本到达后，在后台核对观测点、调度器、时间、五项检查、证据摘要和数据库回执。
7. 从第二个独立网络做一次对照，随后再接告警通知和 SLO。当前实现不会自动切流、自动续证书、自动改 DNS 或自动执行恢复。

## 零公网合同验证

```powershell
node --check scripts/external-site-monitor-worker.mjs
node scripts/external-site-monitor-worker.mjs
node scripts/external-site-monitor-worker.mjs --config scripts/fixtures/external-site-monitor-worker-config.json --validate-config
node scripts/external-site-monitor-worker.mjs --fixture scripts/fixtures/external-site-monitor-probe.json
node scripts/run-node-maintenance-tsx.mjs scripts/verify-external-site-monitor-contract.ts
```

以上验证只读本地 fixture；外网请求、数据库写入、业务写入和生产变更均为 0。
