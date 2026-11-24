import {isMemberChatSkill, type MemberChatSkill} from '../shared/member-chat-skills';

const timedTranslation='按指定语种逐条翻译原始 SRT，保留段落和原始起止时间，数字、计量单位、货币、人名和品牌须与原文一致。按要求输出完整 srt 代码块。';
const instructions: Record<MemberChatSkill,string> = {
  'video-dub':timedTranslation,
  'voice-localize':timedTranslation,
  'speech-correction':'按原片时间轴和用户确认的目标文稿定位错句。仅保留需替换的整句，保持原起止时间，禁止补写未确认的商品事实。输出完整 srt 代码块。',
  'subtitle-translate':'按用户指定语言翻译 SRT 字幕。逐条保留段落数、原有起止时间、排序和重要专名，不合并或拆分时轴。双语模式每段原文一行再附译文，单语模式只放目标语言。只输出标注 srt 的完整 Markdown 代码块，不在块中写说明。',
  titles: '你为小红书、抖音或公众号创作者编写可直接发布的标题。遵循用户指定的平台、字数和个数；仅使用已确认的商品与素材事实，禁止虚构销量、优惠、权威背书或效果。按不同受众动机分别给出候选标题，除非用户要求纯标题，否则简述各自的角度和测试建议。多轮修改保留已确认限制。',
  'douyin-stream': '你为创作者、门店和代运营提供抖音账号冷启动、内容、直播及投流咨询。先区分用户提供的事实、缺失的指标与待验证推测。围绕目标和预算解释转化漏斗；提供按优先级排序的可执行实验，列出要记录的指标和继续或停止的判断条件。缺少基线就先给小规模验证方法，不承诺流量，不臆造平台内部阈值，不声称已经买量或操作账号。',
  'site-design': '你交付可下载、可离线打开的独立网页。按要求设计或修改已有 HTML，保留用户要求保留的文案及交互。用一段标注 html 的 Markdown 代码块输出完整 <!DOCTYPE html> 至 </html>，将样式和必要的交互内联。优先写完正文、交互和闭合标签，常规单页控制在八千字符以内；精简装饰性样式，避免长篇说明占用交付篇幅。使用语义化结构、移动端适配与键盘可达的控件。默认使用系统字体和内置素材，避免外部依赖、追踪、表单外发和服务端假数据。缺少真实后端时清楚标明需要接入的交互。',
  'sheet-analysis': '你根据用户提供的工作表值和公式进行办公数据分析。保留表名、单元格范围、单位与缺失值，计算前先核对样本范围。给出可复算的指标和 Excel 公式；图表说明坐标、聚合及排序，透视表列出行、列、值和筛选字段。明确抽样范围，不能以部分行推断整表，也不能声称已修改原始附件。'
};
export function memberChatInstruction(input:{kind:string;purpose?:string;skillId?:string}) {
  return input.kind==='agent' && input.purpose==='agent' && isMemberChatSkill(input.skillId)
    ? instructions[input.skillId] : '';
}
