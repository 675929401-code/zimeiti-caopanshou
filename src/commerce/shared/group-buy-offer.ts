/** Member-confirmed transaction terms. Render from one snapshot in all three script tracks. */
export const offerFields = { store: '门店', package: '套餐内容', guests: '适用人数', price: '套餐价格', dates: '可用日期', redemption: '预约与核销条件' } as const;
export type GroupBuyOffer = Record<keyof typeof offerFields, string>;
export const offerKeys = Object.keys(offerFields) as (keyof GroupBuyOffer)[];
export const emptyOffer: GroupBuyOffer = {store:'', package:'', guests:'', price:'', dates:'', redemption:''};
export function parseOffer(value: unknown): GroupBuyOffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('请填写团购资料');
  const offer = {...emptyOffer};
  for (const key of offerKeys) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field !== 'string' || field.length > 240 || /[\r\n]/u.test(field)) throw Error(offerFields[key]+'格式无效');
    offer[key] = field.trim();
  }
  return offer;
}
export function requireCompleteOffer(offer: GroupBuyOffer) {
  const missing = offerKeys.filter(key => !offer[key]);
  if (missing.length) throw Error('请先补充'+missing.map(key => offerFields[key]).join('、'));
}
export function offerClosing(offer: GroupBuyOffer, audio: boolean) {
  requireCompleteOffer(offer);
  return [
    ...(audio ? ['核销口播：'+offer.store+'的'+offer.package+'，'+offer.guests+'，'+offer.price+'。'+offer.dates+'。'+offer.redemption+'。'] : []),
    '交易字幕：'+[offer.package,offer.guests,offer.price,offer.dates].join(' · '),
    '结尾提示：'+offer.dates+'，'+offer.redemption,
  ].join('\n');
}
