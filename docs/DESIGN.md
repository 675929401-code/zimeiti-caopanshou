# DESIGN.md

## 气质与意象
对标苹果(Apple)的精致交互体验——清爽专业、弹性反馈、层级分明、触觉即视。不是冰冷工具，而是有呼吸感的专业内容创作工作台。每一次点击都有回应，每一次过渡都有节奏。

## 动效与交互（Apple 风格核心）
- **弹簧回弹曲线**：`cubic-bezier(0.34, 1.56, 0.64, 1)` — 按压释放后过冲~15%再归位，模拟物理弹簧阻尼
- **按压反馈**：点击瞬间 `scale(0.96)` + 80ms ease-in 快缩，释放后 350ms 弹簧回弹
- **卡片交互**：hover上浮3px + 层次阴影加深；active下沉+微缩 scale(0.97)
- **侧边栏快捷按钮**：active:scale(0.9) 弹簧回弹
- **分类标签**：active:scale(0.93) 快速按压感
- **波纹扩散**：主操作按钮(btn-ripple)点击时径向渐变波纹扩散
- **视图转场**：内容区切换使用 content-reveal 淡入微上浮(0.4s)
- **卡片入场**：交错动画 card-enter，每张延迟 40ms，最大 0.6s
- **消息入场**：msg-fade-in 弹簧缩放(0.4s)，替代线性渐变
- **弹窗弹出**：spring-pop 弹性缩放(0.4s)，过冲2%后归位
- **触摸设备**：用 opacity 0.7/0.85 替代 scale，避免移动端抖动
- **统一节奏**：过渡 200-350ms，动画 350-450ms，按压响应 ≤100ms

## 配色方案
- **主色**：跟随主题切换
- **默认主题**：极简白(coze) — 米白暖灰背景+纯白卡片+Indigo强调色(#4f46e5)，对标AIWeb风格
- **6套主题**：极简白(coze)、暗夜青光、霓虹蓝、极光紫、烈焰橙、AIWeb暗夜(aiweb)
- **聊天界面配色**：
  - AI消息气泡：`var(--card)` 背景 + `var(--border)/40` 细边框 + `var(--foreground)` 文字，圆角2xl
  - 用户消息气泡：`var(--muted)` 背景 + `var(--foreground)` 文字，圆角2xl(右上sm)
  - markdown-body 渲染区：透明背景，继承气泡底色，文字/边框/链接颜色跟随主题变量
  - 输入框：`var(--card)` 背景 + `var(--border)/60` 边框，与AI消息气泡视觉一致
  - 消息列表与输入框共享相同宽度容器(max-w)和内边距(px-5)，左右对齐
  - 主背景：米白 `#FAFAF8`（暖调白灰，非冷蓝灰）
  - 侧边栏背景：暖灰 `#F5F5F3`
  - 卡片背景：纯白 `#FFFFFF`
  - 边框：暖灰 `#E8E8E5`
  - 强调色：Indigo `#4f46e5`（对标AIWeb Indigo色系，#4f46e5主色/#6366f1悬停/#818cf8浅色/#312e81深色）
- **AIWeb暗夜主题(aiweb)**：
  - 设计理念：中性灰底+Indigo强调色，边框使用中性灰色而非着色边框，视觉克制精致
  - 背景：`#1C1C1C`（深灰，偏暖非冷蓝） / 次级：`#2A2A2A`
  - 侧边栏：`#161616` / 导航：`#222222`
  - 输入/按钮背景：`#2F2F2F`
  - 边框核心：`#3D3D3D`（默认）/ `#525252`（悬停）/ `#818CF8`（聚焦）——中性灰边框是精致感的关键
  - 强调色：`#818CF8`（浅靛蓝，比其他主题更柔和）/ 悬停：`#6366F1`
  - 文字：`#E0E0E0`（主）/ `#9B9B9B`（辅）/ `#6B6B6B`（禁用/占位）
  - 聚焦环：`0 0 0 2px #818CF822`（极淡靛蓝）
  - 边框精致感来源：纯中性灰色调边框，不掺蓝/紫/青等色彩，视觉"退让"不喧宾夺主
  - 文字主色：纯黑 `#000000`
  - 文字辅色：中灰 `#5C5C5C`

## 字体排版
- 字体族：PingFang SC / Microsoft YaHei / system-ui
- 导航标题：16px semibold，字间距wide
- 导航副标题：11px regular，低透明度(45%/70%)，层级分明
- 卡片标题：15px/600，单行截断(truncate)
- 卡片描述：13px/400/#666，2行截断(-webkit-line-clamp)，行高1.6
- 头像：48px圆形，原生div+img(不再使用shadcn Avatar)，objectFit:cover
- 卡片高度：104px（1:1复刻Coze扣子平台，完整显示2行描述）
- 头像位置：左侧，与文字水平排列，alignItems:center垂直居中
- 头像与文字间距：12px
- 标题与描述间距：4px(mt-1)
- 卡片内边距：16px×14px
- 卡片边框：1px实心灰色 + 悬停蓝光

## 智能体头像风格规范

### 固定提示词模板

当用户说"为未添加头像的智能体生成头像"时，自动使用以下提示词模板。若智能体缺乏描述，需先根据名称和功能补充描述，再生成头像。

**模板（将 `{角色描述}` 替换为智能体定位的角色特征）：**

```
Cyberpunk style portrait of {角色描述}, bright open {场景} background with warm light, holographic {科技道具} floating around, clean refined character design, no text, no letters, no words
```

### 角色描述映射规则

根据智能体名称中的关键词，匹配对应的角色描述和场景：

| 关键词类型 | 角色描述 | 场景 | 科技道具 |
|-----------|---------|------|---------|
| 猎手/品控 | sharp-eyed [man/woman] with cybernetic lenses scanning | editorial office / digital hunting ground | data streams and target markers |
| 炼金/升维 | enigmatic [man/woman] with glowing neural pathways transforming | digital laboratory / alchemy workshop | energy crystals and code patterns |
| 军师/策划 | wise [man/woman] analyzing holographic matrices | strategy room / command center | strategy grids and trend charts |
| 引擎/成交 | powerful [man/woman] channeling multiple light streams | command center / control room | conversion funnels and data flows |
| 架构/铸造 | meticulous [man/woman] constructing holographic blueprints | digital workshop / architecture studio | structural frameworks and component diagrams |
| 锻造/爆款 | dynamic [man/woman] forging glowing knowledge crystals | digital forge / creative studio | sparks and molten data streams |
| 解码/画像 | analytical [man/woman] with cybernetic lenses decoding | data visualization room / research lab | behavioral patterns and silhouette charts |
| 霸屏/流量 | determined [man/woman] dominating holographic rankings | city rooftop / broadcast tower | search result screens and traffic arrows |
| 导演/影像 | creative [man/woman] directing holographic scenes | film studio / production stage | storyboard panels and video frames |
| 速构/生成 | tech-savvy [man/woman] manipulating floating 3D shapes | futuristic workshop / generator room | particle effects and 3D models |
| 领航/导师 | visionary [man/woman] standing at holographic navigation chart | sky-high office / observation deck | pathway maps and milestone markers |
| 文档/说明书 | focused [man/woman] writing on holographic scrolls | digital library / documentation center | auto-formatting document streams |
| 品牌/形象 | stylish [man/woman] crafting holographic brand identities | creative studio / brand lab | logo prototypes and identity systems |
| 起盘/搭建 | confident [man/woman] setting up holographic profiles | storefront / startup workspace | social media panels and setup wizards |
| 星盘/命理 | mystical [man/woman] with cybernetic third eye reading | cosmic observatory / temple of light | star charts and destiny patterns |

### 风格铁律（每次生成必须遵守）

1. **精致人物**：面部细节清晰，表情专注/自信/沉稳，五官立体，发丝可见
2. **敞亮背景**：明亮的暖色调环境（暖金/暖橙/日落余晖），禁止纯黑/暗沉背景
3. **赛博朋克元素**：至少包含一种——发光模块服饰、全息投影、霓虹光效、AR眼镜、神经接口
4. **禁止文字**：头像中不得出现任何字母、文字、汉字、符号
5. **性别交替**：同分类下相邻智能体尽量男女交替，避免全男/全女
6. **尺寸**：1024×1024
7. **色调**：暖光为主基调，冷色科技光为点缀，冷暖对比但整体偏暖
8. **人物着装**：融合科技元素的服饰（发光线条/霓虹配饰/全息材质），拒绝日常休闲装

## 一级导航
- **主导航栏（应用广场顶部）**：胶囊式横排导航，icon+label 内联排列
  - 图标：统一使用 Lucide 矢量图标（LayoutGrid/Eraser/Scissors/Palette/FileSearch/Film/PenTool），不再使用 Emoji
  - 选中态：主题色12%淡底 + 主题色图标/文字 + 底部2px指示条（弹簧动画展开）+ 微弱光晕
  - 非选中态：透明底 + muted文字(55%不透明度) + muted图标(45%不透明度)
  - 悬停态：主题色7%淡底 + 文字加深
  - 按压态：scale(0.96) + 200ms回弹
  - 容器：圆角14px，毛玻璃(backdrop-blur) + 主题色极淡渲染，亮色/暗色模式自适应
  - 分组：组间用1px×16px极淡竖线分隔，形成视觉节奏
  - 侧边栏快捷导航：与主导航使用相同 Lucide 图标，图标尺寸 w-4 h-4

## 分类可见性与智能体权限
- **分类标签样式**：
  - `view_only`分类：分类名旁显示小号"仅展示"标签，用暖灰底色+中灰文字，低调不突兀
  - `private`分类：仅管理员可见，分类名旁显示小锁图标
- **智能体卡片权限标识**：
  - `hidden`智能体：非管理员完全不可见，管理员可见且卡片上有"已隐藏"标签
  - 分类级`view_only`：当分类可见性为"仅展示"时，该分类下所有智能体卡片加半透明遮罩(opacity-60)，hover时不弹起，点击弹出"该智能体仅展示，暂不可用"提示
- **试用套餐弹窗**：
  - 登录后新用户(inactive会员)自动弹出
  - 弹窗风格：圆角卡片，顶部渐变背景，套餐列表用卡片布局
  - 每个套餐卡片：名称+描述+积分数量+试用天数+包含智能体数量
  - 激活按钮：主强调色，hover加深

## 注册页面
- 登录/注册双Tab切换，注册Tab默认隐藏
- 注册表单：手机号+邮箱+验证码(带发送按钮)+密码+确认密码
- 验证码发送按钮：60秒倒计时，蓝色主色
- **分组标题**：10px大写字母间距，带小图标(Bot/Sparkles)，浅色辅助文字
- **导航项**：14px半粗体(600)文字+18px彩色Lucide矢量图标，胶囊式横排（icon+label内联，gap-1.5），左对齐
- **彩色图标方案**：应用广场=#3b82f6(蓝) | 格式去除=#10b981(绿) | 分段工具=#f43f5e(红) | 封面制作=#8b5cf6(紫) | 文案提取=#f59e0b(琥珀) | 视频制作=#06b6d4(青) | 文案操盘=#f97316(橙)
- **选中态**：主题色10%淡底+底部2px指示条(spring动画)+图标drop-shadow微光+1px主题色15%边框
- **暗色选中态**：主题色14%淡底+22%边框+16px主题色8%微光扩散
- **非选中态**：文字75%透明度+透明底，图标保持自身彩色
- **悬停态**：主题色8%淡底+文字变深
- **导航栏容器**：圆角12px，轻薄毛玻璃(backdrop-blur 12~16px)+极淡主题色渲染+1px半透明边框
- **紧凑间距**：按钮paddingX=10px, paddingY=6px, 按钮间距=4px, 组内间距=2px, 容器padding=4px 6px
- **分组分隔线**：18px高渐变竖线(两端渐隐)，组间4px间距
- **添加按钮**：1px虚线边框，紧凑尺寸(px-3 py-1.5)

## 智能体卡片
- **完全可配置**：管理后台提供可视化卡片布局配置面板
- **可配置项**：卡片宽高、网格列数、头像大小/位置、字体大小/粗细/颜色、间距、对齐方式
- **默认布局**：横向卡片，左文字右头像，一行4列
- **头像**：48px圆角(14px)，无图时取首字+渐变色
- **标题**：14px semibold，主色前景，紧凑不挤压
- **描述**：12px regular，0.72透明度辅助色，1行截断(descMaxLines:1)
- **标题与描述间距**：mt-1，层级清晰不拥挤
- **效果**：72%半透明卡片+毛玻璃质感，hover上浮3px+层次阴影+微妙边框亮色；active下沉+微缩弹簧回弹
- **不显示**：来源标签、预设标签（保持卡片简洁）

## 页面结构
- **桌面端（≥768px）**：左侧固定侧边栏（240px）+ 主内容区 flex 横向布局
- **移动端（<768px）**：侧边栏变为抽屉覆盖层（z-50），左滑展开/点击遮罩关闭，顶部汉堡菜单按钮触发
- **应用广场**：一级导航功能卡片（图标+标题+描述）+ 二级分类胶囊标签+搜索框 → 智能体卡片网格
- **聊天界面**：消息区 + 底部固定输入栏（含@提及功能）
- **管理后台**：12个Tab含回收站+卡片布局配置

## 交互与状态
- 侧边栏对话历史：hover浅灰背景+微上浮；active:scale(0.97)按压反馈
- 流式对话：打字机效果逐字输出
- @提及：输入@触发浮动下拉，支持拼音首字母搜索
- 分类标签：胶囊样式，点击切换，激活态主题色底白字+发光阴影；active:scale(0.93)弹簧反馈
- 悬停效果：卡片阴影加深+上浮3px
- 所有可点击元素：按压时缩放+弹簧回弹，释放后微弹
- **预设配置弹窗**：2列网格，spring-pop弹性弹出，取消不进入对话
- **模型切换**：LLM对话中头部在线标识旁显示模型切换按钮(ArrowLeftRight图标)，点击弹出模型列表下拉，选择后覆盖默认模型（高亮显示），点✕恢复默认；切换对话/智能体时自动重置
- **安全防护**：双保险——后端API拦截套取意图+系统提示词注入安全守则
- **用户端主题切换**：导航栏右上角3个小圆点（极简白/星河蓝/极光紫），点击即切，hover显示名称，不影响管理员主题设置
- **登录页**：玻璃态卡片+模糊智能体广场背景，/login路由用深色渐变+浮动光球
- **公告弹窗**：登录后自动弹出最新公告，点"不再显示"则隐藏至公告更新；支持多条分页浏览

## 视频生成平台 (/video)
- **Hero区域**：居中醒目标题+描述，标题使用主题色发光效果(text-shadow)，背景有主题色模糊光球装饰
- **标题/描述自定义**：管理员可点击直接编辑文本；配置面板支持颜色选择器、字体大小滑块、上下位置滑块
- **配色跟随主题**：所有颜色使用CSS变量(var(--primary)/var(--card)/var(--background)等)，切换主题自动同步
- **配置栏**：圆角卡片样式，主题色按钮，模型提示条含黄色价格标签
- **任务卡片**：圆角2xl，hover主题色边框，图片上传区预览+删除按钮，生成按钮使用主题色
- **历史记录**：卡片式网格，hover缩放+主题色边框，下载按钮主题色
- **管理员配置面板**：顶部栏下方折叠面板，4列网格布局，仅管理员可见
- **字体独立于主页**：视频页面标题/描述字体大小可独立配置，不跟随主页字体设置

## 新增应用表单（参考扣子平台）
- **标题**：「新增应用」弹窗
- **布局**：两列网格（名称+状态、排序+分类），底部全宽区域
- **核心字段**：
  - App名称 + App状态开关（同行两列）
  - 排序ID + App分类标签选择（同行两列）
  - App描述（全宽多行文本）
  - 选择预设模型（LLM类型时突出显示的下拉选择器，选中后自动填充所有模型配置）
  - 提示词编辑器（全宽，带预览/上传切换）
- **提问模板**（预设字段）：
  - 双模式编辑器：模板模式（可视化拖拽）+ 普通模式（JSON直接编辑）
  - 模板模式：每个字段卡片含类型切换（输入框/下拉框）、字段名称、提示文字、下拉选项编辑
  - 添加输入框（蓝色按钮）+ 添加下拉框（绿色按钮）
  - 普通模式：JSON文本编辑，带格式校验
- **应用图标 + 背景图**：小图标预览 + URL输入 + 上传按钮
- **高级配置**：可折叠区域，含深度思考/上下文限制/联网搜索等
- **底部按钮**：取消 + 确认新增

## 聊天界面（GitHub markdown-body 风格）
- **AI 消息**：无背景容器，直接在页面白底上渲染，内容区使用 GitHub markdown-body 标准样式；颜色 #24292f
- **用户消息**：浅灰气泡(#E8E8E8)，黑色文字，圆角(rounded-2xl rounded-tr-sm)，px-4 py-2.5
- **Markdown 渲染**：严格遵循 GitHub markdown-body CSS（从竞品 CSS 提取）：
  - 基础字体：16px，行高 1.5，颜色 #24292f
  - `<p>`: margin-top 0, margin-bottom 16px
  - `<h1>`: margin .67em 0, font-weight 600, border-bottom, fontSize 2em
  - `<h2>`: margin 24px 0 16px, font-weight 600, border-bottom, fontSize 1.5em
  - `<h3>-<h6>`: margin 24px 0 16px, font-weight 600, lineHeight 1.25
  - `<ul>/<ol>`: margin-bottom 16px, padding-left 2em
  - `<li>`: margin-top .25em
  - `<blockquote>`: padding 0 1em, border-left .25em solid #d0d7de, color #57606a
- **代码块高度自适应**：对标竞品(chatai8.com)，代码块高度随内容自动增长，无max-height限制，不截断不折叠；超长内容（>800px）仅对pre做overflow-y:auto滚动，保证代码块完整展示
  - `<pre>`(code block): padding 16px, background #f6f8fa, borderRadius 6px, fontSize 85%, lineHeight 1.45, **无max-height限制**
  - `<code>`(inline): padding .2em .4em, fontSize 85%, background rgba(175,184,193,.2), borderRadius 6px
  - `<strong>`: font-weight 600
  - `<a>`: color #0969da, no underline
  - `<table>`: border-collapse, padding 6px 13px, border 1px solid #d0d7de
  - `<hr>`: margin 24px 0, border 1px solid #d0d7de
- **文本预处理**：仅做最小规范化（3+连续换行→2），不合并短行、不删除标题旁空行，让 CSS 处理间距
- **头像**：32px 圆形，与消息间距 gap-3
- **消息间距**：py-2 适度宽松
- **操作按钮**：hover 才显示（group-hover），极简图标+文字标签
- **思考块**：简洁折叠框，浅灰header背景(#F1F3F4)+圆角，左侧细灰竖线，灰色文字，点击展开/收起
- **输入框**：大号胶囊形(rounded-2xl)，白色背景+细灰边框(#E4E7ED)，左下角附件按钮+右下角圆形发送按钮(#409EFF)；placeholder含智能体名称
- **流式输出**：打字机效果逐字输出，闪烁光标

## 设计禁忌
- 不要在卡片上显示来源/预设等冗余标签
- 不要省略头像占位
- 暗色主题下不要使用纯黑文字
- 主题切换圆点不要喧宾夺主，保持小巧（8px/12px）

## 风格锁定规则
- **主题默认值**：前端不硬编码默认主题，使用 `"auto"` 模式，启动时从 API 读取管理员设置的主题
- **管理员设置优先**：用户可临时切换主题，但管理员在后台设置的默认主题是全局基准
- **6套主题固定**：极简白(coze)、暗夜青光、霓虹蓝、极光紫、烈焰橙、AIWeb暗夜(aiweb)，不随意增删
- **导航栏响应式**：字体/图标使用 `clamp()` + `shrink-0` + `whitespace-nowrap`，缩放时不换行不截断
- **分类栏/卡片已有正确响应式**：导航栏必须对齐分类栏逻辑

## 响应式设计规范

### 断点策略
- **移动端**：<768px — 单列布局，侧边栏抽屉模式，紧凑间距
- **平板端**：768px-1023px — 2-3列卡片网格，侧边栏可折叠
- **桌面端**：≥1024px — 完整布局，4列卡片网格，固定侧边栏

### 移动端适配
- **侧边栏**：抽屉覆盖层，点击遮罩/导航后自动关闭
- **汉堡菜单**：固定在左上角（z-40），仅移动端显示
- **卡片网格**：1列(移动) → 2列(平板) → 3列(小桌面) → 4列(大桌面)
- **内边距**：px-3(移动) → px-5(平板) → px-6(桌面)
- **分类栏**：横向滚动，不换行
- **聊天输入框**：全宽，移动端适当减小最小高度
- **登录页**：全宽卡片，减小最大宽度限制
- **视频/封面页**：全宽布局，操作面板纵向堆叠
- **管理后台**：移除minWidth固定值，允许横向滚动

### 全局禁用 zoom 缩放
- 不使用 CSS `zoom` 等比缩放方案（会导致移动端文字过小、交互困难）
- 改用 Tailwind 响应式断点 + clamp() + flex 自适应
