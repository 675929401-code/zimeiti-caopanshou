# Storyboard environment pack routing candidate v1

状态：`candidate`，未发布，未覆盖两个故事板智能体的 active Prompt。

## 统一输入补充

除了已有 `sourceText`、`visualStyle`、`selectedVisualAssets` 外，编译器候选输入增加可选环境元数据：

- `sceneId`
- `sceneZone`
- `cameraCoverage`
- `fixedAnchors`
- `allowedSegmentKinds`
- `derivedFromAssetId`
- `availableReferenceKinds`

缺失环境元数据时，使用宽幅环境锚点作为最低级参考，输出 `angle_coverage_missing`，不得猜测已有角度。

## 统一资产规则

- 角色/宠物资产用于跨段身份稳定；允许变化限于姿态、表情和剧情状态。
- `environment-wide` 只锁地点布局、固定家具、材质、主色和基准光线。
- `environment-angle` 只锁同一地点的摄影机方向和可见固定锚点；不能变成四格故事板。
- 临时食物、药物、牵引绳、门开关和碗空满由本段 Prompt 管理。
- 环境资产只参与故事板生图；视频只读取本段完整故事板。

## 编译步骤

1. 读取完整文案，按地点/区域建立场景族。
2. 对每段提取地点、固定物、角色路径、动作对象、时间/光线和连续状态。
3. 选择本段最小环境引用集合；没有匹配角度时保留 `angle_coverage_missing`。
4. 先编译静态完整故事板 Prompt，再编译引用该故事板的 video Prompt。
5. 不把所有项目资产全量复制到每段；只写本段 `visualAssetRefs`。

## 输出字段候选

```json
{
  "environmentGroups": [],
  "segments": [
    {
      "sceneId": "home_main",
      "sceneZone": "feeding_area",
      "camera": "front_medium",
      "visualAssetRefs": [],
      "dynamicState": [],
      "capabilityGaps": []
    }
  ]
}
```

## 两套智能体的适配边界

高能版只在动作密度、包装生命周期、镜头冲击和节奏上做适配；普通导演版只在叙事节拍、动作克制和情绪落幅上做适配。两者共享场景路由、资产引用、人物/宠物锁定、完整故事板到视频的单图边界。

## 硬失败

- 角色或宠物资产被场景图替代；
- 场景资产被当作故事板；
- 环境四宫格被作为单张环境参考直接提交；
- 未选定资产被写成已绑定；
- 视频请求附加环境/人物/宠物图；
- 场景引用全量复制到不相关段落；
- 未知角度被编译器伪造成已覆盖。
