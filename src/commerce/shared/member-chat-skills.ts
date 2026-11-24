const inputHints = {
  'speech-correction':'输入错读的人名或商品名，核对需要替换的完整句子。',
  'video-dub':'可就原片字幕提问，或将译文应用回配音时间轴。',
  'voice-localize':'可翻译原片台词，核对译文后逐句制作原音色配音。',
  'subtitle-translate':'导入原字幕，选择目标语言和单语或双语输出。',
  titles: '填写主题、目标受众、发布平台和已确认的商品事实。',
  'douyin-stream': '描述账号、运营目标、已有视频指标或预算，可继续追问。',
  'site-design': '描述网站的用途、内容和风格，或粘贴现有 HTML 并说明修改要求。',
  'sheet-analysis': '可导入工作表，选择数据范围，再填写统计、公式、图表或透视表需求。'
};
export type MemberChatSkill = keyof typeof inputHints;
export function isMemberChatSkill(id?: string): id is MemberChatSkill {
  return !!id && Object.prototype.hasOwnProperty.call(inputHints, id);
}
export function memberChatHint(id: MemberChatSkill) { return inputHints[id]; }
