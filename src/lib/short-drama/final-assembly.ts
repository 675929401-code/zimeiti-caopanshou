import type { ProductionShot } from "./production-repository";

export interface AssemblyFrameSize {
  width: number;
  height: number;
}

const FRAME_SIZES: Record<string, AssemblyFrameSize> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1280, height: 960 },
  "3:4": { width: 960, height: 1280 },
  "21:9": { width: 1680, height: 720 },
};

function srtTimestamp(seconds: number): string {
  const safeMilliseconds = Math.max(0, Math.round(seconds * 1_000));
  const milliseconds = safeMilliseconds % 1_000;
  const totalSeconds = Math.floor(safeMilliseconds / 1_000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

function captionText(shot: Pick<ProductionShot, "narration" | "title">): string {
  const source = shot.narration.trim() || shot.title.trim();
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4_000);
}

export function resolveAssemblyFrameSize(aspectRatio: string): AssemblyFrameSize {
  return FRAME_SIZES[aspectRatio] || FRAME_SIZES["16:9"];
}

export function buildShortDramaSrt(
  shots: Array<Pick<ProductionShot, "sequence" | "narration" | "title" | "durationSeconds">>,
): string {
  let cursorSeconds = 0;
  const blocks: string[] = [];
  for (const shot of [...shots].sort((left, right) => left.sequence - right.sequence)) {
    const duration = Math.max(0.5, Math.min(60, Number(shot.durationSeconds) || 5));
    const start = cursorSeconds;
    const end = start + duration;
    const caption = captionText(shot);
    if (caption) {
      blocks.push([
        String(blocks.length + 1),
        `${srtTimestamp(start)} --> ${srtTimestamp(end)}`,
        caption,
      ].join("\n"));
    }
    cursorSeconds = end;
  }
  return blocks.join("\n\n");
}

export function totalShotDuration(
  shots: Array<Pick<ProductionShot, "durationSeconds">>,
): number {
  return shots.reduce(
    (total, shot) => total + Math.max(0.5, Math.min(60, Number(shot.durationSeconds) || 5)),
    0,
  );
}
