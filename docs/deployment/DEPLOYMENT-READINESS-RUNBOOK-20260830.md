# 自媒体操盘手部署准备运行手册（2026-08-30）

本手册用于把“本地代码优化完成”与“可以生产部署”分开判断，避免每次部署变成大杂烩。

## 一句话结论

代码优化可以快速迭代；生产上线必须同时满足 Git、数据库、运行时配置、素材、服务器共享目录五个闸口。任何一个闸口未过，都不能把“代码能构建”说成“可以上线”。

## 本项目推荐生产拓扑

已按“小白少决策、系统多兜底”的原则固化推荐方案：

```text
origin  = Gitee 私有主仓：zimeiti-caopanshou-source-vnext
backup  = GitHub / GitLab / Coding 等独立私有备份仓：zimeiti-caopanshou-source-vnext-backup
素材    = 短期 shared/assets，长期 COS/OSS/S3 + CDN
数据库  = DEPLOY_DATABASE_URL 单独迁移，部署脚本不自动改库
服务器  = 不可变 artifact 覆盖应用目录，不覆盖 shared 持久化目录
```

不含密钥的模板文件：

```text
deploy/environments/production-topology.template.json
deploy/environments/production.env.example
```

## 两种检查模式

### 0. 闭环总控模式

日常先看人能读懂的状态结论：

```bash
npm run deploy:status
```

如果它显示“暂不能正式部署”，就只处理它列出的阻断项，不要跳过门禁去覆盖服务器。

需要给自动化或 CI 使用时，再输出机器可读 JSON：

```bash
npm run deploy:close-loop
```

生产环境变量单独检查：

```bash
npm run deploy:env:verify
```

如果需要从一个私有 env 文件检查，不要把文件提交到 Git，只在本机或 CI Secret 中使用：

```bash
npm run deploy:env:verify -- --env-file=<私有环境变量文件>
```

如果外部仓库账号暂时还没创建好，先生成离线交接包，封存当前干净发布仓：

```bash
npm run deploy:handoff
```

该命令会在 `Git发布仓/release-handoffs/` 下生成：

- Git bundle：保留 Git 历史，后续可推送到新建主仓或备份仓；
- source zip：给平台导入或人工审查使用；
- handoff manifest：记录 commit、源码指纹、素材摘要和安全边界。

这个交接包不是服务器最终运行制品，不包含 `.env`、`.next`、`node_modules`、数据库、上传素材或运行日志。

如果已经拿到两个正式私有仓库地址，先用安全脚本检查，不要手工改 Git remote：

```bash
npm run deploy:remotes -- --origin=<主仓库地址> --backup=<备份仓库地址>
```

确认输出中的两个 host 都正确、且不含密码或 token 后，再写入发布仓：

```bash
npm run deploy:remotes:apply -- --origin=<主仓库地址> --backup=<备份仓库地址>
```

如果正式 `origin` / `backup` 已经配置，并且需要把当前发布仓 `main` 推送到两个正式远端：

```bash
npm run deploy:close-loop:push
```

该命令不会自动执行数据库 DDL，不会覆盖服务器，也不会输出数据库密码。数据库迁移仍必须由备份回执、目标 host 和 migration manifest SHA 三重确认后单独执行。

### 1. 代码包准备模式

用于本地开发、代码优化、发布仓同步前确认：

```bash
npm run deploy:ready:code
```

该模式只把代码包自身问题设为硬阻断，例如：

- 受管源码审计失败；
- 本地 `.next/BUILD_ID` 与 `127.0.0.1:5000/api/version` 不一致；
- Git 发布仓不存在、分支错误或工作区不干净。

数据库、正式 Git 远端、生产运行时配置在此模式中只作为 warning 输出，不阻断继续优化。

### 2. 生产部署模式

用于真正覆盖/切换服务器前确认：

```bash
npm run deploy:ready
```

该模式会把以下问题全部设为硬阻断：

- 正式 `origin` 和独立 `backup` Git 远端缺失；
- 生产数据库 schema readiness 仍是 `migration_not_ready`；
- `/api/youcai/runtime-config` 不是 `ok: true, state: ready`；
- `/api/youcai/skills` 无法读取已发布 Skill 包；
- 发布仓不是干净 `main`；
- 本地源码审计失败。

## Git 标准

`当前版本/` 是本地开发事实源，不是 Git 仓库。Git 发布只通过：

```text
当前版本/ → scripts/release-workflow.mjs sync → Git发布仓/zimeiti-caopanshou-source-vnext
```

生产标准需要两个外部远端：

```text
origin  = 主 Git 仓库
backup  = 独立备份 Git 仓库
```

`local-archive` 只能作为本机归档，不能冒充正式生产远端。

## 数据库标准

应用部署不得偷偷迁移数据库。生产数据库必须先备份，再执行 reviewed forward-only migration，之后运行：

```bash
npm run release:vnext:schema:verify
```

只有 readiness 不再是 `migration_not_ready`，才能进入生产代码部署。

当前漫剧工作台/Skill/Canvas 相关关键迁移包括：

```text
supabase/migrations/20260825123000_manju_config_control_plane.sql
supabase/migrations/20260829220000_manju_config_actor_text.sql
supabase/migrations/20260829223000_manju_config_storage_state.sql
supabase/migrations/20260827093000_skill_packages_runtime.sql
```

迁移完成后，再执行配置 schema 升级/seed，把 `prompt/content/media/feature_flags/skill` 发布到 1.1.0。

## 素材标准

Git 不存用户上传、会员数据、生成历史和密钥。大素材按 manifest 管理：

- 公共展示素材、示例图、视频：优先 COS + CDN；
- 服务器硬盘：保留版本化、可校验的兜底资产 release；
- 用户上传和生成结果：长期进入对象存储，数据库只保存归属、权限、hash、尺寸、时长和业务状态；
- `public/uploads`、`shared/uploads` 永远不随代码覆盖。

## 服务器覆盖标准

允许快速覆盖应用代码目录，但不允许覆盖 shared 数据目录。

可覆盖：

- 应用代码 release；
- `.next/standalone`；
- `.next/static`；
- 版本化 public 静态资源。

不可覆盖：

- `shared/data`；
- `shared/runtime`；
- `shared/uploads`；
- `shared/assets/current` 指向的已发布资产；
- `shared/logs`；
- `shared/backups`；
- 生产 `.env`；
- 数据库。

真正执行服务器部署使用：

```bash
bash scripts/deploy-artifact-vnext.sh --plan ...
DEPLOY_EXECUTION_APPROVED=<approval-id> bash scripts/deploy-artifact-vnext.sh --execute ...
```

部署脚本只接受已构建、已校验、不可变 artifact；它不会在服务器上 `git pull`，不会安装依赖，不会现场构建，也不会迁移数据库。

## 当前红条含义

如果漫剧页面顶部显示“内置安全基线”，含义不是页面没刷新，而是运行时配置没有 ready：

- `MIGRATION_NOT_READY`：数据库迁移/RPC 缺失；
- `CONFIG_STORE_CORRUPT`：兼容配置仍是旧协议或活动发布链不一致；
- `CONFIG_INCOMPLETE`：公开运行时域未发布完整 1.1 配置。

此时前台可显示内置目录，但后台新发布的提示词、Skill、示例和素材不会进入生产运行时。

## 推荐执行顺序

1. 本地修改代码。
2. 跑 TypeScript 和目标 verifier。
3. 跑 `npm run deploy:ready:code`。
4. 同步 Git 发布仓并提交。
5. 跑 `npm run deploy:close-loop`，确认缺口只剩外部输入。
6. 推送 `origin` 和 `backup`。
7. 生产数据库备份。
8. 执行 reviewed forward-only migrations。
9. 跑 `npm run release:vnext:schema:verify`。
10. 发布 1.1.0 runtime config。
11. 跑 `npm run deploy:close-loop` 和 `npm run deploy:ready`。
12. 构建生产 artifact。
13. 服务器 `--plan`。
14. 服务器 `--execute`。
15. 验收 `/api/version`、`/api/release-readiness`、`/api/youcai/runtime-config`、Skill、Canvas、后台配置中心。
