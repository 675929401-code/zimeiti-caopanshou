/** Video metadata is never a substitute for recognised spoken words. */
export function buildPpt6TranscriptItem(input: {
  index: number;
  transcript: string | null;
  method: string;
  title: string;
  description: string;
}) {
  const content = input.transcript?.trim() || "";
  const success = content.length > 0 && ["asr", "llm", "llm_fallback"].includes(input.method);
  return {
    row: input.index + 1,
    col: 1,
    platform: "douyin",
    success,
    content: success ? content : "",
    corrected_content: success ? content : "",
    title: input.title || input.description,
    source: success ? "asr_llm" : "title_only",
    isTranscript: success,
    transcriptMethod: success ? input.method : "none",
    ...(success ? {} : { error: "视频信息已获取，但语音识别未返回口播正文；标题和描述未作为提取结果" }),
  };
}
