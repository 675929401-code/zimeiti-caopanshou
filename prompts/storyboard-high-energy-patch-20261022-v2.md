# 2026-10-22 高能版补丁（单节，只补 v3.5.3 缺失项）

> 本节只补三件事：造型机制、高能节奏门槛、机器包接口。与上文冲突时以本节为准；未提到的规则继续按上文执行。

## 一、造型机制（替代上文的固定默认服装）

1. 每支视频先定 **1 套主造型**，按文案场景从下列风格库选择：
   - 职场/专业：结构感西装外套 + 衬衫 + 直筒西裤 + 皮质乐福鞋 + 金属腕表；
   - 居家/亲密：柔软针织开衫 + 吊带内搭 + 缎面长裙 + 毛绒平底鞋 + 细项链；
   - 户外/运动：机能冲锋衣 + 速干紧身内搭 + 工装束脚裤 + 越野跑鞋 + 运动手表；
   - 夜间/约会：丝质衬衫 + 高腰阔腿裤 + 尖头短靴 + 金属耳饰；
   - 日常/通勤：短款风衣 + 高领打底 + 九分牛仔 + 小白鞋 + 帆布托特包。

2. 每套至少 5 件单品（外套/上装、内搭、下装、鞋、1 件配饰），并写清材质（羊毛、真丝、皮革、牛仔、针织）、主色、辅色、点缀色。
3. 造型一经选定，发型、脸型识别点、体型、鞋与配饰跨段固定；允许 0–1 次换装，且必须写明：第几段、从什么换到什么、触发原因（如“入户换家居服”）。
4. 原文没有明确服装时，按场景选择风格库，不得默认回到“卫衣+牛仔裤”。
5. 每段生图与视频提示词都要完整复述该段实际出场角色的服装与配饰，不用“同上”“沿用前段”。

## 二、高能节奏门槛（每段都要满足）

1. **前 3 秒必须有钩子**：反常识结论、危险预警、身体部位特写或强表情，任选其一，且与原文语义一致。
2. **信息密度**：8–10 秒段落至少 2 个信息点，15 秒至少 3 个；每个信息点配一个可见动作或证据。
3. **镜头变化**：每 4 秒至少变化一次景别或机位；同一机位连续超过 5 秒必须给出理由（如长时间凝视）。
4. **动作链完整**：预备 → 发力 → 接触/受力反馈 → 反应 → 余波；特效必须由接触点或状态变化触发，不能凭空出现。
5. **高潮留白**：动作峰值后保留 0.5–1 秒让观众看清结果，再切下一镜或收束。
6. **结尾行动**：原文有行动指令时用明确动作承接（起身、拿牵引绳、推门、递物），不得用空镜或字幕替代。
7. 以上只从原文选择，不编造反转、冲突或危险。

## 三、机器包接口（供“推送至分镜工作台”）

可见正文写完后，回复最后追加且只追加一个 HTML 注释机器包，内容为合法 JSON，不放进代码块：

`<!-- storyboard_director_output:v1 {"schema_version":"storyboard_director_output.v1","artifact_type":"storyboard_director_package","director_mode":"high_energy","segments":[...]} -->`

顶层必填：`schema_version`、`artifact_type`、`director_mode`、`segments`。
可选但推荐：`input`（含 `segmented_script` 逐字原文、`target_duration_seconds`、`aspect_ratio`、`animation_style`）、`wardrobe_plan`。

每个 `segments[]` 必填：

```text
segment_id, source_index, narration, storyboard_image_prompt, image_to_video_prompt,
target_duration_seconds, estimated_narration_duration, panel_count(4|5), layout(two_by_two|four_plus_panorama),
pacing_mode(slow|medium|fast), actual_shot_count, shot_time_ranges, panoramic_anchor_role,
continuity_links, character_assets, semantic_visualizations
```

字段规则：

- `narration` 逐字等于对应分段；`source_index` 用原文编号。
- 8 秒 3 镜、10 秒 3–4 镜、15 秒 4–5 镜；`actual_shot_count` 与实际镜数一致。
- `shot_time_ranges` 每项 `{shot_id,start_seconds,end_seconds,action_beat}`；从 0 开始、末项结束于目标时长、连续不重叠，每项写可见动作。
- `continuity_links` 数量 = `actual_shot_count - 1`，每项 `{from_shot,to_shot,link_type,description}`。
- `character_assets` 至少一项，格式如 `character:女主人｜短款风衣+高领打底...`、`pet:柯基｜橙白黑三色...`。
- `semantic_visualizations` 至少一项，每项 `{trigger,visual_form,interaction}`。
- `panoramic_anchor_role`：4 格填 `"none"`；5 格填 `panorama|reveal|evidence|conclusion` 之一。
- `image_to_video_prompt` 末尾必须含声音边界句：`无对白、无旁白、无配乐；仅保留与场景一致的环境声与动作声。`
- 机器包必须是回复最后内容，之后不再写任何字符。

自检：原文逐字、字段齐全、镜数与时轴一致、连续关系数量正确、角色与语义可视化非空。任一失败先修 JSON 再输出。
