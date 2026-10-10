# 本地空盘灾备控制面

## 1. 目标与边界

本控制面用于本地事实盘完全损坏后，在全新空盘上重建可验证的源码和素材副本。三个脚本默认均为 `plan`，不访问网络、不读取凭据、不执行 COSCLI、不连接数据库，也不执行数据库恢复。

数据按五类处理：

| 类别 | 权威来源 | 本工具行为 |
| --- | --- | --- |
| Git A 轨 | 私有 Git 的 exact commit | 按 `.release/source-files.v1.json` 逐文件校验和物化 |
| 公共素材 B 轨 | 版本化 COS release + `public-assets.v1.json` + READY | 生成 COSCLI 命令计划；下载后按版本、大小和 SHA-256 校验 |
| 用户素材 | 私有 COS 稳定 object key/version ID + DB 元数据 | 只消费外部生成的联合 inventory；本工具不查 DB/COS |
| 上游临时 URL | 非平台权威存储 | 拒绝进入 inventory；如需持久恢复，必须先转存成受管 COS 对象 |
| 本地临时素材 | cache/staging/临时下载/可再生文件 | 不纳入恢复承诺 |

数据库加密包只复制和校验。真正恢复必须继续在隔离 Linux 非生产环境使用 `scripts/restore-data.sh`，不得在本工具中绕过数据库身份、角色、隔离盘或回执门禁。

## 2. 输入合同

### 2.1 Source commit receipt

`zimeiti-source-commit-receipt.v1` 必须来自本地 Git 对 exact commit 的只读验证，绑定：

- 40 位 `gitCommit`
- `sourceVersion`
- commit 内 `.release/source-files.v1.json` 的 SHA-256
- `verificationMode=git-object-manifest-sha256`

receipt 不包含 remote URL、凭据或签名 URL。

### 2.2 User object inventory

`zimeiti-user-object-inventory.v1` 是 DB/COS 代理以后生成的接口，不由这些脚本查询：

```json
{
  "schemaVersion": "zimeiti-user-object-inventory.v1",
  "projectId": "zimeiti-caopanshou",
  "environment": "production-recovery",
  "sourceVersion": "R000977",
  "snapshotAt": "2026-10-10T00:00:00.000Z",
  "bucket": "private-user-assets-1250000000",
  "accountId": "cos-account-id",
  "tenantId": "tenant-id",
  "region": "ap-guangzhou",
  "ownerId": "storage-owner-id",
  "databaseIdentity": "production-postgres-cluster-id",
  "crossComponentConsistency": false,
  "files": [
    {
      "relativePath": "uploads/account/object.bin",
      "objectKey": "users/account/object.bin",
      "versionId": "immutable-cos-version-id",
      "bytes": 123,
      "sha256": "<64 lowercase hex>"
    }
  ],
  "fileCount": 1,
  "totalBytes": 123,
  "digest": "<canonical inventory digest>"
}
```

临时 HTTP(S) URL、查询字符串、签名、token、Cookie 或密钥字段会被拒绝。路径穿越、反斜杠、符号链接、大小写碰撞、重复 object version、大小/hash/version 不一致均 fail closed。

### 2.3 3-2-1-1-0 evidence

`zimeiti-recovery-readiness-evidence.v1` 固定包含七项：

1. `primary-copy`
2. `offline-copy`
3. `independent-offsite-copy`
4. `two-failure-domains`
5. `offline-or-immutable`
6. `empty-disk-drill`
7. `zero-verification-errors`

每个已验证项必须同时绑定 `evidence/<receipt>.json`、真实 SHA-256、detached Ed25519 签名和签发者公钥指纹。签名 envelope 还必须绑定 catalog binding、project、environment、target bytes、exact commit、assetVersion、database identity、account 和 tenant，并带唯一 `receiptId`/`nonce`、`issuedAt`/`expiresAt`；有效期和最大证据年龄均不超过 24 小时。同一包内 receipt ID 或 nonce 重放、签名伪造、过期或未来时间都会拒绝。

生产环境只接受仓库受控的 `deploy/policies/recovery-trusted-issuers.v1.json`。当前没有这份可信公钥 allowlist 时，生产 readiness 永远是 `BLOCKED`；调用方临时生成公私钥或自行指定另一份 allowlist 不能把生产变为 READY。零网络测试使用 `fixture-recovery` 临时密钥，不能当作生产证据。

`empty-disk-drill` 和 `zero-verification-errors` 还必须分别绑定包内真实 drill receipt/report 文件及其内容 hash，而不是手写结论。

三份副本还会交叉验证 owner、account/tenant、region、介质和故障域必须互异，offline 必须确为脱机介质，offsite 必须独立且不可变。任一项未验证时 catalog 可生成，但 readiness 必须是 `BLOCKED`。真实 COS、异地副本和空盘演练没有执行时，生产 readiness 必须保持 `BLOCKED`。

## 3. COSCLI 只读命令计划

先生成计划；命令只引用环境占位符，不落盘凭据，也不会被脚本执行：

```text
node scripts/recovery-cos-plan-v1.mjs \
  --public-manifest <downloaded-public-manifest> \
  --public-ready-receipt <downloaded-ready-receipt> \
  --user-inventory <reviewed-user-inventory> \
  --source-version R000977 \
  --git-commit <40-hex> \
  --catalog-binding <64-hex> \
  --environment production-recovery \
  --trusted-issuers deploy/policies/recovery-trusted-issuers.v1.json \
  --public-signature <public-ready.sig.json> \
  --user-signature <user-inventory.sig.json>
```

计划前必须通过非敏感环境身份比对；任何 bucket/account/tenant/region/owner/database identity 不一致都会拒绝。计划同时给出 PowerShell 与 Bash 命令，使用以下占位符：

- `COSCLI_EXE`
- `COSCLI_CONFIG_PATH`
- `RECOVERY_PUBLIC_COS_BUCKET`
- `RECOVERY_USER_COS_BUCKET`
- `RECOVERY_USER_ACCOUNT_ID`
- `RECOVERY_USER_TENANT_ID`
- `RECOVERY_USER_REGION`
- `RECOVERY_USER_OWNER_ID`
- `RECOVERY_DATABASE_IDENTITY`
- `RECOVERY_DOWNLOAD_ROOT`

没有可信 allowlist 和 public/user detached signature 时，仍可生成便于审查的 `BLOCKED_PLAN_ONLY`，但不得据此下载或报告可信恢复计划。人工授权后才能另行执行官方 COSCLI。下载完成后，用 `--download-root`、`--download-receipt`、`--download-signature` 和 `--trusted-issuers` 重跑 plan；除本地 size/SHA/version 外，还验证下载回执的签名、时效和全身份 binding。`--execute --output <new-file> --confirm <plan-sha256>` 只以 no-replace 方式原子写计划文件，仍不执行 COSCLI。

## 4. 原子导出离线包

```text
node scripts/recovery-export-v1.mjs \
  --source-root <verified-checkout> \
  --source-manifest <source-files.v1.json> \
  --source-commit-receipt <source-commit-receipt.json> \
  --git-commit <40-hex> \
  --source-version R000977 \
  --environment production-recovery \
  --public-root <downloaded-public-root> \
  --public-manifest <public-assets.v1.json> \
  --public-ready-receipt <public-assets.ready.v1.json> \
  --user-root <downloaded-user-root> \
  --user-inventory <user-object-inventory.v1.json> \
  --database-package <package.tar.gz.age> \
  --database-receipt <receipt.json> \
  --trusted-issuers deploy/policies/recovery-trusted-issuers.v1.json \
  --source-signature <source-receipt.sig.json> \
  --public-signature <public-ready.sig.json> \
  --database-signature <database-receipt.sig.json> \
  --user-signature <user-inventory.sig.json> \
  --readiness-evidence <readiness-evidence.json> \
  --readiness-evidence-root <directory-containing-item-receipts> \
  --output-root <offline-disk-directory>
```

plan 输出 catalog SHA-256。只有再次加 `--execute --confirm <catalog-sha256>` 才写入。导出通过项目锁定的 Ajv 2020 实现完整加载 Draft 2020-12 schema，并使用严格 RFC3339 `date-time`；不再使用自制 schema 子集。复制使用已打开文件描述符，并在复制前后复核 inode/device/realpath 和目标父目录，阻断 lstat→copy 的 symlink/junction 换位。完整精确树经过 staging 写完、fsync、提交前复验、Windows no-replace rename、父目录 fsync 和最终复验。非 Windows 平台当前对执行提交 fail closed，直到提供等强 `renameat2(RENAME_NOREPLACE)` 实现。

离线包包含源码、公共素材、用户素材、加密数据库包以及所有绑定 manifest/receipt。它不包含数据库明文、secret、签名 URL 或 COSCLI 配置。

## 5. 空盘恢复演练

目标必须是已存在且完全为空的真实目录：

```text
node scripts/recovery-restore-v1.mjs --bundle <offline-bundle> --target <empty-directory>
node scripts/recovery-restore-v1.mjs --bundle <offline-bundle> --target <empty-directory> \
  --execute --confirm <catalog-sha256>
```

恢复结果位于 `restored-<catalogId>/`。脚本使用本机权威 Draft 2020-12 schema 校验 catalog，并要求包内 schema 字节与其 SHA 完全一致；随后重新验证精确 inventory、所有大小/SHA、readiness 真实证据文件、Git commit binding、public assetVersion/READY、DB receipt/package、用户存储身份和 object version inventory，并生成：

```text
.recovery/empty-disk-drill-receipt.v1.json
```

receipt 明确记录 `databaseRestoreExecuted=false` 和 `verificationErrors=0`。写入该回执后、rename 前会再次验证 staging 精确树（含 DB、metadata、readiness、export receipt 和新 drill receipt）；提交点要求目标内只有本轮 staging，Windows no-replace rename 后再对最终精确树做完整复验。并发写入、提交后 DB 篡改或多余文件都会失败。该回执只能证明本地数据物化演练；数据库真实恢复、服务切换和业务验收必须另行完成。

## 6. 零网络回归

```text
node scripts/verify-recovery-control-plane-zero-network.mjs
node --check scripts/recovery-export-v1.mjs
node --check scripts/recovery-cos-plan-v1.mjs
node --check scripts/recovery-restore-v1.mjs
```

回归覆盖签名伪造/过期/重放、共同 owner、错误 DB identity、严格 date-time、Draft 2020-12 schema drift、空目标竞态、提交后 DB 篡改、no-replace、symlink/inode 换位、恶意路径、零字节 source、COS 下载签名和零网络静态门禁。fixture 只写操作系统临时目录，不触碰生产、COS、数据库或 Git；输出中的 `signedFixtureReady=true` 不代表生产 READY。
