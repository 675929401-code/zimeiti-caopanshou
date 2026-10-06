# P0 安全修复第二阶段交付报告

## 结论

本阶段授权范围内的代码修复已完成。未调用真实支付、真实私网、外部攻击或付费模型，未执行数据库迁移，未修改 `storyboard-workbench`、视频生成/轮询/状态/流式路由和计费核心。TypeScript、目标 ESLint、13 项无网络专项测试全部通过。

基线见 `P0-security-stage2-baseline-hashes-2026-08-14.md`，交付哈希见 `P0-security-stage2-post-hashes-2026-08-14.md`。

## P0 修复

### 1. LLM 路由、模型越权和 BOLA

- `src/app/api/llm/route.ts`：普通用户只能提交 `pm_` 开头的 opaque public model id；客户端 `model`、内部 `modelId`、`proxyUrl`、`proxy_url`、provider/API key 类字段不能控制后端路由。公开 ID 由服务端映射到数据库模型。
- `src/lib/public-model-dto.ts`：HMAC 生成不可逆公开 ID；生产环境缺少专用密钥/JWT 密钥时拒绝启动该映射。
- `src/lib/conversation-ownership.ts`：先查 owner，再尝试创建；唯一键冲突后必须重新读取 owner，绝不覆盖 `user_id`。
- 对不存在、格式错误、属于其他用户的 conversationId 统一返回 404 `RESOURCE_NOT_FOUND`，不暴露对象是否存在。
- 新增虚拟智能体白名单，任意 `__xxx__` 不再绕过数据库存在性检查。

### 2. SSRF 与远程内容导入

- 新增 `src/lib/safe-fetch.ts`：只允许 HTTP/HTTPS；拒绝 URL 凭据和非 80/443 端口；DNS 全量解析后拒绝 IPv4/IPv6 loopback、private、link-local、multicast、metadata、保留/文档/映射地址。
- 每一跳重定向重新校验，最多 3 跳；剥离 Authorization/Cookie/API key；限制连接与响应体超时、最大字节和内容类型；错误不回传内部细节。
- 已接入 `/api/fetch-url`、StorageManager URL 转存、LocalProvider URL 转存、图片生成参考图抓取、`image-workbench/persist`。
- `image-workbench/persist` 的 JSON/data URL 大小在解析/解码前校验；远程图最大 25MB。

### 3. 本地对象存储路径

- `LocalProvider` 的 read/write/delete/exists/head/signed-url 使用统一根目录包含校验。
- prefix 只允许安全路径段；文件 key 使用随机 UUID，不再信任用户文件名。
- list 不接受穿越 prefix；专项测试覆盖 `..`、绝对路径和反斜杠穿越。

### 4. 公开模型 DTO

- 普通用户的 chat/cover/llm/video models API 只返回：`id`、`displayName`、`variantLabel`、`avatarUrl`、`capabilities`、`publicPrice`。
- capabilities 使用字段白名单，无法夹带 provider/channel/protocol/proxy/endpoint/apiKey/internal model id/成本统计。
- 管理员原始模型数据分支保留，但必须同时通过 JWT admin role 和数据库当前用户 role/status 复核。
- chat 与 image 前端已改为使用公开 ID；视频提交映射按任务边界交给任务01，见“P0 交接项”。

### 5. 上传防护

- multipart 请求先检查 Content-Length，再执行 `formData()`；随后用 `File.size` 再检查一次，最后才读取内存。
- magic bytes 与声明 MIME 必须相符；明确拒绝 SVG、HTML、JavaScript、XML 等主动内容。
- 文件名改用随机 UUID；客户端只收到通用错误，不返回堆栈、存储路径或供应商细节。

### 6. 日志、诊断接口和提示词保密

- 支付 notify 不再记录完整 payload、签名或明文订单号，只记录 provider hint、订单哈希引用和截断状态；异常日志仅记录错误类型。
- 诊断日志接口要求登录，使用严格 zod schema、32KB 流式大小限制、嵌套敏感键脱敏和每分钟 10 次限流。
- 修正 `llm-security` 的 `skipFields` 语义：只删除明确豁免字段，其余所有嵌套字段继续扫描。
- `prompt-guard` 保留明确的系统提示词套取/冒充管理员拦截，删除会误伤“帮我搭建一个正常智能体”的宽泛规则；系统提示词只追加一次短保密边界。

## 自动化证据

- `tsc -p tsconfig.json --noEmit`：通过。
- 目标文件 `eslint --quiet`：通过，0 error。
- `scripts/verify-p0-security-stage2.ts`：13/13 通过，0 外部网络调用。
- 覆盖：conversation BOLA、并发创建冲突、私网/metadata/IPv6/重定向 SSRF、响应大小/类型/超时、公开 DTO 六字段、路径穿越、SVG/HTML/JS/XML 上传、skipFields、虚拟智能体白名单、提示词套取与正常聊天不误伤。

## P0 交接项

1. **视频公开 ID 闭环**：`/api/video/models` 已只返回 opaque ID；由于本阶段禁止修改 `video/generate` 及任务01正在排查视频链路，提交端和生成端的公开 ID 映射尚未在本任务中接通。任务01必须同步适配 `src/app/video/page.tsx`、`src/components/free-canvas-shell.tsx`、分镜工作台消费者，并在 `video/generate` 服务端映射，禁止恢复内部 ID 到前端。
2. **钱包/计费核心**：并发漏扣、余额与流水非事务、fire-and-forget 后扣、语音扣费原子性、退款余额冲正仍属于下一阶段钱包迁移；本阶段按明确约束未修改。
3. **内部编译工作流信任**：客户端仍可声明 `internal_workflow`。目前只能跳过全局前缀，不能绕过 JWT、BOLA、公开模型映射和请求注入检测；后续应由任务01为 canvas/storyboard 服务端调用增加 HMAC 内部头，并让 `/api/llm` 拒绝未签名的该字段。

## P1/P2 残余风险

- P1：DNS 校验与实际 fetch 之间仍存在理论上的 DNS rebinding TOCTOU。完全消除需使用支持固定解析结果和 TLS SNI 的受控 HTTP dispatcher，不能只重写 Host。
- P1：限流为单进程内存桶；多实例部署需迁移到 Redis/数据库原子计数器。
- P2：LocalProvider 能阻止 API 路径穿越，但若主机管理员在存储根目录内预先创建恶意符号链接，仍需部署层禁止/清理 symlink 或使用 `openat` 类目录句柄约束。
- P2：公开模型 ID 为稳定 HMAC；管理员删除/重建模型或轮换密钥时需计划兼容窗口。

## 沙箱与人工验收

可自动化：本报告列出的 13 项；API schema/DTO 快照；mock DNS/redirect/body；BOLA store fixture；恶意文件 fixture；静态 secret-field 扫描。

必须使用支付沙箱或管理员人工确认：第三方回调签名兼容、真实扫码跳转、退款供应商状态、余额/流水/订单/供应商四账对账、管理员模型原始字段页面、对象存储生产域名与签名 URL、视频公开 ID 全链路。

## 回滚点

- 基线中已有文件可按基线哈希逐文件恢复；新增文件可删除并撤销对应 import/调用点。
- SSRF 回滚单位：`safe-fetch.ts` + 四个接入路由/存储调用点。
- DTO 回滚单位：`public-model-dto.ts`、`public-model-access.ts` + 四个 models API + chat/image 客户端。
- BOLA 回滚单位：`conversation-ownership.ts` + `/api/llm` ownership block。
- 上传回滚单位：`file-upload-security.ts` + 两个上传路由。
- 提示词防护回滚单位：`prompt-guard.ts` 中两条精准模式、三条已删除的宽泛模式和 `[系统保密边界]` 追加逻辑。

过程说明：初始基线覆盖了授权资料包中的核心文件。审计过程中新增发现的 `prompt-guard.ts` 与 `image-workbench/persist/route.ts` 未包含在初始快照，只记录了交付哈希和精确回滚单位；未伪造修改前哈希。
