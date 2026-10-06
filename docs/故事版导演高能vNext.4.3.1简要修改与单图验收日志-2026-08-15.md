# 高能vNext.4.3.1简要修改与单图验收日志

日期：2026-08-15  
范围：仅“故事版导演｜高能夸张”；电影叙事、抒情情感和自由画布未修改。

## 修改与回滚

- vNext.4.2增加人体/犬体硬门禁、4/5格高能钩子比例、强透视、物理反馈和语义英雄揭示。
- vNext.4.3把未指定人物的默认女主锁为28至32岁成年亚洲女性、经典高端商业3D动画电影女主造型，补齐脸型、五官、马尾、成年体态、服装配色和跨格一致性。
- vNext.4.3.1禁止同格重复手/手持道具；手持前景特写必须显示完整手掌至肩的唯一连接，否则改用无手接触的滚动物、织物或环境形变制造前景冲击。
- 当前Prompt SHA：`c028fea1fbed5da74d29f3f09a73a1b67034affc7e1222387e6ba53050c00905`；平台历史：`5a449055-5ec2-4cb5-a6b4-dec8cba47a77`。
- 直接回滚点：vNext.4.3 SHA `79fa02604ddfe9b1e8b37a3185e8e29bde60c59b97bc2891ca94a3a079e18237`，平台历史 `f2b3069f-c352-4869-8ea3-5c3c8ae0d512`。
- 修改前备份：`backups/storyboard-directors-semantic-vnext-preflight-20260815T102218Z/`；变更备份：`backups/storyboard-high-energy-semantic-vnext-4-3-1-change-2026-08-15T102404062Z/`。

## 新文案与真实链路

测试口播：“你一拿钥匙，狗就叼着拖鞋躲起来，它不是故意捣乱，也不一定讨厌出门。钥匙声、换鞋、关灯这些每天重复的动作，早被它串成了‘你要离开’的预告。试着打乱顺序：拿起钥匙却坐回沙发，穿好鞋先陪它玩一会儿，让这些信号不再只通向分别。它误解的不是钥匙，是你反复演给它看的离开。”

- 最终平台真实会话：`conv_storyboard_semantic_vnext_high_energy_1786789490706_r5f5vv`。
- 原始双Prompt：`.tmp-e2e/storyboard-high-energy-vnext4-3-1-novel-departure-signal-20260815-suite.json`。
- 正确生图路由：`gpt-image-2-chA-1` / `pm_HabdJ5rvD_L3-HUkfMUmGsrm`，E指纹`sha256:0b49a8c5f27a…yaoE`，payload `gpt-image-2`，2K。

## 单图验收

- 首图：FAIL。Frame 1巨大前景钥匙旁产生无完整手臂归属的手形/钥匙重复错觉；保留为问题证据，不计通过。
- 修源后重跑：PASS。真实PNG为2560×1440；4格分别使用低机位急刹、俯视因果路径、沙发前景碰撞、贴地玩具追逐；包装完成出现→增强→撞击折返→转化收束；女主、金毛、服装与场景一致，未见额外手臂、悬空手、犬体漂移、真人化或监控式同机位。
- 文字：“离开？”准确；模型额外生成的“不只离开”语义准确、无乱码且不遮挡主动作，记为非阻断偏差。
- 最终复核页：`http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-3-1-novel-departure-signal-pro2k-20260815`
- 最终原图：`.tmp-e2e/high-energy-vnext4-3-1-novel-departure-signal-pro2k-20260815-image.png`
- 本轮真实生图2次，平台业务价合计¥0.40；测试账户现金流水扣款¥0。未调用视频。

## vNext.4.3.2高能精彩度补验

- 将上一张降级为仅结构与美型通过；新增4/5格强制节拍、占格25%至40%的英雄机制舞台、角色与机关互动和跨格冷暖/明暗/材质反差。
- 同一口播平台真实会话：`conv_storyboard_semantic_vnext_high_energy_1786791463683_yuez7b`。文案未指定犬种，智能体按高能反差默认规则选择柯基；测试不再把犬种硬编码为金毛。
- 正确pro 2K单次生成图通过结构、美型和高能精彩度三门禁。英雄格为深色钥匙—鞋踏板—灯罩—门洞因果机关，与暖色开场、冷色升级和明亮结尾形成明显反差。
- 当前SHA：`f888706e5754545949c4ed7aadce377dd8c8e55ca17f27198ba1af4d8e5c23c3`；平台历史：`c8ea8c66-5460-4ad7-bb18-f4d3519a23ba`；回滚历史：`5a449055-5ec2-4cb5-a6b4-dec8cba47a77`。
- 复核：`http://127.0.0.1:5000/storyboard-workbench?review=high-energy-vnext4-3-2-novel-departure-signal-pro2k-20260815`

## vNext.4.3.3反科幻污染与三文三图

- vNext.4.3.2因工业履带/机械臂审美被撤销最终结论；保留女主美型、手部归属和格数门禁，新增“无科技语义禁止机械工厂/HUD/赛博轨道”、场景实体包装、单格1主包装+最多2辅助效果及人犬协同表演规则。
- 当前SHA：`a795e8f08bc0ba93454fdec399ac15ace6b6574d586974ac8f4ee5578b554a98`；平台历史：`23911e6a-703f-417d-847e-8a1aa56083d2`；回滚历史：`c8ea8c66-5460-4ad7-bb18-f4d3519a23ba`。
- A哈士奇选择性听觉、B友好耳部检查、C玩具安慰关系三条分别建立平台会话并各生成一张正确pro 2K；三张原图均为2560×1440，首轮3/3通过，无额外肢体、真人化或科幻污染，主载体/主配色/高潮构图不重复。
- 三张复核URL分别为：`high-energy-vnext4-3-3-a-husky-hearing-pro2k-20260815`、`high-energy-vnext4-3-3-b-ear-health-pro2k-20260815`、`high-energy-vnext4-3-3-c-gift-comfort-pro2k-20260815`。
