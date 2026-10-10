# 备份与隔离恢复控制面

状态：本地控制面已加固；生产定时作业、独立生产数据库身份回执、异地副本、密钥托管和真实恢复演练仍未完成，**不得宣称灾备已完成**。

## 平台与边界

本控制面仅支持 Linux。它依赖 GNU `stat/findmnt/mountpoint/lsblk/tar`、`age`、PostgreSQL 客户端和 Node.js 24；Windows、WSL 映射盘、容器 overlay 根盘及未验证 bind mount 都不是执行环境。

脚本不会宣称 PostgreSQL、两个 SQLite 和五棵文件树拥有共同时间点快照：

- PostgreSQL dump、行数和财务核对共享一个 exported repeatable-read snapshot。
- Commerce、Voice 各自通过 SQLite online backup 得到独立快照。
- 五棵文件树各自在复制前后做完整路径、字节数和 SHA-256 比对，并验证目标树与源树一致；任何变化立即失败。
- 包元数据和回执都写入八个 `componentSnapshots`，每项 `sharedWithOtherComponents=false`。
- 当前没有受控写入静默/全局 quiesce 的密码学回执，所以 `productionConsistency` 固定为 `incomplete`，`productionConsistencyComplete=false`。一条环境变量或人工字符串不能把它升级为生产一致快照。

`status=complete` 只表示加密制品完整、校验通过并已原子提交，不表示跨组件生产一致性、异地容灾或业务已恢复。

## 入口

```bash
bash runtime-tools/backup-data.sh --plan
bash runtime-tools/backup-data.sh --preflight
bash runtime-tools/backup-data.sh --execute

bash scripts/restore-data.sh --plan
bash scripts/restore-data.sh --preflight
bash scripts/restore-data.sh --execute
```

默认模式是 `--plan`。本仓验证器只运行 plan、语法和本地 fixture；不会连接生产、COS 或数据库。

## 备份前置

| 变量 | 要求 |
| --- | --- |
| `DEPLOY_DATABASE_URL` | 仅从受控进程环境注入；不得进入参数、回执、文档或日志 |
| `PERSISTENT_DATA_MOUNTPOINT` | 独立数据盘真实挂载点；用 `stat.st_dev` 与 `/` 区分，不用 `findmnt SOURCE` 作为设备身份 |
| `BACKUP_DIR` | 数据盘上的绝对目录；与每个源根必须双向不相交，既不能包含源，也不能被源包含 |
| `BACKUP_PLAINTEXT_STAGING_MOUNTPOINT` | 专用、空的挂载；只接受 `tmpfs` 或 `lsblk TYPE=crypt` 的 dm-crypt 块设备；设备号必须与系统盘、数据盘不同 |
| `BACKUP_AGE_RECIPIENTS_FILE` | 非 symlink、当前执行 UID 所有、group/other 无权限的收件人文件 |
| `APP_DATA_DIR` | 应用耐久数据目录 |
| `COMMERCE_DATA_DIR` | 必须同时存在非 symlink 的 `commerce.sqlite` 和 `assets/` |
| `VOICE_SQLITE_PATH` | Voice SQLite 普通文件 |
| `VOICE_REFERENCE_AUDIO_DIR` | Voice 参考音频目录 |
| `STORAGE_LOCAL_BASE_PATH` | uploads 根 |
| `PUBLIC_ASSET_ROOT` | public assets 根 |

备份根和六个源入口都必须真实落在 `PERSISTENT_DATA_MOUNTPOINT` 的 `stat.st_dev`；路径位于挂载点文本之下但设备号不同也会拒绝。最终 `package.tar.gz.age` 与 `receipt.json` 先在 `BACKUP_DIR` 同一文件系统的隐藏 commit 目录完成，再用目录 rename 原子提交。

明文 payload 与 tar 只进入专用 staging 挂载。正常退出、`SIGINT`、`SIGTERM` 会清理；`SIGKILL`、内核崩溃或断电无法运行 trap，因此下一次执行会对任何残留 staging 失败关闭，必须由运维在确认没有运行中进程后人工处置。`tmpfs` 在掉电后消失；dm-crypt 盘断电后仍保留密文块，安全性取决于密钥没有与盘同存。该设计降低明文落盘风险，但不能承诺内存取证、DMA、休眠镜像或宿主机已失陷时保密。

## 恢复目标身份

恢复不接受“我确认这是隔离库”字符串。必须同时具备：

1. `RESTORE_EXPECTED_TARGET_SYSTEM_IDENTIFIER`：目标 cluster 的预期 `pg_control_system().system_identifier`。
2. `RESTORE_PRODUCTION_IDENTITY_FILE`：由独立资产清单签发的生产 cluster identity 回执。
3. `RESTORE_PROVISIONING_RECEIPT`：绑定目标 system identifier、数据库名、最小权限角色和随机 provisioning nonce 的回执。
4. `RESTORE_PROVISIONING_HMAC_KEY_FILE`：验证两份回执的控制面 HMAC key；三份文件均须非 symlink、当前 UID 所有且 group/other 无权限。
5. 目标 PostgreSQL 必须通过 `current_setting('zimeiti.restore_provisioning_nonce')` 返回相同 nonce。
6. `RESTORE_EXPECTED_TARGET_ROLE` 必须精确匹配当前角色；角色不得是 superuser、CREATEROLE、CREATEDB、REPLICATION 或 BYPASSRLS，只允许本次空库恢复需要的 CONNECT/CREATE/TEMP 与 public schema CREATE。

脚本在解密前、`pg_restore` 紧前和恢复后读取 cluster identity。目标 ID 必须匹配预期 ID且与独立生产 ID 不同；因此“同一 cluster 换一个数据库名”会在 `pg_restore` 之前被拒绝。恢复后再核对 system identifier、数据库、角色和 nonce 摘要未变化。

两份证明的精确字段合同如下；`signature` 是对除自身以外、按此顺序序列化字段的 HMAC-SHA256，不接受附加字段：

```json
{
  "schemaVersion": "zimeiti-production-postgres-identity.v1",
  "environment": "production",
  "systemIdentifier": "独立资产清单读取的十进制 system_identifier",
  "issuedEpoch": 0,
  "expiresEpoch": 0,
  "signature": "64位小写十六进制"
}
```

```json
{
  "schemaVersion": "zimeiti-restore-provisioning-receipt.v1",
  "targetSystemIdentifier": "新 cluster 的十进制 system_identifier",
  "targetDatabase": "zimeiti_restore_...",
  "targetRole": "受限恢复角色",
  "provisioningNonce": "至少32位小写十六进制随机值",
  "issuedEpoch": 0,
  "expiresEpoch": 0,
  "signature": "64位小写十六进制"
}
```

示例中的 `0` 只是字段类型说明，实际回执必须使用有效签发/过期时间；过期、未来签发、签名不符、额外字段或 nonce 不匹配均拒绝。

目标连接使用 `RESTORE_PG_SERVICE` 的受控 libpq service 名，不把数据库 URL 或凭据写入命令参数/回执。`postgres/globals.sql` 仅作证据，绝不自动应用。

## 恢复文件与明文

| 变量 | 要求 |
| --- | --- |
| `RESTORE_PACKAGE` | 已完成目录内的 age 包 |
| `RESTORE_EXPECTED_PACKAGE_SHA256` | 独立获得的 64 位 SHA-256 |
| `RESTORE_AGE_IDENTITY_FILE` | 权限/owner/symlink 均通过门禁的 age 私钥文件 |
| `RESTORE_ISOLATION_MOUNTPOINT` | 仅接受 tmpfs 或已验证 dm-crypt；与系统盘设备号不同；最终恢复树位于其上 |
| `RESTORE_PLAINTEXT_STAGING_MOUNTPOINT` | 嵌套在隔离挂载路径下的专用 tmpfs/dm-crypt 挂载，设备号与隔离盘不同 |
| `RESTORE_ROOT` | 不存在的新 `zimeiti-restore-*` 目录，父目录设备号必须等于隔离盘 |
| `RESTORE_RECEIPT_DIR` | 已存在可写目录，必须与明文 staging 双向不相交 |

解密归档只进入 `RESTORE_PLAINTEXT_STAGING_MOUNTPOINT`，不再使用 receipt 目录。最终文件的隐藏 staging 固定在隔离盘；两个固定 staging 名称任一残留都会阻断新运行。隔离盘本身也必须是 tmpfs 或 dm-crypt，避免 `SIGKILL` 后在普通明文盘留下恢复内容。恢复包在开始前与全部数据库/文件验证完成后各做一次 SHA-256；SQLite 对比同时覆盖 integrity、逐表行数、字节数和文件 SHA-256；五棵文件树在隔离 staging 和最终 rename 后各再做一次逐文件字节数/SHA-256 比对。

## 回执、backup age、data restore duration 与服务 RPO/RTO

机器合同：

- `scripts/contracts/backup-receipt.v1.schema.json`
- `scripts/contracts/restore-receipt.v1.schema.json`

脚本通过专用 JSON 生成器写回执，不使用 shell heredoc 插入路径或身份字段；随后实际执行等价 schema validator。两个 schema 根及嵌套对象均 `additionalProperties=false`，成功真实性字段使用 `const true/false`。

回执只记录：

- `artifactCreationDurationSeconds`：生成本次加密制品耗时。
- `oldestComponentAgeAtCompletionSeconds`：完成时最早组件快照的年龄。
- `backupAgeAtRestoreStartSeconds`：恢复开始时最早组件快照的年龄，必须非负。
- `dataRestoreDurationSeconds`：从恢复脚本启动到数据验证完成的耗时。

这些都不是服务级 RPO/RTO。只有真实故障/演练事件具有已证实的故障发生点、恢复点、服务切换时间、业务验收时间和独立证据时，外部服务验收系统才可以写 `serviceRpoSeconds/serviceRtoSeconds`；本脚本和本 schema 不生成这两个字段。

## 生产启用前外部阻塞

1. 补齐正确生产 PostgreSQL system identifier 的独立签名回执；当前身份不明时不得执行。
2. 在受控密钥系统建立 age 收件人、离线私钥和 provisioning HMAC key 的轮换/双人取用。
3. 配置真实 tmpfs/dm-crypt staging 与隔离恢复盘，并演练 `SIGKILL` 残留发现和人工处置。
4. 将加密包复制到 COS/另一备份域，启用版本、不可变保留与独立身份，并回读摘要；本地同盘包不是异地备份。
5. 建立可验证的全局 quiesce 协议后，才能考虑跨组件生产一致性；在此之前所有回执保持 `incomplete`。
6. 在全新非生产 cluster 完成真实恢复、服务切换和业务验收，才能报告实测服务 RPO/RTO。
