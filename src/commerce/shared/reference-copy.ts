export const beatRoles = {
  hook: '开场钩子', problem: '用户痛点', demonstration: '商品演示', proof: '卖点依据',
  turn: '转折', action: '行动引导', context: '场景铺垫',
} as const;

export const rewriteAngles = { problem: '从用户困扰切入', demonstration: '从商品演示切入' } as const;
export type RewriteAngle = keyof typeof rewriteAngles;
export type CopyCue = { id: string; start: number; end: number; text: string; source: 'spoken' | 'subtitle' };
export type SemanticBeat = {
  shotIndex: number;
  role: keyof typeof beatRoles;
  explanation: string;
  cueIds: string[];
  frameIds: string[];
};
type Shot = { start: number; end: number; frameIds: string[] };

// Each line is attached to the current source video and confirmed by its user.
export function parseCopyCues(input: string, duration: number): CopyCue[] {
  if (typeof input !== 'string' || input.length > 6000 || !Number.isFinite(duration) || duration <= 0) throw Error('原文长度或视频时长无效');
  const rows = input.split(/\r?\n/).filter(line => line.trim());
  if (rows.length > 80) throw Error('每段视频最多保存 80 条原文');
  return rows.map((line, index) => {
    const match = /^\s*(\d+(?:\.\d{1,3})?)\s*[-–—]\s*(\d+(?:\.\d{1,3})?)\s*[|｜]\s*(口播|字幕)\s*[|｜]\s*(.+?)\s*$/u.exec(line);
    const start = Number(match?.[1]), end = Number(match?.[2]);
    if (!match || end <= start || end > duration + 0.001 || !match[4].trim()) throw Error(`第 ${index + 1} 行需要有效的起止秒数、来源和原文，时间不能超过原片`);
    return { id: `c${index + 1}`, start, end, source: match[3] === '口播' ? 'spoken' : 'subtitle', text: match[4].trim() };
  });
}

export function validateSemanticBeats(raw: unknown, shots: Shot[], cues: CopyCue[]): SemanticBeat[] {
  if (!Array.isArray(raw) || raw.length > 64) throw Error('语义拆解需要分段列表');
  const ids = (value: unknown, allowed: string[]) => {
    if (!Array.isArray(value) || value.length > 80 || value.some(id => typeof id !== 'string' || !allowed.includes(id)) || new Set(value).size !== value.length) throw Error('语义引用必须属于对应时段');
    return value as string[];
  };
  return raw.map(row => {
    if (!row || !Number.isInteger(row.shotIndex) || !Object.hasOwn(beatRoles, row.role)) throw Error('语义标签或镜头编号无效');
    const shot = shots[row.shotIndex];
    if (!shot || typeof row.explanation !== 'string' || !row.explanation.trim() || row.explanation.length > 500) throw Error('每段判断须关联镜头并说明理由');
    const cueIds = ids(row.cueIds, cues.filter(cue => cue.start < shot.end && cue.end > shot.start).map(cue => cue.id));
    const frameIds = ids(row.frameIds, shot.frameIds);
    if (!cueIds.length && !frameIds.length) throw Error('语义判断缺少可回看的原文或画面证据');
    return { shotIndex: row.shotIndex, role: row.role as SemanticBeat['role'], explanation: row.explanation.trim(), cueIds, frameIds };
  });
}
