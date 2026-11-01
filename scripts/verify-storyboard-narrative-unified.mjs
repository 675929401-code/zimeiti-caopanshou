import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  estimateNarrationDuration, parseSegmentedScript, parseStoryboardDirectorPackage, parseStoryboardDirectorPlanPackage,
  validateStoryboardDirectorPackage, validateStoryboardDirectorPlanPackage,
  renderStoryboardDirectorVisibleOutput, renderStoryboardDirectorPlanVisibleOutput,
} from '../src/lib/storyboard-director-protocol.ts';
import { parseStructuredAgentOutput, buildStructuredAgentOutputReadyDetail } from '../src/lib/structured-agent-output.ts';
import { parseStoryboardCanvasImport } from '../src/lib/storyboard-canvas-bridge.ts';
import { buildStoryboardDirectorExecution } from '../src/lib/storyboard-director-execution.ts';
import { StoryboardProjectDocument } from '../src/lib/storyboard-project-contract.ts';
import { sanitizeStoryboardPersistenceValue } from '../src/lib/storyboard-local-persistence.ts';
import { STORYBOARD_PERFORMANCE_MODE_LABELS } from '../src/lib/storyboard-director-performance.ts';
import { parseStoryboardDirectorIntake } from '../src/lib/storyboard-director-intake.ts';

// Authored transport examples test the real pure contracts, not model quality.
// This script has no API, database, browser, provider or activation path.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptPath = path.join(root, 'prompts/storyboard-narrative-unified-20261023.md');
const evidence = path.join(root, '.codex-evidence/director-refinement-20261023/narrative-followup');
const exampleMarker = '\n## 九、完整普通模式工程例\n';
const owner = '女主人许宁：年轻成年亚洲女性，略长鹅蛋脸、浅挑眉、深棕眼睛、黑色齐肩微卷短发，头身比约6.2；米白棉质圆领针织上衣、深蓝斜纹直筒长裤、白色低帮帆布鞋，左腕银色细表，其他配饰为空。';
const pet = '柴犬阿豆：中小型匀称四足犬，赤色背部与头顶、乳白胸口腹侧和口鼻、直立三角耳、深棕眼、黑鼻头、卷尾；墨绿布项圈与无字圆形银色吊牌，身体比例和毛区全文不变。';
const style = '温暖家庭3D卡通动画电影，轻度风格化面孔、清楚眼神与可信重心，细腻织物木材和分束毛发，中性窗光、柔和阴影，整体材质与角色比例统一。';
const entryScene = '住宅玄关浅灰地砖，关闭的木门在右后方，左侧矮鞋柜与窗光固定，门前留有清楚空地，人物与柴犬始终在门内。主人在画面左侧、柴犬在右侧，摄影机各镜均在两者连线的室内一侧。';
const roomScene = '客厅浅灰地砖，矮沙发在后方，靠垫位于沙发前左侧地面，左侧窗光不变，人物与柴犬之间留出可读活动路径。';
const wardrobe = { base_look: 'LOOK_01｜米白棉质圆领针织上衣、深蓝斜纹直筒长裤、白色低帮帆布鞋；黑色齐肩微卷短发，左腕银色细表，其他配饰为空。',
  continuity_rule: '人物脸形、发型、身体比例和全部衣服配饰，宠物犬种、毛区与项圈跨段保持不变，只有用户明确换装才登记改变。', change_events: [] };
const layout = '9:16竖幅整张故事板，固定2×2四格等大同构，从左上到右下阅读；外边距画布短边1%，格间距0.6%，细实线分隔。每格88%剧情画面、底部12%米白三行审片注释带，深灰字左对齐、字号层级一致，人物表情与关键接触点在剧情区。';
const audio = '无对白、无旁白、无配乐；仅保留与场景一致的环境声与动作声。';
const clean = '参考故事板只取88%剧情区的角色、构图和动作，主体等比、自然补全到成片比例；中文审片重点、英文技术注释、镜号、底栏、格线与分镜框全部去除，最终视频只显示连续剧情。';
const hash = value => createHash('sha256').update(value).digest('hex');
const wire = value => `<!-- ${value.phase === 'planned' ? 'storyboard_director_plan' : 'storyboard_director_output'}:v1 ${JSON.stringify(value)} -->`;

const cases = [
  {
    name: 'tension-hold', mode: 'tension_hold', duration: 10,
    narration: '你伸手准备摸它时，它退了半步。先停下手，让它自己决定要不要靠近。',
    event: '主人把伸向柴犬的手停住并收回，让退开后的空隙保留下来，柴犬仍未靠近。', scene: entryScene,
    chain: { setup: '主人微屈膝站稳，右手留在自己腰侧，前臂尚未伸出，柴犬在前方一臂之外四爪落地', drive: '主人右手从腰侧向前伸出一小段，前臂离开身体',
      contact: '柴犬向后撤出半步', feedback: '主人右手停在身前，手掌与犬鼻间保留清楚可见的空气间隙', settle: '主人将右手一次收回腿边并侧身站稳' },
    expressions: [
      { actor_asset_id: 'owner_001', actor_role: 'character', trigger: '柴犬向后撤出半步', before: '主人目光落在犬额，右手掌心朝下', peak: '主人目光落在后爪的新落点，下颌略收，右手仍停在身前', release: '主人视线移向犬肩，肩膀放松而手留在腿边' },
      { actor_asset_id: 'pet_001', actor_role: 'pet', trigger: '主人右手从腰侧向前伸出一小段，前臂离开身体', before: '柴犬重心原在前爪，耳根朝向主人', peak: '柴犬耳根侧转、目光追手，后腿承重而嘴部闭合', release: '柴犬目光停在主人退让后空出的地砖，四爪仍停在原处' },
    ],
    end: '主人右手贴在自己腿侧，柴犬留在一步之外，门仍关闭而双方尚未接触',
    summaries: ['手留腰侧准备伸出', '半步后撤拉开距离', '手停前方保留间隔', '收手侧身留出空隙'],
    camera: ['Side medium shot', 'Low two shot', 'Low two shot', 'Side wide shot'],
    action: ['Owner prepares to reach', 'Dog steps back', 'Owner holds hand still', 'Owner gives dog space'],
    panels: ['同侧中景，机位高1.1米，朝向人与犬之间的空隙，摄影机固定。主人微屈膝，米白袖口下的右手留在自己腰侧，前臂尚未伸出；柴犬面朝她，四爪完整，右后木门关闭。',
      '同侧低位人宠双主体中景，机位高0.65米，朝向人与犬之间的空隙，摄影机固定。柴犬后爪在半步外的新位置落稳，{petPeak}；主人深蓝裤腿仍在原地，前伸的右手留在身前未触犬。',
      '同侧低位人宠双主体中景，机位高0.65米，朝向人与犬之间的空隙，摄影机固定。{humanPeak}；柴犬四爪保持后退后的位置，目光仍追着前方的手，白鞋与爪落点清楚，手掌到犬鼻之间留出完整空气。',
      '同侧中全景，机位高1.1米，朝向人与犬之间的空隙，摄影机固定。主人右手贴回深蓝裤侧，身体侧让，柴犬仍站在一步之外看向空出的地砖；没有抚摸、拥抱或跨过空隙。'],
    cuts: [0, 2.6, 6.4, 10],
    shotNotes: ['同侧中景，机位高1.1米，朝向人与犬之间的空隙，摄影机固定。先给出腰侧准备态与伸手方向，镜头不追近。', '同侧低位人宠双主体中景，机位高0.65米，朝向人与犬之间的空隙，摄影机固定。让后撤与停手发生在同一空间。', '同侧中全景，机位高1.1米，朝向人与犬之间的空隙，摄影机固定。留出双方之间的空地；末0.8秒停留。'],
    secondVideoBody: '柴犬向后撤出半步。柴犬后爪在更远处落稳，人与犬之间的空隙增大。主人右手停在身前，手掌与犬鼻间保留清楚可见的空气间隙。柴犬耳根侧转、目光追手，后腿承重而嘴部闭合。看见犬只停在新位置后，主人目光落在后爪的新落点，下颌略收，右手仍停在身前。',
    sounds: ['音效：鞋底与衣料轻响；环境声：安静室内底噪。', '音效：半步爪音后归于安静；环境声：室内底噪。', '音效：轻微衣料落回和自然呼吸；环境声：室内底噪。'],
  },
  {
    name: 'action-peak', mode: 'action_peak', duration: 10,
    narration: '靠垫挡住玩具时，你把靠垫挪开，让它自己把球找回来。',
    event: '主人挪开挡住蓝球的靠垫并松手，柴犬沿露出的地面自己叼起球，帮助停在让路这一步。', scene: roomScene,
    chain: { setup: '主人在沙发左侧蹲稳，柴犬鼻尖朝向靠垫后露出的一小段蓝球', drive: '主人伸出左手抓住靠垫外沿',
      contact: '主人将靠垫平移到左侧空地，犬鼻沿露出的地面探向球', feedback: '靠垫边缘离开球，蓝球完整露在地砖上', settle: '柴犬用嘴叼起蓝球，主人双手收回膝侧' },
    expressions: [
      { actor_asset_id: 'owner_001', actor_role: 'character', trigger: '蓝球从靠垫后完整露出', before: '主人看着球，双手空着放在膝侧', peak: '主人视线落向犬鼻，左手指尖完全离开靠垫', release: '主人眼睑放松，手留在膝旁不代替柴犬取球' },
      { actor_asset_id: 'pet_001', actor_role: 'pet', trigger: '靠垫不再挡住犬鼻前方', before: '柴犬鼻尖对准靠垫下沿，前爪在边缘外支撑', peak: '柴犬双耳前转、鼻尖下压，前爪停在蓝球两侧', release: '柴犬抬起叼球的头，重心回到四爪之间' },
    ],
    end: '靠垫留在左侧空地，蓝球被柴犬叼住，主人没有伸手抢球',
    summaries: ['靠垫挡住取球路线', '帮忙只需挪开阻碍', '松手让它自己找到', '球由它自己叼回来'],
    camera: ['Low medium shot', 'Side medium shot', 'Eye-level two shot', 'Low wide shot'],
    action: ['Dog looks behind cushion', 'Owner moves cushion aside', 'Dog reaches blue ball', 'Dog lifts blue ball'],
    panels: ['贴地中景，靠垫位于沙发前，蓝球仅一小段露在后沿，柴犬鼻尖对准缺口，主人蹲在左侧，白鞋完整。',
      '侧面中景，米白袖口下的左手抓住靠垫外沿，靠垫已经偏向左侧空地，柴犬前爪仍留在原支撑点。',
      '低平视人宠双主体中景，{peaks}；靠垫已离开路径，手与靠垫分离，蓝球只在柴犬鼻前一处。',
      '贴地中全景，柴犬嘴里叼住蓝球，四爪站稳，主人双手退回膝侧；靠垫留在左边，没有第二颗球。'],
    cuts: [0, 2.8, 6.6, 10],
    shotNotes: ['固定贴地中景，从球被遮挡和犬鼻路径建立目标。', '侧面中景短横移跟随靠垫后停，持续拍清手抓住、平移和释放。', '沿相同方向切低平视中景，柴犬自己叼球；末0.8秒读懂结果。'],
    sounds: ['音效：犬鼻轻嗅和衣料声；环境声：室内底噪。', '音效：靠垫布料擦过地砖；环境声：室内底噪。', '音效：爪步和布球轻响；环境声：室内底噪。'],
  },
  {
    name: 'reaction-peak', mode: 'reaction_peak', duration: 10,
    narration: '你举起玩具以为它要接，它却看了一眼，转身走向了水碗。',
    event: '主人举起蓝球准备互动，柴犬看球后转向水碗，主人停下抛球动作，让本次期待落空。',
    scene: '客厅浅灰地砖，沙发在左后方，无字白色水碗在画面右侧固定喂水角，左侧窗光不变，主人与柴犬之间留出通路。',
    chain: { setup: '主人站在左侧托住蓝球，柴犬面朝她四爪站稳', drive: '主人将蓝球举至胸前，柴犬抬眼看球',
      contact: '主人托球的右手停在胸前，犬身从球下方转向右侧水碗', feedback: '球停在原处，犬影越过球下方的地砖', settle: '柴犬走到水碗旁停下，主人将蓝球降回腰侧' },
    expressions: [
      { actor_asset_id: 'owner_001', actor_role: 'character', trigger: '柴犬转头看向右侧水碗', before: '主人目光看着球前方，右肘已经抬起', peak: '主人眉间略收、目光转向右侧，持球手停在胸前', release: '主人呼气放松手指，仍站在原地不追过去' },
      { actor_asset_id: 'pet_001', actor_role: 'pet', trigger: '主人将蓝球举到胸前', before: '柴犬面朝主人，耳根朝向蓝球', peak: '柴犬目光越过蓝球落向水碗，双耳跟随转向而嘴部闭合', release: '柴犬低头看碗，前爪在碗边站稳' },
    ],
    end: '蓝球留在主人右手，柴犬独自站在水碗左侧，球没有被抛出',
    summaries: ['举球期待它来接住', '看过玩具另有去向', '期待落空先停下手', '走向水碗不添解释'],
    camera: ['Eye-level medium shot', 'Side medium shot', 'Eye-level two shot', 'Side wide shot'],
    action: ['Owner lifts blue ball', 'Dog turns toward bowl', 'Owner stops throwing gesture', 'Dog stands beside bowl'],
    panels: ['平视中景，主人右手托球停在腰侧，柴犬面朝球，水碗在右侧喂水角完整可见。',
      '侧面中景，蓝球已抬到胸前，柴犬的头刚转向右侧，身体仍在原位，主人白鞋没有移动。',
      '平视双主体中景，{peaks}；蓝球仍在手中，右侧水碗作为视线落点完整入框。',
      '侧面全景，柴犬在水碗左侧停住，主人把球降至腰侧，两者距离增大；不加喝水动作、口渴标签或诊断。'],
    cuts: [0, 2.6, 6.2, 10],
    shotNotes: ['平视中景固定，先建立球与水碗两个实际位置。', '短横移跟随犬头转向后停，让主人来不及投球的手仍在画内。', '保持向右方向切全景，主人留在左侧，柴犬只走到水碗；末0.8秒停留。'],
    sounds: ['音效：手指轻擦布球；环境声：室内底噪。', '音效：转身爪步；环境声：室内底噪。', '音效：爪步停止与呼气；环境声：室内底噪。'],
  },
  {
    name: 'reveal-peak', mode: 'reveal_peak', duration: 15,
    narration: '你以为它在挠门，走近才看见，它的牵引绳被门角压住了。',
    event: '主人起初注意柴犬的前爪，蹲近后才沿绳带看清门角的压点，信息从挠门表象转为具体阻碍。', scene: entryScene,
    chain: { setup: '柴犬前爪停在木门下方，主人站在左侧看向爪尖', drive: '主人屈膝蹲近，视线沿墨绿绳带移向门角',
      contact: '摄影机降到门角一侧，露出牵引绳被门角压住的接触点', feedback: '绳带从项圈到门角保持绷直，门板仍关闭不动', settle: '主人双手留在自己膝侧，柴犬前爪落回地砖' },
    expressions: [
      { actor_asset_id: 'owner_001', actor_role: 'character', trigger: '门角压住绳带的接触点显露', before: '主人目光盯着犬爪，眉间微收', peak: '主人眉间松开、眼睛下移到门角，伸出的食指停在空中', release: '主人收回食指，视线留在绳带压点' },
      { actor_asset_id: 'pet_001', actor_role: 'pet', trigger: '主人蹲到能看见门角的位置', before: '柴犬耳根朝门，目光落在前爪附近', peak: '柴犬耳根转向主人、视线仍沿绳带，嘴部短暂闭紧', release: '柴犬前爪落地，目光沿绳子看向门角' },
    ],
    end: '主人与柴犬都看向门角压住的绳带，木门仍关闭，尚未解除阻碍',
    summaries: ['先看爪尖误读挠门', '沿着绳带寻找线索', '门角压点终于显露', '看清阻碍尚未处理'],
    camera: ['Side medium shot', 'Low medium shot', 'Low two shot', 'Side wide shot'],
    action: ['Owner watches raised paw', 'Owner follows leash line', 'Camera reveals trapped leash', 'Both look toward corner'],
    panels: ['侧面中景，柴犬一只前爪停在门下，主人站在左侧看爪尖；墨绿牵引绳在地面延向门角，门始终关闭。',
      '低机位中景，主人蹲近但双手不碰门，视线沿地面绳带走向右侧，柴犬仍在门内原位置。',
      '门角侧低机位人宠双主体构图，{peaks}；前景墨绿绳带被关闭木门的底角压住，压点与绷直绳带清楚，人物和犬的脸在其上方中景，真实遮挡不被剖开。',
      '侧面中全景，主人双手回膝侧，柴犬四爪落稳，双方一起看门角；绳带尚被压住，木门没有被打开。'],
    cuts: [0, 3, 6.8, 11, 15],
    shotNotes: ['固定侧面中景，注意先落在前爪，不先给全知解说。', '低机位短移，随主人视线沿绳带接近门角。', '沿绳带同方向匹配切到压点，保留两张脸和真实空间。', '退回侧面中全景，不重复前爪动作；末0.8秒留在尚未解决的状态。'],
    sounds: ['音效：一次爪尖触地声；环境声：门内房间底噪。', '音效：衣料与鞋底轻响；环境声：门内底噪。', '音效：绳纤维轻响；环境声：门内底噪。', '音效：自然呼吸；环境声：门内底噪。'],
  },
];

function review(spec, index) {
  return `底栏三行（中文只印引号内原字，不印引号或前缀）：\n“${spec.summaries[index]}”\nSHOT ${String(index + 1).padStart(2, '0')} | CAMERA: ${spec.camera[index]}\nACTION: ${spec.action[index]}`;
}

function makePackage(spec) {
  const [human, dog] = spec.expressions; const chain = spec.chain;
  const peakIndex = spec.duration === 15 ? 2 : 1;
  const bodies = spec.name === 'tension-hold' ? [
    `${chain.setup}。${human.before}；${dog.before}。${chain.drive}。`,
    spec.secondVideoBody,
    `${chain.settle}。${human.release}；${dog.release}。${spec.end}。`,
  ] : spec.duration === 15 ? [
    `${chain.setup}。${human.before}；${dog.before}。`,
    `${chain.drive}。${dog.trigger}。`,
    `${chain.contact}。${chain.feedback}。${human.trigger}。${human.peak}；${dog.peak}。`,
    `${chain.settle}。${human.release}；${dog.release}。${spec.end}。`,
  ] : [
    `${chain.setup}。${human.before}；${dog.before}。${dog.trigger}。${chain.drive}。`,
    `${chain.contact}。${chain.feedback}。${human.trigger}。${human.peak}；${dog.peak}。`,
    `${chain.settle}。${human.release}；${dog.release}。${spec.end}。`,
  ];
  const coverage = bodies.length === 4 ? ['1', '2', '3', '4'] : ['1', '2/3', '4'];
  const shotPlans = bodies.map((body, index) => `覆盖第${coverage[index]}格；${spec.shotNotes[index]}${body}`);
  const shots = shotPlans.map((body, index) => `第${index + 1}镜（${spec.cuts[index]}-${spec.cuts[index + 1]}秒）：${body}${spec.sounds[index]}`);
  const panels = spec.panels.map((value, index) => `第${index + 1}格：${value.replace('{peaks}', `${human.peak}；${dog.peak}`).replace('{humanPeak}', human.peak).replace('{petPeak}', dog.peak)}\n${review(spec, index)}`);
  const peakPanels = spec.expressions.map(expression => panels.findIndex(panel => panel.includes(expression.peak)));
  assert.ok(peakPanels.every(index => index >= 0), 'AUTHORED_IMAGE_MUST_SHOW_EACH_ACTOR_PEAK');
  const imageExcerpt = panels.slice(Math.min(...peakPanels), Math.max(...peakPanels) + 1).join('\n');
  const image = [`本段演绎：${spec.event}`, owner, pet, style, spec.scene, ...panels, layout,
    '同一角色与衣服毛区保持一致，每格只出现一名主人与一只柴犬；四足与双手归属自然，主道具不复制。底栏只排指定三行，不加顶栏或覆盖标题；88%剧情区的服装与背景无字。'].join('\n');
  const video = [`本段演绎：${spec.event}`, `${spec.duration}秒9:16连续全屏3D动画，第一帧直接进入当前场景；许宁保持米白上衣、深蓝长裤、白色帆布鞋与银表，阿豆保持赤白毛区、卷尾与墨绿项圈。`,
    style, spec.scene, `全片共${shots.length}个镜头`, ...shots, audio, clean].join('\n');
  const segment = { segment_id: 'segment_001', source_index: 1, narration: spec.narration, target_duration_seconds: spec.duration,
    estimated_narration_duration: estimateNarrationDuration(spec.narration), panel_count: 4, layout: 'two_by_two', pacing_mode: 'medium',
    actual_shot_count: shots.length,
    shot_time_ranges: shotPlans.map((body, index) => ({ shot_id: `shot_${String(index + 1).padStart(3, '0')}`, start_seconds: spec.cuts[index], end_seconds: spec.cuts[index + 1], action_beat: body })),
    panoramic_anchor_role: null, bottom_panel_role: 'none',
    continuity_links: bodies.slice(1).map((_, index) => ({ from_shot: `shot_${String(index + 1).padStart(3, '0')}`, to_shot: `shot_${String(index + 2).padStart(3, '0')}`,
      link_type: 'gaze_match', description: `从${index === 0 ? '人物和柴犬的注意方向' : '前一镜已经成立的接触或距离'}承接到下一镜，保持${spec.name === 'action-peak' ? '球与靠垫' : spec.name === 'reaction-peak' ? '球与水碗' : '门与人物'}原有方位，不回演已经完成的动作。` })),
    character_asset_ids: ['owner_001', 'pet_001'], character_assets: [owner, pet], visual_asset_refs: [],
    scene_id: spec.scene === entryScene ? 'entry_001' : 'living_001', scene_zone: spec.scene === entryScene ? 'door_inside' : spec.name === 'action-peak' ? 'sofa_area' : 'water_corner',
    style_lock: style, scene_lock: spec.scene,
    semantic_visualizations: [{ trigger: spec.narration, visual_form: spec.event, interaction: spec.end }],
    performance_plan: { schema_version: 'storyboard_performance.v1', mode: spec.mode, peak_shot_id: `shot_${String(peakIndex + 1).padStart(3, '0')}`,
      semantic_event: spec.event, action_chain: chain, expressions: spec.expressions, image_excerpt: imageExcerpt, video_excerpt: shots.join('\n'), end_state: spec.end },
    storyboard_image_prompt: image, image_to_video_prompt: video };
  return { schema_version: 'storyboard_director_output.v1', artifact_type: 'storyboard_director_package', production_contract_version: 'storyboard_director_contract.v2',
    phase: 'storyboard', director_mode: 'cinematic', input: { schema_version: 'storyboard_director_input.v1', segmented_script: `1.【${spec.narration}】`, director_mode: 'cinematic',
      animation_style: '温暖家庭3D动画电影', aspect_ratio: '9:16', target_duration_seconds: spec.duration,
      special_notes: '女主人米白针织上衣、深蓝直筒长裤、白色帆布鞋、左腕银表；保持克制动作，叙事不强制靠近或拥抱。',
      owner_gender: '女主人', dog_breed: '柴犬', video_model_profile: '自动通用（分镜工作台再选择模型）', visual_asset_mode: '普通模式' },
    wardrobe_plan: structuredClone(wardrobe), visual_asset_plan: { mode: 'off', assets: [] },
    environment_groups: [{ scene_id: segment.scene_id, name: segment.scene_id === 'entry_001' ? '住宅玄关' : '客厅',
      fixed_anchors: [spec.scene], zones: [segment.scene_zone], scene_zone: segment.scene_zone,
      available_angles: ['wide', 'front', 'side', 'reverse', 'detail'], allowed_segment_kinds: ['observation', 'interaction'],
      scene_type: 'interior', environment_mode: 'prompt', anchor_required: false }], segments: [segment] };
}

function asPlan(pkg) {
  const result = structuredClone(pkg);
  result.schema_version = 'storyboard_director_plan.v1'; result.artifact_type = 'storyboard_director_plan'; result.phase = 'planned';
  result.input.visual_asset_mode = '参考图模式';
  result.visual_asset_plan = { mode: 'selected', generation_policy: { max_initial_images: 2, initial_required_asset_ids: ['owner_001', 'pet_001'], initial_deferred_asset_ids: [], environment_anchor_policy: 'none' },
    assets: [
      { id: 'owner_001', role: 'character', name: '女主人许宁', identity_lock: owner, allowed_changes: ['姿态', '表情', '景别'],
        reference_prompts: [{ kind: 'turnaround', purpose: '主人身份与完整穿搭定妆', prompt: `${owner}${style}单个女主人1×3等宽三视图：正面显示脸型、上衣和鞋面；90度侧面显示鼻梁、微卷发型轮廓、长裤侧缝和鞋型；背面显示后脑发型、针织后背、裤装和鞋后跟。统一浅灰无字背景、柔和中性棚光、平视正交感、相同尺度与脚底基线，发顶到鞋底完整，中性表情，双手自然下垂，三列穿搭配饰一致。` }] },
      { id: 'pet_001', role: 'pet', name: '柴犬阿豆', identity_lock: pet, allowed_changes: ['姿态', '表情', '景别'],
        reference_prompts: [{ kind: 'turnaround', purpose: '宠物身份毛区与项圈定妆', prompt: `${pet}${style}单只柴犬1×3等宽三视图：正面显示直立耳、眼鼻与乳白胸口；90度侧面显示背线、赤白毛区交界、墨绿项圈与卷尾；背面显示臀部、卷尾根部和后腿。统一浅灰无字背景、柔和中性棚光、平视正交感、相同尺度与脚底基线，耳尖脚掌尾尖完整，中性表情，四足自然站立，三列毛区配饰一致。` }] },
    ] };
  result.segments.forEach(segment => { segment.visual_asset_refs = [{ asset_id: 'owner_001', role: 'character', reference_kinds: ['turnaround'] }, { asset_id: 'pet_001', role: 'pet', reference_kinds: ['turnaround'] }]; });
  return result;
}

function continuityPackage(first) {
  const continuation = {
    ...cases[0], name: 'continuation', mode: 'reaction_peak',
    narration: '过了一会儿，它自己走近闻了闻你的鞋。你没有伸手，只把身体转开一点。',
    event: '主人继续不伸手，柴犬稍后走近闻鞋；距离变小，主人只侧身让出空间。',
    chain: { setup: '主人右手贴在腿侧，柴犬仍在一步之外四爪站稳', drive: '柴犬向白色帆布鞋走近两步',
      contact: '犬鼻停在白鞋前的一小段空气中，主人不伸手触犬', feedback: '鞋尖不移动，犬鼻短促翕动，项圈吊牌轻晃', settle: '主人保持右手贴腿，将上身向外侧转开一点' },
    expressions: [
      { actor_asset_id: 'owner_001', actor_role: 'character', trigger: '柴犬自己走近白色帆布鞋', before: '主人视线留在犬肩，手掌贴着自己裤腿', peak: '主人视线下移到白鞋前，右手仍贴着深蓝裤侧', release: '主人肩背松下，身体保持侧让而不俯身伸手' },
      { actor_asset_id: 'pet_001', actor_role: 'pet', trigger: '主人手掌仍留在自己腿边没有靠近', before: '柴犬耳根侧转，四爪停在一步之外', peak: '柴犬鼻尖向白鞋轻探、耳根转前，前爪在鞋前停稳', release: '柴犬鼻尖离开鞋面方向，目光抬到主人膝侧' },
    ],
    end: '柴犬站在白鞋前，主人右手仍贴腿，双方距离缩短但没有抚摸',
    summaries: ['手留腿侧继续等候', '靠近由它自己选择', '闻鞋只是新的试探', '距离变小仍不追摸'],
    camera: ['Side wide shot', 'Low medium shot', 'Eye-level two shot', 'Side medium shot'],
    action: ['Owner waits without reaching', 'Dog approaches white shoe', 'Dog sniffs near shoe', 'Owner turns slightly aside'],
    panels: ['侧面中全景，主人右手贴着深蓝裤侧，柴犬在一步之外看她，玄关木门与鞋柜位置承接前段，门仍关闭。',
      '低机位中景，柴犬朝白鞋走近，前爪即将落地，主人脚与手均未追向柴犬。',
      '平视人宠双主体中景，{peaks}；犬鼻与白鞋之间有细小空气，银表与墨绿项圈身份清楚。',
      '侧面中景，主人上身略向外侧让开，右手仍贴腿，柴犬留在白鞋前；没有把闻鞋改写成同意抚摸。'],
    shotNotes: ['固定侧面中全景，从前段未接触的距离起步，不重新演伸手与后退。', '切低一些的双主体中景，让主人保持不动，柴犬自行走近。', '保持空间方向，轻移到侧面观察主人让开；末0.8秒停留。'],
    sounds: ['音效：自然呼吸；环境声：沿用玄关底噪。', '音效：两下爪步和短促闻嗅；环境声：玄关底噪。', '音效：衣料轻响；环境声：玄关底噪。'],
  };
  const result = structuredClone(first); const second = makePackage(continuation).segments[0];
  second.segment_id = 'segment_002'; second.source_index = 2;
  result.segments.push(second); result.input.segmented_script += `\n2.【${continuation.narration}】`;
  return asPlan(result);
}

function visible(pkg) {
  const assets = pkg.phase === 'planned' ? pkg.visual_asset_plan.assets.map(asset => `**视觉资产：${asset.name}**\n\n\`\`\`text\n${asset.reference_prompts[0].prompt}\n\`\`\``).join('\n\n') : '';
  const sections = pkg.segments.map(segment => `## 原文案内容段落 ${segment.source_index}：【${segment.narration}】\n\n**演绎重点**：${segment.performance_plan.semantic_event}\n**主峰**：${STORYBOARD_PERFORMANCE_MODE_LABELS[segment.performance_plan.mode]}；**段末**：${segment.performance_plan.end_state}\n\n### 故事板生图Prompt\n\n\`\`\`text\n${segment.storyboard_image_prompt}\n\`\`\`\n\n### 图生视频Prompt\n\n\`\`\`text\n${segment.image_to_video_prompt}\n\`\`\``).join('\n\n');
  return [`本轮识别：${pkg.phase === 'planned' ? '参考图模式；完整文字计划，图片视频待工作台执行' : '普通模式'}；女主人许宁与柴犬阿豆；${pkg.input.target_duration_seconds}秒；9:16；温暖家庭3D动画电影；米白上衣、深蓝长裤、白色帆布鞋与银表。`, assets, sections, wire(pkg)].filter(Boolean).join('\n\n');
}

async function main() {
  await mkdir(evidence, { recursive: true });
  const fixtures = cases.map(makePackage); const ordinary = fixtures[0]; const planned = asPlan(ordinary); const continuity = continuityPackage(ordinary);
  if (process.argv.includes('--sync-example')) {
    const current = await readFile(promptPath, 'utf8'); const prefix = current.split(exampleMarker)[0].trimEnd();
    await writeFile(promptPath, `${prefix}${exampleMarker}\n以下是人工编写的工程合同样例，不是实际智能体输出、图片或成片；角色与演法只说明本段，不套用于其他文案。此例保留尚未靠近的结尾，示范克制表演仍有状态变化。\n\n${visible(ordinary)}\n\n## 十、参考模式一次完整计划工程例\n\n这是独立的一轮参考模式回复，同样只是文字计划；推送后在工作台生成并逐项确认角色图片，再执行分镜和视频，无需返回智能体。\n\n${visible(planned)}\n`);
  }
  await writeFile(path.join(evidence, 'prompt-ordinary-example.json'), JSON.stringify(ordinary, null, 2) + '\n');
  await writeFile(path.join(evidence, 'prompt-complete-plan-example.json'), JSON.stringify(planned, null, 2) + '\n');
  await writeFile(path.join(evidence, 'performance-engineering-cases.json'), JSON.stringify(fixtures, null, 2) + '\n');
  await writeFile(path.join(evidence, 'prompt-continuity-plan-example.json'), JSON.stringify(continuity, null, 2) + '\n');
  if (process.argv.includes('--write-only')) return;
  const text = await readFile(promptPath, 'utf8'); const checks = [];
  const check = (name, run) => { run(); checks.push(name); };
  const issues = value => value.phase === 'planned' ? validateStoryboardDirectorPlanPackage(value, value.input) : validateStoryboardDirectorPackage(value, value.input, { requirePerformancePlan: true });
  function assertInvalid(value) {
    const parsed = parseStructuredAgentOutput(wire(value), true, { expectedInput: value.input, requirePerformancePlan: true });
    assert.equal(parsed.status, 'invalid');
  }
  for (const [index, pkg] of [...fixtures, planned].entries()) {
    check(`production_contract_${index}_${pkg.segments[0].performance_plan.mode}`, () => {
      assert.deepEqual(issues(pkg), []);
      const parsed = pkg.phase === 'planned' ? parseStoryboardDirectorPlanPackage(wire(pkg)) : parseStoryboardDirectorPackage(wire(pkg));
      assert.ok(parsed); assert.deepEqual(issues(parsed), []);
      const output = parseStructuredAgentOutput(wire(pkg), true, { expectedInput: pkg.input, requirePerformancePlan: true });
      assert.equal(output.status, 'valid');
      const detail = buildStructuredAgentOutputReadyDetail(`narrative_${index}`, output); assert.ok(detail);
      const imported = parseStoryboardCanvasImport(detail, { expectedInput: pkg.input, requirePerformancePlan: true }); assert.ok(imported);
      assert.equal(imported.settings.directorMode, 'cinematic'); assert.equal(imported.segments.length, pkg.segments.length);
      assert.deepEqual(imported.originalInput, pkg.input);
      const segment = pkg.segments[0];
      assert.equal(imported.segments[0].imagePrompt, segment.storyboard_image_prompt); assert.equal(imported.segments[0].videoPrompt, segment.image_to_video_prompt);
      const execution = buildStoryboardDirectorExecution(imported, imported.segments[0]);
      const document = { id: `narrative_engineering_${index}`, title: '叙事导演离线合同样例', createdAt: 1, updatedAt: 1, ratio: '9:16', imageResolution: '2K', videoResolution: '720p', videoDuration: pkg.input.target_duration_seconds,
        imageModelId: 'engineering-only-image', videoModelId: 'engineering-only-video', wardrobePlan: imported.wardrobePlan,
        environmentGroups: imported.environmentGroups,
        ...(pkg.phase === 'planned' ? { directorIntake: { phase: 'planned', sourceMessageId: `narrative_${index}`, input: imported.originalInput }, visualAssetPlan: imported.visualAssetPlan } : {}),
        cards: [{ id: 'card_1', order: 1, imagePrompt: segment.storyboard_image_prompt, videoPrompt: segment.image_to_video_prompt, referenceImageUrls: [], imageStatus: 'idle', videoStatus: 'idle', directorExecution: execution }] };
      const roundtrip = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(sanitizeStoryboardPersistenceValue(document))));
      assert.deepEqual(roundtrip.cards[0].directorExecution.performancePlan, segment.performance_plan);
      assert.deepEqual(roundtrip.environmentGroups, imported.environmentGroups);
      if (pkg.phase === 'planned') { assert.deepEqual(roundtrip.directorIntake.input, pkg.input); assert.deepEqual(roundtrip.visualAssetPlan, imported.visualAssetPlan); }
      const rendered = pkg.phase === 'planned' ? renderStoryboardDirectorPlanVisibleOutput(parsed) : renderStoryboardDirectorVisibleOutput(parsed);
      assert.ok(rendered.includes(segment.storyboard_image_prompt) && rendered.includes(segment.image_to_video_prompt));
      assert.ok(rendered.includes(segment.performance_plan.semantic_event) && rendered.includes(segment.performance_plan.end_state));
      if (pkg.phase === 'planned') { assert.equal(imported.referenceProjectId, undefined); assert.equal(imported.pendingAssetVerification, undefined); assert.ok(imported.visualAssetPlan.assets.every(asset => !asset.source)); }
    });
  }
  check('four_semantically_distinct_modes_and_both_cinematic_durations', () => {
    assert.deepEqual(new Set(fixtures.map(pkg => pkg.segments[0].performance_plan.mode)), new Set(['action_peak', 'reaction_peak', 'reveal_peak', 'tension_hold']));
    assert.deepEqual(new Set(fixtures.map(pkg => pkg.input.target_duration_seconds)), new Set([10, 15]));
    assert.equal(new Set(fixtures.map(pkg => pkg.segments[0].performance_plan.semantic_event)).size, 4);
  });
  check('staggered_actor_peaks_use_contiguous_image_panels_without_forcing_simultaneity', () => {
    const segment = ordinary.segments[0]; const [human, dog] = segment.performance_plan.expressions;
    const panels = segment.storyboard_image_prompt.split(/(?=第\d格：)/u).slice(1);
    assert.ok(panels[1].includes(dog.peak) && !panels[1].includes(human.peak));
    assert.ok(panels[2].includes(human.peak) && !panels[2].includes(dog.peak));
    assert.ok(segment.performance_plan.image_excerpt.startsWith('第2格：') && segment.performance_plan.image_excerpt.includes('第3格：'));
    assert.ok(segment.storyboard_image_prompt.includes(segment.performance_plan.image_excerpt));
    const missingPeak = structuredClone(ordinary); missingPeak.segments[0].performance_plan.image_excerpt = panels[2].trim();
    assertInvalid(missingPeak);
  });
  check('reaching_retreat_stop_and_release_are_single_forward_ordered_events', () => {
    const segment = ordinary.segments[0]; const plan = segment.performance_plan; const [human, dog] = plan.expressions;
    assert.equal(dog.trigger, plan.action_chain.drive);
    assert.equal(human.trigger, plan.action_chain.contact);
    const ordered = [plan.action_chain.setup, plan.action_chain.drive, plan.action_chain.contact, plan.action_chain.feedback, dog.peak, human.peak, plan.action_chain.settle];
    let previous = -1;
    for (const anchor of ordered) {
      assert.equal(plan.video_excerpt.split(anchor).length - 1, 1);
      const position = plan.video_excerpt.indexOf(anchor); assert.ok(position > previous); previous = position;
    }
    const firstImage = segment.storyboard_image_prompt.split('第1格：')[1].split('第2格：')[0];
    assert.ok(firstImage.includes('右手留在自己腰侧，前臂尚未伸出') && firstImage.includes('ACTION: Owner prepares to reach'));
    assert.ok(!firstImage.includes('右前臂已离开身体'));
  });
  check('late_pressure_point_is_revealed_after_traceable_leash_establishment', () => {
    const segment = fixtures.find(pkg => pkg.segments[0].performance_plan.mode === 'reveal_peak').segments[0];
    const firstPanel = segment.storyboard_image_prompt.split('第1格：')[1].split('第2格：')[0];
    const thirdPanel = segment.storyboard_image_prompt.split('第3格：')[1].split('第4格：')[0];
    assert.ok(firstPanel.includes('牵引绳在地面延向门角') && !firstPanel.includes('被关闭木门的底角压住'));
    assert.ok(thirdPanel.includes('前景墨绿绳带被关闭木门的底角压住'));
  });
  check('two_segment_plan_keeps_unresolved_first_end_and_same_assets_without_recasting', () => {
    assert.deepEqual(validateStoryboardDirectorPlanPackage(continuity, continuity.input), []);
    const parsed = parseStructuredAgentOutput(wire(continuity), true, { expectedInput: continuity.input, requirePerformancePlan: true }); assert.equal(parsed.status, 'valid');
    const detail = buildStructuredAgentOutputReadyDetail('narrative_continuity', parsed); assert.ok(detail);
    const imported = parseStoryboardCanvasImport(detail, { expectedInput: continuity.input, requirePerformancePlan: true }); assert.ok(imported);
    assert.equal(imported.segments.length, 2);
    assert.equal(continuity.segments[0].performance_plan.end_state, ordinary.segments[0].performance_plan.end_state);
    assert.ok(continuity.segments[1].performance_plan.action_chain.setup.includes('右手贴在腿侧'));
    assert.deepEqual(continuity.segments[0].character_assets, continuity.segments[1].character_assets);
    assert.deepEqual(continuity.segments[0].character_asset_ids, continuity.segments[1].character_asset_ids);
    assert.equal(continuity.segments[0].scene_lock, continuity.segments[1].scene_lock);
    assert.deepEqual(imported.segments.map(segment => buildStoryboardDirectorExecution(imported, segment).performancePlan), continuity.segments.map(segment => segment.performance_plan));
  });
  check('unregistered_second_segment_wardrobe_drift_rejected', () => {
    const value = structuredClone(continuity); value.segments[1].character_assets[0] = owner.replace('米白棉质圆领针织上衣', '红色皮质夹克');
    value.segments[1].storyboard_image_prompt = value.segments[1].storyboard_image_prompt.replace(owner, value.segments[1].character_assets[0]);
    assertInvalid(value);
  });
  check('all_image_and_video_prompts_are_content_first_with_full_once_only_identity', () => {
    for (const pkg of fixtures) for (const segment of pkg.segments) {
      assert.ok(segment.storyboard_image_prompt.startsWith(`本段演绎：${segment.performance_plan.semantic_event}\n${owner}\n${pet}\n`));
      assert.ok(segment.image_to_video_prompt.startsWith(`本段演绎：${segment.performance_plan.semantic_event}\n`));
      assert.equal(segment.storyboard_image_prompt.split(owner).length - 1, 1); assert.equal(segment.storyboard_image_prompt.split(pet).length - 1, 1);
    }
  });
  check('four_three_line_bands_preserve_chinese_meaning_and_short_english', () => {
    for (const pkg of fixtures) {
      const segment = pkg.segments[0]; const bands = [...segment.storyboard_image_prompt.matchAll(/“([^”]+)”\nSHOT (\d{2}) \| CAMERA: ([^\n]+)\nACTION: ([^\n]+)/gu)];
      assert.equal(bands.length, 4); assert.deepEqual(bands.map(match => match[2]), ['01', '02', '03', '04']);
      for (const band of bands) { assert.match(band[1], /^[\p{Script=Han}]{6,12}$/u); assert.match(band[3], /^[A-Za-z -]+$/u); assert.match(band[4], /^[A-Za-z -]+$/u); assert.ok(`${band[3]} ${band[4]}`.split(/\s+/u).length <= 12); }
      assert.ok(!segment.image_to_video_prompt.includes('SHOT 01') && !segment.image_to_video_prompt.includes('ACTION:'));
      assert.ok(segment.image_to_video_prompt.includes('中文审片重点、英文技术注释、镜号、底栏、格线与分镜框全部去除'));
      assert.equal(segment.actual_shot_count === 3 || segment.actual_shot_count === 4, true); assert.equal(segment.panel_count, 4);
    }
  });
  const previousPrompt = await readFile(path.join(root, 'prompts/storyboard-voiceover-cinematic-v4.3.2.md'), 'utf8');
  check('prompt_preserves_ten_original_style_options', () => {
    const old = text.slice(text.indexOf('## 六、'), text.indexOf('## 七、'));
    const names = [...old.matchAll(/^- \*\*([^*]+)\*\*/gmu)].map(match => match[1]);
    assert.equal(names.length, 10); assert.equal(new Set(names).size, 10);
    const originalSection = previousPrompt.slice(previousPrompt.indexOf('# 3D风格库'), previousPrompt.indexOf('# 人物与狗的表演'));
    assert.deepEqual(names, [...originalSection.matchAll(/^- \*\*([^*]+)\*\*/gmu)].map(match => match[1]));
  });
  check('visible_and_machine_examples_share_exact_strings', () => {
    for (const [pkg, marker] of [[ordinary, 'storyboard_director_output'], [planned, 'storyboard_director_plan']]) {
      const example = [...text.matchAll(new RegExp(`<!-- ${marker}:v1 (\\{"schema_version".+?) -->`, 'gu'))].at(-1); assert.ok(example); assert.deepEqual(JSON.parse(example[1]), pkg);
      const start = text.lastIndexOf('本轮识别：', example.index); const visibleExample = text.slice(start, example.index);
      const codes = [...visibleExample.matchAll(/```text\n([\s\S]*?)\n```/gu)].map(match => match[1]);
      const expected = [...(pkg.phase === 'planned' ? pkg.visual_asset_plan.assets.map(asset => asset.reference_prompts[0].prompt) : []), ...pkg.segments.flatMap(segment => [segment.storyboard_image_prompt, segment.image_to_video_prompt])];
      assert.deepEqual(codes, expected);
    }
  });
  check('candidate_has_no_conflicting_old_pure_wordless_or_five_panel_rule', () => {
    const rules = text.split(exampleMarker)[0];
    assert.ok(!/参考图必须纯净无字|不输出JSON|不写[^。\n]*英文镜头说明|15秒[^。\n]*自动[^。\n]*5格/u.test(rules));
    assert.ok(rules.includes('固定 `panel_count:4`') && rules.includes('无需返回智能体'));
    assert.ok(rules.includes('不占88%剧情画面内的文字配额'));
  });
  const rules = text.split(exampleMarker)[0];
  const assertInheritedRules = value => {
    const styleSection = value.slice(value.indexOf('## 六、'), value.indexOf('## 七、'));
    for (const required of ['[HOST_NARRATION_TIMING_FACTS_V1]', 'status=parsed', 'status=unknown', 'estimated_narration_seconds', 'estimated_narration_duration',
      'capability_gaps', 'check_id', 'status:"pass"|"fail"|"unknown"', 'health_safety', '非空 `detail`', '免责声明不能放行',
      '分类/排名/比较固定共同判别维度', '原文否定的动机不能演成对象先确实追求、随后放弃',
      '无人文案不硬加主人', '明确猫或其他动物不被默认犬种覆盖', '可追溯的年龄版本',
      '图解或修辞能显著澄清或强调命题时即可选择', '每个独立三视图、生图和视频Prompt均明确承接同一3D卡通造型',
      '只有无编号输入才按整篇一段', '不强求零重叠']) assert.ok(value.includes(required), `继承边界缺失：${required}`);
    assert.doesNotMatch(value, /口播按约每秒6个有效字加必要停顿估算；超过目标时长|不要写模型自报通过的quality_checks|每段先在内部回答四件事|电影叙事的核心是：角色有一个具体目标|宠物保持犬类四足和品种比例|现实动作能讲清就不用包装/u);
    assert.doesNotMatch(styleSection, /镜头稳定|稳定横移|精确跟拍|反应切点|优雅移动|短停顿|定格节奏|35–65毫米|预期与反应差/u);
  };
  check('real_baseline_D01_D09_retained_without_conflicting_universal_rules', () => assertInheritedRules(rules));
  check('contradictory_old_estimation_dramaturgy_species_packaging_and_style_rules_are_detected', () => {
    for (const contradiction of ['口播按约每秒6个有效字加必要停顿估算；超过目标时长', '不要写模型自报通过的quality_checks',
      '每段先在内部回答四件事', '电影叙事的核心是：角色有一个具体目标', '宠物保持犬类四足和品种比例', '现实动作能讲清就不用包装']) {
      assert.throws(() => assertInheritedRules(`${rules}\n${contradiction}`));
    }
    for (const camera of ['镜头稳定', '稳定横移', '精确跟拍', '反应切点', '定格节奏']) {
      assert.throws(() => assertInheritedRules(rules.replace('## 七、', `${camera}\n## 七、`)));
    }
    assert.throws(() => assertInheritedRules(rules.replace('原文否定的动机不能演成对象先确实追求、随后放弃', '先演出对象欲望再改变')));
  });
  check('existing_source_parser_preserves_numbering_boundary_negation_and_internal_brackets', () => {
    const source = '1. 【你以为它想要【零食】，其实它并不想抢。】\n2、【它可能只是在追随你的手势；先等一等。】';
    const segments = parseSegmentedScript(source);
    assert.deepEqual(segments.map(segment => [segment.source_index, segment.narration]), [[1, '你以为它想要【零食】，其实它并不想抢。'], [2, '它可能只是在追随你的手势；先等一等。']]);
    assert.deepEqual(parseSegmentedScript('猫在看移动的影子。\n它不一定会靠近。').map(segment => segment.narration), ['猫在看移动的影子。\n它不一定会靠近。']);
    assert.deepEqual(parseSegmentedScript('  【猫在看影子，它并不一定靠近。】  ').map(segment => segment.narration), ['【猫在看影子，它并不一定靠近。】']);
    assert.ok(rules.includes('无编号输入才按整篇一段并trim首尾，保留其外层【】'));
  });
  check('publication_gap_and_safe_visual_self_check_survive_real_parser_without_blocking', () => {
    for (const fixture of [ordinary, planned]) {
      const value = structuredClone(fixture); const segment = value.segments[0];
      segment.capability_gaps = ['出版事实待审：原文对宠物意图的解释尚未核实；发布前需审核，不代表已核实或获准发布。'];
      segment.quality_checks = [{ check_id: 'health_safety', status: 'pass', detail: '仅指本段安全退后与等待的视觉规划；无诊断、危险处置或器官背书，不是医学或原文事实认证。' }];
      const parsed = value.phase === 'planned' ? parseStoryboardDirectorPlanPackage(wire(value)) : parseStoryboardDirectorPackage(wire(value));
      assert.ok(parsed); assert.deepEqual(issues(parsed), []);
      assert.deepEqual(parsed.segments[0].capability_gaps, segment.capability_gaps); assert.deepEqual(parsed.segments[0].quality_checks, segment.quality_checks);
      for (const status of ['fail', 'unknown']) { const unsafe = structuredClone(value); unsafe.segments[0].quality_checks[0].status = status; assertInvalid(unsafe); }
      const wrongSchema = structuredClone(value); wrongSchema.segments[0].quality_checks[0].reason = wrongSchema.segments[0].quality_checks[0].detail;
      delete wrongSchema.segments[0].quality_checks[0].detail; assertInvalid(wrongSchema);
    }
  });
  check('standalone_reference_image_and_video_examples_all_carry_the_same_3D_cartoon_form', () => {
    for (const fixture of [...fixtures, planned]) {
      for (const segment of fixture.segments) { assert.ok(segment.storyboard_image_prompt.includes('3D卡通')); assert.ok(segment.image_to_video_prompt.includes('3D卡通')); }
      for (const asset of fixture.visual_asset_plan.assets) for (const reference of asset.reference_prompts) assert.ok(reference.prompt.includes('3D卡通'));
    }
  });
  const runtime = await readFile(path.join(root, 'src/lib/server/storyboard-director-runtime-policy.ts'), 'utf8');
  check('exact_runtime_text_only_identity_is_bound_to_this_prompt_revision', () => {
    assert.ok(runtime.includes(`STORYBOARD_NARRATIVE_UNIFIED_PROMPT_SHA256 = "${hash(text.trim())}"`));
  });
  const assertInitialState = pkg => {
    const segment = pkg.segments[0];
    const firstPanel = segment.storyboard_image_prompt.split('第1格：')[1].split('第2格：')[0];
    const firstShot = segment.performance_plan.video_excerpt.split('第2镜')[0];
    const state = '右手留在自己腰侧，前臂尚未伸出';
    assert.ok(firstPanel.includes(state) && firstShot.includes(state) && segment.performance_plan.action_chain.setup.includes(state));
    assert.ok(firstPanel.includes('“手留腰侧准备伸出”') && firstPanel.includes('ACTION: Owner prepares to reach'));
    assert.ok(!firstPanel.includes('前臂已离开身体') && !firstPanel.includes('ACTION: Owner begins reaching'));
  };
  check('full_baseline_D10_initial_panel_matches_first_video_state_and_shared_shot_coverage', () => {
    for (const pkg of [ordinary, planned]) {
      assertInitialState(pkg);
      for (const panel of [2, 3]) {
        const anchor = pkg.segments[0].storyboard_image_prompt.split(`第${panel}格：`)[1].split(`第${panel + 1}格：`)[0];
        assert.ok(anchor.includes('同侧低位人宠双主体中景') && anchor.includes('CAMERA: Low two shot'));
        assert.ok(!anchor.includes('平视人宠双主体'));
      }
    }
    const rewound = structuredClone(ordinary);
    rewound.segments[0].storyboard_image_prompt = rewound.segments[0].storyboard_image_prompt.replace('右手留在自己腰侧，前臂尚未伸出', '右前臂已离开身体，手掌停在身体前方一小段');
    assert.throws(() => assertInitialState(rewound));
    for (const pkg of [...fixtures, planned, continuity]) for (const segment of pkg.segments) {
      for (const [index, shot] of segment.shot_time_ranges.entries()) {
        const coverage = segment.actual_shot_count === 4 ? String(index + 1) : ['1', '2/3', '4'][index];
        assert.ok(shot.action_beat.startsWith(`覆盖第${coverage}格；`));
        assert.ok(segment.image_to_video_prompt.includes(shot.action_beat));
        assert.ok(segment.performance_plan.video_excerpt.includes(shot.action_beat));
      }
    }
    assert.ok(rules.includes('首格就是视频真实起态') && rules.includes('纯推拉只改远近，不偷换侧'));
  });
  const assertEnvironmentBindings = pkg => {
    assert.ok(pkg.environment_groups?.length);
    for (const segment of pkg.segments) {
      const group = pkg.environment_groups.find(value => value.scene_id === segment.scene_id);
      assert.ok(group && group.zones.includes(segment.scene_zone));
      assert.equal(group.environment_mode, 'prompt'); assert.equal(group.anchor_required, false);
      assert.ok(group.available_angles.every(angle => ['wide', 'front', 'side', 'reverse', 'detail'].includes(angle)));
    }
    assert.ok(pkg.visual_asset_plan.assets.every(asset => !['environment', 'prop'].includes(asset.role)));
  };
  check('full_baseline_D11_environment_groups_and_segment_scene_bindings_survive_parser_bridge_and_storage', () => {
    for (const pkg of [...fixtures, planned, continuity]) {
      assertEnvironmentBindings(pkg);
      const output = parseStructuredAgentOutput(wire(pkg), true, { expectedInput: pkg.input, requirePerformancePlan: true }); assert.equal(output.status, 'valid');
      const detail = buildStructuredAgentOutputReadyDetail('environment_binding', output);
      const imported = parseStoryboardCanvasImport(detail, { expectedInput: pkg.input, requirePerformancePlan: true }); assert.ok(imported);
      assert.equal(imported.environmentGroups.length, pkg.environment_groups.length);
      for (const [index, segment] of imported.segments.entries()) {
        assert.equal(segment.sceneId, pkg.segments[index].scene_id); assert.equal(segment.sceneZone, pkg.segments[index].scene_zone);
      }
      assert.ok(imported.environmentGroups.every(group => group.environmentMode === 'prompt' && group.anchorRequired === false));
    }
    const missing = structuredClone(ordinary); delete missing.environment_groups; assert.throws(() => assertEnvironmentBindings(missing));
    for (const field of ['scene_id', 'scene_zone']) { const mismatch = structuredClone(ordinary); mismatch.segments[0][field] = 'not_declared'; assertInvalid(mismatch); }
    assert.deepEqual(continuity.segments.map(segment => [segment.scene_id, segment.scene_zone]), [['entry_001', 'door_inside'], ['entry_001', 'door_inside']]);
    assert.equal(planned.visual_asset_plan.generation_policy.max_initial_images, 2);
    assert.ok(rules.includes('文字环境使用 `environment_mode:"prompt"/anchor_required:false`'));
  });
  check('full_baseline_D12_pet_age_does_not_age_the_owner_or_replace_coherent_outfit_design', () => {
    const assertAgeBoundary = value => {
      assert.ok(value.includes('宠物年龄、怀旧或伤感不推导主人变老') && value.includes('明确老人、职业或时代造型保持'));
      assert.ok(value.includes('年轻或轻熟成年作设计假设') && value.includes('脸发、上下装比例、鞋履与活动适配组成协调主轮廓'));
      assert.doesNotMatch(value, /老犬[^。\n]{0,10}主人必须变老|宠物年龄决定主人年龄/u);
    };
    assertAgeBoundary(rules);
    assert.throws(() => assertAgeBoundary(`${rules}\n宠物年龄决定主人年龄。`));
    assert.ok(rules.includes('仍使用宿主同一次选角与用户明确覆盖'));
  });
  const mutations = [
    ['missing_new_performance', value => { delete value.segments[0].performance_plan; }],
    ['missing_pet_expression', value => { value.segments[0].performance_plan.expressions.pop(); }],
    ['duplicate_actor', value => { value.segments[0].performance_plan.expressions[1].actor_asset_id = 'owner_001'; }],
    ['foreign_peak_shot', value => { value.segments[0].performance_plan.peak_shot_id = 'shot_999'; }],
    ['image_excerpt_drift', value => { value.segments[0].performance_plan.image_excerpt += '不存在的画面锚'; }],
    ['video_excerpt_drift', value => { value.segments[0].performance_plan.video_excerpt += '不存在的动作锚'; }],
    ['source_reworded', value => { value.segments[0].narration = '它其实一定想被拥抱。'; }],
    ['timeline_gap', value => { value.segments[0].shot_time_ranges[1].start_seconds += 1; }],
    ['identity_omitted_from_independent_image', value => { value.segments[0].storyboard_image_prompt = value.segments[0].storyboard_image_prompt.replace(owner, '同上角色'); }],
  ];
  for (const [name, mutate] of mutations) check(`reject_${name}`, () => { const value = structuredClone(ordinary); mutate(value); assertInvalid(value); });
  check('reference_role_mismatch_rejected', () => { const value = structuredClone(planned); value.segments[0].performance_plan.expressions[1].actor_role = 'character'; assertInvalid(value); });
  check('planned_model_media_does_not_become_actual_evidence', () => {
    const value = structuredClone(planned); value.visual_asset_plan.assets[0].source = { kind: 'generated-image-history', asset_id: 'forged-image', history_record_id: 'a'.repeat(64) };
    value.visual_asset_plan.assets[0].previewUrl = 'https://example.invalid/forged-image';
    const parsed = parseStoryboardDirectorPlanPackage(wire(value)); assert.ok(parsed); assert.deepEqual(validateStoryboardDirectorPlanPackage(parsed, planned.input), []);
    assert.ok(!JSON.stringify(parsed).includes('forged-image')); assert.ok(parsed.visual_asset_plan.assets.every(asset => !asset.source));
  });
  check('raw_input_echo_cannot_replace_original_intake', () => {
    const value = structuredClone(ordinary); value.input.special_notes = '改成另一套衣服';
    assert.equal(parseStructuredAgentOutput(wire(value), true, { expectedInput: ordinary.input, requirePerformancePlan: true }).status, 'invalid');
  });
  check('case_a_canonical_input_keeps_card_strings_but_requires_derived_mode_and_numeric_duration', () => {
    for (const fixture of [ordinary, planned, fixtures.find(value => value.input.target_duration_seconds === 15)]) {
      assert.ok(fixture);
      const label = fixture.input.target_duration_seconds === 10 ? '10秒版：每段2-3个镜头' : '15秒版：每段3-4个镜头';
      const card = Object.entries(fixture.input).filter(([key]) => !['schema_version', 'director_mode'].includes(key))
        .map(([key, value]) => `${key}：${key === 'target_duration_seconds' ? label : value}`).join('\n');
      const intake = parseStoryboardDirectorIntake(card, { directorMode: 'cinematic' });
      assert.ok(intake); assert.deepEqual(intake.missingFields, []); assert.deepEqual(intake.input, fixture.input);
      assert.equal(typeof intake.input.target_duration_seconds, 'number');
      for (const mutate of [value => { delete value.input.director_mode; }, value => { value.input.target_duration_seconds = label; }, value => { value.input.target_duration_seconds = String(fixture.input.target_duration_seconds); }]) {
        const broken = structuredClone(fixture); mutate(broken); assertInvalid(broken);
      }
      assert.equal(parseStructuredAgentOutput(wire(fixture), true, { expectedInput: intake.input, requirePerformancePlan: true }).status, 'valid');
    }
    assert.ok(rules.includes('不照抄人可读表单标签') && rules.includes('其余八个接收字符串保留原值'));
    assert.doesNotMatch(rules, /`input` 始终原样|原样保留全部接收字段/u);
  });
  check('case_a_interleaved_peak_details_fail_until_a_short_common_clause_is_defined_without_weakening_the_gate', () => {
    for (const fixture of [ordinary, planned]) {
      const value = structuredClone(fixture); const segment = value.segments[0];
      const expression = segment.performance_plan.expressions.find(item => item.actor_role === 'pet');
      const original = expression.peak; assert.ok(original.includes('，'));
      const interrupted = original.replace('，', '，墨绿项圈仍清楚可见，');
      segment.storyboard_image_prompt = segment.storyboard_image_prompt.replace(original, interrupted);
      segment.performance_plan.image_excerpt = segment.performance_plan.image_excerpt.replace(original, interrupted);
      assert.ok(segment.storyboard_image_prompt.includes(segment.performance_plan.image_excerpt));
      assert.ok(!segment.performance_plan.image_excerpt.includes(expression.peak)); assertInvalid(value);
      expression.peak = original.split('，')[0];
      const parsed = parseStructuredAgentOutput(wire(value), true, { expectedInput: fixture.input, requirePerformancePlan: true });
      assert.equal(parsed.status, 'valid'); assert.deepEqual(issues(value), []);
      assert.ok(segment.performance_plan.image_excerpt.includes(expression.peak) && segment.performance_plan.video_excerpt.includes(expression.peak));
    }
    assert.ok(rules.includes('先定义最短而完整的可见短句') && rules.includes('不在逗号中插入项圈或站位'));
  });
  check('case_a_unrendered_media_stays_honestly_unknown_in_gaps_and_cannot_be_a_passed_planning_check', () => {
    for (const fixture of [ordinary, planned]) {
      const value = structuredClone(fixture); const segment = value.segments[0];
      const detail = '尚未实际生成和观看，表情可读性、底栏渲染与成片连续性仍待真实结果验证。';
      segment.quality_checks = [{ check_id: 'generation_validation', status: 'unknown', detail }];
      assertInvalid(value);
      segment.quality_checks = [];
      segment.capability_gaps = [...segment.capability_gaps || [], detail];
      const parsed = parseStructuredAgentOutput(wire(value), true, { expectedInput: fixture.input, requirePerformancePlan: true });
      assert.equal(parsed.status, 'valid'); assert.deepEqual(issues(value), []);
      assert.ok(parsed.machine_payload.segments[0].capability_gaps.includes(detail));
      assert.equal(parsed.machine_payload.segments[0].quality_checks.length, 0);
    }
    assert.ok(rules.includes('不得放 `generation_validation:unknown`') && rules.includes('也不得为推送改成pass'));
  });
  check('case_a_readable_species_signals_information_change_and_visible_review_guidance_do_not_claim_artistic_improvement', () => {
    for (const phrase of ['观众或角色看见了什么变化', '不强制揭示', '镜位、构图、视线与道具落点承担这次信息变化',
      '按物种选2个互相支持的可见信号', '不画人化狗眉', '不要求每镜强塞全套', '短暂峰值，再回落或保留',
      '不以表情认证宠物动机', '生活感不变成高能夸张表演', '不把“原因待观察/未经证实”等审核说明当画面描写']) assert.ok(rules.includes(phrase));
    assert.ok(ordinary.segments[0].storyboard_image_prompt.includes('“收手侧身留出空隙”'));
    assert.ok(!ordinary.segments[0].storyboard_image_prompt.includes('“原因待观察”'));
    assert.ok(rules.includes('都需真实生成和观看'));
  });
  check('reference_turnaround_purpose_missing_or_trimmed_to_three_characters_cannot_parse_or_import', () => {
    for (const actor of planned.visual_asset_plan.assets) for (const purpose of [undefined, '', '  主人图  ']) {
      const value = structuredClone(planned);
      const reference = value.visual_asset_plan.assets.find(asset => asset.id === actor.id).reference_prompts[0];
      if (purpose === undefined) delete reference.purpose;
      else reference.purpose = purpose;
      const result = parseStructuredAgentOutput(wire(value), true, { expectedInput: planned.input, requirePerformancePlan: true });
      assert.equal(result.status, 'invalid'); assert.equal(buildStructuredAgentOutputReadyDetail('missing-purpose', result), null);
      assert.equal(parseStoryboardCanvasImport({ source: 'stable_json', schema_version: value.schema_version, machine_payload: value, expected_input: planned.input, require_performance_plan: true }), null);
    }
    assert.ok(rules.includes('purpose') && rules.includes('trim') && rules.includes('至少4'));
  });
  check('shared_fixed_shot_camera_sentences_are_identical_in_all_covered_panels_video_and_machine_timeline', () => {
    const assertCameraProjection = pkg => {
      const segment = pkg.segments[0];
      for (const shot of segment.shot_time_ranges) {
        const match = shot.action_beat.match(/^覆盖第([\d/]+)格；([^。]+。)/u); assert.ok(match);
        const cameraSentence = match[2];
        assert.ok(segment.image_to_video_prompt.includes(shot.action_beat));
        for (const panel of match[1].split('/').map(Number)) {
          const body = segment.storyboard_image_prompt.split(`第${panel}格：`)[1]; assert.ok(body?.startsWith(cameraSentence));
        }
      }
    };
    for (const fixture of [ordinary, planned]) {
      assertCameraProjection(fixture);
      const drift = structuredClone(fixture);
      drift.segments[0].storyboard_image_prompt = drift.segments[0].storyboard_image_prompt.replace('机位高0.65米', '机位高1.1米');
      assert.throws(() => assertCameraProjection(drift));
    }
    const order = ['定可见变化与事实边界', '定一个主峰事件的五步', '冻结每镜摄影句', '从这些镜头取四个瞬间', '补任务型表演并读回末态'].map(label => rules.indexOf(label));
    assert.ok(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])));
    assert.ok(rules.includes('五步不能各自换一个主任务') && rules.includes('两格原字复用同一句摄影描述'));
  });
  const report = { scope: 'offline narrative text and production contract only', generatedAt: new Date().toISOString(), checks,
    prompt: { path: path.relative(root, promptPath), characters: text.length, rawSha256: hash(text), trimmedSha256: hash(text.trim()) },
    networkRequests: 0, providerRequests: 0, businessWrites: 0, runtimeActivated: false,
    artisticQuality: 'not evaluated; authored fixtures and structural checks are not generated-media evidence' };
  await writeFile(path.join(evidence, 'offline-contract-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

await main();
