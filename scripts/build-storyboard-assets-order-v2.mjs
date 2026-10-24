import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const common = `# 本轮真实输出纠偏：身份、状态与执行开场
资产设定只锁定外观，不替代剧情状态。人物参考板默认双手自然空置，不把牵引绳、饭碗或其他可移动剧情道具写成永久手持配件；宠物项圈参考只说明外观，不代表段落开始已经佩戴。可移动道具如需参考，单独展示外观，不在人物板和场景板中重复摆出同一个实体。场景参考板只锁定结构与固定物，可移动道具的初始位置和持有人按原文在各段声明。
严格区分动作对象：“扣好项圈”是项圈两端绕颈扣合，“把牵引绳扣到项圈”是绳端弹扣连接项圈环，二者不能互换。每段先按原文核对动作、受作用对象、段前状态和段后状态；原文要求尚未完成的动作不能在资产计划中预先完成。剧情确实涉及开关门时，必须写清操作者、哪只手接触门把/门体、门的方向及角色通过的先后，不能只写门自己打开。
需要三视图时用同一中性姿态的正面、严格90度侧面、背面，比例与服装/毛色一致；3/4角度仅可另加，不能代替严格侧视。无需多角度的资产不强迫三视图。
视频代码框第一句统一包含“所选风格名称 + 1至2个可见造型/材质指纹 + 完整故事板为唯一参考图 + 本次时长与比例”；英文模型路线使用语义相同的英文风格锚，不破坏对应路线的英文结构。随后直接写时间镜头，不重复整套外观。例：对标皮克斯式高能3D宠物科普动画，圆润大眼商业3D、弹性毛束；完整四格故事板为唯一参考，8秒16:9全屏连续动画。
生图和视频采用同一份特效清单：每个已采用特效的源、触发、方向、可见变化与消散都要双向一致；视频无需某特效时，两份Prompt一起删除，不让速度线、光晕或实体牌只出现在一边。
密度是删除冗词的目标，不得牺牲原文动作或必要因果。中文代码框正文计含标点与空白的Unicode字符：8秒生图上限500、视频450、合计900；10秒620、520、合计1100；15秒760、700、合计1400。全英文模型表达的相应上限乘以2.5，保留必须的结构字段与完整动作；资产参考板和框外原文不计入段落双框。最终由执行侧计数复核，不能把模型自称已检查当作通过。
`;
const sourceHashes = { A: '2fdd26cd185e93d8a0254fe6154c7f1cbcbd8d24145e4d1e91152a72e3027400', B: '201a9715d86484b8406beb1fa9e74329de658008a92377a1a6c126c69ffcf7c2' };
const entries = [];
for (const id of ['A', 'B']) {
  const source = await fs.readFile(`prompts/storyboard-high-energy-assets-order-${id}-v1.md`, 'utf8');
  assert.equal(sha(source), sourceHashes[id], 'V1_EVIDENCE_BASELINE_DRIFT');
  let revised = source.replace(`候选 ${id} v1`, `候选 ${id} v2`).replace(/手持简洁蓝色牵引绳配件/gu, '双手自然空置，剧情道具另按段落状态安排');
  if (id === 'A') {
    revised = revised.replace('开头必须写：读取上传的完整故事板', '第一句先写所选风格名与可见指纹、本次时长和比例，再紧接：读取上传的完整故事板');
    revised = revised.replace('开场绑定句不超过80字，只锁定参考图、核心角色、核心道具、成片全屏连续和声音边界', '开场绑定句先写所选风格与可见指纹、本次时长和比例，再锁定完整故事板、核心角色、核心道具、成片全屏连续和声音边界');
    revised = revised.replace('8秒控制在220至350个字符，10秒控制在270至420个字符，15秒控制在380至560个字符', '中文视频正文8秒不超过450个字符，10秒不超过520个字符，15秒不超过700个字符；全英文路线对应上限乘以2.5');
    revised = revised.replace('8秒800个字符、10秒930个字符、15秒1250个字符', '8秒900个字符、10秒1100个字符、15秒1400个字符；全英文模型表达的相应上限乘以2.5');
    const index = revised.indexOf('# 输出提交前硬长度复核');
    assert.ok(index > 0);
    revised = revised.slice(0, index).trimEnd() + '\n\n';
  } else {
    revised = revised.replace(/沿用原版密度目标，资产参考板不计入段落双框：[\s\S]*?计数过程不展示。/u, '段落密度按本轮真实输出纠偏中的明确上限复核；先删冗词、重复身份与材质，保留语义、动作因果、参考绑定和声音边界。');
  }
  const anchor = id === 'A' ? '# 四层控制架构' : '# 原文、时长与分段';
  const index = revised.indexOf(anchor);
  if (index >= 0) revised = revised.slice(0, index) + common + '\n' + revised.slice(index);
  else revised = common + '\n' + revised;
  assert.ok(revised.includes('扣好项圈') && revised.includes('严格90度侧面'));
  const destination = `prompts/storyboard-high-energy-assets-order-${id}-v2.md`;
  try { await fs.writeFile(destination, revised, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await fs.readFile(destination, 'utf8'), revised, 'EXISTING_V2_DIFFERS_FROM_REPRODUCIBLE_REVISION'); }
  entries.push({ id, path: destination, parentFileSha256: sha(source), fileSha256: sha(revised), normalizedSha256: sha(revised.trim()), characters: revised.trim().length });
}
console.log(JSON.stringify({ schemaVersion: 'storyboard_prompt_revision.v1', revision: 2, reason: 'A-v1 real-output semantic/style/asset-state failures; B-v1 network failure kept with charge unknown', entries, stablePromptWrites: 0, providerCalls: 0 }, null, 2));
