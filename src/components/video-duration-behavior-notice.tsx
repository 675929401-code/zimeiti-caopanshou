import { readVideoDurationBehavior, type VideoDurationBehavior } from "@/lib/video-duration-behavior";

export function VideoDurationBehaviorNotice({ durationBehavior }: { durationBehavior?: VideoDurationBehavior }) {
  if (readVideoDurationBehavior(durationBehavior) !== "requested_target") return null;
  return <p role="note" className="video-duration-behavior-notice mt-1.5 text-[11px] leading-4 text-[var(--text-secondary)]">所选秒数为目标时长，成片可能稍长。按所选秒数计费。</p>;
}
