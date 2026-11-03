# 智能体目录本地版本档案与增量发布

本工具把“提示词/目录业务数据”从 Web 代码发布中独立出来。源码只包含工具与合成测试；真实正文仅保存到固定私有运行目录 `F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/agent-catalog-release-v1`，不输出到终端，不进 public、Git、代码制品或测试夹具。Windows 初始化把该新目录 ACL 限定为当前用户、SYSTEM、Administrators；每次写档案前复核权限，拒绝目录联接、符号链接和文件硬链接。

入口 `agent-catalog-release-cli.mjs`，核心 `agent-catalog-release-core.mjs`，受控只读采集器 `agent-catalog-release-readers.mjs`，正常 API 发布/核对器 `agent-catalog-release-publish.mjs`，正式 owner 工厂 `agent-catalog-release-owner.mjs`，完整覆盖 gate `agent-catalog-release-gate.mjs`。业务可移交字段与规范 SHA 只引用 `src/lib/server/agent-catalog-publication.ts` 的 `CATALOG_PUBLICATION_FIELDS`、`publicationHash`，不维护另一份字段常量。目录恢复/发布不包含模型调用。

## 可以直接运行的本地命令

```powershell
Set-Location 'F:\总项目文件\Skill存储系统\01_网页开发项目\自媒体操盘手\当前版本'
node scripts/agent-catalog-release-cli.mjs init --author owner --reason '建立本地受控提示词版本档案'
node scripts/agent-catalog-release-cli.mjs snapshot-local --author owner --reason '归档当前正式本地目录，不补造历史'
node scripts/agent-catalog-release-cli.mjs status
node scripts/agent-catalog-release-cli.mjs verify
node --test scripts/agent-catalog-release-test.mjs scripts/agent-catalog-release-gate-test.mjs
```

`snapshot-local` 只读取登记的本地 runtime 配置，不接受任意数据库 URL、环境变量、库名、host 或 `--production` 开关。先验证 URL 为 loopback:54322/zimeiti_local，再在 REPEATABLE READ READ ONLY 中核对库名、OID16393、服务端端口54322及 read_only；同一事务查询全部 `agents` 行，包括软删除行。可回传的只有稳定 ID、revision、删除状态和已批准可移交字段；没有账户/会话查询。私有渠道、proxy、Coze、知识/Skill依赖仅在数据库内做存在性检查，不返回其秘密或URL。端口/OID变化须经项目 authority 重新审核，工具不自动猜新库。

完整盘点复用 `20261103010000_agent_catalog_publications.sql` 中原生读取函数的纯 SELECT：只把单ID谓词变为完整ID排序、将38字段投影内联，不执行迁移或 DDL。采集身份记录查询及该SQL来源的SHA。`numericText` 与5种 portability 理由都来自同一SQL；额外调用原生 `hasExactCatalogDecimals` 检测 JSON 小数精度。无法精确表示的小数、嵌套私有配置及不可移交依赖会在计划中标为 blocked，不能静默丢弃后发布。

每张卡的正文位置为 `agents/<stable-id>/versions/<version-hash>/prompt.md`；`metadata.json` 只有字段哈希、有限安全标识、源 revision、上次生产 revision、正文哈希/字节数。封面 URL 和其他文字配置只存哈希，正文不会复制到 metadata。作者、原因、采集时点、版本引用进入不可覆盖的 `changelog/<sequence>-<hash>.json`，前一条哈希串成链；它记录本次真实采集，绝不把当前正文反填成早期历史版本。

归档前再次调用同源 `validatePortableNestedFields` 检查全部批准列。存在受限 secret/env 引用、私钥、明显令牌或私有嵌套配置时，只记录摘要与 `RESTRICTED_CONTENT_NOT_ARCHIVED`，不写 prompt.md，亦不把受限内容复制进 safe metadata。此卡仍在完整ID库存中，但不能导出原文或发布。旧受控版本不自动覆盖、清理或反填。

```powershell
# 只打印已归档文件路径，不向终端输出提示词。
node scripts/agent-catalog-release-cli.mjs export --id agent-稳定ID
```

## 三方计划和刷新

先由项目正常 owner runner 执行 `index-production` 获取全站无正文完整索引，再按显式稳定 ID 执行 `refresh-production` 获取计划所需源配置。`GET ?view=index` 包含隐藏及软删除行、数据库名称/OID、修订、正文原始UTF8 SHA、可移交字段摘要、生命周期、完整总数及索引摘要；没有正文或秘密。客户端验证精确字段白名单、重复/截断、分项计数、摘要、时间和登记数据库身份，意外多出的原始字段也会拒收。旧 `/api/admin/agents` 受权限视图不能作为全站缺卡证明。

单卡源配置 capture 仍明确标记 `explicit-scope-only`，只有正规完整 index 才能支持全站覆盖判断。完整本地 inventory 会把所有新 ID、提示词变化列出；没有实际读取的单卡源仍列为 `unobserved`，不能自动补发。

生产初始基线必须显式接受对应 capture 的每 ID hash。`ids.json` 是稳定 ID 数组，`hashes.json` 为 `{ "agent-...": "实际远端SHA256" }`，二者必须位于固定私有运行目录内。生产基线不能从本地快照初始化。

```powershell
node scripts/agent-catalog-release-cli.mjs baseline --remote <实际生产capture-UUID> --ids '<私有目录>/ids.json' --hashes '<私有目录>/hashes.json' --author owner --reason '审定这些ID当前生产版本为初始基线'
node scripts/agent-catalog-release-cli.mjs plan --local <完整本地capture-UUID> --remote <实际生产capture-UUID> --author owner --reason '三方比对已发布基线、本地目录和当前生产值'
```

计划按稳定 ID 给出 `new / update / unchanged / conflict / remote-update`，并明确 `untracked / converged / unobserved / missing-local / missing-remote / tombstone / pending`。匹配哈希但没有发布基线时需要显式接纳，revision 变化也按远端更新处理。缺席永不产生 retire。正文变化用独立字段哈希检测，不因显示名或排序相同而遗漏。

普通 `refresh-production` 仅更新 `publishedCache`，不推进 `baselines`，不改本地数据库、不覆盖本地草稿。需要接纳云端新基线时再次显式运行 `baseline`；旧草稿 ancestry 被保留，草稿基线和新生产基线分叉时仍报 conflict，不能靠刷新消除冲突。

```powershell
# 只记录已审定退役意图；不会调用删除接口。
node scripts/agent-catalog-release-cli.mjs retire-intent --id agent-稳定ID --revision <已发布revision> --hash <已发布hash> --author owner --reason '明确审定此ID退役，交原生soft-delete CAS执行'
```

退役/恢复依旧走现行原生 soft-delete/restore CAS，新发布 API phase1 不实现它们。此工具既不因列表缺行撤卡，也不自动重建生产已消失的已发布行。

## 正常 owner runner 的接入合同

档案/计划/gate 核心不处理凭据。正式生产命令默认使用同目录 `agent-catalog-release-owner.mjs`，不依赖 C 盘 case 工具，也不调用本地 fixture JWT/SQL step-up helper。它仅从 F 盘已登记的 DPAPI CurrentUser 文件读取对应账号到 RAM，正常 HTTPS login 一次、正常密码 unlock 一次，使用服务端 Set-Cookie，读取真实 me/self 并验证全权 owner、合法 profile、权限、maintenance、step-up 及完整索引数据库身份。它从不读登录返回的 JWT，不抽取用户浏览器会话，不 mint、不重试认证、不打印凭据。

默认命令和 `coverage-gate` 不登录、不写生产。只有操作者明确运行 `index-production / coverage-live / refresh-published / refresh-production / reconcile` 才打开正规只读 owner session；`publish` 必须提供审定 manifest、canonical SHA 和明确 release 批准字串才允许进入写策略。也可注入已有合法 `withOwner`，复用根持有的同进程正规 session。

```javascript
import {runCli,cliExitCode} from './scripts/agent-catalog-release-cli.mjs';
const result = await runCli(argv, {
  withOwner: async ({mode,scopeIds,authority,planId,expectedPlanHash,manifest,expectedManifestHash,approval}, execute) => {
    // 项目受审 runner 在这里配置命名 policy、正规 owner 鉴权和逐请求白名单。
    // controlledRequest 由它提供，绝不在本工具中抽取 session/token 或开放通用写凭据。
    return existingOwnerRunner({mode,scopeIds,authority,planId,expectedPlanHash,manifest,expectedManifestHash,approval}, execute);
  },
});
process.exitCode=cliExitCode(result);
```

`execute(request)` 接受 `{method,path,body?}`，返回 `{status,body}`。允许域只有已登记 `https://zyuani8.com`，私有 authority JSON 为 `{origin,profileId:"formal-production-owner-v1",version:{sourceVersion,buildId,releaseId,deployCommitSha}}`，四项必须由根的当前冻结生产计划给定；不在工具中写死旧版本，也不自动更换线上身份。

请求只使用：

- `GET /api/version`，对照四项冻结身份；采集前后、逐卡及 apply 前复核。
- `GET /api/admin/agent-catalog-publications?view=index`，正规 owner/step-up 获取单事务完整无正文索引；缺失、503、错误库身份或非完整/失效索引不能宣称一致。
- `GET /api/admin/agent-catalog-publications?agentId=<明确稳定ID>&view=source`，读取正常 owner 可移交配置；原文只在 RAM 及上述私有正文版本中。
- `GET /api/admin/agent-catalog-publications?requestKey=<原UUID>`，只核对原请求。
- `POST /api/admin/agent-catalog-publications`，先 `action:plan`，再带该次服务端 `planHash` 的 `action:apply`。source 的 ID、源revision、完整字段SHA必须匹配冻结的本地计划；baseline绑定目标生产 revision/hash；new必须目标确实不存在；audience只能逐批准ID的 source/owner-only。

根必须先部署/验收此新 API 及相应数据库函数。正式 F owner 工厂已自带受限 policy：只读模式不放任何配置写；写模式逐 ID 比对 manifest 的完整 source SHA/revision、生产 baseline、audience、lifecycle、stripPortability，原生 planHash 仅能消费一次。当前工具不会绕过未上线 API 或改用生产 SQL 写。可直接调用的导出为：

```javascript
import {Archive} from './scripts/agent-catalog-release-core.mjs';
import {refreshPublishedCache} from './scripts/agent-catalog-release-readers.mjs';
import {publishIncremental,reconcilePublication} from './scripts/agent-catalog-release-publish.mjs';

await refreshPublishedCache({archive,request,authority,ids,author,reason});
await publishIncremental({archive,request,authority,planId,expectedPlanHash,
  scopeIds,audiences,manifest,expectedManifestHash,approval,readLocal,author,reason});
await reconcilePublication({archive,request,authority,ids,author,reason});
```

通过正常 runner 执行的 CLI 参数：

```text
refresh-production --ids <私有ids.json> --authority <私有authority.json> --author owner --reason <原因>
publish --plan <冻结planId> --hash <冻结planHash> --ids <私有ids.json> --authority <私有authority.json> --manifest <审定manifest.json> --manifest-sha256 <canonical SHA> --approve-release <准确releaseId> --author owner --reason <原因>
apply-release --plan <冻结planId> --hash <冻结planHash> --ids <私有ids.json> --authority <私有authority.json> --manifest <审定manifest.json> --manifest-sha256 <canonical SHA> --approve-release <准确releaseId> --author owner --reason <原因>
reconcile --ids <原请求的私有ids.json> --authority <私有authority.json> --author owner --reason <只读核对原因>
```

`apply-release` 与 `publish` 是同一受限执行入口。独立进程和导出的 `runCliMain(argv, dependencies, io)` 使用相同退出判断；嵌入式 runner 若只调用 `runCli`，必须将 `cliExitCode(result)` 传播给外层进程。退出码0表示本命令所声明的成功条件已达到，1表示抛出的前置/执行错误，2表示发布或核对未完成，3表示 Web 目录覆盖 gate 未通过。

发布只有 `status:'complete'`、`complete:true`、`finalIdentityVerified:true`、本次每行都是 verified/previously-verified 且本 manifest 全部写 ID 均已有持久确认回执时才退出0。pending、not-dispatched、index-drift、partial、rejected、noop待接纳或末次身份未核实均非零；`remainingIds` 列出尚未确认的批准 ID。仅完成一个分批 scope 时可以 `scopeComplete:true`，但整份 release 仍 `complete:false`、退出2。reconcile 有任意持久 pending 或末次身份未核实也退出2。判断在逐卡处理结束后执行；一张卡的确定拒绝不阻止其他安全独立卡执行，未知写结果/索引或身份漂移仍按原策略停派发。退出判断不改 journal，不自动重发。

## Web 发布前的正式覆盖门禁

以下命令是供项目部署 Skill / F 规约接入的实际 hook；它不执行 Web build、迁移、切换或后台配置写。`coverage-live` 重新读取完整正式本地库存，再以一次正常 owner session 获取当前完整索引。缺合法完整索引、过期、scope遗漏、local新增、prompt未发布或未说明的生产差异，返回 `UNKNOWN/BLOCKED` 或 `webReleaseAllowed:false`；独立进程退出码为3。调用者必须检查非零退出码，不能只记录输出后继续宣称全量一致。

```powershell
node scripts/agent-catalog-release-cli.mjs index-production --authority '<私有目录>/authority.json' --author owner --reason '只读取得完整生产目录摘要'
node scripts/agent-catalog-release-cli.mjs manifest-template --local <完整local-capture> --index <完整index-capture> --authority '<私有目录>/authority.json' --release-id <本次发布ID> --author owner --reason '生成待人工审阅的增量发布清单'
# 填写本次真实actions后重新计算摘要；此命令不授权写。
node scripts/agent-catalog-release-cli.mjs manifest-hash --manifest '<私有目录>/release-manifests/<ID>.draft.json'
node scripts/agent-catalog-release-cli.mjs coverage-live --local <完整local-capture> --authority '<私有目录>/authority.json' --manifest '<已审manifest.json>' --manifest-sha256 <canonicalSha256> --author owner --reason 'Web发布前核对完整目录覆盖'
if ($LASTEXITCODE -ne 0) { throw '目录覆盖门禁未通过；停止宣称全量一致' }
```

`coverage-gate --local <capture> --index <capture> --manifest <file> --manifest-sha256 <sha>` 使用同一规则离线 dryrun，不登录。索引默认10分钟内有效；没有取得完整索引时明确 UNKNOWN。`manifest-hash` 同时给出 canonicalSha256 与原文件 fileSha256，批准参数使用 canonicalSha256，根可另封存原文件摘要。

供 F 正式发布规约映射的字段只有本目录域的结论，不能替代源码/Git/构建/迁移/切换等其他 gate：

| 实际目录场景 | status | readyToPush / webReleaseAllowed | complete / claimsFullParity | 退出码 |
| --- | --- | --- | --- | --- |
| 完整本地与正规完整生产索引一致，包括已确认的 owner-only/catalog-only 投影 | VERIFIED | true | true | 0 |
| selected 清单逐项明确 preserve-remote/exclude，全部差异已解释，且无待执行写操作 | ACCOUNTED_DIFFERENCES | true | false | 0 |
| 清单仍有未执行 create/update/retire，或分批/断线/待读回 | ACCOUNTED_DIFFERENCES、BLOCKED 或 UNKNOWN | false | false | 3 |
| 正式完整索引未取得、接口/迁移未部署、错误身份、过期或不完整 | UNKNOWN | false | false | 3 |

`readyToPush:true` 表示该次显式清单的 Web 目录覆盖门禁允许继续；只有 `complete:true` 才能声称完整目录按受审策略一致。selected 放行始终保留实际差异，不能将 readyToPush 写成“配置全量一致”。pendingActionIds 非空时，即使设置 allowSelectiveWebRelease 也不能把待执行配置计划当成已完成。

新端点或数据库函数尚未部署时，首次引入该能力存在 bootstrap 顺序：正常 coverage-live 仍返回 UNKNOWN/readyToPush:false/complete:false，保留官方不可用原因；不得用旧权限目录、显式小集合、离线fixture或伪造索引补成 VERIFIED。根的正式发布流程只有在用户明确批准“仅引导代码/端点及必要原生迁移”且其他部署门禁独立通过时，才可按其 bootstrap 分支发布这些代码；这不是本工具的配置放行，也不授权目录 apply。部署后必须重新取得真实完整索引、冻结本次清单并重跑 coverage-live，之后才能报告目录 readyToPush/complete。本 CLI 不提供自动 --bootstrap 绕过、后台写入或自动补发布。

Manifest schema 为 `agent-catalog-release-manifest.v1`，必须包含 releaseId、mode(full/selected)、authority、完整 localInventoryHash、productionIndexHash 和独立稳定 ID actions。create/update action 冻结 `local:{revision,hash,promptHash}`、`production:null|{revision,hash}`，并显式给出 audience。retire 使用现有原生 soft-delete CAS；不因本地缺行自动生成。生产独有/生产已更新默认保护，只有准确 revision/hash 的 preserve-remote 或本地未发布记录的明确 exclude 才能记为已说明；这种 selected 发布即使获准，`claimsFullParity` 仍为 false。

`productionIndexBinding` 也是必填项，必须由真实不可变 index-capture 派生，包含 captureId、原 inventoryHash、observedAt、totalCount、database、identityHash 及 `scope:'all-agents-including-deleted'`。gate 会从私有 hash-chain 日志重取这份正式读回，逐项比较；只填一个格式正确的SHA、64个0、换采集时间/authority/完整范围，即使当前值恰好相同也不会通过。旧manifest缺少绑定时必须重新做真实只读盘点和人工审核，不能自动补签。

发布器在首次进入、每卡处理、每次apply前及确认后重新GET完整合法生产索引。当前索引必须等于manifest冻结索引，或等于只按本manifest持久confirmed回执逐行推进后的索引；其他ID任何新增/删除/修订变化都停止。所有pending都必须先reconcile，未知结果不推进expected hash；已确认卡可用原manifest分批恢复并跳过，不自动重发、不改签其他变化。首次冻结索引默认10分钟内有效；过期的部分发布只能凭先前持久release-started与confirmed回执，配合新的完整合法索引精确匹配后继续。authority/运行四项身份变化仍停止。

写 action 需要 `authorization:{kind:'user-explicit',referenceHash:<用户本次具体批准证据SHA>,approvedAt:<真实时间>,scopeIds:[精确写ID]}`，且命令必须同时给 manifest SHA 与 `--approve-release <releaseId>`。模板的 authorization 默认 null、actions 默认空，不会自动编造用户批准。

`lifecycle` 缺省 executable；显式 catalog-only 只进行目录记录，由原生 API 登记拟用模型，物理 model_id 为空、model为空、inactive，普通source为view_only、owner-only为hidden，不产生 provider 调用。只有 catalog-only 下明确 `stripPortability:['PRIVATE_AGENT_PROXY']` 可以声明剥离这一个本地旧代理，实际值从不传输；其他私有依赖仍阻止。测试卡必须本次 manifest 明确 owner-only，工具/服务都不依赖卡专用ID硬编码。回执固定 `billingEvidence:'configuration-only',providerCalls:0`，不代表付费调用验收。

源与目标归档分别保留 sourceHash/sourceRevision、targetHash/targetRevision、audience/lifecycle/strip。正常owner-only投影或catalog-only物理解绑导致源/目标摘要不同，只要分别匹配已发布双侧基线就视为无待发布；不会反复部署同一份内容。

## 更新前的完整恢复材料

每个update在任何apply之前都保存受控的完整38列前镜像：`before-images/<requestKey>/<stableID>/fields.private.json` 含实际原值，包括正文、非价展示、模型标识/元数据、价格及其他批准列。文件只在私有运行目录，fsync后读回校验全部38列及sourceHash，dispatch与confirmed回执持久引用其摘要、原revision和requestKey。`metadata.json` 与日志只记录引用和哈希，不能把这些摘要当成备份。加载档案会重新校验所有前镜像；丢失或损坏时阻止继续发布。

目标存在私人proxy、渠道/秘密/知识/Skill依赖、不能精确表示的JSON数值等portability标记，或批准列本身含受限引用/明显秘密/带token的URL时，此工具明确阻断update，不保存受限原文，也不宣称38列镜像足以恢复这些额外私有状态。需要这类修改时必须另走明确审定的受控数据库备份/恢复合同；当前CLI没有仅凭一个备份hash就绕过阻断的参数。

```powershell
# 只验证并显示私有前镜像文件路径，不打印38列值、不执行回滚。
node scripts/agent-catalog-release-cli.mjs before-image --request-key <原请求UUID>
node scripts/agent-catalog-release-cli.mjs verify
```

恢复数据仍须根独立审核当前revision、模型/权限/资产资格及正常写路径；这里提供可读回的真实原值，不自动回滚或绕过原生准入。

## 云端更新与本地已发布缓存

`refresh-published --authority <私有authority.json> --author owner --reason <原因>` 是正规入口：默认仅刷新已有发布 baseline IDs；尚无基线时必须显式给 `--ids <私有ids.json>`。正常 owner API 读取当前云端值，追加私有缓存版本；不推进基线、不覆盖本地draft、不写本地业务数据库。云端有新修订、草稿已变、删除/受限依赖或接口不可用都保留明确状态，不能用刷新消除冲突。需接纳远端新baseline仍运行显式 `baseline`；这也不会把旧草稿当已合并。

## 并发、断线和恢复

每次本地变更使用 OS 独占创建的 `.lock`，冲突即失败，不按 PID/时间自动清锁。进程异常后需先审阅原进程及 pending，再由根明确处理锁，不能靠启动下一次任务自动解锁。

每次 apply 前 fsync 记录稳定 requestKey、计划/源/目标哈希、CAS revision 和 `issued_unknown`。apply只派发一次；断线/5xx/返回不合约时保留 pending，后续 publish拒绝该 ID。收到合法服务端写回执会再持久记录 `receipt-observed`，随后读取实际生产配置；因此可区别“结果未知”与“已确认写入、待读回”。只有回执与真实读回均一致才推进已发布基线。断线后执行 reconcile，仅 GET 原 requestKey 和同 ID 读回，不自动补发。确切4xx拒绝只在 apply本次响应上释放 pending，读回403不会被误算成未写。单卡拒绝不会阻断其他独立卡；生产身份漂移会停止后续派发。

日志文件或版本字节损坏时完整性校验失败，不自动覆盖/截断以制造“恢复成功”。无引用 `.pending-*` 目录是未完成本地版本写入，不能当成既有历史或生产确认。本文只提供本地档案、发布计划与正常 API 执行器，不自动授权任何生产变更。
