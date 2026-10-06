# SERVER-LOAD-TELEMETRY 持久化设计（DESIGN-ONLY）

状态：**未应用**。本文件只定义后续迁移边界；本阶段没有新增 SQL migration、没有执行 DDL、没有连接或写入本地/生产数据库。当前 API 的 `sampling.persistence` 固定为 `process_memory_only`，进程重启后样本清空。

## 第一阶段低成本运行策略

Web 进程只保留一个进程级采样器。管理员读取发生后，采样器按 5 秒周期更新进程 CPU delta、RSS/heap、event-loop utilization/delay 与 uptime；每次请求只读取后台快照。连续 **5 分钟无读取**时，采样器清除定时器并执行 `eventLoopDelay.disable()`，响应通过 `idlePolicy` 明确披露停止定时器、停用延迟监视器、空闲时刻和读取恢复策略。

空闲后的下一次获准读取复用同一个进程级 singleton，重置 CPU 与 event-loop utilization 基线、清空并重新启用延迟直方图，再恢复后台周期。这个过程不会创建第二个采样器；恢复当次会返回 `background_sampler_resumed`，只读元数据请求可返回 `background_sampler_idle_suspended` 而不唤醒采样器。

客户端在**页面隐藏或离线**时暂停首次读取和自动读取，并中止尚未完成的读取。页面重新可见且恢复联网后，只在现有快照已经过期时发起读取；界面持续显示暂停原因。组件样式使用私有深空配色，可见文字不低于 12px，并提供键盘焦点、电脑端窄窗口和 reduced-motion 规则。

## 目标边界

后续持久化只接收由各运行实例在后台形成的分钟级聚合，不保存逐请求记录、路由、用户标识、请求参数、提示词、响应正文、主机名、IP、环境变量或凭据。第一阶段的来源范围仍是 `current_web_process`；宿主机 CPU/总内存、磁盘、网络、数据库连接池和共享 Worker 心跳必须等各自真实采集器接入后另设来源，不能从 Web 进程指标推导。

## 候选表与约束

候选迁移名：`runtime_telemetry_minute_v1`，正式 migration 需在部署批次中另行评审后创建。

建议列：

- `id bigint generated always as identity primary key`
- `service_key text not null`：稳定服务 key，例如 `web`
- `instance_key_hash text not null`：部署控制面生成的不可逆实例标识，不保存主机名
- `scope text not null check (scope = 'current_web_process')`
- `bucket_start timestamptz not null`：UTC 分钟边界
- `sample_count integer not null check (sample_count > 0)`
- `cpu_single_core_avg/p95/max numeric null`
- `rss_bytes_avg/max bigint null`
- `heap_used_bytes_avg/max bigint null`
- `event_loop_utilization_avg/p95 numeric null`
- `event_loop_delay_p95_ms/max_ms numeric null`
- `uptime_seconds_max numeric null`
- `created_at timestamptz not null default now()`
- 唯一键 `(service_key, instance_key_hash, scope, bucket_start)`，写入使用幂等 upsert

分钟聚合在应用进程内由固定后台采样生成；管理员读取 API 只查聚合结果，不触发采样或扫描业务表。表中不设 host 总量字段，避免 `null` 被错误替换成 0。

## RLS 与权限设计

正式迁移必须执行 `ENABLE ROW LEVEL SECURITY`，并保持 `anon`、`authenticated` 默认拒绝；不向浏览器角色授予表级 `SELECT/INSERT/UPDATE/DELETE`。写入由服务器专用受限角色完成，该角色只能对这张表执行分钟桶幂等写入。读取继续先经过现有管理员 `logs.view` 权限，再由受限 server-only RPC 返回固定列。

如采用 `SECURITY DEFINER` 函数，迁移必须同时固定 `search_path`、撤销 `PUBLIC` 执行权、仅授予专用服务角色，并在函数内限制窗口和最大行数。任何读函数都不能返回实例原始标识、数据库连接信息或其他环境数据。RLS 验收至少覆盖匿名拒绝、普通会员拒绝、缺少 `logs.view` 的管理员拒绝、授权管理员只读和写角色最小权限。

## 保留策略

分钟聚合默认保留 **30 天**。每日低峰运行一次幂等删除，条件为 `bucket_start < now() - interval '30 days'`，单批限制行数并记录删除数量与耗时；调度器不可用时只标记保留任务 `unavailable`，不能声称已清理。进程内原始 5 秒样本仍只保留 60 点，不写数据库。

容量评审后才能改变保留期。若未来接入 host、database 或 worker 来源，应分别设置来源字段、采样主体和数据质量，不复用 `current_web_process` 冒充。

## 发布与回滚

应用迁移前先完成候选库备份、DDL 计划审查、RLS 负向测试和 30 天删除的 dry-run。发布顺序为建表与权限 → 验证默认拒绝 → 启用单实例写入 → 校验分钟桶 → 再开放管理员只读；任何阶段失败均保持现有进程内 API 可用。

**回滚**顺序：先停用分钟聚合写入和保留调度，再撤销读/写函数执行权，导出需保留的聚合证据，删除函数与策略，最后在确认无消费者后删除候选表。回滚不改业务表、不重放请求，也不影响现有 Web 进程内采样器。正式 down migration 必须和 up migration 同批评审；本 DESIGN-ONLY 文件本身不执行任何回滚动作。
