# UI 到后端功能链路审计

生成时间：2026-09-25T07:22:59.084Z

前端 bundle、共享组件、29 个 query 条件入口、可观察 GET 载荷和 /canvas/{workspace_id} 控制器源码已闭合；真实持久化 Canvas 的页面语义仍失败，4 个 canvas-only 提交和真实桌面/390px本站运行验收仍缺。

| Surface | Route | 页面已抓 | Controller 已抓 | Shared renderer | API contract | 运行验收 | 缺口 |
|---|---|---:|---:|---:|---|---:|---|
| workspace-shell | /(workspace)/* | 是 | 是 | 是 | 间接 | 否 | 桌面与390px computed-style 验收待执行 |
| toolbox-catalog | /toolbox | 是 | 是 | 否 | 客户端目录常量 | 否 | 9张顶层卡不能代表全部内嵌技能 |
| toolbox-shared-shell | /toolbox/[toolSlug] | 是 | 是 | 是 | 按工具注入 | 否 | 需逐工具 desktop+390 溢出/折叠验收 |
| image-generation | /toolbox/image-generation | 是 | 是 | 是 | skill-packs/model-routes/batches/assets | 否 | provider worker/quote settlement/asset terminal 私有 |
| ecommerce-image-set | /toolbox/ecommerce-image-set | 是 | 是 | 是 | analysis-row/row-quote/row-generations/regenerations | 否 | 分析 worker、逐图资产与计费终态不可见 |
| video-processors | /toolbox/{hot-video-remix,subtitle,watermark,enhance,depth} | 是 | 是 | 是 | batches/assets/model routes | 否 | 私有 split/edit/provider workers 不可见 |
| video-generation-director | /toolbox/video-generation | 是 | 是 | 是 | video-creator conversations/script stream/batches/quote | 否 | 应用脚本仅证明回填生成表单；19个运行发布ID/读回待核 |
| digital-human | /toolbox/digital-human | 是 | 是 | 是 | voice-profiles/system voices/batches/assets | 否 | 客户端意图不证明声音/口型服务可用 |
| assets-workspace | /assets and /assets/generated | 是 | 是 | 是 | upload-policy/complete/assets/groups/auth | 否 | 对象存储权限、生命周期与清理私有 |
| canvas-list | /canvas | 是 | 是 | 是 | canvas CRUD/duplicate/snapshot/share | 否 | 列表和一个真实详情 GET 已取证；本站仍需当前构建浏览器验收 |
| canvas-dynamic-editor | /canvas/{workspace_id} | 是 | 是 | 是 | canvas detail/nodes/edges/groups/runs/templates/media derivatives/share | 否 | 真实持久化 ID 的 detail API 200，但精确页面正文为“页面未找到”且自然 detail GET=0；控制器源码存在，实获画布 revision=0 且 nodes/edges/groups 为空；页面接线、写操作、非空持久化、协作冲突和任务终态未通过 |
| canvas-skill-composer | /canvas/{workspace_id} | 是 | 是 | 是 | skill catalog→composer payload→run/task→asset/node insertion | 否 | 4 个 canvas-only 技能的 UI/控制器合同已取证；提交会写业务状态且可能付费，未执行 |
| shared-video-stitch-editor | 共享结果/资产编辑入口 | 否 | 部分入口未知 | 是 | batches/assets/segment-retake | 否 | 引擎存在不等于所有入口挂载或服务器终态可用 |
| admin-video-director-skills | /admin/video-creator-skills | 是 | 是 | 否 | draft/validate/preview/publish/versions/rollback/enable | 否 | common policy→category root→child skill；当前 published pointer 未证明 |
| admin-image-skill-packages | /admin/skill-packages | 是 | 是 | 否 | common prompts/package draft/validate/preview/publish/versions/rollback | 否 | 数据库 published prompt/model route/原子切换未证明 |
| affiliate-user-admin | /affiliate/* and /admin/affiliate/* | 是 | 是 | 是 | KYC/referral/commission/settlement/recharge cards/proof/bank reveal | 否 | 金融/KYC/RBAC/支付幂等服务端不可见 |

## 技能入口分层

- 顶层工具：9
- Query 入口：11 图片 + 18 视频，29/29 已只读抓取
- 仅画布内：4，UI 与 controller 合同已取证；提交未执行
- 隐藏默认配置：2
- 内部 action 家族：5

