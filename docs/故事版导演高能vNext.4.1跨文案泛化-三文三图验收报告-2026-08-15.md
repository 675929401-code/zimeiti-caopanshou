# 故事版导演高能 vNext.4.1 跨文案泛化三文三图验收报告

日期：2026-08-15  
验收范围：仅「故事版导演｜高能夸张」。  
测试设计：三条语义、场景和包装载体不同的口播文案，各自建立独立平台会话，各自输出一份原始双 `text` Prompt，各自使用当时工作台公开名称 GPT Image A 生成一张真实图片。  
路由终态：用户最终只保留 `gpt-image-2-chA-1 / GPT-Image-2 · 渠道A pro`，公开 ID `pm_HabdJ5rvD_L3-HUkfMUmGsrm`，绑定 E 指纹并由密钥组选择 `adobe-image2-high` 高质量路由；payload model 按供应商契约保持 `gpt-image-2`，支持 1K/2K/4K、默认 2K。本轮原三张产生于已删除的 `gpt-image-2-chA-2` / F 指纹时期，只能作为方法论和跨文案差异证据，不能冒充 E 高质量组证据。当前 pro 路由已另做一次 2K 真实成功验收，详见 `GPT-Image-2渠道A-pro高质量路由排障与2K真实验收报告-2026-08-15.md`。

## 1. 测试设计纠正

上一轮使用同一份 Prompt 生成三张图片，只能验证图片模型的结果稳定性，不能证明故事版智能体对不同文案的语义泛化。本轮将验收单元纠正为：

`不同口播文案 → 独立平台会话 → 独立导演判断 → 独立双Prompt → 独立真实图片 → 跨文案差异审计`

三条文案没有被改写成剧本，只按用户提供的原创抖音口播原文进入平台字段。

## 2. Prompt版本、备份与源头修复

| 项目 | 值 |
| --- | --- |
| Agent | `agent-1786633444187-594spj` |
| 测试起点 | 高能 vNext.4 |
| 起点 SHA256 | `0e9d7b4550efa5a80cb5d8b0f01624af484f40c62e18c3d833e02b452d0030ee` |
| 起点平台历史 ID | `15517dba-7ce3-427f-a6ef-e72acfa0173c` |
| 本轮修改前快照 | `backups/storyboard-directors-semantic-vnext-preflight-20260815T072038Z/` |
| 修复后版本 | 高能 vNext.4.1 |
| 修复后 SHA256 | `fef1331a75640908d50394c4631f4749cff7f57c2a3f0e5a95772c5ec2020571` |
| 修复后平台历史 ID | `9c144582-1a53-4474-bec2-56b423dbc85e` |
| 变更快照 | `backups/storyboard-high-energy-semantic-vnext-4-1-change-2026-08-15T072244883Z/` |
| 修改后复核快照 | `backups/storyboard-directors-semantic-vnext-preflight-20260815T073242Z/` |

A、B 首轮真实输出通过。C 首轮真实输出虽然正确选择柯基、犬床和祖先草窝母题，却完全省略人物，违反“未指定人物时默认成年亚洲女性”。失败发生在结构门禁，未把失败 Prompt 送入图片模型。

vNext.4.1 只增加一条源头修复：默认成年亚洲女性必须进入完整资产锁，并至少在一格与宠物、道具或环境发生有意义的反应或关系行为，不得因为宠物可以单独完成动作就省略人物。电影叙事和抒情情感 SHA 在修改前后均保持不变；`free_canvas_coupling=false`。

回滚：优先在平台后台恢复历史 ID `15517dba-7ce3-427f-a6ef-e72acfa0173c`；也可从本轮修改前快照恢复系统 Prompt、`preset_fields`、`output_style` 和 `guide_message` 后核对旧 SHA。

## 3. 三条独立平台真实会话

### A 健康判断 / 身体负担

平台会话：`conv_storyboard_semantic_vnext_high_energy_1786778290633_jaa9xx`  
原始输出：`.tmp-e2e/storyboard-high-energy-vnext4-generalization-a-20260815-1-suite.json`

- 人物/犬种：31岁成年亚洲女性宠物健康顾问 + 柯基。
- 主冲突：凭可爱判断胖瘦 versus 用体态和运动反馈判断健康。
- 视觉母题：薄荷绿体态检查线。
- 核心载体：俯视检查垫、无创肋骨弧影、宠物台阶实体消耗槽、步道嵌灯。
- 空间：家庭检查角转向户外散步路径。
- 色彩：奶白木色/珊瑚红 → 薄荷绿 → 琥珀警示 → 夕阳粉回归。
- 动作：移开过量犬粮 → 触摸侧腹 → 上阶喘息停顿 → 减少份量 → 轻快同行。
- 相机：正上俯拍、侧腹低位近景、台阶贴地广角、桌面高度关系中景、后侧超低全景。
- 门禁：没有普通体重秤套模板，没有恶心解剖。

### B 关系情绪 / 安全确认

平台会话：`conv_storyboard_semantic_vnext_high_energy_1786778290564_50whnc`  
原始输出：`.tmp-e2e/storyboard-high-energy-vnext4-generalization-b-20260815-1-suite.json`

- 人物/犬种：32岁成年亚洲女性 + 金毛。
- 主冲突：把回头误解为磨蹭胆小 versus 把主人确认成安全坐标。
- 视觉母题：深蓝牵引绳从绷紧变成松弛 U 形。
- 核心载体：真实绳索张力、步道铺装汇聚线、金属定位嵌件、最终松弛绳弧。
- 空间：清晨城市公园弧形步道。
- 色彩：灰绿暖白 → 深蓝冲突 → 青绿/珊瑚确认 → 自然晨光。
- 动作：走几步回望 → 女性停步回视 → 松开手腕 → 眼神许可后向前 → 同步前行。
- 相机：低位侧后跟拍、犬肩后主观视角、侧面环绕、低位前侧广角、升起大全景。
- 门禁：没有无理由爱心雨、盾牌或天平。

### C 本能机制 / 喜剧动作

平台会话：`conv_storyboard_semantic_vnext_high_energy_1786778576576_z2zzk6`  
原始输出：`.tmp-e2e/storyboard-high-energy-vnext4-generalization-c-20260815-2-suite.json`

- 人物/犬种：32岁成年亚洲女性宠物行为撰稿人 + 柯基。
- 主冲突：把转圈扒窝误解为嫌弃新床 versus 现代环境自动运行的祖先生存程序。
- 视觉母题：犬床纤维显影为环形草叶压痕，最终沉回真实卧痕。
- 核心载体：深蓝犬床与软垫纤维、橡胶小虫玩具、窗帘真实气流、草叶压痕。
- 空间：冷蓝月光与暖橙灯光并存的现代卧室。
- 色彩：深蓝/暖橙 → 青绿 → 珊瑚红/冷蓝 → 安静暖橙回归。
- 动作：嗅闻试探 → 转圈带动软垫 → 扒窝弹出玩具虫 → 鼻尖耳朵感受风向 → 蜷卧压出卧痕。
- 相机：犬眼低机位、斜俯拍旋转、爪部贴地特写、侧逆光中景、略高全宽近景。
- 门禁：旋转由文案本能机制选中，没有复用上一条隐藏声源的声波方案。

三份生图和视频 Prompt 均完整重复高端商业级皮克斯式风格化 3D、非真人、非半写实、非照片写实锁；视频 Prompt 均锁定同一人物和犬种，不重新设计资产。

## 4. 旧 F 路由三图：仅作方法论历史证据

| 文案 | 图片评分 | 跨文案差异度 | 复核 URL |
| --- | ---: | ---: | --- |
| A 健康判断 | 96.1 | 98 | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-generalization-a-health-gpt-image-20260815` |
| B 关系安全 | 97.1 | 99 | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-generalization-b-safety-gpt-image-20260815` |
| C 本能机制 | 97.5 | 99 | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-generalization-c-instinct-gpt-image-20260815` |

逐图证据：

- A：`.tmp-e2e/high-energy-vnext4-generalization-a-health-gpt-image-20260815-image.png`、`.tmp-e2e/high-energy-vnext4-generalization-a-health-gpt-image-20260815-result.json`
- B：`.tmp-e2e/high-energy-vnext4-generalization-b-safety-gpt-image-20260815-image.png`、`.tmp-e2e/high-energy-vnext4-generalization-b-safety-gpt-image-20260815-result.json`
- C：`.tmp-e2e/high-energy-vnext4-generalization-c-instinct-gpt-image-20260815-image.png`、`.tmp-e2e/high-energy-vnext4-generalization-c-instinct-gpt-image-20260815-result.json`

完整评分：`.tmp-e2e/storyboard-high-energy-vnext4-cross-copy-generalization-score.json`。

每张均按语义准确、视觉母题、道具独特性、特效与角色互动、动态色彩、动作峰值、镜头差异、缩略图钩子、皮克斯式动画风格、人物/犬体稳定、文字准确 11 项评分，并单独增加跨文案差异度。3/3 均达到 92 分以上；核心载体、空间和相机序列不重复；英文动作说明 15/15 准确，中文短标签 5/5 准确：`正常腰线`、`体力透支`、`安全坐标`、`清理本能`、`风向`。

硬失败全部为否：无真人/半写实、无无关固定道具、无核心载体复用、无全片金光、无监控式构图、无重复事件、无人物/犬种漂移、无肢体扭曲、无错字、无不适解剖。

以上结论证明 vNext.4.1 面对不同文案时能改变角色/犬种、道具、空间、包装、色彩和相机语法；原三张不证明命中当前 E 高质量组。它们的评分只保留为 Prompt/视觉方法论历史证据，不再计入最终图片门禁。

## 5. 正确 pro 路由三文三图最终验收

排障完成后，从原平台历史恢复 A/B/C 三个会话及原始生图 Prompt，没有开发者手写替换。三条分别在分镜工作台使用当前唯一保留的 `GPT-Image-2 · 渠道A pro` 各提交一次 2K 生图，没有付费重试。

| 文案 | 平台会话 | 最终评分 | 跨文案差异 | 真实文件 | 复核 URL |
| --- | --- | ---: | ---: | --- | --- |
| A 健康判断 | `conv_storyboard_semantic_vnext_high_energy_1786778290633_jaa9xx` | 97.2 | 99 | 2560×1440 PNG，4,702,910 bytes | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-generalization-a-health-gpt-image-pro2k-20260815` |
| B 关系安全 | `conv_storyboard_semantic_vnext_high_energy_1786778290564_50whnc` | 97.5 | 99 | 2560×1440 PNG，6,102,261 bytes | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-generalization-b-safety-gpt-image-pro2k-20260815` |
| C 本能机制 | `conv_storyboard_semantic_vnext_high_energy_1786778576576_z2zzk6` | 98.2 | 99 | 2560×1440 PNG，5,043,368 bytes | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-generalization-c-instinct-gpt-image-pro2k-20260815` |

正式路由证据：DB `gpt-image-2-chA-1`、公开 ID `pm_HabdJ5rvD_L3-HUkfMUmGsrm`、E 指纹 `sha256:0b49a8c5f27a…yaoE`、payload `model=gpt-image-2`、高质量密钥组 `adobe-image2-high`、分辨率 `2K`；已删除的 `gpt-image-2-chA-2` 当前行数为 0。完整评分：`.tmp-e2e/storyboard-high-energy-vnext4-pro2k-cross-copy-final-score.json`；平台会话、工作台历史、路由和费用证据：`.tmp-e2e/storyboard-high-energy-vnext4-pro2k-route-billing-history-evidence.json`。pro 路由回滚点为 `backups/gpt-image2-pro-route-pre-20260815-162954/`；回滚不得插回旧 `gpt-image-2-chA-2`，也不得覆盖当前 pro 行。

逐图本地证据：

- A：`.tmp-e2e/high-energy-vnext4-generalization-a-health-gpt-image-pro2k-20260815-image.png`、`.tmp-e2e/high-energy-vnext4-generalization-a-health-gpt-image-pro2k-20260815-result.json`
- B：`.tmp-e2e/high-energy-vnext4-generalization-b-safety-gpt-image-pro2k-20260815-image.png`、`.tmp-e2e/high-energy-vnext4-generalization-b-safety-gpt-image-pro2k-20260815-result.json`
- C：`.tmp-e2e/high-energy-vnext4-generalization-c-instinct-gpt-image-pro2k-20260815-image.png`、`.tmp-e2e/high-energy-vnext4-generalization-c-instinct-gpt-image-pro2k-20260815-result.json`

11维与附加门禁均通过：成年亚洲女性默认角色 3/3；犬种 A/C 柯基、B 金毛符合语义；皮克斯式商业 3D 锁 3/3；英文动作说明条 15/15；中文短标签 `正常腰线`、`体力透支`、`安全坐标`、`清理本能`、`风向` 5/5；无真人/半写实、畸形、监控感、固定道具套用、普通体重秤、不适解剖、爱心雨、盾牌或天平硬失败。三条主道具、色彩脚本、动作链和相机序列均不同。

## 6. 费用与视频状态

| 项目 | 实际费用 |
| --- | ---: |
| A GPT Image A | ¥0.20 |
| B GPT Image A | ¥0.20 |
| C GPT Image A | ¥0.20 |
| 旧 F 路由三图历史业务计价 | ¥0.60 |
| 当前 pro 2K A/B/C 业务计价 | ¥0.60（3×¥0.20） |
| 当前 pro 2K 管理员验收账户本地现金扣款 | ¥0.00（现金流水0条） |
| C → Omni Flash 10秒1080P | ¥0.00（quota 失败） |

费用口径：当前 pro 三图的生产业务价合计为 ¥0.60；本次使用管理员验收账户，本地实际现金扣款为 ¥0.00。接口没有返回供应商侧独立账单金额，因此不把业务价伪写成已核销的供应商账单。

在用户随后纠正生图路由之前，已按当时最新指令选择跨文案评分最高且动作最适合的 C，复用平台会话 `conv_storyboard_semantic_vnext_high_energy_1786778576576_z2zzk6` 的原始视频 Prompt 与真实 C 原图，向准确后台模型 `omni-flash-10s-1080p-ch3`（公开 ID `pm_11gMj3vJW9NhBw75h4XZNUxu`）提交一次且仅一次。3.6 秒后返回：`Omni Flash · 10秒 · 1080p的渠道额度暂不可用，请联系管理员检查该模型渠道账户`；后台诊断根因为 `user quota is not enough`。无视频 URL，未重试。

- 视频复核页：`http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-generalization-c-instinct-omni-video-20260815`
- 页面执行证据：`.tmp-e2e/high-energy-vnext4-generalization-c-instinct-omni-video-20260815-result.json`
- 公开复核记录：`public/storyboard-reviews/high-energy-vnext4-generalization-c-instinct-omni-video-20260815.json`
- 后台失败历史与扣费证据：`.tmp-e2e/high-energy-vnext4-generalization-c-instinct-omni-video-20260815-db-evidence.json`
- 后台历史：`status=failed`、10秒、C原图已绑定、`price_charged=0`；关联现金流水 `0` 条。

视频未生成，因此皮克斯式 3D 风格保持、人物/犬种一致、实际镜头数、动作节奏与包装生命周期均不能评分，也不能宣称视频通过。生图在路由排障完成后按授权恢复并完成三次 pro 2K 终验；视频则始终保持暂停，没有新的 Omni 提交。

新 pro 三图通过后，已选择评分最高且动作链最完整的 C 作为后续视频候选，保留其原图和平台原始视频 Prompt。当前 Omni 绑定凭据 quota 没有新的恢复证据，因此本轮没有再提交视频。

## 7. 最终结论

- 平台真实 Prompt 泛化门禁：通过。
- 正确 pro 路由三文三图门禁：通过，97.2/97.5/98.2，3/3 ≥ 92，真实像素均为 2560×1440。
- 跨文案差异门禁：通过，99/99/99，核心载体、色彩、动作链和相机序列零整套复用。
- 视频门禁：C 已锁定为候选，但 Omni quota 未确认恢复，未再次提交；历史唯一失败任务零扣费、无 URL，故视频仍未通过。
- 当前执行状态：高能 vNext.4.1 的 Prompt 泛化与正确 pro 2K 图片门禁已通过；视频因供应商 quota 阻塞。按强制顺序，电影叙事与抒情情感仍不解锁。
- 电影叙事、抒情情感：保持 vNext.3，未修改、未测试。
- 本轮只在 C 首轮结构失败后把高能源 Prompt 从 vNext.4 修到 vNext.4.1；pro 路由修复与三图重跑阶段未再次修改三卡 Prompt。电影/抒情、自由画布、主题和工具箱未修改；分镜工作台只更新 pro 公开名、分辨率能力、图片 adapter、脱敏和扣费幂等。
