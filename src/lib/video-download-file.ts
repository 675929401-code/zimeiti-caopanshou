/** Download names follow delivered bytes; this helper never transcodes media. */
const VIDEO_FILE_TYPES: Readonly<Record<string, { extension: string; mime: string }>> = {
  "video/mp4": { extension: "mp4", mime: "video/mp4" },
  "application/mp4": { extension: "mp4", mime: "video/mp4" },
  "video/x-m4v": { extension: "mp4", mime: "video/mp4" },
  "video/webm": { extension: "webm", mime: "video/webm" },
  "video/quicktime": { extension: "mov", mime: "video/quicktime" },
  "video/ogg": { extension: "ogv", mime: "video/ogg" },
  "video/x-matroska": { extension: "mkv", mime: "video/x-matroska" },
  "video/x-msvideo": { extension: "avi", mime: "video/x-msvideo" },
};

export function videoDownloadFile(requestedName: string, contentType: string) {
  const type = VIDEO_FILE_TYPES[contentType.split(";", 1)[0].trim().toLowerCase()];
  if (!type) throw new Error("无法确认视频文件格式，请重新加载后下载");
  const stem = requestedName.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-")
    .replace(/\.(?:mp4|m4v|webm|mov|qt|ogv|ogg|mkv|avi)$/iu, "").replace(/[. ]+$/u, "") || "视频";
  return { name: `${stem}.${type.extension}`, mime: type.mime, extension: `.${type.extension}` };
}
