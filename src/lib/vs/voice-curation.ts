// Snapshot aligned to the user's official Volcengine console capture, 2026-09-03.
// English aliases of the same Chinese speaker are deduplicated; no synthetic popularity scores.
export const VOICE_CURATION_DATE='2026-09-03';
export const RECOMMENDED_VOICE_IDS=[
'zh_female_vv_uranus_bigtts','zh_female_xiaohe_uranus_bigtts','zh_male_m191_uranus_bigtts',
'zh_male_taocheng_uranus_bigtts','zh_male_shaonianzixin_uranus_bigtts','zh_female_meilinvyou_uranus_bigtts',
'zh_male_liufei_uranus_bigtts','zh_female_yingyujiaoxue_uranus_bigtts'];
export const WEEKLY_VOICE_IDS=['zh_female_qingxinnvsheng_uranus_bigtts','zh_female_tianmeixiaoyuan_uranus_bigtts','zh_female_cancan_uranus_bigtts','zh_female_tiexinnvsheng_uranus_bigtts','zh_male_tiancaitongsheng_uranus_bigtts','zh_female_vv_uranus_bigtts','zh_female_xiaohe_uranus_bigtts','zh_male_lanyinmianbao_uranus_bigtts'];
export const isChineseVoice=(voice:{language?:string;speakerId?:string})=>/^zh(?:-|$)/i.test(voice.language||'')||!!voice.speakerId?.includes('_zh_');

// Official 2.0 emotion-command speakers; legacy 1.0 emotion resources remain unavailable until granted.
export const EMOTIONAL_VOICE_IDS=['saturn_zh_female_keainvsheng_tob','ICL_uranus_zh_female_tiaopigongzhu_tob','saturn_zh_male_shuanglangshaonian_tob','saturn_zh_male_tiancaitongzhuo_tob'];
