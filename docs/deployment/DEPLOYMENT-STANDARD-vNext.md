# 自媒体操盘手部署与存储标准 vNext

> 状态：本文件定义目标标准和操作门禁，不代表已经推送 Git、上传 COS、切换服务器或完成线上部署。
>
> 适用范围：主站 Web、Voice Platform、公共展示素材、用户上传、会员与业务数据、发布制品、备份与回滚。
>
> 基准日期：2026-08-28。

> 2026-10-10 路径校正：当前生产唯一允许的发布根为独立挂载盘 `/data/web`，制品入口为 `/data/direct-deploy/incoming`。旧 `/srv` 示例已作废；执行时还必须满足 `DEPLOY-STORAGE-CONTRACT.md` 的设备、UUID、marker、空间和 inode 门禁。

## 1. 先给结论

今天的问题不是“Git 仓库天生不可靠”，也不只是某一段页面代码。根因是旧链路把本应独立的源码、依赖、构建结果、大体积素材、运行数据和服务器进程混在一次部署里：仓库过重，服务器还要临时安装和构建，静态页面又直接加载大量原图；一旦任何一环的环境、数据或资源不一致，整个发布就会变慢、失败或上线后表现异常。

vNext 的统一原则是：

1. Git 只保存可审计的源码、配置模板、迁移脚本和小型元数据，不保存运行数据、密钥、依赖目录、构建目录和大体积二进制素材。
2. 构建只在受控 Linux CI 中进行，固定 Node.js 24.19.0、pnpm 9.0.0、`--frozen-lockfile`，产出带哈希和来源证明的不可变 Web/Voice 制品。
3. 服务器不执行 `git pull`、不安装依赖、不构建、不生成或覆盖业务数据；服务器只校验、解包、候选端口验收、原子切换和失败回滚。
4. 公共大素材与用户上传优先进入 COS，并由 CDN 分发；服务器磁盘只保留不可变代码制品、必要的单机数据库、短期缓存、日志缓冲与受控备份。
5. 代码、素材、数据库、用户上传、密钥和备份各有独立生命周期。更新代码不能覆盖数据，更新素材不应重建 Web，更新 Voice 不应重启 Web。
6. 小改动只发布受影响的服务；首次迁移或真正的大版本才走经过演练的全量编排。

目标链路如下：

```text
开发事实源
   │ 受控同步、差异分类、审核
   ▼
干净 Git 工作树 ──► origin + backup 两个远程 ──► 签名 Tag/受保护分支
   │
   └── Linux CI（Node 24.19.0 / pnpm 9.0.0 / frozen lock）
          ├── web-<release-id>.tar.gz + sha256 + manifest
          └── voice-<release-id>.tar.gz + sha256 + manifest
                         │
                         ▼
             私有制品库/对象存储（不可变）
                         │ 校验、候选启动、readiness
                         ▼
        releases/<release-id>/<service> ──原子链接──► current-web/current-voice

公共素材清单 ──SHA-256寻址──► COS 私有源站 ──CDN──► 浏览器
运行数据/会员数据 ───────────► 独立数据库、shared 持久卷或私有 COS
```

## 2. 今天部署不顺利的原因：已确认事实与待补证事项

### 2.1 已确认的链路证据

本地审计已经发现以下结构性问题：

- 旧候选仓库约 2.78 GB，其中 `.git` 松散对象约 2.46 GiB，约 3,524 个文件被纳入仓库，没有使用 Git LFS；该仓库同时存在脏工作区并落后于当前事实源。这样的仓库每次克隆、打包、传输和对象遍历都很重，也无法证明线上构建与当前本地功能完全一致。
- 旧发布脚本会归档整个仓库，并在服务器临时安装依赖、执行构建，然后删除/重建 PM2 进程。服务器网络、包源、Node ABI、系统库、内存或磁盘任一差异，都会把“部署”变成一次不可重复的现场编译。
- 本次服务器只读检查确认，`/data/web/current` 指向 `release-20260828-110702-85c48932`，release 中仍包含 `.git`、`node_modules`、`.next`、源码、文档、脚本和 `public`；实际运行方式仍是服务器目录内的 `next start -p 5000`。这不是不可变 standalone 制品发布，而是把服务器同时当作 Git 工作树、构建机和运行机。
- 服务器系统 Node 是 20，PM2 实际解释器是 Node 22.23.2，而 vNext 生产契约要求 Node 24.19.0。即使某次现场构建碰巧成功，也不能证明原生依赖 ABI、Next 构建结果和下一次部署一致。
- 在新干净 Git 工作树中第一次执行 Node 24.19.0、pnpm 9.0.0、`pnpm install --frozen-lockfile` 时，确定复现了 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`：覆盖配置写在 pnpm 9 不读取的位置，而锁文件记录了这些 overrides。该问题已在本地源码中修正为 `package.json#pnpm.overrides`，并加入静态门禁；不能用 `--no-frozen-lockfile` 绕过后再让服务器临时解析依赖。后续安装还证明原来的依赖生命周期白名单同样使用了 pnpm 10/11 的格式，pnpm 9 会忽略。现已改为 `package.json#pnpm.onlyBuiltDependencies`，只允许构建必需的原生包执行安装脚本，`canvas`、`puppeteer` 与已携带预编译二进制的 `better-sqlite3@13.0.3` 都不进入发布安装白名单。Puppeteer 测试所需 Chrome 必须通过 `pnpm run e2e:browser:install` 在独立 E2E 阶段显式安装，不再让约 280 MB 的浏览器下载成为 Web 发布依赖安装的成败条件。本地第二次还复现了 `better-sqlite3@13.0.1` 在 Windows 上误进入 `node-gyp` 而因缺少 Python 失败；当前已固定到修正了该安装行为的 13.0.3，并保留 Docker 中对原生模块的实际 `require()` 验证。
- 旧 Docker 路径曾把约 1.66 GB 的 `node_modules`、约 2.67 GB 的 `public` 和约 124 MB 的 `.next` 混在上下文中，总量约 4.45 GB。重复发送未变化内容，既慢，也容易把开发机平台依赖带进 Linux 服务器。
- 旧 Windows 工作树还残留 380 个 CRLF 和 221 个 mixed-EOL 跟踪文件，而 `.gitattributes` 要求 LF。Git 的 clean filter 会让 `git status` 仍显示干净，但旧 source manifest 按 Windows 原始工作树字节计算 SHA，Linux CI checkout 后必然变为 LF 字节并导致指纹不一致。vNext 现已将普通有效 UTF-8 文本在快照、同步和清单阶段确定性规范为 LF，二进制文件保留原字节；Git 仓门禁另外拒绝任何非显式 `-text` 例外的 `w/crlf` 或 `w/mixed` 候选。`public/youcai-media/v1/source-manifest.json` 同时是代码构建输入和已定稿资产 digest 成员，因此用 `.gitattributes -text -diff` 把它作为字节不可变资产保存并禁止逐行文本 diff；不能只为换行就改变整个 1.30 GB 资产版本。
- 灵感广场首屏曾让 36 张卡片直接请求 35 个大原图，总计约 71.63 MiB。浏览器网络、解码、布局与内存压力会在服务器/CDN链路下被放大；原来的瞬时 `onError` 还会把临时失败固化成“预览加载失败”。
- 本地事实源与端口 5000 当前运行的 `.next` 不是同一构建。源码已经变化并不等于浏览器正在看的运行版本已经变化；HTTP 200 也不能证明 BUILD_ID、提交、素材版本、数据库和普通用户功能一致。
- 服务器日志已经出现 `Failed to find Server Action`，同时还有 `attachment migration is not ready`。前者与新旧 Next.js 构建混用一致，后者直接证明运行代码与生产数据库迁移不一致。vNext 以精确 Git commit 作为 `deploymentId` 和 provenance 身份：Voice 的 Next 15 仍由 `generateBuildId` 生成 commit 型 BUILD_ID；Web 的 Next 16 则把 BUILD_ID 作为框架内部构建标识，必须从 `required-server-files.json` 另外验证编译后的 `deploymentId` 等于 commit，不能再错误要求两个不同语义的字段相等。该修复在新制品真正构建、候选验证并切换前，不能描述为线上已修复。
- Voice 目录虽然自带独立 lockfile，但父目录的 `pnpm-workspace.yaml` 只声明主站根包。过去在 Voice 目录直接运行 `pnpm install --frozen-lockfile` 会向上加入父工作区并实际不安装 Voice 依赖；vNext 的 CI 和构建器现统一使用 `pnpm --ignore-workspace ...`，Voice 自身也固定 pnpm 9 与生命周期白名单，从而真正以自己的 lockfile 独立安装和构建。
- 原 `validate` 会在 pnpm 9 脚本内部再次按系统 PATH 执行 `pnpm run`；开发机若同时装有 pnpm 11，内层命令会越过当前 CLI 身份并被引擎门禁拒绝。现改为直接调用已冻结安装到项目内的 `tsc` 与 `eslint`，避免同一条验收命令中混入第二个包管理器版本。
- Web 首次无密构建已复现：四个管理 API 在模块顶层调用 `getSupabaseClient()`，Next 收集路由数据时因此要求构建机持有生产 Supabase 密钥并直接失败。四处初始化已移入请求函数，静态门禁禁止再次出现顶层数据库客户端；CI 构建保持无生产密钥，真实配置只在候选运行时由 readiness 校验。
- 公共素材曾存在“文件扩展名是 `.png`、实际内容是 JPEG”的历史兼容数据。新清单已使用真实 MIME 对应的 `.jpg` 作为规范路径，同时保留旧 `.png` 兼容别名，避免旧构建在切换前立即断链。
- `public/storyboard-reviews/**` 实际含 298 个测试/验收文件、约 1,362,449,488 B（约 1.269 GiB），其中包括任务 JSON、PNG、MP4、错误记录、成本记录、任务代理地址和 158 个会在 2026-09-12 至 2026-09-17 到期的 COS 签名 URL；`public/demo-assets/**` 还包含已于 2026-08-13 到期的外部图片 URL。它们过去被误放在 Web 公共目录，是部署体积膨胀和“今天能看、以后失效”的直接结构性风险，不是正式产品素材。
- 固定产品演示已迁入 `public/product-assets/youcai-demo-v1/**`：10 张本地画布图片、一个去除外部 URL 且通过 `WorkflowGraphSchema` 的 53 节点/74 边可编辑 graph、版本化演示视频、轻量 WebP poster，以及 3 张本地化帮助页封面。原测试记录未删除，但不再进入 Git 源码快照、资产 manifest、Docker Web 制品或 Nginx 公共路由。

为改善素材链路，本地已生成 162 个最长边不超过 720 px 的 WebP 预览图，清单通过 `previewPath` 绑定预览，界面先加载缩略图、失败后再回退原图。它解决的是页面预览负载问题，不能被当作“已经部署线上”的证据。

### 2.2 今天失败的归因

按当前证据，应把原因归为“旧部署体系失败”，而不是简单归为“Git 坏了”或“本地功能代码坏了”：

| 层面 | 问题 | 直接后果 |
| --- | --- | --- |
| 源码基线 | 事实源、旧 Git 候选仓、端口 5000 运行构建不是一个可追踪基线 | 不知道服务器到底拿到了哪一版 |
| 仓库 | 大体积资产和历史对象混入，无 LFS，工作区不干净 | 推送、克隆、打包慢，变更边界不可信 |
| 依赖 | pnpm 9 配置位置与锁文件不一致，frozen install 可稳定复现失败 | CI/新服务器无法按锁文件重建环境 |
| 构建 | 在服务器现场安装/编译；环境未被制品记录 | 本地能跑不代表 Linux 服务器能稳定复现 |
| 制品 | 代码、依赖、`.next`、`public` 和数据没有严格分层 | 每次像全量搬家，容易遗漏或误覆盖 |
| 静态资源 | 首屏请求几十 MiB 原图，临时失败被永久显示 | 线上导航与画布周边页面显著卡顿、预览失败 |
| 激活 | 删除/重建进程，缺少候选端口、`deploymentId` 与身份级 readiness 门禁 | 新旧 Server Action/RSC 混用，半成品可能直接暴露给用户 |
| 数据 | JSON、SQLite、上传和代码目录曾存在耦合 | 覆盖代码时可能丢数据，或新代码读到旧结构 |

### 2.3 已取得的线上证据与仍需补齐的验收证据

本次已经以只读方式取得当前 release 指针、运行命令、Node 解释器和关键错误日志，因此“现场构建、版本漂移、Server Action 版本偏差、数据库迁移未就绪”不再只是推测。重新部署前和候选验收时仍必须补齐以下量化证据：

- 新 Linux CI 的 frozen install、构建、打包、SHA 校验和退出码；
- 候选主机的 CPU 架构、glibc、磁盘空间、inode、内存峰值与 OOM 记录；
- 新 `current-web`、`current-voice`、PM2 进程对应的 releaseId、commitSha、BUILD_ID 和 deploymentId；
- Nginx 访问日志中的资源状态码、TTFB、上游耗时、响应大小、缓存命中率和 Range 请求；
- 当前环境变量是否指向预期的 shared 目录、数据库和素材版本；
- 数据库 schema/RPC 是否完成独立迁移，以及 readiness 是否真实通过。

因此，今天的失败是多项已确认问题叠加，而不是单一 Git 故障：旧仓库与现场构建导致不可复现，pnpm frozen lock 配置不一致会直接阻断干净安装，新旧 Next.js 构建混用导致 Server Action 错误，生产数据库又未达到当前代码契约。剩余证据用于证明“新链路已经修好并达到性能目标”，不是继续猜测旧链路是否有问题。

### 2.4 当前生产数据库契约：明确 NO-GO

截至 2026-08-28，本次生产 PostgREST OpenAPI 只读核验快照显示：目标版本化数据库契约仍有 **32 个表路径缺失、17 个关键列标记缺失、34 个 RPC 路径缺失**。这里的 `32 / 17 / 34` 是该次生产探针返回的“缺失数量”，不是契约对象总量；当前源码契约 `zimeiti-caopanshou-production-database-v1@20260828193000` 共声明 42 个表、533 个列标记、34 个 RPC、229 个 RPC 参数和 1 个禁止再暴露的旧 RPC。生产缺失不是提示级问题，而是发布阻断项：只要 `missingTables`、`missingColumns`、`missingRpcs`、`missingRpcArguments` 或 `forbiddenRpcsPresent` 任一非空，数据库状态就必须是 `PRODUCTION_SCHEMA_MIGRATION_NOT_READY`，不得激活新的 `WEB`、`VOICE` 或 `FULL` 版本；`ASSET` 最多只能安装不可变候选，不能借此切换依赖新数据库契约的 Web 指针。

当前数据库 manifest 是 `deploy/policies/database-contract.v1.json`，运行时与 CI 共用 `src/lib/production-database-readiness.ts` 校验：它按 service role 可见的 OpenAPI 元数据核对表路径、表属性、RPC、RPC 参数和被禁止的旧 RPC，全程不读取业务行、不执行数据库 RPC。发布证据必须保存本次 verifier 的 JSON 结果和契约版本，不能只写“数据库应该没问题”。

此前审计暴露的两个 bootstrap 缺口已经被编码进本地源码迁移 `supabase/migrations/20260828193000_release_baseline_audit_and_debt.sql`：该迁移创建 `cash_debt_records` 和 `password_audit_log` 并限定 service-role 访问；健康检查源码也已改为复用统一数据库契约，不再把 `avatars` 当成数据库表。这里必须严格区分“源码已补齐”与“生产已迁移”：本文件没有证据证明该迁移已在生产应用，生产只读快照仍然 NO-GO。`avatars` 实际是 Supabase Storage bucket，其 readiness 应走独立的 Storage 只读检查，禁止为了让 PostgREST 探针变绿而创建同名表。

本地 migration 文件存在、TypeScript 通过、CI 构建成功或主页返回 HTTP 200，都不能消除上述 NO-GO。正确顺序是：数据库所有者备份并审阅迁移 → 在受控窗口应用迁移 → 刷新 PostgREST schema cache → 重新运行同一 OpenAPI 契约探针 → 缺失计数全部归零 → 才允许继续候选端口与上线门禁。本文件不授权也不执行其中任何数据库或生产动作。

## 3. 四层发布对象：source / runtime data / assets / artifacts

四层必须具有独立的事实源、校验方式、发布动作和回滚动作，禁止用“把整个项目目录复制一遍”同时处理四层：

| 层 | 唯一职责 | 版本身份 | 允许随代码发布 | 回滚方式 |
| --- | --- | --- | --- | --- |
| `source` | 可审计源码、锁文件、迁移、测试、无密模板 | Git commit / Tag | 是，先经 PR 和 CI | 回到已验证 commit，但不直接覆盖本地事实源 |
| `runtime data` | 会员、订单、余额、SQLite、业务 JSON、上传与幂等状态 | 数据库版本、备份点、schema/data checksum | 否 | 数据库专用恢复或向前修复，不跟随代码链接 |
| `assets` | 公共图片/视频/音频、用户上传、参考音频 | assetDigest、对象 SHA、READY | 否；只发布清单或独立 asset release | 切回旧 assetVersion/CDN 映射 |
| `artifacts` | Linux CI 产出的 Web/Voice 可执行制品 | releaseId、commitSha、BUILD_ID、artifact SHA | 这是服务器唯一接收的代码交付物 | 原子切回旧 `current-*` |

### 3.1 第一层：Git 源码层

Git 中允许保存：

- `src/`、`voice-platform/src/` 等源码；
- `package.json`、锁文件、Next/TypeScript/ESLint 配置；
- 数据库迁移脚本，但不含数据库文件和生产数据；
- `deploy/`、`scripts/`、CI 工作流、Nginx/PM2 配置模板；
- 文档、提示词、小型 JSON schema/清单；
- `public/version.json` 与构建需要的精确小型元数据；
- 公共资产的内容寻址清单，不保存清单所指向的大二进制对象。

Git 中禁止保存：

- `.env*` 中的真实密钥、云凭据、Cookie、Token；
- `node_modules/`、`.next/`、日志、缓存、临时文件；
- `data/` 中的运行数据、SQLite 数据库、用户生成内容；
- `public/uploads/`、参考音频和不断变化的用户文件；
- 几 GB 的图片、视频、音频素材；
- 生产备份、导出数据、线上错误快照中的敏感内容。

事实源通过 `release-workflow.mjs` 生成或同步到相邻的干净 Git 工作树。只有干净工作树被提交和推送，开发事实源本身不被假装成 Git 仓库，也不直接作为服务器发布包。

### 3.2 第二层：运行数据层

运行数据永远位于发布目录之外：

- 会员、余额、订单、计费、授权：现有受控数据库/Supabase，使用迁移和事务管理；
- Voice SQLite：单机阶段放在 `shared/voice/voice.db`，独立备份；多实例或高可用阶段迁移到托管 PostgreSQL；
- 应用 JSON：`shared/data`，仅作为过渡性配置/数据层，必须校验 schema、原子写入和备份；
- 幂等记录和运行状态：`shared/runtime`；
- 用户上传：优先私有 COS，服务器 `shared/uploads` 仅作迁移兼容或短期落盘；
- 参考音频：`shared/voice/reference-audio` 或私有 COS；
- 日志：`shared/logs` 轮转后汇聚到集中日志服务；
- 备份：`shared/backups` 只是本机暂存，最终副本必须离开该服务器。

代码制品对运行数据只有“挂载和读取/按业务规则写入”的权限，绝不能把空目录、演示 JSON、SQLite、seed 或旧备份复制到 shared 中。制品 manifest 或压缩包一旦出现 `shared/`、`data/`、`uploads/`、数据库文件、真实 `.env`，CI 和服务器 plan 必须立即拒绝。

### 3.3 第三层：静态资产层

公共展示素材采用内容寻址：

```text
sha256-<asset-digest>/public/avatars/...
sha256-<asset-digest>/public/youcai-media/...
sha256-<asset-digest>/.release/public-assets.v1.json
sha256-<asset-digest>/.release/public-assets.ready.v1.json
```

只有完整 SHA-256 验证通过并最后写入 READY 回执的资产版本才能被激活。文件名或对象 key 不变时，不允许原地替换内容；内容变化就产生新 digest。这样 Web 制品可以精确声明自己需要哪个素材版本，回滚代码时也能回到匹配的素材版本。

asset digest 不只覆盖文件 SHA/path，还覆盖稳定序列化后的资产策略摘要 `assetPolicySha256`；manifest 本身不写每次运行都会变化的生成时间。于是“文件与资产边界都没变”时，重复生成会得到字节完全相同的 manifest SHA；资产 allowlist、必需路径或校验规则变化时则产生新 digest，避免同一 `sha256-*` 目录下出现两份不同 manifest。时间戳只属于最后生成的 READY 回执。

生产 immutable asset manifest 采用明确 allowlist，只允许以下 12 个 `public` 子树：`product-assets`、`youcai-media`、`short-drama`、`cover-references`、`avatars`、`cover-presets`、`help`、`cover-assets`、`cover-generated-samples`、`official-home`、`downloads`、`model-brands`。`public/storyboard-reviews` 与 `public/demo-assets` 整体拒绝，`public/uploads` 则属于独立 mutable 数据，不进入该清单。测试脚本的新输出统一进入 Web 根目录之外的 `evidence-archive/<domain>/<date>/<id>`，只有经过挑选、脱敏、本地化、优化和 SHA 登记的文件才能晋升到 `product-assets`。

公共素材与用户上传必须分 bucket 或至少分前缀、权限与生命周期：

- `public-assets/sha256-.../`：可缓存、不可变、通过 CDN 对外；
- `user-uploads/<tenant>/<date>/<uuid>`：默认私有、鉴权访问、独立生命周期；
- `release-artifacts/<service>/<release-id>/`：私有、只允许部署身份读取；
- `backups/<system>/<date>/`：私有、加密、不可由 Web 运行身份删除。

### 3.4 第四层：CI 不可变制品层

CI 制品是“构建一次、处处运行”的交付单位。每个服务独立产生：

- `web-<release-id>.tar.gz`；
- `voice-<release-id>.tar.gz`；
- 对应的 `.sha256`；
- `release-manifest.json`；
- `.next/BUILD_ID`；
- `.next/release-provenance.v1.json`；
- 代码提交 SHA、锁文件 SHA、Node/pnpm/ABI/libc、素材清单 SHA 和资产 digest。

其中 commitSha 是不可变发布身份，`deploymentId` 是 Next.js 的跨实例版本偏斜保护，BUILD_ID 是该框架版本的实际构建标识。Web 固定 Next 16.2.11，必须验证编译配置中的 `deploymentId === commitSha`；Voice 固定 Next 15.5.21，并额外要求 `BUILD_ID === commitSha`。provenance 同时记录 `nextVersion`、`buildIdStrategy`、实际 BUILD_ID 和编译后的 deploymentId，readiness 必须逐项与制品 manifest 对账。

运行时不再从 `process.cwd()/.next/BUILD_ID` 读取身份，因为这种根目录文件访问会让 Next/NFT 把源码根误判为动态追踪范围并膨胀 standalone。打包器先核对制品内 BUILD_ID，部署器再从已校验 manifest 注入 `EXPECTED_BUILD_ID`；候选 readiness、PM2 环境和回滚路径都必须与该值一致。真实 BUILD_ID 文件仍保留在制品内供安装前离线校验，但不会触发运行时全项目追踪。

制品必须不可覆盖。相同 releaseId 若已存在，CI 和服务器都应拒绝覆盖。制品存入私有 Artifact Registry、GitHub/Gitee CI 制品库或专用私有 COS bucket；Git Release 只用于索引和发布说明，不应把几 GB 运行素材重新塞回源码仓库。服务器永远不接收“完整仓库压缩包”作为运行制品，也不从制品中生成或覆盖 shared。

## 4. 服务器磁盘还是 COS + CDN

### 4.1 推荐选择

| 内容 | 首选位置 | 服务器磁盘用途 | 原因 |
| --- | --- | --- | --- |
| Git 源码 | 两个 Git 远程 | 不保存工作树 | 服务器不参与开发与构建 |
| Web/Voice 制品 | 私有制品库或私有 COS | 保留当前和前 2–3 个已验收版本 | 制品小、不可变、便于秒级回滚 |
| 公共图片/视频/音频 | COS + CDN | 首次迁移可用只读镜像；不作长期源站首选 | 大文件吞吐、Range、边缘缓存、减少应用服务器负载 |
| 用户上传 | 私有 COS | 临时上传缓冲，成功后清理 | 权限、扩容、持久性和跨机一致性更好 |
| Voice SQLite | 单机持久盘；高可用用托管 PostgreSQL | 单机阶段必须落独立数据盘 | SQLite 不适合多实例共享写入 |
| 会员/计费/订单 | 托管数据库 | 不落发布目录 | 事务、备份、PITR 与审计要求高 |
| 日志 | 集中日志服务 | 有限轮转缓冲 | 避免日志写满系统盘 |
| 备份 | 异地私有对象存储/另一账户 | 短期暂存 | 同机备份不能防磁盘、账号和误删事故 |

结论：公共素材和用户上传应逐步转到 COS，外部访问走 CDN；服务器硬盘不是大素材仓库。服务器保留少量不可变代码版本和必须低延迟访问的单机运行数据即可。

### 4.2 两阶段落地：磁盘首次基线，COS + CDN 长期运行

| 阶段 | 目的 | 执行动作 | 退出条件 | 回退 |
| --- | --- | --- | --- | --- |
| A：首次磁盘基线 | 先建立可校验、可回滚的完整产品资产版本，消除散文件和临时 URL | 将 allowlist 内正式资产安装到 `shared/assets/releases/sha256-<digest>`；逐对象校验 SHA/大小/MIME/Range；最后生成 READY；只读挂载 | Web 制品声明同一 assetDigest，候选和生产都能读取，旧路径兼容，备份已离机 | 切回上一 disk assetVersion；不碰 `shared/data`、上传或数据库 |
| B：COS + CDN 长期方案 | 让大图、视频、音频离开应用服务器，后续只上传缺失对象 | 上传内容寻址对象；验证 GET/HEAD/Range/CORS/缓存；建立 version-aware URL 映射；保留 manifest/READY 与轻量回退资产 | COS 全量哈希、CDN、回源权限、域名证书、监控、成本预算和回滚演练全部通过 | 恢复上一 CDN 映射或回到已验收 disk release |

阶段 A 不是把旧 `public/` 散拷到 Nginx 目录，也不是让代码发布覆盖 `shared/assets/current`；它是一次性的不可变资产 bootstrap。阶段 B 也不是删除服务器全部资产后再试 CDN：至少在一个观察窗口内保留最后一个完整 disk 版本和对应 Web 制品，确认 COS/CDN 稳定后再按保留策略清理。

任何未完成版本化 URL 映射、COS 对象校验或 CDN Range/CORS 验收的环境，都必须停留在阶段 A。这样首次部署可以先得到正确基线，长期迭代则只传缺失对象，不会每次重复搬运约 1.30 GB 正式素材。

### 4.3 COS + CDN 必须同时配置的细节

- 源 bucket 默认私有，CDN 回源使用受控身份或回源鉴权；不要把写权限暴露给浏览器。
- 内容寻址对象设置长缓存，例如 `Cache-Control: public, max-age=31536000, immutable`；清单、READY、current 别名短缓存或禁止缓存。
- 视频启用 Range 请求，正确返回 `Content-Type`、`Content-Length` 和 `Accept-Ranges`。
- 配置 CORS，只允许实际站点域名和必要方法/请求头。
- 上传由服务端签发短期、最小权限凭证或预签名请求；不得把永久 SecretKey 下发到前端。
- 图片预览使用缩略图/WebP/AVIF，详情页按需加载原图；视频先 poster、后元数据、用户播放时再加载主体。
- CDN 域名、HTTPS、压缩、HTTP/2 或 HTTP/3、热点缓存和防盗链需要单独验收。
- COS 生命周期按前缀管理临时文件、失败分片和历史版本；不可变资产不因简单“清理”任务被删除。
- COS 版本清单、对象数量、总字节数、逐对象 SHA-256/自定义元数据和 READY 回执必须可审计。

内容寻址对象的浏览器 URL 映射也是发布契约的一部分。当前 COS publisher 的对象 key 是 `assets/releases/<assetVersion>/public/<path>`，而页面历史 URL 是 `/<path>`；因此不能简单把 `$request_uri` 原样 302 到 CDN。正式开启 COS 模式前，必须实现并验收一种受版本控制的映射：由 Web/资产发布事务把已验证的 `assetVersion` 注入 Nginx/边缘重写，最终请求必须落到 `/assets/releases/<assetVersion>/public/<path>`。映射版本要进入 READY、部署审计和回滚记录，并真实验收 GET、HEAD、Range、CORS、Content-Type 与缓存。该适配器完成前，生产使用完整 disk asset release；不得启用示例 CDN 占位跳转。

### 4.4 什么时候仍可使用服务器磁盘

以下情况可以暂时使用服务器磁盘：

- 首次迁移期间，先按 `shared/assets/releases/sha256-<digest>` 建立只读不可变资产版本；
- 单服务器、低并发阶段的 SQLite；
- 上传后转存 COS 前的短期 staging；
- 受大小限制并轮转的日志；
- 最近 2–3 个 Web/Voice 制品，支持快速回滚。

即使使用磁盘，也必须独立挂载、监控容量、校验哈希、禁止放进 `releases/<release-id>` 的代码目录，并有异机备份。

## 5. 标准目录布局

服务器根目录固定为独立数据盘上的 `/data/web`，初始化时人工创建根标记和权限：

```text
/data/web/
├── .zimeiti-release-root
├── releases/
│   ├── <release-id>/web/
│   └── <release-id>/voice/
├── staging/                         # 部署临时目录，失败后可安全清理
├── current-web -> releases/<id>/web
├── current-voice -> releases/<id>/voice
└── shared/
    ├── assets/
    │   ├── releases/
    │   │   └── sha256-<digest>/
    │   │       ├── public/
    │   │       └── .release/
    │   └── current -> releases/sha256-<digest>
    ├── data/
    ├── runtime/
    │   └── llm-request-idempotency/
    ├── uploads/
    ├── voice/
    │   ├── voice.db
    │   └── reference-audio/
    ├── logs/
    └── backups/
```

`releases/` 与资产版本都是不可变目录。部署只允许新建，不允许覆盖。`current-*` 和 `shared/assets/current` 是受控原子符号链接。`shared/` 中的数据不跟随代码回滚，数据回滚必须走独立、明确授权的恢复流程。

## 6. 环境变量标准

生产环境变量由服务器 Secret Manager、CI 环境保护或 PM2 的受控环境注入；仓库只存 `.env.example`。关键路径必须是绝对路径：

| 变量 | 生产示例 | 含义 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 启用生产行为 |
| `COZE_PROJECT_ENV` | `PROD` | 主站 readiness 的环境身份 |
| `RELEASE_ROOT` | `/data/web` | 固定发布根目录，必须位于已验明的独立挂载盘 |
| `RELEASE_ID` | `20260828-<sha>` | 不可变发布编号 |
| `DEPLOY_COMMIT_SHA` | 40 位 Git SHA | 源码身份 |
| `APP_DATA_DIR` | `/data/web/shared/data` | JSON 数据目录 |
| `APP_RUNTIME_DIR` | `/data/web/shared/runtime` | 幂等/运行状态目录 |
| `IDEMPOTENCY_DIR` | `/data/web/shared/runtime/llm-request-idempotency` | 幂等记录 |
| `BACKUP_DIR` | `/data/web/shared/backups` | 本机备份暂存目录；不等于异地灾备 |
| `PUBLIC_ASSET_ROOT` | `/data/web/shared/assets/current/public` | 当前不可变资产根；迁移到 CDN 后改为明确适配层 |
| `ASSET_DIGEST` | 64 位 SHA-256 | Web 所需资产身份 |
| `ASSET_MANIFEST_SHA256` | 64 位 SHA-256 | Web 所需资产清单身份 |
| `STORAGE_LOCAL_BASE_PATH` | `/data/web/shared/uploads` | 本地上传兼容目录 |
| `VOICE_SQLITE_PATH` | `/data/web/shared/voice/voice.db` | Voice 数据库绝对路径 |
| `VOICE_DATABASE_URL` | `file:/data/web/shared/voice/voice.db` | Prisma 连接串 |
| `VOICE_REFERENCE_AUDIO_DIR` | `/data/web/shared/voice/reference-audio` | 参考音频持久目录 |
| `PORT` | Web `5000` / Voice `5001` | PM2 服务端口 |

此外，数据库、邮件、模型、COS 等真实凭据只能保存在密钥系统中；禁止放入 Git、发布制品、构建日志、截图和聊天记录。密钥应按服务分权、定期轮换，部署身份只读制品，应用身份不能删除备份。

## 7. Git 协作标准

### 7.1 仓库角色

- “当前版本”是开发事实源，允许存在本地素材和运行数据，但不直接推送。
- 相邻干净工作树是正式 Git 源码仓，只包含发布策略允许的文件。
- `origin` 是主远程；`backup` 是另一平台或另一组织/账户的独立远程。两个远程都应使用受保护的 `main`，但日常开发只从一个主远程协作，避免双向漂移。
- CI 只从干净 Git 提交构建，任何未提交文件都会触发 fail-closed。

### 7.2 首次 Git 基线与后续 PR 增量

当前 `当前版本/` 没有 `.git`，首次接管不是在里面执行 `git init`，也不是从旧仓库 pull 回来覆盖。标准基线流程是：

1. 对本地事实源建立任务快照、SHA-256 和 runtime data boundary；
2. 运行 release audit、资产策略和敏感信息扫描；
3. 由受控同步器把允许进入 Git 的文件复制到相邻干净工作树；
4. 核对文件数、source snapshot、锁文件和排除清单；
5. 在干净工作树创建首个 baseline commit；
6. 经单独远端写入授权后，推到新私有 `origin` 的工作分支并走 PR；
7. 合并后把同一 commit 同步到独立 `backup`，从全新目录恢复验证；
8. 只有 baseline、双远程 SHA、CI 制品和恢复验证一致，才创建首个不可变 Tag。

首次基线之后，日常变化只通过 PR/MR 表达增量：PR 展示代码 diff、资产 manifest diff、数据库 migration diff 和风险分类；CI 始终从完整 commit 重建受影响服务的完整不可变制品。即使功能迭代很大，也应合并为一个可追踪 commit/Tag 并生成完整制品，而不是把全仓目录覆盖到服务器。“完整发布”表示完整制品与完整门禁，不表示重新上传未变化素材或覆盖运行数据。

每个 PR 必须声明：`releaseMode`、影响服务、是否改变锁文件、是否改变 database contract/migration、是否改变 assetDigest、是否需要 expand/contract、回滚对象和验证证据。缺少任一项时不允许合并到受保护 `main`。

### 7.3 分支与提交

- 主分支：`main`，禁止直接强推；启用 PR/MR、必需检查和最少一人审核（单人项目也应保留自审清单）。
- 工作分支：`codex/<topic>` 或 `feature/<topic>`；一个分支只处理一个可说明的目标。
- 紧急修复：`hotfix/<topic>`，仍需 CI 和 Tag，不允许直接改服务器文件。
- 提交保持原子性，说明“改了什么、为什么、如何验证、是否影响数据/素材/迁移”。
- 合并前必须与 `main` 同步并通过 frozen-lock、静态检查、构建、制品打包和变更分类。

### 7.4 Tag 与发布身份

- 单服务 Tag：`web-vYYYY.MM.DD.N` 或 `voice-vYYYY.MM.DD.N`，只构建对应制品；`full-vYYYY.MM.DD.N` 才同时构建 Web 与 Voice。普通小更新不得使用 FULL Tag；Tag 指向唯一提交，禁止移动。
- releaseId 建议包含 Tag、短 SHA 和 CI run，例如 `web-v2026.08.28.1-a1b2c3d4-r128`。
- 发布说明必须记录 Web/Voice 制品 SHA-256、commitSha、BUILD_ID、assetDigest、迁移编号、审批人和验收结果。
- 能配置签名时使用签名 Tag；无签名时至少用受保护分支、不可变制品和双远程做完整追踪。

### 7.5 双远程推送顺序

1. 本地静态门禁通过；
2. 推工作分支到 `origin`，走 PR/MR；
3. 合并后的 `main` 由 CI 构建；
4. 同一个不可变提交同步到 `backup`；
5. 验证两个远程的提交 SHA 完全相同；
6. 创建/推送不可变 Tag；
7. 由受保护环境人工批准部署已生成制品。

如果 backup 推送失败，不应删除 origin 上的成功提交，但该版本标记为“备份未完成”，在完成前不进入生产部署门禁。

## 8. 标准构建链路

本仓库的可执行示例是 `.github/workflows/release-vnext.yml`。它只做 Linux CI 校验、构建、打包和上传 CI 制品，不包含服务器地址、SSH 私钥或自动上线动作。

如果主远程是 Gitee 或自建 GitLab，不需要改发布原则：把同一组 frozen install、vNext verifier、build、package 和 checksum 命令移植到其 Linux Runner 即可。仓库平台可以替换，制品 manifest、SHA-256、环境约束和人工生产审批不能省略。

构建要求：

1. Ubuntu/Linux x64；
2. Node.js 24.19.0；
3. pnpm 9.0.0；
4. `pnpm install --frozen-lockfile`；
5. 干净 Git HEAD；
6. 资产清单与 source snapshot 相互锁定；
7. Web 与 Voice 分别构建、分别打包；
8. 制品外置到 CI 临时目录，绝不写回 Git；
9. 生成 SHA-256，上传后禁止覆盖；
10. 构建成功不等于已部署，部署必须另行审批和 readiness 验收。

本地开发机可以运行 rehearsal 验证源码，但 Windows 生成的制品只能标记为 `deployable: false`，不能上传生产服务器。真正上线制品必须由与服务器 ABI/libc 兼容的 Linux CI 产生。

Next standalone 可能包含由包管理器生成的依赖符号链接。打包器只允许链接解析到本次 standalone 目录或当前服务的 `node_modules` 受信构建根，并在制品中将其物化为普通文件/目录；断链、循环链接、越界链接和最终制品中的任何符号链接都会 fail-closed。这样可以避免把 Windows 绝对路径或 CI 工作目录带入服务器。

常用命令示例：

```bash
# 事实源只读审计与资产清单验证
pnpm run release:vnext:audit
pnpm run release:vnext:verify
pnpm run release:vnext:data:verify
pnpm run release:vnext:inspiration:verify

# 干净 Git 仓不携带 data/ 时上一步返回 EXTERNAL_RUNTIME_DATA_NOT_PRESENT；候选服务器必须显式验证真实 shared 挂载
node scripts/verify-runtime-data-vnext.mjs --data-root /data/web/shared/data

# 灵感素材在事实源中返回 full-local-sha256-and-decode；干净 Git 仓返回 pinned-external-manifest。
# 后者只证明 Git 清单绑定正确，不代表服务器素材 READY、CDN 可访问或已经激活。

# 仅在受控发布环境、已配置生产 Supabase 只读探针凭据时执行；只 GET OpenAPI 元数据，不读业务行、不调用 RPC
pnpm run release:vnext:schema:verify

# 产品演示只从受控来源晋升；默认命令可重复执行且不触发生成
pnpm run release:vnext:curate-demo-assets

# CI 中的生产构建
pnpm run release:vnext:build:web
pnpm run release:vnext:build:voice

# CI 中分别打包；输出必须在 Git 工作树之外
node scripts/package-standalone-artifact.mjs \
  --service web \
  --output /tmp/web-<release-id> \
  --release-id <release-id> \
  --commit <full-commit-sha> \
  --archive \
  --archive-path /tmp/web-<release-id>.tar.gz
```

## 9. 发布模式：小更新与全量更新

所有变更先运行分类器，再选择最小必要模式。模式不是人工凭感觉命名，而由变更文件、制品和清单共同证明。

| 模式 | 适用变化 | 构建/传输 | 激活动作 | 数据处理 |
| --- | --- | --- | --- | --- |
| `DOCS` | 纯文档、注释、不会进入运行制品的说明 | 不构建、不部署 | 无 | 无 |
| `ASSET` | 图片、视频、音频、缩略图或资产元数据 | 只哈希/上传缺失对象 | 生成 READY 并安装到不可变 `releases/sha256-*`，默认不切 `current`；首次 bootstrap 或兼容 WEB 事务负责激活 | 不碰业务数据 |
| `WEB` | 主站源码、Web 依赖或 Web 配置 | 只构建/传 Web 制品 | 候选端口验收后切 `current-web`；同时确认固定 assetDigest | 不复制、不 seed、不迁移 |
| `VOICE` | Voice Platform 源码/依赖 | 只构建/传 Voice 制品 | 候选端口验收后切 `current-voice` | 只挂载现有 Voice DB，不覆盖 |
| `FULL` | 破坏性接口升级、Web+Voice+资产必须同步的重大版本 | 三类制品都准备好 | 作为一个经演练的复合事务切换 | 数据迁移另有先决条件和回滚方案 |

重要限制：当前 vNext 部署脚本明确对 `FULL` fail-closed，因为 Web、Voice 与资产的真正复合原子事务还需要专门的协调器和演练。不得连续执行两个单服务脚本后把结果宣称为 FULL。现阶段应优先拆成兼容的 `ASSET`、`WEB`、`VOICE` 发布；确实不可拆分时，先完成并验证复合编排器，再开放 FULL。

还要明确：`current-web` 与 `shared/assets/current` 是两个独立符号链接，操作系统无法把两次链接切换合并成一个内核级原子动作。普通 `ASSET` 操作只安装 READY 版本而不切指针。vNext 只有在新资产清单是旧资产清单的严格向前兼容超集时，才允许由 WEB 发布事务协调先切资产、再切 Web：所有旧路径的 SHA-256 与字节数必须完全不变，只能新增对象。只要同路径内容被替换、旧路径被删除或兼容性无法证明，部署器就必须在切换任何指针之前 fail-closed；这类变更应改用新路径并保留旧对象，或等未来用单一 bundle 指针完成真正复合切换。

### 9.1 首次全量迁移

首次迁移只做一次，耗时会明显长于日常发布：

1. 冻结旧发布入口并保留现场日志；
2. 盘点源码、资产、数据库、上传、参考音频、密钥和 DNS/CDN；
3. 生成完整资产清单和 digest；
4. 把公共素材上传到 COS 内容寻址路径，或先落服务器不可变资产目录；
5. 对每个对象校验大小、完整内容 SHA-256、Content-Type 和 Range；
6. 最后写入 READY 回执；使用 COS 时，再由清单物化工具生成只含本地轻量文件、manifest 和同一 READY 的服务器 asset bundle；
7. 初始化 shared 目录，不覆盖现有数据；
8. 对数据库做独立备份与只读校验；迁移另走审批；
9. 从干净 Git 提交在 Linux CI 产出 Web/Voice 制品；
10. 服务器先执行计划模式，再候选端口启动；
11. readiness 同时核对 releaseId、commitSha、BUILD_ID、assetDigest、数据文件和 SQLite；
12. 通过后原子切换，失败则自动回到旧链接；
13. 验收普通用户页面、登录、导航、灵感预览、画布编辑、播放/下载和关键 API；
14. 观察期通过后再清理超出保留策略的旧制品。

### 9.2 后续增量发布

- 代码增量：Git 只推差异，CI 仍从完整提交构建一个小型、完整、不可变的服务制品。服务器传输的是新服务制品，不是散乱文件补丁。
- 素材增量：按 SHA-256 HEAD/清单比对，只上传 COS 中不存在的对象；当前约 1.30 GB 的正式素材若未变化就不重复上传。被排除的约 1.27 GiB 测试证据更不会进入此链路。
- 数据变化：由业务 API、数据库事务或独立迁移处理，永远不跟代码复制。
- 依赖变化：锁文件变化会触发相应服务重建；CI 缓存加快安装，但制品仍完整验证。
- 配置变化：非敏感模板走 Git；生产值走 Secret Manager。配置变更也要生成新 releaseId，禁止登录服务器临时改完不留记录。

“增量”指少传、少构建、少重启，不指在生产目录里覆盖几个散文件。完整服务制品加原子链接比散文件覆盖更快、更可审计，也更容易回滚。

### 9.3 一键直接替换与运行态回滚

用户操作层可以、也应该只有“一条命令直接替换当前版本”，不需要人工改 Nginx、挑目录或手工切链接；但这里的“直接替换”不等于把压缩包解到正在运行的目录。部署程序内部必须完整执行：`staging` 解包与校验 → 候选进程验证 → 不可变 release 入库 → 受控替换 `current-*` → PM2 reload → 最终代码/素材/进程/端口/readiness 组合身份校验。任何一步失败或收到 HUP/INT/TERM，都自动恢复上一组合身份；第一次部署失败则必须证明候选链接、PM2 进程和端口都已清理。

Git 仓库是源码、锁文件、发布脚本和审计历史的灾难恢复来源，不是服务器秒级运行态回滚。Git 不包含 Linux 已构建制品、服务器 BUILD_ID、Secret、PM2 进程状态、素材 READY、会员数据库和用户上传；因此服务器仍保留最近 2–3 个不可变 release 和对应资产指针。这个内部保留不增加日常操作步骤，却能避免一次失败覆盖把线上变成“半新半旧”。

## 10. 服务器部署协议

服务器部署脚本只接受以下输入：

- release mode；
- service；
- 不可变制品文件；
- 外部提供的制品 SHA-256；
- releaseId；
- 固定发布根目录；
- 与 releaseId 精确相等的一次性执行批准。

服务器的代码输入只有 CI 不可变制品，不能是 Git 工作树、开发机目录或“整个仓库压缩包”。部署身份不得通过 `git pull && pnpm build` 现场生产新版本，也不得用全仓 `cp`、`scp`、`rsync` 或解压覆盖 `/data/web/shared`；`shared` 只能初始化一次并按独立数据协议维护，代码发布前后必须验证其摘要和挂载身份不变。

标准顺序：

1. **计划阶段（零写入）**：检查根标记、目录边界、制品外部 SHA、压缩包路径安全、manifest schema、Git/BUILD_ID/asset 身份、Linux/ABI/libc、shared 数据文件和素材 READY。
2. **加锁**：同一时刻只允许一个发布事务。
3. **安全解包**：只在 `staging/<release-id>` 中解包，拒绝绝对路径、`..`、符号链接逃逸和重复 releaseId。
4. **完整性验证**：逐文件核对制品清单与 SHA。
5. **候选启动**：Web 使用 15100–15149，Voice 使用 15150–15199；候选进程只绑定 `127.0.0.1`。
6. **readiness 门禁**：要求 `ready: true`，并精确匹配 service、releaseId、commitSha、BUILD_ID、assetDigest；同时验证数据、数据库和目录可用性。
7. **身份验证**：确认候选端口由刚启动的候选 PID 持有。
8. **不可变入库**：移动到 `releases/<release-id>/<service>`，不覆盖旧版本。
9. **受控链接切换**：单个 `current-*` 链接各自原子切换；Web 与资产双链接只有通过前述兼容超集门禁后才能按顺序切换，不能宣称为双指针原子事务。最终 Web 必须和它声明的资产版本一致。
10. **PM2 startOrReload**：按服务独立重载，并核对 PM2 环境和端口归属。
11. **生产 readiness**：再次核对完整身份，不接受仅 HTTP 200。
12. **数据不变校验**：发布前后 `shared/data` 摘要必须一致。
13. **自动回滚**：任一步失败，恢复旧代码/资产链接和旧 PM2 身份；不恢复或覆盖 shared 数据。
14. **审计记录**：追加时间、releaseId、service、制品 SHA、commit、assetDigest 和操作者/审批记录。

示例只展示参数形态。先在服务器执行零写入 plan；只有 plan、备份、候选条件和本次人工审批都通过后，才允许 execute：

```bash
# 先从 CI/私有制品库取得 archive 和外部 SHA-256，再进行零写入计划检查
bash scripts/deploy-artifact-vnext.sh --plan \
  --release-mode WEB \
  --service web \
  --artifact /data/direct-deploy/incoming/web-<release-id>.tar.gz \
  --sha256 <64-char-artifact-sha256> \
  --release-id <release-id> \
  --root /data/web

# 明确批准值必须与 releaseId 完全相等；不要把此变量写进长期环境配置
DEPLOY_EXECUTION_APPROVED=<release-id> \
bash scripts/deploy-artifact-vnext.sh --execute \
  --release-mode WEB \
  --service web \
  --artifact /data/direct-deploy/incoming/web-<release-id>.tar.gz \
  --sha256 <64-char-artifact-sha256> \
  --release-id <release-id> \
  --root /data/web
```

Voice 把 mode/service 改为 `VOICE`/`voice`。资产发布先通过 `verify-public-asset-release.mjs` 做磁盘全 SHA 验证，或使用 `publish-public-assets-cos-vnext.mjs` 先生成只读计划；COS 真正执行必须另行提供短期最小权限凭据和精确确认值。不要在文档命令中保存真实凭据。

每个已安装资产 release 的实际后端必须从它自己的 READY `storageBackend` 读取；`ASSET_DELIVERY_MODE=auto` 表示接受该回执，显式 `disk`/`cos` 只用作本次目标资产的策略约束，不能拿目标后端去误判旧版本。代码发布若复用同一 asset digest，不重新上传 1.30 GB 素材，同一 plan 或 execute 事务内也只做一次完整内容校验。plan 和 execute 仍各自独立校验，防止两阶段之间被篡改。

只有在资产目录由独立 `root/asset-installer` 写入、deploy 用户只有只读权限，且 READY、manifest、目录权限和不可变标记均被独立封存后，才可以启用可信快速校验来避免每次读取全部素材内容；仅凭缓存文件或 `chmod` 不能跳过 SHA-256。未完成这项服务器权限隔离前，发布系统继续选择安全的完整校验，而不是为了快而默许素材错配。

COS 执行成功后，应把远端 READY 保存到 Git 忽略的 `dist`，再按 manifest 生成可搬运的服务器轻量 bundle；大图、视频和音频仍由 COS/CDN 提供，JSON、字幕、manifest 与 READY 留在本地 asset release。计划模式和执行模式示例如下，materialize 不会切换 `shared/assets/current`：

```bash
# 只读 COS 上传计划
node scripts/publish-public-assets-cos-vnext.mjs

# 真正 COS 上传完成且做完全量远端内容 SHA 后，输出一份本地 receipt
node scripts/publish-public-assets-cos-vnext.mjs --execute \
  --confirm sha256-<asset-digest> \
  --receipt-output dist/asset-ready/public-assets.ready.v1.json

# 先看服务器轻量 bundle 计划，再按同一 assetVersion 精确批准
node scripts/materialize-public-asset-release-vnext.mjs \
  --mode cos \
  --receipt dist/asset-ready/public-assets.ready.v1.json \
  --location cos://<bucket>/assets/releases/sha256-<asset-digest>

node scripts/materialize-public-asset-release-vnext.mjs \
  --mode cos --execute \
  --confirm sha256-<asset-digest> \
  --receipt dist/asset-ready/public-assets.ready.v1.json \
  --location cos://<bucket>/assets/releases/sha256-<asset-digest>
```

随后只把生成的 `dist/asset-releases/sha256-<digest>` 目录传到服务器专用 asset staging，由 `install-public-asset-release-vnext.sh` 再次按 manifest/receipt 验证并原子入库。禁止手工把 JSON 或几张图片散拷到 `current`。第一次建站可在“当前资产指针完全不存在”时使用专门的初始化批准；后续 asset 指针只能由带兼容超集门禁的 Web 发布事务协调切换。

明确禁止：

- 服务器 `git pull`、`git checkout` 或从工作分支运行；
- 服务器 `pnpm install`、`npm install`、`next build`、Prisma generate；
- 把开发机 `node_modules` 或 `.next` 复制到服务器；
- 部署脚本执行数据库 `push`、seed 或未经审批的迁移；
- 复制空 `data/`、SQLite、uploads 覆盖 shared；
- `pm2 delete` 后再赌新服务能否启动；
- 仅以 Nginx/主页 HTTP 200 判定成功；
- 手工覆盖 `current-*` 指向目录中的文件。

## 11. Readiness 与验收门禁

### 11.1 构建前门禁

- Git 工作树干净，HEAD 可追踪；
- `origin` 与 `backup` 已配置，禁止 force push；
- source snapshot、release policy 与 asset manifest SHA 相互匹配；
- mutable data、uploads、数据库、密钥不在 Git/制品中；
- 锁文件存在且 frozen install 成功；
- 静态 verifier、类型检查和构建检查通过；
- 变更已分类为 DOCS/ASSET/WEB/VOICE/FULL；
- 需要迁移时，迁移先决条件与回滚方案已经单独批准。

### 11.2 资产 READY 门禁

- manifest 项目身份、schema、路径排序、文件数、总字节数有效；
- 每个文件完整 SHA-256、大小、路径边界和真实文件类型验证通过；
- 不包含 `public/uploads`；
- 只包含 release policy 批准的 12 个目录；显式拒绝 `storyboard-reviews`、`demo-assets` 和任意未登记的 `public` 二进制；
- `product-assets/**/*.json` 不含 `http://`、`https://`、`q-sign-`、`/api/video/proxy` 或 `127.0.0.1` 等临时/环境型引用；生产 `src` 也不得引用证据目录；
- assetVersion 等于 `sha256-<digest>`；
- READY 回执最后生成，且记录 full-sha256、storageBackend、location、verifiedAt；
- Web 制品嵌入的 manifest SHA 与目标资产版本完全一致。

### 11.3 运行 readiness 门禁

主站 `/api/release-readiness` 和 Voice `/voice-platform/api/release-readiness` 必须返回并匹配：

```json
{
  "ready": true,
  "service": "web-or-voice",
  "releaseId": "expected-release-id",
  "commitSha": "expected-full-sha",
  "buildId": "expected-next-build-id",
  "assetDigest": "web-only-expected-digest"
}
```

同时检查：必要 JSON 可解析、运行目录可用、素材 READY、Voice SQLite header/quick_check/必要表可读。主站 readiness 的 `checks.database` 必须返回预期 `contractId`/`contractVersion`，并且表、列、RPC、RPC 参数缺失计数及禁止 RPC 命中数全部为 0；`checks.referenceData` 还必须证明至少存在一项有效 Voice 激活价格，且 Manju 所有必需域均已就绪。任一数据库契约或引用数据检查失败，顶层 `ready` 就不能为 `true`，不得用候选端口 HTTP 200 绕过。readiness 路由只允许本机部署器访问，Nginx 对公网返回 404。

### 11.4 上线后验收

- 新浏览器上下文访问，不复用旧缓存标签页作为唯一证据；
- 主页、导航、灵感广场、详情、画布加载和编辑；
- 缩略图先加载，原图按需加载，失败回退可恢复；
- 静态资源状态码、Content-Type、Range、CDN cache hit；
- 登录、会员身份、关键读取 API；
- Voice 数据与参考音频；
- 需要真实付费生成时，另行取得当次授权，并完整验证任务、资产、计费、退款和幂等；静态通过不能代替真实付费 E2E。

### 11.5 构建、发布与回滚的统一硬门禁

| 阶段 | 必须为真 | 任一失败时 |
| --- | --- | --- |
| PR 合并前 | diff 分类完整；Git 工作树干净；secret/license/lock/static verifier 通过；database/asset 影响已声明 | 不合并，不打 Tag |
| CI 构建 | Linux、Node/pnpm/frozen lock 固定；Web/Voice 分开构建；manifest、provenance 和外部 checksum 一致 | 不上传或立即隔离制品 |
| 发布前 | 数据库契约缺失全部归零；资产 READY；生产备份和抽样恢复通过；服务器 `--plan` 通过；旧回滚目标健康 | NO-GO，不运行 `--execute` |
| 候选切换前 | 候选 PID/端口归属正确；readiness 精确匹配 releaseId、commitSha、BUILD_ID、assetDigest；shared 数据摘要不变 | 停候选并清理 staging，不切链接 |
| 生产切换后 | 生产 readiness、关键 API、登录、导航、画布、静态资源和监控观察期通过 | 在既定窗口原子切回旧制品/资产 |
| 回滚完成后 | 旧版本身份重新匹配；普通用户烟测通过；事故和回滚记录归档 | 继续保持流量冻结并升级事故响应 |

数据库门禁不得被“本次只是前端改动”绕过，因为新 Web 仍可能触达既有付费、会话、画布、Voice 或会员链路。当前生产快照仍是 `32 tables / 17 columns / 34 RPCs missing`，所以当前结论是 NO-GO；只有同一契约 verifier 重跑后所有缺失数组为空，才允许把这一项改为 GO。

发布与回滚都禁止重新构建：发布使用本次 CI 制品，回滚使用历史已验收制品。若旧制品、旧 assetVersion 或旧配置已经不可用，就没有合格回滚点，本次发布应在切换前停止，而不是上线后再临时找文件。

### 11.6 Manju 配置控制面的迁移、对账与回滚顺序

Manju 配置控制面不是普通代码覆盖项。数据库所有者必须在备份、隔离演练和审批后，严格按以下 forward 顺序应用三个不可变迁移，任一步失败都停止后续步骤：

应用与数据的上线编排遵循 **expand → migrate → contract**：expand 版本先具备读取旧历史和执行受控升级的兼容能力，但不得继续激活旧 schema；migrate 阶段使用可 dry-run、锁定目标、校验 storage generation/active pointer CAS 的升级 runner，逐域生成并发布 1.1.0 revision，再核对活动 ETag/hash；只有生产 active 全部升级、readiness 通过且恢复路径已演练，才切换到只运行 latest schema 的 contract 版本。若没有 expand 版本或受控升级 runner，禁止先切新应用再临时修数据。

1. `20260825123000_manju_config_control_plane.sql`：建立基础 revision、release、active 与 audit 事实表；
2. `20260829220000_manju_config_actor_text.sql`：把操作者标识升级为受约束文本；
3. `20260829223000_manju_config_storage_state.sql`：建立 compat/native 权威状态、原子提交、对账和切换 RPC。

第三步的 `MANJU_CONFIG_STORAGE_NATIVE_SCOPE_WITHOUT_ACTIVE_REQUIRES_RECONCILIATION` 是发布阻断，不是可忽略告警。只要某个 scope 已有 native revision 却没有 active pointer，迁移就必须失败关闭；先导出并核对这些 revision，再通过单独审批的恢复操作建立明确 active pointer 或处置孤立数据，禁止把 draft-only native scope 静默标成 compat。

已有 native active 的 scope 会先进入 `migrating` 隔离态，业务读写不得猜测存储来源。选择 compat 时，操作员必须在同一锁下提交 compat 的 storage revision、active release/revision/hash，以及 native 的 active release/revision/hash。两个 payload hash 不同则必须先审阅差异，并显式批准 `p_allow_payload_divergence=true`；未批准时 RPC 失败，批准决定和双边证据都写入 audit。选择 native 或执行最终 cutover 同样必须核对双边活动版本和 ETag/hash，audit 的 `previous_storage` 必须来自锁定后的真实旧状态。

`reconcile_manju_config_storage_to_compat` 只允许由受控 reconcile runner 调用：runner 必须先复用应用的 `parseEnvelope`/domain validator 对完整 drafts、active、history 链和 payload hash 做精确校验，再把 storage revision、generation 和双边活动证据交给 SQL 在锁内 CAS。SQL 负责不可绕过的状态、锁、关键证据与审计，不用另一份容易漂移的 PL/pgSQL 重新实现整套 TypeScript JSON schema。

配置 schema 升级也是数据迁移门禁。发布前要盘点 active、draft 和 history 的 schema version；旧版本只能按其历史契约读取，不能用新契约伪装成同一版本，也不能重写历史 payload/hash。需要升级时，从旧 payload 生成满足最新 schema 的新 draft，经校验后发布为新 revision/release。seed/dry-run 必须把 schema version 纳入比较；payload hash 相同但 schema 非最新时应报告 `schema-upgrade-required`，不能报告 `current`。旧 release 若不满足当前运行契约，只能查看，不能直接 rollback 激活；恢复其业务语义应走 upgrade-rollback。

数据库回滚顺序固定为 **storage-state rollback → actor-text rollback → base rollback**，不得倒序：

1. `20260829223000_manju_config_storage_state.rollback.sql`：对任何 native state、`storage_reconcile` 或 `cutover` audit 都失败关闭，此时只能单独评审恢复或向前修复；
2. `20260829220000_manju_config_actor_text.rollback.sql`：检查 storage table 和相关 RPC 是否仍存在；若 storage rollback 未完成，返回 `MANJU_CONFIG_ACTOR_ROLLBACK_REQUIRES_STORAGE_ROLLBACK_FIRST`；
3. `20260825123000_manju_config_control_plane.rollback.sql`：这是破坏性 base rollback，只有前两层完全撤销、备份可恢复且单独批准时才可执行。

本地静态 verifier、TypeScript 或 ESLint 通过，只证明源码合同自洽，不证明生产数据已完成上述迁移。上线前仍须保存生产只读盘点、迁移执行回执、PostgREST schema refresh、状态对账 audit、readiness 和普通用户验收证据。

## 12. 回滚标准

回滚不是重新构建旧代码，而是把原子链接切回已经验收过的旧制品：

| 事故 | 回滚对象 | 不应回滚/覆盖 |
| --- | --- | --- |
| Web 新版本异常 | `current-web` 与其匹配的资产指针 | shared 数据、上传、数据库 |
| Voice 新版本异常 | `current-voice` | Voice DB，除非另有数据事故流程 |
| 新素材异常 | `shared/assets/current` 或 CDN 当前别名 | Web 代码，前提是旧素材仍满足代码契约 |
| 数据迁移异常 | 走数据库专用回滚/向前修复方案 | 不用代码回滚假装恢复数据 |
| 密钥错误 | 恢复上一受控 Secret 版本并重载 | 不改 Git 历史 |

至少保留当前和前两个已验收制品及对应 assetDigest。回滚后仍要重新执行 readiness、身份、端口归属和普通用户烟测，并追加审计记录。

## 13. 备份协议：3-2-1 与恢复演练

3-2-1 的最低要求是：至少 3 份数据、2 种介质或独立故障域、1 份异地/异账号且不可由生产应用身份删除。

### 13.1 各类备份

- 源码：本地干净工作树 + `origin` + `backup`；Tag/分支保护；定期导出 bare mirror 到独立对象存储。
- 公共资产：COS 版本控制、清单、对象校验；关键资产可跨地域复制到第二 bucket/账户。
- 会员/业务数据库：托管数据库 PITR + 每日加密逻辑备份 + 周期性异地副本。
- Voice SQLite：一致性快照前执行 `quick_check`；复制时停写或使用 SQLite backup API，禁止直接复制正在写的 WAL 状态；备份后再次校验。
- JSON 数据：原子快照、schema 版本、SHA-256 和时间戳；恢复前先在隔离目录解析验证。
- 用户上传：COS 版本/生命周期，必要时跨区复制；删除采用回收期而非立即永久删除。
- 密钥：由密钥系统管理版本与恢复，不把明文密钥放进普通备份包。
- 发布审计：制品 manifest、checksum、CI 日志、部署历史和验收报告长期保存。

### 13.2 RPO、RTO 与保留标准

`RPO` 是最多可接受丢失多少时间的数据，`RTO` 是从确认事故到恢复可用服务的最长目标时间。以下是 vNext 的初始业务目标，不是未经演练就可以宣称已经达到的 SLA：

| 对象 | 目标 RPO | 目标 RTO | 必要手段 |
| --- | --- | --- | --- |
| 已发布 source、Tag、Web/Voice artifacts | 0；已发布身份不得丢 | 1 小时内恢复一个已验收版本 | origin + backup + 私有制品库 + checksum + 隔离恢复演练 |
| 会员、余额、订单、计费、授权数据库 | 不高于 15 分钟 | 4 小时内恢复关键读写 | 托管 PITR、每日加密逻辑备份、异账号副本、事务/对账 |
| Voice SQLite、shared JSON/运行状态 | 不高于 1 小时 | 4 小时内恢复对应服务 | SQLite backup API/停写快照、原子 JSON 快照、schema/SHA 校验 |
| 用户上传与私有媒体 | 成功入库后不高于 1 小时 | 8 小时内恢复访问 | COS 版本控制、跨故障域复制、对象清单与抽样下载 |
| 公共产品资产/CDN 映射 | 0；已 READY 版本不可变 | 2 小时内回到上一版本 | 内容寻址、双版本保留、disk fallback、CDN 映射回滚 |
| 密钥与生产配置 | 上一受控版本必须可恢复 | 2 小时内恢复并重载 | Secret Manager 版本、双人复核、禁止写入普通备份包 |

如果现有云产品、备份频率或预算达不到表中目标，应记录实际值、差距、责任人和整改期限；涉及资金、会员或不可重建用户资产的差距未接受前，相应高风险发布保持 NO-GO。RPO/RTO 只能由真实恢复演练计时证明，不能由“备份任务显示成功”推断。

保留周期基线：

- 数据库/PITR：按业务可接受的 RPO 配置，建议至少 5–15 分钟级恢复点；
- 每日备份：保留 14–30 天；
- 每周备份：保留 8–12 周；
- 每月备份：保留 12 个月；
- 重要大版本：单独长期保留源码 Tag、制品、asset manifest 和迁移前快照。

具体保留期应根据数据量、成本、法规和业务损失评估，不机械照抄示例。

### 13.3 恢复演练

备份成功日志不等于可恢复。至少每月在隔离环境抽样执行：下载、解密、校验、数据库恢复、应用挂载、readiness 和关键查询。记录实际 RPO/RTO、失败点和整改责任人。未演练的备份只能标记为“存在”，不能标记为“可恢复”。

## 14. 性能与发布时间目标

以下是体系成熟后的工程目标，不是对当前网络和服务器的保证：

| 场景 | 目标 | 主要手段 |
| --- | --- | --- |
| DOCS | 0 分钟生产部署 | 不触发发布 |
| 单服务 CI 构建 | 常规 5–15 分钟 | pnpm store/Next 缓存、服务独立矩阵 |
| 单服务制品传输 | 常规 1–3 分钟 | standalone 小制品、就近私有对象存储 |
| 候选验收与切换 | 30–90 秒 | 候选端口、readiness、原子链接、PM2 reload |
| 日常资产增量 | 只上传缺失对象 | SHA-256 HEAD/清单比对、并发限流、断点续传 |
| 首次约 1.30 GB 正式资产迁移 | 取决于上行带宽，允许较长 | 一次性迁移、分片上传、失败续传；以后不重复全量；测试证据不迁移 |
| 回滚 | 1–3 分钟 | 旧制品保留、原子链接、无需重建 |

性能验收要看 P50/P95 TTFB、LCP、首屏传输字节、资源缓存命中率、导航交互延迟、错误率和服务器 CPU/内存，而不是只看“部署命令用了多久”。

## 15. 监控与运维补充

容易被忽略但必须补上的事项：

- 为 Web/Voice、Nginx、数据库、COS/CDN 分别建立指标和告警；
- 磁盘使用率、inode、内存/OOM、PM2 重启次数、5xx、readiness 失败必须告警；
- 记录 releaseId/commitSha/BUILD_ID/assetDigest 到日志上下文，便于一眼定位版本；
- 建立 CSP、依赖漏洞、SBOM、许可证与镜像/制品签名流程；
- CI 第三方 Action 与基础镜像应固定到审核过的版本或 digest，并由自动化提交升级 PR；
- 设置 CDN 源站保护、限流、防盗链和大文件带宽预算；
- 数据迁移使用 expand/contract：先兼容读写，再切代码，最后清理旧字段；
- 新旧 Web/Voice API 至少在一个发布窗口内保持兼容，避免必须冒险执行 FULL；
- 对供应商 API、付费生成和回调建立 traceId、幂等键、超时、重试与对账；
- 制定密钥泄露、数据库误删、COS 误删、CDN 污染和制品供应链事故预案；
- 发布窗口之外禁止手工线上热修。紧急修复也必须回写 Git、CI 和 Tag，消除配置漂移。

### 15.1 质量承诺边界：不承诺“永远零 BUG”

行业标准不能诚实地承诺任何复杂系统“以后不会出现任何 BUG”。vNext 可以并且必须承诺的是：已知 P0/P1 阻塞项不带病上线；每个 release 可追踪；变更范围可审计；失败会 fail-closed；数据不被代码覆盖；监控能及时发现异常；旧制品和备份可以在目标 RTO 内恢复。把这些机制写成“绝对零 BUG”反而会掩盖残余风险和未验证边界。

每次 GO 决策必须附一份残余风险记录，至少包括未覆盖浏览器/设备、第三方服务、数据迁移、缓存/CDN、并发、付费链路和恢复演练。`0 known release blockers` 只表示当前门禁中没有已知阻塞，不等于未来缺陷为零。上线后出现异常时，先限流/降级/回滚并保护数据，再修复源码、走 PR/CI/Tag 重新发布；禁止直接在服务器热改后把现场当成新基线。

## 16. 实施顺序与当前 Go/No-Go

建议按以下顺序落地：

1. 固化 release policy、资产清单和 runtime data boundary；
2. 生成相邻干净 Git 工作树，建立首个可审计提交；
3. 配置 `origin`、`backup`、受保护 `main` 与 Tag 规则；
4. 固化 `database-contract.v1.json`，保存当前只读探针 NO-GO 证据；
5. 数据库所有者完成备份、迁移评审和恢复方案；经单独授权后才应用迁移并刷新 schema cache；
6. 重跑同一 OpenAPI 契约，确认表、列、RPC、参数缺失全部归零且禁用 RPC 不可见；
7. 在 Linux CI 跑 vNext verifier、Web/Voice 构建和不可变打包；
8. 首次上传并全量验证资产，生成 READY；
9. 在服务器初始化 shared 目录、权限、根标记、PM2/Nginx 和 Secret；
10. 备份并抽样恢复当前生产数据，记录实际 RPO/RTO；
11. 先执行部署 plan 模式，确认零写入；
12. 使用非 5000 候选端口演练，验证自动回滚；
13. 经人工批准后才执行单服务生产切换；
14. 上线后按新浏览器上下文做功能和性能验收；
15. 完成至少一次资产、代码和数据库恢复演练。

当前结论是 **尚未授权也尚未完成生产部署，并且数据库契约明确 NO-GO**：生产只读快照仍缺少 32 个表路径、17 个关键列标记和 34 个 RPC 路径。只有 Git 基线、数据库契约缺失归零、Linux CI 制品、资产 READY、shared 数据、服务器环境、备份、plan、候选 readiness 和回滚演练全部有证据时，某个具体 releaseId 才能被标记为 GO。任何一项缺失都应 fail-closed，而不是“先覆盖上去再看看”。

## 17. 日常操作清单

### 开发完成后

- [ ] 保存源码，但不把运行数据、素材原件或密钥加入 Git；
- [ ] 生成/验证资产清单；
- [ ] 同步到干净 Git 工作树；
- [ ] 运行变更分类；
- [ ] PR 已声明 database/asset/runtime data 影响和回滚对象；
- [ ] 在工作分支提交并推 origin；
- [ ] PR/MR 门禁通过并合并；
- [ ] 同步 backup，并确认提交 SHA 一致；
- [ ] 创建不可变 Tag。

### 发布前

- [ ] Linux CI 用 Node 24.19.0、pnpm 9.0.0、frozen lock 构建；
- [ ] Web/Voice 独立制品和 SHA 已保存；
- [ ] 资产 digest/manifest/READY 完整；
- [ ] 生产数据库契约表/列/RPC/参数缺失全部为 0，禁止 RPC 不可见；
- [ ] 数据库迁移（如有）已独立评审、备份且有恢复/向前修复方案；
- [ ] 生产备份及抽样恢复验证完成；
- [ ] 服务器 plan 模式通过；
- [ ] 候选 readiness 身份完全匹配；
- [ ] 回滚目标仍健康；
- [ ] 人工批准值与 releaseId 精确匹配。

### 发布后

- [ ] 生产 readiness 和 PM2/端口身份通过；
- [ ] shared 数据摘要未被代码部署改变；
- [ ] 新浏览器完成普通用户烟测；
- [ ] CDN/资源/导航/画布性能无回退；
- [ ] 5xx、错误率、内存、磁盘、带宽观察期正常；
- [ ] 部署历史、验收证据和回滚点已归档。
