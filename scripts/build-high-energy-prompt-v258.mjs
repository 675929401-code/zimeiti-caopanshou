import fs from "node:fs/promises";
import crypto from "node:crypto";

// Builds the v2.5.8 high-energy prompt from the frozen v2.5.7 base.
// Every edit is a literal, uniqueness-asserted replacement; nothing is retyped wholesale.
const dir = "F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/prompts";
const basePath = `${dir}/storyboard-high-energy-original-v2.5.7-20261022.md`;
const sectionPath = `${dir}/storyboard-high-energy-append-20261022-N1-N8.md`;
const outPath = `${dir}/storyboard-high-energy-v3.2.1-20261022.md`;

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const editable = [
  {
    id: "M5",
    old: "15秒版：每段约75至90个有效汉字，视频使用4至6个真实镜头",
    neu: "15秒版：每段约75至90个有效汉字，视频使用4至5个真实镜头；确需第6镜时先建议拆段，机器包中不得写6镜",
  },
  {
    id: "M1",
    old: "分格顺序由左上到右下的自然阅读位置表达，分格边角保持干净",
    neu: "分格位置只用于内部规划阅读，不得把“左上/右上/左下/右下/第几格”写进生图或视频 Prompt；画面内不出现格位坐标、编号或边框标签；分格边角保持干净",
  },
  {
    id: "M3",
    old: "图文导演注释版：生图Prompt要求每格画面下方保留一条细窄白色导演说明条，说明条使用简短英文，格式为“Frame N: camera + core action + reaction + effect trigger”，每条8至16个英文单词",
    neu: "默认使用纯画面参考版：画面内不绘制说明条、Frame 标签或编号；确需注释时只在正文文本里写 Shot 元数据，不出现在画面中。Shot 元数据使用简短英文，格式为“Shot N: camera + core action + reaction + effect trigger”，每条8至16个英文单词",
  },
  {
    id: "M4",
    old: "视频Prompt必须引用Frame N或第N格",
    neu: "视频Prompt按镜头绑定：镜头N（起止秒｜动作｜运镜｜落幅）；只允许使用镜头编号与时间码，禁止出现格位词与 Frame 编号",
  },
  {
    id: "M7+M8",
    old: "默认穿搭是同一项目内必须稳定的对标胶囊造型",
    neu: "默认穿搭是同一项目内必须稳定的对标胶囊造型（该胶囊造型即风格库“通勤休闲”套，作为默认造型）。若本段文案场景明显属于职场、居家、户外、夜间或通勤，按文末追加规范 N3 的造型库替换为对应造型：每套至少5件单品，写明材质与主辅色；允许0–1次换装，必须写入 wardrobe_plan。换装时保留三项不变量：脸型与五官、发型发色、体型比例；服装识别点随新造型迁移，不再沿用旧造型的上衣或裤装颜色。默认胶囊造型",
  },
  {
    id: "M2",
    old: "读取上传的完整故事板作为第1格至第N格的连续时间地图",
    neu: "把上传的完整故事板作为动作规划参考；成片第一帧直接进入单一连续场景，不展示故事板本身，不出现网格、分格线、拼图或格间转场",
  },
  {
    id: "E8-15秒保鲜镜数上限",
    old: "15秒必须有4至6个真实镜头、至少4个强视觉事件",
    neu: "15秒必须有4至5个真实镜头、至少4个强视觉事件",
  },
  {
    id: "E9-面板数不等于镜头数镜数上限",
    old: "10秒版通常3-4个真实镜头，15秒版通常4-6个真实镜头",
    neu: "10秒版通常3-4个真实镜头，15秒版通常4-5个真实镜头",
  },
  {
    id: "E10-视频Prompt写法镜数上限",
    old: "15秒版写0-15秒、4-6个镜头",
    neu: "15秒版写0-15秒、4-5个镜头",
  },
  {
    id: "E11-视频演出生成器镜数上限",
    old: "10秒版3-4个镜头，15秒版4-6个镜头",
    neu: "10秒版3-4个镜头，15秒版4-5个镜头",
  },
  {
    id: "V1-版本号升级",
    old: "故事版短视频导演智能体 v2.5.7",
    neu: "故事版短视频导演智能体 v3.2.1",
  },
  {
    id: "C1-注释层定义改为文本元数据",
    old: "对标图里的“Frame 1: Fast push-in ...”不是观众字幕，也不是中文爆点牌，而是导演注释层。它的作用是把每个静态格子与视频里的运镜、动作、情绪和特效触发绑定，方便图生视频按格演绎。",
    neu: "对标图里的“Frame 1: Fast push-in ...”不是观众字幕，也不是中文爆点牌，而是导演注释层。它的作用是把每个静态格子的运镜、动作、情绪和特效触发写成文本元数据，方便图生视频按镜头演绎；这条注释只存在于正文与机器包，不画进图。",
  },
  {
    id: "C2-纯画面版绑定改镜头与时间码",
    old: "- 纯画面参考版：生图Prompt不把Frame说明条写入图片，只在视频Prompt里按“第N格/Frame N”绑定动作。",
    neu: "- 纯画面参考版：生图Prompt不把说明条写入图片；视频Prompt按镜头编号与时间码绑定动作，成片不出现说明条。",
  },
  {
    id: "C3-双版本以纯画面为主",
    old: "- 双版本提示词：生图Prompt先给“图文导演注释版”口令，再给“纯画面参考版”口令；两版角色、道具、动作峰值和中文白名单必须一致。",
    neu: "- 双版本提示词：先给“纯画面参考版”口令，再给“注释文本版”口令；两版角色、道具、动作峰值和中文白名单必须一致。",
  },
  {
    id: "C4-视频开头句改注释文本版",
    old: "，把图中动作峰值转成秒级动作；如果使用图文导演注释版，视频Prompt开头写明“参考画面主体和Frame说明条，最终成片不保留说明条”。",
    neu: "，把图中动作峰值转成秒级动作；注释文本版在视频Prompt开头写“以分镜板作为动作规划参考，成片不保留任何说明文字”。",
  },
  {
    id: "C5-注释校准改Shot元数据",
    old: "8. 注释校准：图文导演注释版的每格Frame说明必须能回答四件事",
    neu: "8. 注释校准：每格 Shot 元数据必须能回答四件事",
  },
  {
    id: "C6-生图收尾第6条去说明条",
    old: "6. 画面只保留电影级多格漫画画面、清晰分隔线、白名单短中文语义牌和按卡片选择的导演说明条，如",
    neu: "6. 画面只保留电影级多格漫画画面、清晰分隔线、白名单短中文语义牌，如",
  },
  {
    id: "C7-生图收尾第7条去说明条",
    old: "短中文牌、按卡片选择的Frame说明条和环境反馈",
    neu: "短中文牌和环境反馈",
  },
  {
    id: "C8-说明条出现条件改文本层",
    old: "画面说明条只在用户选择“图文导演注释版”时出现，作用是给人和上游智能体校准镜头，不作为视频模型运动层要重绘的画面文字。",
    neu: "镜头注释只写在正文与机器包里，作用是把每个镜头的运镜、动作和特效触发交代清楚，不作为要重绘的画面文字。",
  },
  {
    id: "C9-自检14去说明条",
    old: "14. 视频Prompt是否把参考图中文字牌、Frame说明条和小字信息编译成视频安全包装",
    neu: "14. 视频Prompt是否把参考图中文字牌和小字信息编译成视频安全包装",
  },
  {
    id: "C10-自检18措辞",
    old: "运动层复制Frame说明条",
    neu: "运动层复制正文注释文字",
  },
  {
    id: "C11-开场过渡禁止项去说明条",
    old: "不把整张故事板参考图、分格白线、Frame说明条或多画面缩略图作为开场过渡",
    neu: "不把整张故事板参考图、分格白线或多画面缩略图作为开场过渡",
  },
  {
    id: "E1-分段时长补8秒并修正15秒镜数",
    old: "- 分段时长：10秒版或15秒版；10秒版每段3-4个真实镜头，15秒版每段4-6个真实镜头；",
    neu: "- 分段时长：8秒版、10秒版或15秒版；8秒版每段3个真实镜头，10秒版每段3-4个真实镜头，15秒版每段4-5个真实镜头；",
  },
  {
    id: "E2-故事板形态默认改纯画面",
    old: "- 故事板形态：默认“图文导演注释版”，可选纯画面参考版或双版本提示词；",
    neu: "- 故事板形态：默认“纯画面参考版”；可选双版本提示词；注释只写正文文本，不进入画面；",
  },
  {
    id: "E3-工作量估算补8秒并修正15秒镜数",
    old: "10秒版按每秒约5-6个汉字估算，适合每段约50-60字、3-4个镜头；15秒版按每秒约5-6个汉字估算，适合每段约75-90字、4-6个镜头。",
    neu: "8秒版按每秒约5-6个汉字估算，适合每段约40-48字、3个镜头；10秒版按每秒约5-6个汉字估算，适合每段约50-60字、3-4个镜头；15秒版按每秒约5-6个汉字估算，适合每段约75-90字、4-5个镜头。",
  },
  {
    id: "E4-生图顺序第5条改纯画面边界",
    old: "5. 按故事板形态写清是否带导演说明条：图文导演注释版使用每格下方细窄白色Frame说明条；纯画面参考版保持分格边角干净；双版本提示词同时给出两版口令；",
    neu: "5. 按故事板形态写清画面边界：默认纯画面参考版，画面内不出现说明条、Frame 标签或格位编号，分格边角干净；双版本提示词同时给出两版口令；",
  },
  {
    id: "E5-回归测试口径改为纯画面为主",
    old: "默认回归测试必须至少跑一次图文导演注释版，不能只测纯画面版；若视频模型出现文字乱码、错别字、小UI扩展或说明条入镜，再用视频安全参考版做对照测试。",
    neu: "默认回归测试以纯画面参考版为主，不能只测注释版；若视频模型出现文字乱码、错别字、小UI扩展或说明条入镜，再用视频安全参考版做对照测试。",
  },
  {
    id: "M6+E6-输出格式改先图后视频并放开机器包",
    old: [
      "直接输出结果，不寒暄、不输出 JSON。每个段落严格使用以下顺序，不能调换。视频提示词和生图提示词必须分别用 ```text 代码框包裹，方便一键复制：",
      "",
      "**分段 N（分段文案）**：",
      "逐字放入该段原文",
      "",
      "**视频提示词**：",
      "```text",
      "完整可复制视频 Prompt",
      "```",
      "",
      "**生图提示词**：",
      "```text",
      "完整可复制生图 Prompt",
      "```",
    ].join("\n"),
    neu: [
      "直接输出结果，不寒暄；可见正文只写两个代码框，不写 JSON 代码块；机器包只出现在回复末尾的 HTML 注释里。每个段落严格使用以下顺序，不能调换。生图提示词和视频提示词必须分别用 ```text 代码框包裹，方便一键复制（顺序与分镜工作台一致，均为先图后视频）：",
      "",
      "**分段 N（分段文案）**：",
      "逐字放入该段原文",
      "",
      "**生图提示词**：",
      "```text",
      "完整可复制生图 Prompt",
      "```",
      "",
      "**视频提示词**：",
      "```text",
      "完整可复制视频 Prompt",
      "```",
    ].join("\n"),
  },
  {
    id: "E7-自检第4条改纯画面",
    old: "4. 生图Prompt是否按故事板形态执行：图文导演注释版有细窄Frame说明条，纯画面参考版分格边角干净，双版本两套口令一致。",
    neu: "4. 生图Prompt是否按故事板形态执行：默认纯画面参考版，分格边角干净，画面内没有说明条、Frame 标签或格位编号；双版本时两套口令一致。",
  },
];

const baseRaw = (await fs.readFile(basePath, "utf8")).replace(/^\uFEFF/u, "");
// 文件头是合同文件的工程注释（“原始底座 / 禁止当作已生效”），不属于提示词正文；从 # 角色 起取用。
const roleIndex = baseRaw.indexOf("# 角色");
if (roleIndex < 0) throw new Error("ROLE_ANCHOR_MISSING");
const strippedHeader = baseRaw.slice(0, roleIndex);
const base = baseRaw.slice(roleIndex);
const section = (await fs.readFile(sectionPath, "utf8")).replace(/^\uFEFF/u, "").trim();

let doc = base;
const applied = [];
for (const edit of editable) {
  const occurrences = doc.split(edit.old).length - 1;
  if (occurrences !== 1) {
    throw new Error(`ANCHOR_NOT_UNIQUE: ${edit.id} occurrences=${occurrences}`);
  }
  doc = doc.replace(edit.old, edit.neu);
  applied.push({ id: edit.id, occurrences, addedChars: edit.neu.length - edit.old.length });
}

doc = `${doc.replace(/\s+$/u, "")}\n\n---\n\n${section}\n`;

await fs.writeFile(outPath, doc, "utf8");

const selfChecks = doc.slice(doc.indexOf("# 输出前自检"), doc.indexOf("2026-10-22 追加规范"));
const selfCheckCount = (selfChecks.match(/^\d+\. /gmu) || []).length;

const report = {
  base: { chars: base.length, sha256: sha256(base) },
  output: { path: outPath, chars: doc.length, sha256: sha256(doc), grewBy: doc.length - base.length },
  acceptance: {
    charsAtLeastBase: doc.length >= base.length,
    selfCheckItems: selfCheckCount,
    sectionAppended: doc.includes("# 2026-10-22 追加规范（优先级最高）"),
    frameBarDefaultRemoved: !/默认“图文导演注释版”/u.test(doc),
    shotCapFixed: !/4至6个真实镜头|4-6个镜头/u.test(doc),
  },
  applied,
};
console.log(JSON.stringify(report, null, 2));
