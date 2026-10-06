import sourceManifest from "../../../public/youcai-media/v1/source-manifest.json";
import {
  ANCIENT_OFFICIAL_GRAPH,
  CAR_OFFICIAL_GRAPH,
  PET_OFFICIAL_GRAPH,
  type OfficialCanvasGraphSnapshot,
  type OfficialCanvasSnapshotNode,
} from "./canvas-official-snapshot";

export type CanvasShowcaseNodeKind = "text" | "image" | "video" | "audio" | "music" | "video-plan" | "audio-plan" | "group";

export interface CanvasShowcasePosition {
  x: number;
  y: number;
}

export interface CanvasShowcaseNode {
  id: string;
  order: string;
  title: string;
  kind: CanvasShowcaseNodeKind;
  status: string;
  body: string;
  position: CanvasShowcasePosition;
  width?: number;
  height?: number;
  parentId?: string;
  imagePath?: string;
  imageAlt?: string;
  mediaPath?: string;
  mediaType?: "video/mp4" | "video/webm" | "audio/mp4" | "audio/mpeg";
  posterPath?: string;
  durationLabel?: string;
  toolLabel?: string;
}

export interface CanvasShowcaseEdge {
  id: string;
  source: string;
  target: string;
}

interface CanvasShareShowcaseBase {
  id: string;
  title: string;
  tag: string;
  description: string;
  prompt: string;
  coverImage: string;
  coverAlt: string;
  officialSnapshot?: {
    sourceUrl: string;
    capturedAt: "2026-08-24";
    nodeCount: number;
    edgeCount: number;
  };
  nodes: readonly CanvasShowcaseNode[];
  edges: readonly CanvasShowcaseEdge[];
}

export type CanvasShareShowcaseData = CanvasShareShowcaseBase & (
  | { coverMediaType: "image"; coverVideo?: never }
  | { coverMediaType: "video"; coverVideo: string }
);

type NodeSeed = Pick<CanvasShowcaseNode, "id" | "order" | "title" | "body" | "position"> & {
  width?: number;
  height?: number;
  parentId?: string;
};

type LocalMediaType = "image" | "video" | "audio";

interface LocalMediaItem {
  id: string;
  type: LocalMediaType;
  title: string;
  localPath: string;
  mimeType: string;
}

interface LocalMediaRef extends LocalMediaItem {
  path: string;
  posterPath?: string;
}

const LOCAL_MEDIA_ROOT = "/youcai-media/v1";
const LOCAL_MEDIA = sourceManifest as readonly LocalMediaItem[];

function exactLocalMedia(type: LocalMediaType, id: string): LocalMediaRef {
  const item = LOCAL_MEDIA.find((candidate) => candidate.type === type && candidate.id === id);

  if (!item) {
    throw new Error(`Missing required local ${type} media ${id} in YouCai source manifest.`);
  }

  return {
    ...item,
    path: `${LOCAL_MEDIA_ROOT}/${item.localPath}`,
    posterPath: type === "video" ? `${LOCAL_MEDIA_ROOT}/posters/${item.id}.jpg` : undefined,
  };
}

function exactLocalMediaPool(type: LocalMediaType, ids: readonly string[]): readonly LocalMediaRef[] {
  return ids.map((id) => exactLocalMedia(type, id));
}

function staticShowcaseImage(id: string, title: string, localPath: string): LocalMediaRef {
  return {
    id,
    type: "image",
    title,
    localPath,
    mimeType: "image/jpeg",
    path: `${LOCAL_MEDIA_ROOT}/${localPath}`,
  };
}

function staticShowcaseVideo(
  id: string,
  title: string,
  localPath: string,
  posterPath: string,
): LocalMediaRef {
  return {
    id,
    type: "video",
    title,
    localPath,
    mimeType: "video/mp4",
    path: `${LOCAL_MEDIA_ROOT}/${localPath}`,
    posterPath,
  };
}

function derivedShowcaseImages(
  showcase: "pet" | "m8",
  titlePrefix: string,
  start: number,
  end: number,
): readonly LocalMediaRef[] {
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const sequence = start + offset;
    const padded = String(sequence).padStart(3, "0");
    return staticShowcaseImage(
      `${showcase}-derived-${padded}`,
      `${titlePrefix} ${padded}`,
      `canvas-showcases/derived/${showcase}/images/${showcase}-${padded}.jpg`,
    );
  });
}

const MEDIA = {
  foxVideoA: exactLocalMedia("video", "cmmvosgtg0109z25il3n8j3eg"),
} as const;

const PET_MANGA_IMAGES = [
  ...exactLocalMediaPool("image", [
    "cmok186sz05wu110szov6wsch",
    "cmol5v1kk067g11vsofh4u7ik",
    "cmojxhpjj040w110sa17h0fk0",
    "cmojwuzdr03hd110sm3sjdbcs",
    "cmojwuzbr03hb110sbutstseo",
    "cmojwuz9o03h9110sseu935l0",
    "cmojwuz7903h7110snekxlxxs",
    "cmojwqc5y03bw110si80ibkv4",
    "cmojwg47i038h110sr0h1yq6y",
    "cmojwg45f038f110s9yuy8hua",
    "cmojwg438038d110syzkip9g9",
    "cmojwg40r038b110s6wy29xtg",
    "cmok9oelv01w411vsmetukbyx",
    "cms91bkwl0097sznxl7cjh7iq",
    "cmmwclfuh003u51n07kjpo1dj",
    "cmmwck1mi003k51n0dhc7tvpf",
    "cmmthj7zi001fu9h8p4ixh3gb",
  ]),
  ...derivedShowcaseImages("pet", "宠物漫剧同主题本地派生分镜", 18, 67),
] as const;

const PET_MANGA_VIDEOS = [
  ...exactLocalMediaPool("video", ["cmny078nc000dro6oj5ryao36"]),
  staticShowcaseVideo(
    "pet-derived-video-02",
    "宠物漫剧同主题本地派生视频预览 02",
    "canvas-showcases/derived/pet/videos/pet-02.mp4",
    `${LOCAL_MEDIA_ROOT}/canvas-showcases/derived/pet/images/pet-018.jpg`,
  ),
] as const;

const PET_MANGA_AUDIO = exactLocalMediaPool("audio", ["cmooa7ytq07eahcs9pusaqh95"]);

const M8_BASE_IMAGES = [
  ["m8-cockpit-family", "奕派M8座舱与家庭露营", "canvas-showcases/m8/01-cockpit-family.jpg"],
  ["m8-cockpit-sunset", "奕派M8座舱黄昏视角", "canvas-showcases/m8/02-cockpit-sunset.jpg"],
  ["m8-family-camp", "家庭湖畔露营", "canvas-showcases/m8/03-family-camp.jpg"],
  ["m8-dashboard-camp", "座舱中控与露营地", "canvas-showcases/m8/04-dashboard-camp.jpg"],
  ["m8-dashboard-sunset", "座舱中控黄昏氛围", "canvas-showcases/m8/05-dashboard-sunset.jpg"],
  ["m8-camp-lifestyle", "家庭露营生活方式", "canvas-showcases/m8/06-camp-lifestyle.jpg"],
  ["m8-cockpit-detail", "奕派M8座舱细节", "canvas-showcases/m8/07-cockpit-detail.jpg"],
  ["m8-family-detail", "家庭成员露营细节", "canvas-showcases/m8/08-family-detail.jpg"],
  ["m8-camp-detail", "湖边营地细节", "canvas-showcases/m8/09-camp-detail.jpg"],
  ["m8-sunset-detail", "湖边黄昏环境细节", "canvas-showcases/m8/10-sunset-detail.jpg"],
] as const;

const M8_IMAGES = [
  ...M8_BASE_IMAGES.map(([id, title, localPath]) => staticShowcaseImage(id, title, localPath)),
  ...derivedShowcaseImages("m8", "M8家庭出行同主题本地派生分镜", 11, 106),
] as const;

const M8_VIDEOS = Array.from({ length: 11 }, (_, index) => {
  const sequence = index + 1;
  const padded = String(sequence).padStart(2, "0");
  const posterPath = sequence <= M8_BASE_IMAGES.length
    ? `${LOCAL_MEDIA_ROOT}/${M8_BASE_IMAGES[index][2]}`
    : `${LOCAL_MEDIA_ROOT}/canvas-showcases/derived/m8/images/m8-011.jpg`;
  return staticShowcaseVideo(
    `m8-derived-video-${padded}`,
    `M8家庭出行同主题本地派生视频预览 ${padded}`,
    `canvas-showcases/derived/m8/videos/m8-${padded}.mp4`,
    posterPath,
  );
});

const M8_AUDIO = exactLocalMediaPool("audio", [
  "cmreqtxrp00x412o9vht6yoxw",
  "cmrepdsql005912o9i4yhyz21",
  "cmreoz0lg002b12o91tl24a2k",
]);

const ANCIENT_IMAGES = exactLocalMediaPool("image", [
  "cmt1majdi02wd7fsa8xed2xe5",
  "cmt1m9gg902vn7fsa781qqiq4",
  "cmt1m9fmb02vk7fsayssbhkzx",
  "cmt1m9dz402vh7fsazz8aj833",
  "cmt1m9drz02ve7fsaj8cu3eng",
  "cmt1m9d4202vb7fsa0izcsj0i",
  "cmt1m9cp002v87fsaohrxlgt3",
  "cmt1m9cei02v57fsae42u8zpp",
  "cmt1m9cbd02v27fsabgl7bns7",
  "cmt1m9c1a02uz7fsa0nk2mlt7",
  "cmt1m9bsi02uw7fsaavszflqr",
  "cmt1m9bnl02ut7fsac4aja7l0",
  "cmt1m9b5l02uq7fsawcl76vrk",
  "cmt1m9b1a02un7fsanakfc911",
  "cmt1m99nt02uk7fsa15zlgbn4",
  "cmt1m89hm02rd7fsabxtjkifg",
  "cmt1m88tc02ra7fsawoiaosw3",
  "cmt164bml00tqa3iw3oa3qbus",
  "cmt1613pd00r8a3iw6qqmog30",
  "cmt160wf700r5a3iw6k5eehrj",
  "cmt160u7v00r2a3iwilbdruod",
  "cmt160rur00qza3iweddjmclz",
  "cmt160mkq00qma3iw80glbfcn",
  "cmt160ku800qja3iwzb92hpmk",
  "cmt160ket00qca3iwsk6p4iit",
  "cmt160jpy00q9a3iwya3p1jkw",
  "cmt160h5x00q6a3iw8d2favsb",
  "cmt160fei00q3a3iw9zkr8olo",
]);

const SHOWCASE_MEDIA_ROOT = "/youcai-media/v1/canvas-showcases";

const SHOWCASE_MEDIA = {
  covers: {
    paperFox: `${SHOWCASE_MEDIA_ROOT}/paper-fox/06-cover.jpg`,
    silentPet: "/youcai-media/v1/images/cmojwg45f038f110s9yuy8hua.png",
    m8Ad: `${SHOWCASE_MEDIA_ROOT}/m8/01-cockpit-family.jpg`,
    ancientCanvas: "/youcai-media/v1/images/cmt1m9fmb02vk7fsayssbhkzx.png",
  },
  paperFox: {
    character: `${SHOWCASE_MEDIA_ROOT}/paper-fox/04-fox-character.jpg`,
    study: `${SHOWCASE_MEDIA_ROOT}/paper-fox/05-real-study.jpg`,
    cover: `${SHOWCASE_MEDIA_ROOT}/paper-fox/06-cover.jpg`,
    firstHalfVideo: `${SHOWCASE_MEDIA_ROOT}/paper-fox/07-story-first-half.mp4`,
    extendedVideo: `${SHOWCASE_MEDIA_ROOT}/paper-fox/08-story-extended.mp4`,
    themeSong: `${SHOWCASE_MEDIA_ROOT}/paper-fox/10-theme-song.mp3`,
    soundTheater: `${SHOWCASE_MEDIA_ROOT}/paper-fox/11-sound-theater.mp3`,
  },
} as const;

const p = (x: number, y: number): CanvasShowcasePosition => ({ x, y });

function textNode(seed: NodeSeed): CanvasShowcaseNode {
  return { ...seed, kind: "text", status: "已完成" };
}

function imageNode(seed: NodeSeed, imagePath: string, imageAlt: string): CanvasShowcaseNode {
  return {
    ...seed,
    kind: "image",
    status: "已完成",
    height: seed.height ?? 430,
    imagePath,
    imageAlt,
    toolLabel: "本地参考图",
  };
}

function videoNode(seed: NodeSeed, mediaPath: string, posterPath: string): CanvasShowcaseNode {
  return {
    ...seed,
    kind: "video",
    status: "已完成",
    height: seed.height ?? 450,
    mediaPath,
    mediaType: "video/mp4",
    posterPath,
    durationLabel: "本地视频",
    toolLabel: "只读演示媒体",
  };
}

function audioNode(
  seed: NodeSeed,
  mediaPath: string,
  kind: "audio" | "music" = "audio",
): CanvasShowcaseNode {
  return {
    ...seed,
    kind,
    status: "已完成",
    height: seed.height ?? 260,
    mediaPath,
    mediaType: "audio/mpeg",
    durationLabel: kind === "music" ? "本地音乐" : "本地声音",
    toolLabel: "只读演示媒体",
  };
}

function snapshotNodeBody(node: OfficialCanvasSnapshotNode, snapshot: OfficialCanvasGraphSnapshot): string {
  const publicState = node.outputCount > 0
    ? `官网公开结构记录该节点有 ${node.outputCount} 个结果。`
    : node.kind === "group"
      ? "官网公开结构将该节点标记为分组框。"
      : "官网公开结构保留该方案节点，当前没有结果记录。";
  const localState = node.kind === "image" || node.kind === "video" || node.kind === "audio" || node.kind === "music"
    ? "详情页只挂载同主题、项目内版本化自有素材或由其生成的可追溯本地预览，不串用其他案例或远程媒体。"
    : node.kind === "video-plan" || node.kind === "audio-plan"
      ? "该方案节点保持未生成状态，不挂载伪造的媒体结果。"
    : "未公开的提示词与隐藏配置不会在本地补写。";
  return `${publicState}${localState}\n\n公开结构来源：${snapshot.sourceUrl}\n核对日期：${snapshot.capturedAt}`;
}

interface SnapshotMediaPool {
  images: readonly LocalMediaRef[];
  videos: readonly LocalMediaRef[];
  audios: readonly LocalMediaRef[];
}

function mediaFromPool(
  pool: readonly LocalMediaRef[],
  index: number,
): LocalMediaRef | undefined {
  // A public showcase node may only consume its own matching local asset once.
  // Cycling a short pool made large official snapshots repeat and visually leak
  // assets across otherwise independent examples. Missing source media stays an
  // explicit unavailable placeholder instead of being silently substituted.
  return pool[index];
}

function unavailableSnapshotMediaNode(
  seed: NodeSeed,
  kind: "image" | "video" | "audio" | "music",
): CanvasShowcaseNode {
  return {
    ...seed,
    kind,
    status: "同主题本地媒体待归档",
    height: seed.height ?? (kind === "audio" || kind === "music" ? 260 : 430),
    toolLabel: "未挂载跨案例媒体",
  };
}

function materializeOfficialSnapshot(
  snapshot: OfficialCanvasGraphSnapshot,
  mediaPool: SnapshotMediaPool,
): readonly CanvasShowcaseNode[] {
  let imageIndex = 0;
  let videoIndex = 0;
  let audioIndex = 0;
  const minX = Math.min(...snapshot.nodes.map((node) => node.position.x));
  const minY = Math.min(...snapshot.nodes.map((node) => node.position.y));
  const normalizedPositions = new Map(snapshot.nodes.map((node) => [node.id, {
    x: node.position.x - minX,
    y: node.position.y - minY,
  }]));
  return snapshot.nodes.map((node, index): CanvasShowcaseNode => {
    // The public snapshot does not expose explicit group membership or bounds.
    // Keep its group marker as a conservative visual frame instead of guessing
    // ownership from proximity, which can swallow unrelated distant nodes.
    const frame = node.kind === "group" ? { width: 720, height: 520 } : undefined;
    const seed: NodeSeed = {
      id: node.id,
      order: String(index + 1).padStart(3, "0"),
      title: node.title,
      body: snapshotNodeBody(node, snapshot),
      position: normalizedPositions.get(node.id) || { x: 0, y: 0 },
      width: frame?.width,
      height: frame?.height,
    };
    if (node.kind === "image") {
      const media = mediaFromPool(mediaPool.images, imageIndex++);
      return media
        ? imageNode(seed, media.path, `${node.title} · 同主题本地版本化素材`)
        : unavailableSnapshotMediaNode(seed, "image");
    }
    if (node.kind === "video") {
      const media = mediaFromPool(mediaPool.videos, videoIndex++);
      return media
        ? videoNode(seed, media.path, media.posterPath || "")
        : unavailableSnapshotMediaNode(seed, "video");
    }
    if (node.kind === "audio" || node.kind === "music") {
      const media = mediaFromPool(mediaPool.audios, audioIndex++);
      return media
        ? audioNode(seed, media.path, node.kind)
        : unavailableSnapshotMediaNode(seed, node.kind);
    }
    return {
      ...seed,
      kind: node.kind,
      status: node.kind === "video-plan" || node.kind === "audio-plan"
        ? "官网公开状态：未生成"
        : node.kind === "group"
          ? "结构分组"
          : "已公开",
    };
  });
}

function snapshotEdges(snapshot: OfficialCanvasGraphSnapshot): readonly CanvasShowcaseEdge[] {
  return snapshot.edges.map((edge) => ({ ...edge }));
}

function edges(prefix: string, pairs: readonly (readonly [string, string])[]): CanvasShowcaseEdge[] {
  return pairs.map(([source, target], index) => ({
    id: `${prefix}-e${String(index + 1).padStart(2, "0")}`,
    source,
    target,
  }));
}

const PAPER_FOX_SHOWCASE: CanvasShareShowcaseData = {
  id: "canvas-showcase-78f7a4a9ce11-paper-fox-adventure",
  title: "示例｜纸上小狐狸的奇幻冒险",
  tag: "",
  description: "打开示例查看节点编排与创作流程，一键复制为自己的画布。",
  coverMediaType: "image",
  coverImage: SHOWCASE_MEDIA.covers.paperFox,
  coverAlt: "台灯照亮书本上跃出的发光纸绘小狐狸",
  officialSnapshot: {
    sourceUrl: "https://youcai.art/share/canvas/canvas-showcase-78f7a4a9ce11-paper-fox-adventure",
    capturedAt: "2026-08-24",
    nodeCount: 13,
    edgeCount: 17,
  },
  prompt: "二维蜡笔手绘与真实书房材质融合的奇幻短片：一只橙红色发光小狐狸从素描本的纸面跃出，穿过铅笔形成的拱门，跃上横跨旧书的铅笔桥，最后在黄铜台灯底座用尾巴画出金橙色星星。角色保持蜡笔颗粒和纸面质感，书房保持真实光影，无字幕、无水印、无品牌标识。",
  nodes: [
    textNode({ id: "fox-guide", order: "01", title: "使用说明", position: p(0, 0), height: 370, body: "这是一个可复制、可继续创作的四宫格竖屏多模态短片工作流。先阅读创意简报，再依次检查分镜脚本、角色、场景、封面、两段剧情视频、独立视频预览、音乐、声音剧场与发布文案；复制后所有节点均可继续编辑。" }),
    textNode({ id: "fox-brief", order: "02", title: "创意简报", position: p(0, 460), height: 390, body: "创意：一只由橙色蜡笔线条画成的小狐狸，从画纸跃入真实书房，在书本、铅笔和台灯之间奔跑。\n\n角色锁定：橙红色蜡笔轮廓、奶白胸口与尾尖、黑色圆眼、纸面折痕。\n\n场景锁定：温暖安静的夜间书房，深色木书桌、摊开的素描本、彩色蜡笔、叠放书籍与黄铜台灯。\n\n成片规格：9:16 竖屏；角色不说话；无字幕、无水印、无品牌标识。" }),
    textNode({ id: "fox-storyboard", order: "03", title: "四宫格分镜脚本", position: p(0, 940), height: 560, body: "分镜 1｜苏醒：小狐狸在纸面眨眼，前爪撑住纸边后轻巧跃出。\n\n分镜 2｜出发：穿越铅笔桥，沿书桌奔跑，镜头低机位跟随。\n\n分镜 3｜转折：夜风翻动书页，小狐狸用尾巴勾住书签，借力跃上更高处。\n\n分镜 4｜收束：小狐狸跃上黄铜台灯底座，用尾巴在空气中画出金橙色星星。\n\n声音贯穿：木管、八音盒、纸张摩擦、蜡笔划动、轻巧脚步与风吹书页。" }),
    imageNode({ id: "fox-character", order: "04", title: "小狐狸角色图", position: p(560, 0), body: "统一锁定小狐狸的体型、橙红蜡笔轮廓、奶白胸口与尾尖、黑色圆眼和纸面折痕；后续镜头不得改变角色材质。" }, SHOWCASE_MEDIA.paperFox.character, "小狐狸角色三视图"),
    imageNode({ id: "fox-scene", order: "05", title: "真实书房场景图", position: p(560, 520), body: "深色木书桌、打开的素描本、蜡笔、旧书与暖金台灯构成连续空间；锁定窗、书堆与台灯的相对位置。" }, SHOWCASE_MEDIA.paperFox.study, "真实书房参考场景"),
    imageNode({ id: "fox-cover", order: "06", title: "短片封面图", position: p(1120, 0), body: "小狐狸与台灯形成双视觉锚点，预留竖屏安全区，不嵌入文字、水印和品牌标识。" }, SHOWCASE_MEDIA.paperFox.cover, "纸上小狐狸短片封面"),
    videoNode({ id: "fox-video-a", order: "07", title: "故事前半段 · 分镜 1–2 · 14 秒", position: p(1120, 520), body: "苏醒与出发：镜头从画纸俯拍转为低机位跟随，小狐狸跃出纸面并穿过铅笔桥。该节点使用已归档本地视频，可直接播放。" }, SHOWCASE_MEDIA.paperFox.firstHalfVideo, SHOWCASE_MEDIA.paperFox.cover),
    videoNode({ id: "fox-video-b", order: "08", title: "向后延长 · 分镜 3–4 · 14 秒", position: p(1680, 520), body: "转折与收束：承接前一段角色、材质与空间，完成书页转折、跃上台灯和星光收束。该节点使用另一条本地视频，不再重复首段素材。" }, SHOWCASE_MEDIA.paperFox.extendedVideo, SHOWCASE_MEDIA.paperFox.study),
    textNode({ id: "fox-music-direction", order: "09", title: "音乐风格与编曲", position: p(560, 1040), height: 320, body: "温暖奇幻的童话流行：木管与八音盒起步，拨弦和轻柔弦乐逐层加入；前半段保持好奇与轻盈，转折处短暂收紧，星光出现时释放，结尾回到单颗八音盒音色。" }),
    audioNode({ id: "fox-music", order: "10", title: "独立主题歌曲", position: p(1120, 1040), body: "为《纸上小狐狸的奇幻冒险》配置的独立音乐节点，使用已归档本地音频验证试听、复制与继续编辑。" }, SHOWCASE_MEDIA.paperFox.themeSong, "music"),
    audioNode({ id: "fox-voice", order: "11", title: "60 秒奇幻声音剧场", position: p(1680, 1040), body: "由旁白、纸张摩擦、蜡笔划动、脚步、书页风声与环境底噪组成；旁白只补充情绪，不代替角色对白。" }, SHOWCASE_MEDIA.paperFox.soundTheater),
    textNode({ id: "fox-publish", order: "12", title: "发布文案", position: p(2240, 0), height: 360, body: "标题：《纸上小狐狸的奇幻冒险》\n\n简介：每一个被画下的想象，都在等待一个勇敢的瞬间。越过纸张与现实的边界，跳进属于自己的世界。\n\n检查：竖屏安全区、封面、两段视频、主题歌曲和声音剧场均已关联。" }),
    videoNode({ id: "fox-video-preview", order: "", title: "视频", position: p(2240, 520), body: "官网公开快照中存在一个无编号、无连线的独立视频结果节点。本地使用独立的狐狸主题版本化视频承载第三个可播放预览，不把它伪装成主剧情链路的输入或输出。" }, MEDIA.foxVideoA.path, MEDIA.foxVideoA.posterPath || SHOWCASE_MEDIA.paperFox.cover),
  ],
  edges: edges("fox", [
    ["fox-brief", "fox-character"],
    ["fox-brief", "fox-scene"],
    ["fox-brief", "fox-cover"],
    ["fox-character", "fox-cover"],
    ["fox-scene", "fox-cover"],
    ["fox-storyboard", "fox-video-a"],
    ["fox-character", "fox-video-a"],
    ["fox-scene", "fox-video-a"],
    ["fox-video-a", "fox-publish"],
    ["fox-storyboard", "fox-video-b"],
    ["fox-character", "fox-video-b"],
    ["fox-scene", "fox-video-b"],
    ["fox-video-a", "fox-video-b"],
    ["fox-video-b", "fox-publish"],
    ["fox-storyboard", "fox-voice"],
    ["fox-cover", "fox-publish"],
    ["fox-music-direction", "fox-music"],
  ]),
};

const OFFICIAL_CARD_SUBTITLE = "打开示例查看节点编排与创作流程，一键复制为自己的画布。";

const PET_COMIC_SHOWCASE: CanvasShareShowcaseData = {
  id: "cmsyrsury01e3caezkqyg5l5l",
  title: "示例：漫剧（未完成）",
  tag: "短剧",
  description: OFFICIAL_CARD_SUBTITLE,
  coverMediaType: "image",
  coverImage: SHOWCASE_MEDIA.covers.silentPet,
  coverAlt: "雪景花枝前身着古装的女子近景",
  officialSnapshot: {
    sourceUrl: PET_OFFICIAL_GRAPH.sourceUrl,
    capturedAt: PET_OFFICIAL_GRAPH.capturedAt,
    nodeCount: PET_OFFICIAL_GRAPH.nodes.length,
    edgeCount: PET_OFFICIAL_GRAPH.edges.length,
  },
  prompt: "古装女子与灵宠共同推进的无对白漫剧工作流：保留官网公开的 78 个节点与 71 条连线，只挂载古装人物、灵宠、古风场景及同主题本地音视频，不串用其他案例素材。",
  nodes: materializeOfficialSnapshot(PET_OFFICIAL_GRAPH, {
    images: PET_MANGA_IMAGES,
    videos: PET_MANGA_VIDEOS,
    audios: PET_MANGA_AUDIO,
  }),
  edges: snapshotEdges(PET_OFFICIAL_GRAPH),
};

const CONCEPT_CAR_SHOWCASE: CanvasShareShowcaseData = {
  id: "cmsyrvsqh01jgcaez3xadrsob",
  title: "示例：奕派M8广告",
  tag: "广告",
  description: OFFICIAL_CARD_SUBTITLE,
  coverMediaType: "image",
  coverImage: SHOWCASE_MEDIA.covers.m8Ad,
  coverAlt: "奕派M8座舱望向海边黄昏家庭露营场景",
  officialSnapshot: {
    sourceUrl: CAR_OFFICIAL_GRAPH.sourceUrl,
    capturedAt: CAR_OFFICIAL_GRAPH.capturedAt,
    nodeCount: CAR_OFFICIAL_GRAPH.nodes.length,
    edgeCount: CAR_OFFICIAL_GRAPH.edges.length,
  },
  prompt: "奕派M8家庭出行广告工作流：围绕智能座舱、湖畔露营、亲子陪伴与黄昏光线组织 139 个节点和 148 条连线；图片、视频与声音均使用项目内同主题素材或由其生成的可追溯本地预览，不挂载其他商品、远程媒体或第三方 Logo。",
  nodes: materializeOfficialSnapshot(CAR_OFFICIAL_GRAPH, {
    images: M8_IMAGES,
    videos: M8_VIDEOS,
    audios: M8_AUDIO,
  }),
  edges: snapshotEdges(CAR_OFFICIAL_GRAPH),
};

const ANCIENT_STORY_SHOWCASE: CanvasShareShowcaseData = {
  id: "cmt37buny005u85fyne9adfac",
  title: "我在古代当花魁 · 创作画布示例",
  tag: "爽剧",
  description: OFFICIAL_CARD_SUBTITLE,
  coverMediaType: "image",
  coverImage: SHOWCASE_MEDIA.covers.ancientCanvas,
  coverAlt: "红色灯笼与帷幔装饰的古代清芳馆大堂",
  officialSnapshot: {
    sourceUrl: ANCIENT_OFFICIAL_GRAPH.sourceUrl,
    capturedAt: ANCIENT_OFFICIAL_GRAPH.capturedAt,
    nodeCount: ANCIENT_OFFICIAL_GRAPH.nodes.length,
    edgeCount: ANCIENT_OFFICIAL_GRAPH.edges.length,
  },
  prompt: "古代花魁爽剧工作流：28 个人物、场景与道具节点使用彼此独立的同主题本地素材；54 个视频方案节点严格保持未生成，不复用房间图充当镜头结果，也不伪造可播放视频。",
  nodes: materializeOfficialSnapshot(ANCIENT_OFFICIAL_GRAPH, {
    images: ANCIENT_IMAGES,
    videos: [],
    audios: [],
  }),
  edges: snapshotEdges(ANCIENT_OFFICIAL_GRAPH),
};

export const CANVAS_SHARE_SHOWCASES: readonly CanvasShareShowcaseData[] = [
  PAPER_FOX_SHOWCASE,
  PET_COMIC_SHOWCASE,
  CONCEPT_CAR_SHOWCASE,
  ANCIENT_STORY_SHOWCASE,
];

const SHOWCASE_BY_ID: Readonly<Record<string, CanvasShareShowcaseData>> = Object.freeze({
  ...Object.fromEntries(CANVAS_SHARE_SHOWCASES.map((showcase) => [showcase.id, showcase])),
  "local-showcase-paper-fox-adventure": {
    ...PAPER_FOX_SHOWCASE,
    id: "local-showcase-paper-fox-adventure",
  },
});

export function getCanvasShareShowcase(shareId: string): CanvasShareShowcaseData | undefined {
  return SHOWCASE_BY_ID[shareId];
}
