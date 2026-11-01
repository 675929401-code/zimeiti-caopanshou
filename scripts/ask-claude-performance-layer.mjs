import fs from "node:fs/promises";

// Ask Claude Opus 5.5 (product's own channel) to author ONLY the performance layer.
const rt = JSON.parse(
  (await fs.readFile("F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json", "utf8")).replace(/^\uFEFF/u, ""),
);
const supabase = rt.supabaseUrl.replace(/\/$/u, "");
const headers = { apikey: rt.serviceRoleKey, Authorization: `Bearer ${rt.serviceRoleKey}` };
const q = new URL("/rest/v1/llm_models", supabase);
q.searchParams.set("select", "api_endpoint,api_key,model_name");
q.searchParams.set("id", "eq.3af4f2e6-a51f-44f6-ad17-9e6412147c81");
const row = (await (await fetch(q, { headers })).json())[0];
if (!row?.api_key) throw new Error("NO_CLAUDE_KEY");

const baseUrl = String(row.api_endpoint).replace(/\/+$/u, "");
const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

const system = `你是顶级的短视频分镜提示词工程师，擅长把"好视频的画面语法"编译成其他模型能执行的中文规则。你的输出会被直接放进一个商业产品的系统提示词里，因此必须：具体、可执行、可检查，不写口号，不写"要精彩""要有冲击力"这类无法判定的形容词。`;

const user = `# 任务
为"3D故事导演｜高能版"写一份**演绎层规范**（中文，8,000–12,000 字）。

这个智能体的工作：用户给它**已按语义分好的口播文案段落**（每段 8 秒/10 秒/15 秒），它要为每段输出一张 4–5 格连续故事板生图提示词 + 一条图生视频提示词。

**你只写"画面怎么演"这一层。** 不要写：接收字段定义、机器包 JSON schema、输出格式、时长档位规则、动画风格枚举——这些产品里已经固定，你写了也不会被采用。

# 已知输入（它一定拿得到，你不需要定义，只需要用）
分段文案（逐字）、分段时长（8/10/15 秒）、视频比例（16:9 或 9:16）、动画风格（6 套预设之一）、主人性别、狗狗品种、特殊备注、视觉资产模式（普通/参考图）、生成模型。

镜数规则：8 秒 3 镜、10 秒 3 镜、15 秒 4 镜；原文确有 4 个独立动作节拍时，10 秒可到 4 镜、15 秒可到 5 镜（上限 5）。

# 对标账号的反推结论（18 条公开视频 + 108 张关键帧，这是唯一依据）

## 12 条包装语法
1. 行为误解反转：先给"主人视角误读"，再用狗的身体动作和符号证据纠偏。
2. 局部放大检查：健康/护理类先给脚垫、牙齿、鼻子等友好局部特写，再叠加检查圈、裂纹、温度、气味路径。
3. 看不见的信息实体化：气味、爽感、营养、疼痛、焦虑都变成雾、光、粒子、波纹、旋涡、温度条。
4. 错误做法拟物化：禁食、夏季伤害变成压力源、红线、毒雾、危险货架、错误按钮。
5. 道具角色化：球、磨牙棒、检测盒、饭盆要与狗产生追逐、咬合、拒绝、选择、安抚关系。
6. 特效生命周期：出现于语义对象旁 → 增强成环境反馈 → 与角色动作碰撞 → 收束成结论符号。
7. 功能色脚本：红/紫=风险恐惧，绿=毒雾或营养，蓝=检查/科学，金/暖黄=修复、爱、安心。
8. 动作预备-爆发-余波：先蓄力或误会，再扑/咬/踩/闻/躲/追，最后给表情反应或环境余波。
9. 榜单/清单的视觉换挡：每一项换材质和空间，不只换字幕，但统一母题保持系列感。
10. 抽象高潮舞台：爽感、秘密、真相类用舞台灯、宇宙、按钮、光柱做高潮，不宜每条都用。
11. 温暖情绪减特效：关系/被爱类更依赖眼神、距离、柔光、慢动作和小道具轨迹。
12. 关注收束的包装化：结尾用关注牌、路线图、清单、阳光场景做落点；学"收束功能"，不复制页面按钮样式。

## 帧级观察（必须遵守的事实）
- 首帧不只有特写：08 号是空镜玩具悬念、10 号是狗趴热源中景、11 号是绿色毒雾先行、12 号是红底标题大字。四类都出现过。
- 色彩会演进：07 号蓝检查 → 红干裂 → 金修复；09 号红紫 → 暖黄；12 号红 → 绿 → 暖。**单帧只有一个主色，整条有弧线。**
- 画内文字分两类：标题大字与关注牌多为后期叠加；道具牌（狗举"关爱"）才由画面承担。
- 每条换犬种，但美术风格、材质语言、光照逻辑统一。
- 镜头密度：一条 32–99 秒的视频约 8–10 个镜头，平均 4–6 秒/镜。

## 对标的数据分布（用来校准）
- 时长 31.9–98.8 秒，均值 59 秒；32–45 秒区间表现最好。
- 钩子类型与点赞：清单/榜单向好，禁令/警示向稳，**"误解反转"反而是表现最低的一类**（仅 1 条、126 赞）。所以不要把"误解反转"当成万能结构。
- 功能色频次：红/橙 12 条、蓝 9 条、绿 7 条、金 5 条。默认应偏暖，冷蓝只用于检查段。

# 必须修正的旧写法（这些已被实测证明不可执行或与对标相反）
1. "每 2 至 3 秒一个可见强事件 / 至少 3 个强视觉事件" —— 10 秒只有 3 镜，做不到，导致硬凑。
2. "每段完成一个小戏剧" —— 10 秒装不下戏剧弧。
3. "3 至 5 个剧情功能点" —— 10 秒 3 镜装不下 5 个。
4. "主包装占画面 25% 至 40%" —— 无法测量。
5. "先通读全部文案，锁定全片统一角色" —— 单段输出时看不到其他段。
6. "首帧必须是特写" —— 对标有四类。
7. "一条只用一个功能色系，不跨色系" —— 对标有色彩演进。
8. "画内只留 1 块结论牌" —— 没区分后期字与道具牌。

# 你要产出的内容（按这个结构写）

## 一、从文案到画面的五步演绎算法
写成一个可以对着文案逐步执行的过程。每一步都要说清：输入是什么、判断依据是什么、输出什么、什么情况算没做到。要能覆盖 8 秒和 15 秒两种容量。

## 二、12 条包装语法 → 可执行模板
把上面 12 条，逐条翻译成"什么时候用 + 具体怎么演 + 落在第几镜 + 常见失败"。不要只写载体名字，要写动作序列。

## 三、首帧四类的选择规则
四类分别适用于什么文案，怎么判断选哪一类，同一批里怎么保证多样性。

## 四、功能色与色彩弧线的执行规则
单帧怎么定色、跨段怎么演进、冷蓝的使用边界、辅助色从哪来。

## 五、特效生命周期四段的写法
每一段必须出现什么动词，怎么算"演完了"，怎么算"只出生没收束"。

## 六、动作链与物理
把准备→发力→接触→反馈→收束落到具体格位上，写清接触点、受力方向、余波、落幅。

## 七、跨格与跨次一致性
同一段 4 格之间怎么保持角色、毛色、光向、道具位置不变；不同段之间哪些必须变、哪些必须不变。

## 八、自检清单
15 条以内，每条都必须是能一眼判定"过/不过"的，不能是"是否精彩"这类主观判断。

## 九、一个完整示例
用这段文案："很多主人以为柯基屁股圆就是可爱，其实那是超重信号。从正上方拍一张俯视图，腰线两侧凹进去才健康。"（10 秒）写出 4 格的具体演绎（每格一句话说清发生了什么、色是什么、特效在哪个阶段），并说明为什么这样安排。

# 写作要求
- 全部中文。
- 用"必须 / 禁止 / 先……再…… / 每条不超过 N 字"这类可执行措辞。
- 不要写"要考虑用户感受""要有感染力"这类空话。
- 不要输出 JSON、不要输出 Python。
- 直接给正文，不要开场白和结尾总结。`;

console.log("calling", url, "model", row.model_name);
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${row.api_key}`, "Content-Type": "application/json" },
  signal: AbortSignal.timeout(900_000),
  body: JSON.stringify({
    model: row.model_name,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    max_tokens: 20000,
    temperature: 0.4,
  }),
});
const raw = await res.text();
const outDir = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/.codex-evidence/claude-performance-layer-20261022";
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(`${outDir}/raw-response.json`, raw, "utf8");
let summary = { http: res.status, bytes: raw.length };
try {
  const j = JSON.parse(raw);
  const c = j?.choices?.[0]?.message?.content;
  if (typeof c === "string") {
    await fs.writeFile(`${outDir}/performance-layer.md`, c, "utf8");
    Object.assign(summary, { chars: c.length, head: c.slice(0, 200) });
  } else {
    Object.assign(summary, { error: JSON.stringify(j).slice(0, 400) });
  }
} catch { summary.rawHead = raw.slice(0, 400); }
console.log(JSON.stringify(summary, null, 2));
