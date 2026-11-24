/** Member-facing video families. Rows are projected only from models present in the assigned catalog. */
export const videoPickerProfiles = [
  {name:'Seedance-2.5', family:'Seedance', aliases:['seedance-2-5','seedance-2.5','doubao-seedance-2-5-260628'], detail:'效果最好，适合高要求与复杂场景'},
  {name:'Seedance-2.5-Flash', family:'Seedance', aliases:['seedance-2-5-flash','seedance-2.5-flash'], detail:'高性价比，出片更快、效果稳定'},
  {name:'Seedance-2.0', family:'Seedance', aliases:['seedance-2','seedance-2.0','seedance2.0','doubao-seedance-2-0-260128'], detail:'质量稳定，适合日常高质量出片'},
  {name:'Seedance-2.0-Fast', family:'Seedance', aliases:['seedance-2-fast','seedance-2.0-fast','doubao-seedance-2-0-fast-260128','dreamina-seedance-2-0-fast'], detail:'质量适中，适合快速试稿与测试'},
  {name:'Seedance-2.0-Mini', family:'Seedance', aliases:['seedance-2-mini','seedance-2.0-mini','dreamina-seedance-2-0-mini'], detail:'成本最低，适合灵感探索与测试'},
  {name:'Wan 3.0', family:'Wan', aliases:['wan3.0-video','wan 3.0'], detail:'质量均衡，适合日常创作与稳定出片'},
  {name:'Wan 3.0 Prime', family:'Wan', aliases:['wan3.0-video-prime','wan 3.0 prime'], detail:'出片更快，质量均衡，适合日常创作'},
  {name:'Kling 4.0', family:'Kling', aliases:['kling-4.0','kling-v4','kling-v4-0','kling 4.0','kling-video-v4'], detail:'质量稳定，视听出色，叙事连贯'},
] as const;
export function videoPickerProfile(identity: string) {
  const key=identity.trim().toLowerCase();
  return videoPickerProfiles.find(profile=>profile.name.toLowerCase()===key || profile.aliases.some(alias=>alias===key));
}
export const videoFamilyIcons = {Seedance:'/commerce-video-families/bytedance.svg',Wan:'/commerce-video-families/qwen.svg',Kling:'/commerce-video-families/kling.svg'} as const;

/** Member rates are denominated in CNY. Supplier costs stay on the server. */
export type MemberVideoBilling = {
  unit: 'per_use' | 'output_second' | 'token';
  unitPrice?: number;
  resolutionPrices?: Record<string, number>;
};
export function memberVideoBillingText(billing:MemberVideoBilling|undefined,resolution:string) {
  if(!billing)return '';
  if(billing.unit==='token')return '按实际 Token 计费';
  const rate=billing.resolutionPrices?billing.resolutionPrices[resolution.toLowerCase()]:billing.unitPrice;
  const unit=billing.unit==='per_use'?'次':'秒';
  if(typeof rate!=='number'||!Number.isFinite(rate)||rate<0)return '按'+unit+'计费';
  return '¥'+rate.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8,useGrouping:false})+'/'+unit;
}
