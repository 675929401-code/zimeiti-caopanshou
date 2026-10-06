# 单条宠物无口型口播 Prompt Profile v1

- Profile：pet-silent-narration
- Version：1.0.0
- Contract：general-script-contract.v1
- Result schema：general-script-result.v1

## 三个核心变量

1. 文案：content.brief
2. 动画风格：settings.animationStyle
3. 视频尺寸：settings.videoSize

原创、改编、续写与重写仍使用通用合同中的其他变量。

## 默认创作语义

该 Profile 默认面向一条完整的宠物口播视频。新草稿或空白草稿选择本
Profile 时，界面默认生成 1 集、总集数 1，并标记为完结。已有有效草稿
继续保留用户原来的集数设置；这是界面默认值，不是对 API 合同的强制锁定。

## 永久硬约束

- 人物和宠物都不张嘴说话。
- 不出现对白口型，不用角色台词推动情节。
- 语言信息全部作为后期旁白，旁白标记为“【后期旁白】”。
- 文案信息必须转为表情、动作、视线、走位、环境反馈或语义道具。
- 道具必须承担可解释的叙事意义。
- 画面组织适配指定视频尺寸，视觉语言延续指定动画风格。

## 下游合同

输出仍为完整的 summary、episodes、characters、scenes、props。
profileId 固定为 pet-silent-narration，summary.performanceMode 固定为
silent_narration。角色 voiceDirection 必须明确不发声、不做对白口型。
summary.protagonist 必须概括宠物主角的身份、可视特征和核心驱动力。
