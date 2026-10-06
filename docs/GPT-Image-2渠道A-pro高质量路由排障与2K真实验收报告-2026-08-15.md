# GPT-Image-2 · 渠道A pro 高质量路由排障与 2K 真实验收报告

日期：2026-08-15（Asia/Shanghai）  
范围：分镜工作台生图模型、公开模型接口、图片生成 adapter、持久化、历史和计费门禁。未修改故事版三智能体 Prompt、自由画布、主题或工具箱。

## 最终结论

用户最终保留且唯一有效的 GPT Image 2 配置是：

| 项目 | 最终值 |
| --- | --- |
| 数据库 ID | `gpt-image-2-chA-1` |
| 公开模型 ID | `pm_HabdJ5rvD_L3-HUkfMUmGsrm` |
| 用户端显示名 | `GPT-Image-2 · 渠道A pro` |
| 上游 payload `model` | `gpt-image-2` |
| 高质量密钥组/路由语义 | `adobe-image2-high` |
| E 密钥指纹 | `sha256:0b49a8c5f27a…yaoE` |
| 分辨率 | `1K`、`2K`、`4K`；平台默认 `2K` |
| 业务价格 | ¥0.20/张，未改价 |
| 当前状态 | 启用、非隐藏、可在分镜工作台选择 |

`adobe-image2-high` 不是该网关接受的 payload 模型字符串。供应商文档明确写明当前用户侧统一提交 `gpt-image-2`，标准/中等/高质量由 API Key 分组决定；实际用 E 密钥向 `/v1/models` 查询也只返回 `gpt-image-2`。把 `model` 硬改为 `adobe-image2-high` 的无费用无效参数请求被 HTTP 400 拒绝，且未生成图片。因此最终修复保持 payload `model=gpt-image-2`，由 E 密钥选择截图中的 `adobe-image2-high` 高质量组。

## 根因与配置纠偏

最初公开 ID `pm_takE97o_QD3mnl65r8uLsnza` / DB `gpt-image-2-chA-2` 实际绑定 F 指纹 `sha256:84757b63edc7…yaoF`，不是用户指定的 E 密钥。此前三张 GPT Image A 图片均产生于该 F 指纹配置时期，不能作为 E 高质量组命中证据；它们只能保留为故事版方法论和视觉差异证据。

用户随后主动删除误导的 `gpt-image-2-chA-2`，只保留 `gpt-image-2-chA-1 / GPT-Image-2 · 渠道A pro`。排障期间曾因不了解该删除是用户主动操作而短暂恢复旧行；收到纠偏后已立即精确删除该旧行，并逐字段确认 pro 行未被覆盖。最终数据库只保留 pro 行。

pro 行原本已经绑定正确 E 指纹，但 `supports_image_input=false` 与供应商文档的 JSON `image: [URL...]` 能力相矛盾。修复只把该能力标记改为 `true`；名称、payload model、provider、endpoint、密钥、价格、启停、隐藏状态和排序均保持不变。

## UI → API → adapter → 上游参数

链路现为：

`GPT-Image-2 · 渠道A pro` → 公开 ID `pm_Habd...` → `/api/image/generate` → DB `gpt-image-2-chA-1` → E 指纹 → `/v1/images/generations` → `model=gpt-image-2` + `image_size=1K/2K/4K` + `aspect_ratio` + 可选 JSON `image[]`。

修复点：

- 公共 `/api/cover-models` 对普通用户和管理员都只返回不透明 ID、公开显示名、渠道标签、能力和公开价格；不再因管理员登录态返回整行密钥/endpoint/provider。
- 分镜工作台显示精确公开名 `GPT-Image-2 · 渠道A pro`，分辨率下拉为 1K/2K/4K，默认 2K。
- GPT Image 2 能力定义为 1K/2K/4K、默认 2K。
- Secure Skill 图片 adapter 对参考图使用供应商要求的 `/images/generations` JSON `image[]`，不再错误走 multipart `/images/edits`。
- payload 始终发送 `model=gpt-image-2`；`adobe-image2-high` 只作为 E 密钥组语义，不进入请求体。
- 成功结果用远端文件头读取真实宽高；本次 2K 实图为 2560×1440，避免继续按本地尺寸表伪报 2048×1152。

## 唯一一次 pro 2K 真实测试

提交前记录：业务价 ¥0.20；管理员验收账户本地扣费预计 ¥0；脚本硬限制最多一次上游生成提交。

结果：

| 项目 | 实测值 |
| --- | --- |
| 上游生成提交次数 | 1 |
| 终态 | 成功 |
| 提交模型 | `gpt-image-2-chA-1` / `pm_HabdJ5rvD_L3-HUkfMUmGsrm` |
| 显示名 | `GPT-Image-2 · 渠道A pro` |
| 分辨率 | `2K` |
| 实际 PNG | 2560×1440，3,779,439 字节 |
| PNG SHA-256 | `f828cdf1b898f24ee76f2d45cb1fe5a60b44c5ac9c7fd0d35bee39ab5b7f9237` |
| 内容凭据 | 含 C2PA、`gpt-image-2` 标记；不回显私有密钥组名 |
| 上游成功 URL | `https://source.openclaw-token.shop/uploads/1786782883-5f67449adce8.png` |
| 工作台转存 | 腾讯 COS，HTTP 200，`image/png` |
| 刷新恢复 | 通过 |
| 历史→恢复 | 通过 |
| 本地现金余额 | 20 → 20 |
| 现金流水数 | 2 → 2 |
| 本地实际扣费 | ¥0（管理员验收） |

供应商响应和图片 C2PA 不回显 `adobe-image2-high` 私有分组名，因此分组证据由用户截图中的密钥组标签、E 指纹和供应商“质量由 Key 分组决定”的文档共同构成，不能把图片里的 `gpt-image-2` 标记误判为未命中高质量组。

机器结果：`.tmp-e2e/gpt-image2-pro-2k-live-result-20260815.json`。  
费用门禁：`.tmp-e2e/gpt-image2-pro-2k-cost-preflight-20260815.json`。

截图：

- `.codex-screenshots/gpt-image2-pro-2k-before-20260815.png`
- `.codex-screenshots/gpt-image2-pro-2k-success-20260815.png`
- `.codex-screenshots/gpt-image2-pro-2k-history-restored-20260815.png`

## 失败历史、脱敏与重复扣费

- 无效 8K 契约请求在调用上游前返回 `IMAGE_RESOLUTION_UNSUPPORTED`，只显示公开名和支持的 1K/2K/4K；余额和流水均不变。
- 生图失败会写入当前 run，随后由工作台历史 effect 持久化；无费用重生成回归保留 3 个历史快照。
- 同一卡片正在提交时由 `imageSubmissionsRef` 拦截重复点击；文件损坏自动重试复用同一个 `clientTraceId`。
- 后台扣费使用 `reference_id=image:<traceId>` 查重；只有 `deductedAmount>0` 才记收入，响应 `cashCharged` 返回实际扣款额，防止顺序重试重复扣费/重复收入。
- 后台日志保留内部 DB ID、公开 trace 和完整供应商诊断；用户 API、错误和截图不输出完整密钥、endpoint、provider 或签名 URL。

## 验证

- E 密钥 `/v1/models`：HTTP 200，仅列 `gpt-image-2`；无付费生成。
- `adobe-image2-high` 无效 payload 契约：HTTP 400，无图片、无费用。
- 1K/2K/4K adapter 纯函数回归：通过；默认 2K，参考图为 JSON `image[]`。
- 公开 ID → API 分辨率门禁：通过；错误脱敏、余额与流水不变。
- pro 2K 真实浏览器验收：通过；无 page error / console error。
- 实图文件头宽高复核：通过，2560×1440。
- 分镜重生成/失败/历史无费用回归：通过，`paidCalls=0`。
- 目标 ESLint：0 errors；工作台仍有 5 个既有 `<img>` 性能 warning。
- 全量 `tsc --noEmit`：本次修改文件无新增错误；仓库既存错误仍在 `scripts/refine-storyboard-*`、`scripts/update-storyboard-director-single-instance-rule.ts` 和 `src/app/api/canvas/compile-script/route.ts`。

## 修改文件

- `src/app/api/cover-models/route.ts`
- `src/app/api/image/generate/route.ts`
- `src/components/storyboard-workbench.tsx`
- `src/lib/image-model-capabilities.ts`
- `src/lib/secure-skill-image-adapter.ts`
- `src/lib/image-dimensions.ts`
- `src/lib/public-model-dto.ts`
- `scripts/verify-gpt-image2-high-route.ts`
- `scripts/verify-gpt-image2-high-live.mjs`
- `scripts/verify-gpt-image2-pro-result-metadata.ts`

同步登记文件：

- `03_知识库/网站开发项目文档/自媒体操盘手开发文档/故事版导演知识入口与优化日志.md`
- `03_知识库/网站开发项目文档/自媒体操盘手开发文档/故事版导演知识索引.json`
- `01_网页开发项目/自媒体操盘手/项目工作台.md`
- `01_网页开发项目/自媒体操盘手/信息收集与规则记录.md`
- `03_知识库/项目导航.md`
- `99_系统协议/01_路由与索引/资产总索引.json`
- `99_系统协议/01_路由与索引/资产注册表.json`
- `LOG.md`

## 备份与局部回滚

最终 pro 配置修改前备份：`backups/gpt-image2-pro-route-pre-20260815-162954/`。  
私密 DB 快照：`.secure/gpt-image2-pro-route-pre-20260815-162954/cover-model-pro.private.json`。  
私密快照 SHA-256：`6c480eecf6d9351027a0ef73e57dd6580fbf6a843ed935139fb3f8ca584e73a3`。

旧的 `backups/gpt-image2-high-route-pre-20260815-161130/` 只用于审计最初 F/E 差异，不能用于恢复已被用户主动删除的 `gpt-image-2-chA-2`。

局部回滚只允许：恢复 pro 行的修改前快照和本报告列出的单个代码文件；不得插回 `gpt-image-2-chA-2`，不得覆盖用户的 `GPT-Image-2 · 渠道A pro` 名称。详细顺序见 pro 备份目录的 `ROLLBACK.md`。

## 残余说明

- 供应商公开 API 与 C2PA 不回显私有分组名；高质量组名只能由用户的密钥组截图和 E 指纹关联证明。
- 此次只执行用户授权的一次 pro 2K 实图；1K/4K 通过供应商文档、UI/API/adapter payload 契约验证，未额外付费实测。
