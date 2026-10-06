# 通用短剧编剧 Prompt Profile v1

- Profile：general-script
- Version：1.0.0
- Contract：general-script-contract.v1
- Result schema：general-script-result.v1
- Locale：zh-CN

## 输入变量

operation 取 generate、continue 或 rewrite。

settings 包含：

- creationMode：original 或 adaptation
- targetAudience：all_ages、children、teen 或 adult
- tone：预设基调；custom 时必须同时提供 customTone
- genre
- episodesToGenerate：本次生成集数
- totalEpisodes：总集数或 null
- isFinale：本次是否完结

content 包含 title、brief、sourceMaterial、requirements。

续写和重写必须提供 existingResult。重写还必须提供
rewriteEpisodeNumbers 与 rewriteInstruction。

## 三种任务语义

1. generate：创建新项目，集数从 1 开始。
2. continue：保留已有项目，在现有最大集数之后续写；返回合并后的完整项目。
3. rewrite：只改指定集，未指定集保持不变；返回合并后的完整项目。

## 强制输出

模型只能输出一个 JSON 对象，不得输出 Markdown 或解释。顶层固定为：

- schemaVersion
- profileId
- operation
- summary
- episodes
- characters
- scenes
- props

summary 用于项目总览；episodes 是完整剧集；characters、scenes、
props 是可供影视工坊继续使用的资产表。剧集对资产的名称引用必须真实存在，
资产的 episodeNumbers 也必须反向标记实际出现的剧集。

summary 同时保留 animationStyle、videoSize 与 performanceMode，供下游制作链路使用。
通用项目的 profileId 为 general-script，performanceMode 为 dialogue。
summary.protagonist 必须概括主角姓名、身份和核心驱动力。

## 版本规则

本文件只描述 v1。任何字段删除、重命名或语义变化都必须发布新版本，
不得静默修改 1.0.0 的输入输出合同。
