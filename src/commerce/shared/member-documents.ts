export const memberDocumentActions = {
  'word-tools': {read:'读取正文和批注',append:'追加段落',replace:'替换原文',comment:'添加段落批注'},
  spreadsheets: {read:'查看工作表',write:'新建或修改工作簿'},
  'sheet-analysis': {read:'读取分析范围'},
  'wechat-docx': {html:'导入 HTML',url:'读取公开文章链接'},
  'pdf-ocr': {read:'提取文字，扫描页自动识别',scan:'逐页扫描识别'}
} as const;
export type MemberDocumentSkill=keyof typeof memberDocumentActions;
export function isMemberDocumentSkill(id?:string):id is MemberDocumentSkill {
  return !!id && Object.prototype.hasOwnProperty.call(memberDocumentActions,id);
}
export const documentExtensions:Record<MemberDocumentSkill,string[]>={
  'word-tools':['docx'], spreadsheets:['xlsx','xlsm','csv'],'sheet-analysis':['xlsx','xlsm','csv'],
  'wechat-docx':['html','htm'],'pdf-ocr':['pdf']
};
