/** Synthetic contract fixtures only; these are not real model generations. */
export function buildDestinationFixture({reference = false, segments = 12} = {}) {
  if (typeof reference !== 'boolean' || !Number.isInteger(segments) || segments < 1 || segments > 100) throw new Error('DESTINATION_FIXTURE_ARGUMENT_INVALID');
  const narrations = Array.from({length:segments},(_,i)=>`女主人把第${i+1}片蓝色纸叶放在桌上，小狗安静望向她。`);
  const imagePrompts = narrations.map((text,i)=>`合成验收画面${i+1}：${text}严格四格2×2连续分镜，16:9，温暖手绘动画原风格，米色毛衣女主人与红项圈柯基，保持空间关系。`);
  const videoPrompts = narrations.map((text,i)=>`合成验收视频${i+1}：10秒，摄影机轻推。${text}\n\n正文中的“复制/发送”字样必须保留。\n角色自然呼吸，只保留现场声。`);
  const input = {schema_version:'storyboard_director_input.v1',segmented_script:narrations.map((text,i)=>`${i+1}. ${text}`).join('\n'),director_mode:'high_energy',animation_style:'温暖手绘动画原风格',aspect_ratio:'16:9',target_duration_seconds:10,special_notes:'合成验收接收卡；保留原风格与段落，不证明供应商生成。',video_model_profile:'合成验收视频模型',visual_asset_mode:reference?'角色参考模式':'普通模式'};
  const cardText = ['segmented_script:\n'+input.segmented_script,`director_mode: ${input.director_mode}`,`animation_style: ${input.animation_style}`,`aspect_ratio: ${input.aspect_ratio}`,`target_duration_seconds: ${input.target_duration_seconds}`,`visual_asset_mode: ${input.visual_asset_mode}`,`video_model_profile: ${input.video_model_profile}`,`special_notes: ${input.special_notes}`].join('\n');
  const fence = text => '```text\n'+text+'\n```';
  const assets = reference ? ['**视觉资产：人物 · 女主人**\n身份与衣着：黑色短发、米色毛衣、深蓝长裤。\n**三视图生图 Prompt**\n'+fence('女主人三视图：正面、侧面、背面，黑色短发，米色毛衣，温暖手绘原风格。'),'**视觉资产：宠物 · 小狗**\n身份与衣着：黄白柯基、红色项圈。\n**三视图生图 Prompt**\n'+fence('小狗三视图：正面、侧面、背面，黄白柯基，红色项圈，温暖手绘原风格。')].join('\n\n')+'\n\n' : '';
  const replyText = assets+narrations.map((text,i)=>`## 段落 ${i+1}\n\n${text}\n\n### 生图 Prompt\n${fence(imagePrompts[i])}\n\n### 图生视频 Prompt\n${fence(videoPrompts[i])}`).join('\n\n');
  return {input,cardText,replyText,narrations,imagePrompts,videoPrompts};
}
