export const videoProductionSkills = ['speech-cut', 'speech-pace', 'ad-spec'] as const;
export type VideoProductionSkill = typeof videoProductionSkills[number];
export function isVideoProductionSkill(id: string): id is VideoProductionSkill {
  return videoProductionSkills.some(value => value === id);
}
export type Cut = {start: number; end: number};
export type SourceVideoInfo = {
  duration: number; width: number; height: number; codec: string;
  audioCodec: string; fps: number | null; bitrateKbps: number | null;
  videoBitrateKbps: number | null;
};
export type VideoInspection = {source: SourceVideoInfo; pauses: Cut[]; checks?: DeliveryCheck[]};
export type DeliveryCheck = {name:string; pass:boolean};
export function verticalAdChecks(video:SourceVideoInfo,bytes:number):DeliveryCheck[] {
  return [
    {name:'画幅 9:16',pass:video.width*16===video.height*9},
    {name:'尺寸 720×1280 至 1440×2560',pass:video.width>=720&&video.width<=1440&&video.height>=1280&&video.height<=2560},
    {name:'视频码率至少 516 kb/s',pass:video.videoBitrateKbps!==null&&video.videoBitrateKbps>=516},
    {name:'时长 4 至 300 秒',pass:video.duration>=4&&video.duration<=300},
    {name:'文件不超过 1000 MB',pass:bytes<=1000_000_000},
    {name:'H.264 视频编码',pass:video.codec==='h264'},
  ];
}
export const deliverySizes = {
  '720x1280': [720,1280], '1080x1920': [1080,1920],
  '1280x720': [1280,720], '1920x1080': [1920,1080], '1080x1080': [1080,1080],
} as const;
export type DeliverySize = keyof typeof deliverySizes;
export const speechRates = [0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;
export function keepAroundCuts(cuts: Cut[], duration: number): Cut[] {
  const sorted = cuts.slice().sort((a,b) => a.start-b.start);
  let cursor = 0;
  const keep: Cut[] = [];
  for (const cut of sorted) {
    if (!Number.isFinite(cut.start) || !Number.isFinite(cut.end) || cut.start < 0 || cut.end <= cut.start || cut.end > duration) {
      throw Error('删减时间应在原片时长之内，结束时间须大于开始时间');
    }
    if (cut.start > cursor) keep.push({start: cursor, end: cut.start});
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < duration) keep.push({start: cursor, end: duration});
  if (!keep.length) throw Error('请至少保留一个口播片段');
  return keep;
}
