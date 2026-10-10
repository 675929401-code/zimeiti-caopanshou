# Shared Agent Batch CAS 候选集成门禁

`20261010140000_shared_agent_batch_cas.sql` 当前仍是候选迁移，未写入正式数据库合同，也未在本轮连接或应用数据库。

发布链中的 `verify-release-database-gates.ts` 已接入候选感知门禁。只要正式合同未同时登记迁移源文件 SHA-256、两个 RPC 和 `public.agents` 动态 owner / `SECURITY DEFINER` / 固定 `search_path` / 仅 `service_role` 执行权限，发布校验必须失败并报告 `SHARED_AGENT_BATCH_CAS_CANDIDATE_NOT_IN_RELEASE_CONTRACT`。

控制面集成顺序：

1. 独立审计候选 migration、rollback、apply/readiness/rollback probe。
2. 经授权仅在正式本地数据库应用，运行 readiness 与 rollback → reapply → ready 演练并留存哈希。
3. 由数据库合同总控刷新 `database-contract.v1.json` 及生成合同；不要手工绕过候选门禁。
4. 重新运行正式 release database gate。只有合同、ledger、函数定义语义哈希、ACL 和 RPC 同时通过，才可进入后续候选激活。

本文件不是应用、生产变更或部署授权。
