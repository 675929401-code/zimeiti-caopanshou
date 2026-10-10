# 生产存储挂载门禁

`scripts/deploy-activate.sh` 在创建 release 目录、解包或启动候选进程前，必须验证生产数据盘身份。门禁缺失或不匹配时，部署直接停止，现有生产指针和进程不变。

## 一次性配置

1. `/data` 必须是独立真实挂载点，不能与 `/` 使用同一个块设备；`/data/web`、`/data/direct-deploy`、制品、release、共享数据和回执都必须位于该挂载。
2. `/etc/fstab` 必须用该数据盘的 `UUID=<uuid>`（或 `/dev/disk/by-uuid/<uuid>`）持久挂载 `/data`，不得仅依赖易漂移的 `/dev/vdb` 名称。
3. 创建只读身份标记 `/data/.zimeiti-storage-root`，记录不含凭据的固定卷身份文本；文件必须是 `root:root` 且不可被组或其他用户写入。
4. 创建 `/etc/zimeiti/deploy-storage.conf`，文件必须是 `root:root`、普通文件且不可被组或其他用户写入。只允许以下五个键：

```text
DATA_MOUNT_SOURCE=/dev/vdb
DATA_MOUNT_UUID=<实际 UUID>
DATA_MARKER_SHA256=<身份标记文件的 SHA-256>
MIN_AVAILABLE_BYTES=21474836480
MIN_AVAILABLE_INODES=200000
```

脚本内置最低线是 5 GiB 和 50,000 inode，配置只能提高，不能降低。每次制品还会在最低线之外预留“清单总字节 + 10% + 64 MiB”和“清单文件数 + 1,024 inode”。

## 每次发布自动检查

- `/data` 挂载目标、设备、UUID 与 `/etc/fstab` 持久配置一致，且与系统根设备不同。
- `/data/web`、当前 release、待发布制品和共享资产不能跳出 `/data`，也不能回落到旧 `/srv` 或系统盘。
- 制品必须位于 `/data/direct-deploy/incoming/`，是 root 控制、不可被组或其他用户写入的普通文件。
- 解包前拒绝绝对路径、`..`、重复/非规范路径、符号链接、硬链接、设备、FIFO、socket 和未知 tar 条目；元数据文件数与字节数必须与嵌入清单一致。
- 解包采用不继承归档 owner/permission 的受限模式；随后逐文件重算大小、SHA-256 和聚合摘要，与 `release-manifest.json` 完全一致后才进入候选启动。

配置文件或身份标记不应放入 Git、制品或日志。更换数据盘时必须先完成数据恢复验证，再更新 UUID、设备和标记摘要；不要为了放行临时降低门禁。

## PM2 开机启动门禁

发布脚本的检查只覆盖发布事务，不能替代服务器重启时的服务依赖。候选验收通过且准备切换生产前，还必须把
`deploy/systemd/pm2-root.service.d/20-zimeiti-data-mount.conf.example` 作为 root 控制的 drop-in 安装到
`/etc/systemd/system/pm2-root.service.d/20-zimeiti-data-mount.conf`，执行 `systemctl daemon-reload` 后验证：

- `/data` 正常挂载时 PM2 可以启动；
- 临时停用该 mount 的隔离演练中 PM2 不启动，或在 mount 单元失效时随之停止；
- 恢复挂载后仍须先通过 UUID、marker 和空间门禁，再恢复服务；
- `systemctl show pm2-root.service` 能读回 `RequiresMountsFor=/data` 对应依赖、`BindsTo=data.mount` 和两个 Condition。

这是生产状态变更，安装动作必须进入部署回执；仓库中存在模板不代表服务器已经启用。
