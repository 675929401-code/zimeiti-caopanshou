# 故事版导演语义泛化与开放包装 vNext.3 验收报告

日期：2026-08-15  
结论：三张平台智能体的Prompt与真实结构回归通过；高能版GPT Image A真实图片通过；Omni因上游额度不足阻塞，未生成视频，不能宣称视频通过。

## 1. 本轮纠偏

用户要求不是删除盾牌、天平、金线、发光牌、警报牌、弹窗和画内文字，而是把它们从固定答案恢复为开放候选，并建立能随文案判断和搭配的生成方法。vNext.3采用：

`文案意图 → 角色/犬种资产 → 事件因果 → 动作峰值 → 真实物理证据 → 信息任务 → 包装家族 → 语义核/视觉动词/场景载体/空间形态/角色互动/生命周期 → 文字预算 → 4/5格 → 10/15秒实际镜头`

开放包装家族包含剧情道具、测量与状态、标识与结论、关系与平衡、流动与轨迹、空间与环境、局部友好示意、漫画与动作包装。盾牌、天平、金线、发光牌、警报牌和弹窗均可按需使用；验收反对的是无理由整套复制，不反对形式本身。

## 2. 风格与文字规则

- 默认首层风格锁为“对标一致的高端商业级皮克斯式风格化3D动画电影”，禁止真人、半写实和照片写实。
- 材质可以可信精细，但人物必须保持动画骨相、无毛孔皮肤和归纳发束；犬只必须保持明确犬种、动画化头颅眼睛、自然四足和稳定骨骼。
- 每格下方白色英文动作说明条是必选项，逐格提供视频动作依据。
- 场景内短标签不是禁区：高能知识/健康/结论段按需0至2处，电影/抒情通常0至1处；必须短、准确、绑定实体并生成后逐字核对。
- 10秒为3至4个实际镜头，15秒为4至5个实际镜头；4格与5格由语义锚点决定，不等于视频机械切镜数。

## 3. 当前平台版本与回滚

| 模式 | Agent ID | vNext.3 Prompt SHA256 | 当前历史ID |
| --- | --- | --- | --- |
| 高能夸张 | `agent-1786633444187-594spj` | `1488ba6e20e67782535af52748a67f1897e9560ce50b7b6c4753b85572221e34` | `27c6180c-ea0d-4998-bfb5-67cd24fe95b0` |
| 电影叙事 | `agent-1786642714227-e1zid1` | `86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302` | `e328f7e9-5924-409b-b812-cc10f3ade389` |
| 抒情情感 | `agent-1786642714448-m6iaou` | `defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885` | `16d1a454-56e9-489f-9541-533f6243da86` |

vNext.3上线前的vNext.2回滚历史ID：高能`106a7b05-0f54-42ad-bb35-bd5cb85b8d6b`、电影`718ad097-d311-4f27-bcc1-123ef2d7c727`、抒情`e5b87e6b-e9a9-4741-80dc-c02ee9279aa6`。

修改前备份：`backups/storyboard-directors-semantic-vnext-preflight-20260815T051855Z/`。  
修改记录备份：`backups/storyboard-directors-semantic-vnext-3-change-2026-08-15T052041691Z/`。  
修改后快照：`backups/storyboard-directors-semantic-vnext-preflight-20260815T053320Z/`。

回滚优先在平台后台Prompt历史选择修改前历史ID；也可按修改前备份的`恢复说明.md`把白名单字段PUT回`/api/admin/agents`，再GET并核对SHA。项目目录不是Git仓库，因此本轮无法创建Git tag，回滚依赖平台历史和本地JSON快照。

## 4. 三卡真实结构回归

三张卡均用同一批四类文案真实调用平台智能体：关系与社交破冰、累积与热量挤占、听觉与视线校准、时间与情绪留痕。每段均得到一个生图Prompt和一个视频Prompt，无JSON前台包。

| 模式 | 对话ID | 结果 | 格数 | 10秒实际镜头 | 英文说明条 |
| --- | --- | --- | --- | --- | --- |
| 高能夸张 | `conv_storyboard_semantic_vnext_high_energy_1786771256847_cq7pmf` | 4/4通过 | 每段4格 | 每段4镜 | 16/16格齐全 |
| 电影叙事 | `conv_storyboard_semantic_vnext_cinematic_1786771681977_5quxri` | 4/4通过 | 每段4格 | 每段4镜 | 16/16格齐全 |
| 抒情情感 | `conv_storyboard_semantic_vnext_lyrical_1786771681936_1s23nh` | 4/4通过 | 4、4、4、5格 | 每段4镜 | 17/17格齐全 |

真实结果文件：

- `.tmp-e2e/storyboard-semantic-vnext3-high-energy-packaging-regression-20260815-1-suite.json`
- `.tmp-e2e/storyboard-semantic-vnext3-cinematic-packaging-regression-20260815-1-suite.json`
- `.tmp-e2e/storyboard-semantic-vnext3-lyrical-packaging-regression-20260815-1-suite.json`

同一“零食挤占正餐”文案的模式差异：

- 高能：织物刻度、弹性速度弧、量杯阈值、跷跷杠杆、“全天总量”和“正餐空间”。
- 电影：量杯与实体颗粒堆叠、扑空动作弧、真实体积取舍和更克制的“总量”嵌牌。
- 抒情：训练袋计量窗、透明分格碗、可滑动隔板、单个“全天总量”标签和安静收束。

## 5. GPT Image A真实图片与横评

来源必须是平台高能智能体真实输出，未手写测试Prompt。来源对话：`conv_storyboard_semantic_vnext_high_energy_1786771256847_cq7pmf`，来源段落：累积与热量挤占。

- 复核URL：`http://127.0.0.1:5000/storyboard-workbench?review=high-energy-semantic-vnext3-packaging-gpt-image-live-20260815-1`
- 图片：`.tmp-e2e/high-energy-semantic-vnext3-packaging-gpt-image-live-20260815-1-image.png`
- 结果：`.tmp-e2e/high-energy-semantic-vnext3-packaging-gpt-image-live-20260815-1-result.json`
- 模型：GPT Image A；1280×720；真实完成。

| 维度 | 分数/10 | 证据 |
| --- | ---: | --- |
| 皮克斯式风格对齐 | 9.5 | 明显动画骨相、无真人毛孔和半写实漂移 |
| 角色/宠物表演 | 9.2 | 投零食、扑空、观察量杯、触碰食盆四个不同动作峰值 |
| 事件与因果 | 9.6 | 期待累积→扑空→计入总量→挤占正餐，因果可只看图读懂 |
| 语义包装 | 9.7 | 刻度、速度弧、量杯阈值、杠杆和容量变化均由角色触发 |
| 镜头变化 | 9.2 | 袋口低机位、侧向动作、量杯近景、杠杆中全景 |
| 材质与物理 | 9.4 | 颗粒重力、袋体受力、狗爪落点和杠杆关系可信 |
| 色彩 | 8.9 | 薄荷青/珊瑚红功能明确；单格爆发饱和度略低于对标 |
| 人体/犬体稳定 | 9.2 | 同一男性与同一柯基跨格稳定，无额外肢体和明显扭曲 |
| 文字准确度 | 10.0 | 四条英文动作句4/4准确；“全天总量”“正餐空间”2/2准确 |
| **综合** | **94/100** | 通过；信息逻辑和文字准确度优于本轮对标，单格爆发饱和度仍有提升空间 |

被用户否决的过度收敛图保留为反例，不作为通过证据：`.tmp-e2e/high-energy-semantic-vnext-gpt-image-live-20260815-1-image.png`。

## 6. Omni真实尝试

- 复用已通过参考图，不重新生图。
- 模型：`omni-flash-10s-1080p-ch3`（Omni Flash 10秒1080P）。
- 结果文件：`.tmp-e2e/high-energy-semantic-vnext3-packaging-omni-video-live-20260815-1-result.json`。
- 精确错误：`高瑞user quota is not enough`。
- 阶段：`video-running`创建任务时失败；`videoStatus=failed`，没有视频URL，不计为通过，也未用其他模型替代。

## 7. 费用

- 本任务成功生成GPT Image A图片2张，每张公开成本价为¥0.20，合计¥0.40；其中1张为用户纠偏前反例，1张为vNext.3通过图。
- Omni未产出成片；当前证据中没有成功视频费用，不虚报为0元成功生成。
- 三卡结构回归为平台文本智能体调用，现有测试记录未提供独立可核对的媒体计费项。

## 8. 工程验证与边界

- 目标ESLint通过。
- vNext/vNext.1/vNext.2/vNext.3脚本中的新增TypeScript错误已清零；全量`tsc --noEmit`仍被旧v6.3/v6.4迁移脚本和既有自由画布字段错误阻塞，本任务未修改自由画布。
- 当前三卡真实输出无JSON机器包，运行时源码不存在三个Agent ID引用；三卡`output_style.free_canvas_coupling=false`。自由画布源码中既有通用协议兼容代码未改动，也未读取vNext.3三卡Prompt或Agent ID。

## 9. 未决项

1. Omni渠道补充额度后，用当前通过图原样重试，检查3D风格保持、4个实际镜头、无说话口型、无额外文字和包装延续。
2. 后续新文案继续维护批次级多样性账本；允许语义驱动复用盾牌、天平等，但记录新的载体、互动和生命周期，避免整套复制。
3. 若要彻底移除自由画布历史遗留的通用故事板协议兼容代码，应另开自由画布专项；本任务按边界未修改自由画布。
