type VideoDurationDisplaySource = {
  workflowInputMode?: unknown;
  billingUnit?: unknown;
  requiresSourceVideo?: unknown;
};

/** Describe the submitted duration without treating it as measured media metadata. */
export function videoDurationDisplay(source?: VideoDurationDisplaySource | null) {
  if (source?.requiresSourceVideo === true) {
    return { label: "视频时长", description: "", quoteBasis: "按源视频时长报价" };
  }
  const clipsAudio = source?.workflowInputMode === "image_audio_lipsync";
  const perSecond = source?.billingUnit === "output_second";
  return {
    label: clipsAudio ? "音频截取上限" : "目标时长",
    description: clipsAudio
      ? `${perSecond ? "报价按所选上限秒数计算；" : ""}此值限定输入音频的截取长度，成片时长以播放结果为准。`
      : perSecond ? "报价按目标秒数计算；成片时长可能因帧数略有差异，以播放结果为准。" : "",
    quoteBasis: clipsAudio ? "按本次音频截取上限秒数报价" : "按本次目标秒数报价",
  };
}

/** Only finite positive media metadata is an actual duration; never fall back to the request. */
export function formatActualVideoDuration(seconds: unknown): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? `${Number(seconds.toFixed(3))} 秒`
    : null;
}
