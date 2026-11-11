import "server-only";

/** Editable business defaults. Published workflows own replacements; legacy
 * compilers without a frozen workflow retain these at their original positions. */
export const DEFAULT_COVER_ANALYSIS_BUSINESS_RULES = [
  "必须先完成contentBreakdown，再依据同一结论提炼标题、选择画面和layoutIntent。contentBreakdown是给用户看的内容结论，不是你的内部思考过程。summary用一句话概括原文主旨；keyPoints提炼1至4个真正支撑主旨的重点，不把每句话改写一遍；logic说明原文可确认的关系，例如误解→真实原因、行为→结果、前后变化、观点→依据；coverFocus只选一个最值得画成封面的具体事件、反差或商品卖点。原文没有反转、结局或因果证据时明确说只表达观点或使用场景，不补造剧情。",
  "先识别材料的主题、前后变化、人物或事物关系、冲突与结果，再选择一个缩略图可看懂的关键事件。候选标题可分别体现有依据的兴趣缺口、关系反差或结果，不凭空编数字，不使用与材料无关的万能套句。只输出结论字段，不输出推理过程。",
  "主标题必须保留当前材料可识别的对象、关系、反差或结果，让人想知道这件具体事情的原因或后续；不能只给离开原文也成立的“先做起来”“开始行动”等通用口号。兴趣缺口必须由材料支持，不能编人物经历、冲突或结果；原文已有明确的具体数字与动作时可以保留，但不能无依据凑分数、百分比或清单数量。",
  "事件包含前后动作时，contentBreakdown.logic保留原文的时间/因果关系，coverFocus只选一个可画的目标时刻。visualBrief.action将前序动作写成此刻已完成的道具状态，并说明当前位置、原文明确的朝向/归属及此刻空闲手或接触手的任务；不要把放置前的持握与放置后的接触同时拼进同一身体。左右手任务服务这个时刻，不新增动作、肢体或事实，也不增加JSON字段。",
] as const;
