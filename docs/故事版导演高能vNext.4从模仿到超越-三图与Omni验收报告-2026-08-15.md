# 故事版导演高能 vNext.4「从模仿到超越」三图与 Omni 验收报告

日期：2026-08-15  
验收范围：只包含「故事版导演｜高能夸张」；电影叙事、抒情情感未修改。  
结论：高能 Prompt 门禁和图片门禁通过；Omni 视频因渠道用户额度不足阻塞，因此全流程门禁未通过，按强制顺序停止后续两版。

## 1. 修改前备份与回滚

| 项目 | 值 |
| --- | --- |
| 智能体 ID | `agent-1786633444187-594spj` |
| 修改前版本 | `vNext.3` |
| 修改前 SHA256 | `1488ba6e20e67782535af52748a67f1897e9560ce50b7b6c4753b85572221e34` |
| 修改前平台历史 ID | `27c6180c-ea0d-4998-bfb5-67cd24fe95b0` |
| 修改前本地快照 | `backups/storyboard-directors-semantic-vnext-preflight-20260815T064937Z/` |
| 变更快照 | `backups/storyboard-high-energy-semantic-vnext-4-change-2026-08-15T065320150Z/` |
| 修改后版本 | `vNext.4` |
| 修改后 SHA256 | `0e9d7b4550efa5a80cb5d8b0f01624af484f40c62e18c3d833e02b452d0030ee` |
| 修改后平台历史 ID | `15517dba-7ce3-427f-a6ef-e72acfa0173c` |
| 修改后复核快照 | `backups/storyboard-directors-semantic-vnext-preflight-20260815T070501Z/` |

修改前已完整保存系统 Prompt、接收模板 `preset_fields`、`output_style`、智能体行快照和平台 Prompt 历史。回滚时在平台后台选择历史 ID `27c6180c-ea0d-4998-bfb5-67cd24fe95b0` 恢复，或从修改前本地快照取回对应字段；不得覆盖已有历史。

## 2. vNext.4 最小升级

vNext.4 没有推倒 vNext.3，继续保留：皮克斯式商业 3D 强风格锁、4/5 格语义判断、开放包装家族、每格英文动作说明条、每段生图和视频两个独立 `text` 代码框。

本次新增的导演决策层：

1. 先从全文选择一个主冲突、一个核心信息任务和一个统一视觉母题，不逐句堆图。
2. 内部生成「角色表演、现实道具/环境、语义隐喻包装」三种候选，按语义准确、20% 缩略图冲击、角色互动、视频可执行、批次独特性、安全稳定评分，只输出最优方案，不展示内部推理。
3. 视觉母题必须经历「出现 → 增强 → 与角色/环境碰撞 → 转化或收束」，包装不能成为悬浮贴纸。
4. 批次多样性账本同时检查人物、犬种、主道具、包装家族、功能色、机位、构图和知识装置；相邻段禁止整套复用。
5. 动态色彩采用「环境基础色 → 冲突功能色 → 高潮强调色 → 结尾回归色」，金色只是合法候选，不是默认滤镜。
6. 动作采用「预备/蓄力 → 发力 → 反应 → 环境余波 → 清晰停留」，相邻镜用视线、飞散物、光线、门、滚动物或运动方向交接。
7. 每格只有一个主焦点，但至少具备角色表演、现实物理、语义包装中的两层；允许纯表演或纯现实证据的松弛格，禁止每格都爆炸、发光、张嘴。
8. 错字改无文字图形，肢体风险降低动作极限，道具遮挡调整空间，包装太弱加强角色互动，医学不适改局部友好示意。
9. 反例门禁：换到无关文案仍成立的道具/效果淘汰；不与角色环境互动的装饰淘汰；缩略到 20% 没有唯一钩子淘汰；与本批方案高度相似时重选。

这套规则没有禁止盾牌、天平、金线、发光牌或弹窗。它们在语义、场景和互动需要时仍可使用；被禁止的是固定模板、无理由套用和相邻段整套重复。

## 3. 平台真实输出

测试文案来自用户既有宠物行为/科普语料的新案例，未复用零食总量案例：

> 狗狗无缘无故地乱叫？它的听力是人类的十几倍，有时候甚至能听到我们听不到的声音，可能是门外陌生的脚步，也可能是眼前飞过的昆虫。

| 项目 | 结果 |
| --- | --- |
| 平台会话 ID | `conv_storyboard_semantic_vnext_high_energy_1786776895749_ve5gg1` |
| 真实输出证据 | `.tmp-e2e/storyboard-high-energy-vnext4-hidden-signal-benchmark-20260815-1-suite.json` |
| 输出格式 | 生图 Prompt 和视频 Prompt 两个独立 `text` 代码框，通过 |
| 人物选择 | 30 岁成年亚洲女性、黑色齐下巴波波头、砖红开衫、米白上衣、深青长裤；不是固定黄卫衣 |
| 犬种选择 | 高能、动作轮廓和喜剧反差语义选择柯基，并在图视频 Prompt 中完整锁定 |
| 主冲突 | 狗似乎无故吠叫，实际提前捕捉人类听不到的声音 |
| 统一视觉母题 | 常人不可察觉的声音痕迹 |
| 母题生命周期 | 门缝冷青声纹出现 → 触耳增强 → 转成珊瑚红/冷青听力刻度 → 碎散并收束为飞虫振翅轨迹 |
| 色彩脚本 | 暖白浅木 → 冷青异常 → 珊瑚红高潮 → 自然暖色回归 |
| 实际视频镜头 | 10 秒 4 镜；具备预备、发力、反应、物理余波、停留和跨镜钩子 |

## 4. 三张真实 GPT Image A 图片

三张图片均将同一份平台智能体原始生图 Prompt 送入分镜工作台，模型公开名称为 `GPT Image A`，没有手写或修改测试卡片 Prompt。

| 候选 | 总分 | 结果文件 | 复核 URL |
| --- | ---: | --- | --- |
| 1 | 94.1 | `.tmp-e2e/high-energy-vnext4-hidden-signal-gpt-image-candidate-1-20260815-result.json` | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-hidden-signal-gpt-image-candidate-1-20260815` |
| 2 | **95.9** | `.tmp-e2e/high-energy-vnext4-hidden-signal-gpt-image-candidate-2-20260815-result.json` | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-hidden-signal-gpt-image-candidate-2-20260815` |
| 3 | 95.7 | `.tmp-e2e/high-energy-vnext4-hidden-signal-gpt-image-candidate-3-20260815-result.json` | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-hidden-signal-gpt-image-candidate-3-20260815` |

原图：

- `.tmp-e2e/high-energy-vnext4-hidden-signal-gpt-image-candidate-1-20260815-image.png`
- `.tmp-e2e/high-energy-vnext4-hidden-signal-gpt-image-candidate-2-20260815-image.png`
- `.tmp-e2e/high-energy-vnext4-hidden-signal-gpt-image-candidate-3-20260815-image.png`

逐项评分证据：`.tmp-e2e/storyboard-high-energy-vnext4-three-image-benchmark-score.json`。

评分覆盖语义准确、视觉母题、道具独特性、特效与角色互动、动态色彩脚本、动作峰值、机位差异、缩略图钩子、皮克斯式动画风格、人物/犬体稳定、文字准确 11 项。三张全部达到 92 分以上，最佳图 95.9 分，超过 vNext.3 的 94 分基线。

硬失败审计全部为否：无真人/半写实、无无关固定道具、无全片黄线金光、无监控式同构图、无动作事件重复、无人物或犬种漂移、无肢体扭曲、无错误文字。四格英文制作说明 12/12 准确，场景短标签「十几倍」3/3 准确。

## 5. Omni 真实视频提交

最佳候选 2 的原图被原样用作参考图，平台真实提交参数：

| 项目 | 值 |
| --- | --- |
| 视频模型 | `omni-flash-10s-1080p-ch3`（公开名称 Omni） |
| 时长/分辨率 | 10 秒 / 1080P |
| H3 | 未调用 |
| 参考来源 | `high-energy-vnext4-hidden-signal-gpt-image-candidate-2-20260815` |
| 复核 URL | `http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-hidden-signal-best2-omni-video-20260815` |
| 结果 | 失败，未生成视频 |
| 精确错误 | `高瑞user quota is not enough` |
| 错误阶段 | `video-running`；接口 HTTP 500 |
| 证据 | `.tmp-e2e/high-energy-vnext4-hidden-signal-best2-omni-video-20260815-result.json`、`public/storyboard-reviews/high-energy-vnext4-hidden-signal-best2-omni-video-20260815.json` |

因此无法验收成片的 3D 风格保持、角色一致、3–4 个实际镜头、包装参与运动、动作节奏、过渡钩子、无说话口型和无额外文字。不得把「已提交」写成「视频通过」。额度恢复后的下一步是从上述复核记录重试同一个 Omni 任务，不换模型、不改参考图、不改平台输出 Prompt。

## 6. 费用与门禁结论

| 项目 | 实际费用 |
| --- | ---: |
| GPT Image A × 3 | ¥0.60 |
| Omni 视频 | ¥0.00（额度检查失败，未生成） |
| 本轮合计 | ¥0.60 |

- Prompt 门禁：通过。
- 图片门禁：通过，3/3 ≥ 92，最佳 95.9 ≥ 94，无硬失败。
- 视频门禁：阻塞，原因是 Omni 渠道用户额度不足。
- 总门禁：未通过。按用户强制顺序，不修改电影叙事和抒情情感，两者继续保持 vNext.3。
- 自由画布：未修改、未读取三卡 Prompt/JSON、未建立耦合。

