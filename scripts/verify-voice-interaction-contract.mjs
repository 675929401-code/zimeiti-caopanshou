import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const includes = (source, fragments, label) => {
  for (const fragment of fragments) {
    if (!source.includes(fragment)) throw new Error(`${label} missing: ${fragment}`);
  }
};

const gallery = read("src/app/voice-studio/voices/page.tsx");
const featuredCard = read("src/components/vs/FeaturedVoiceCard.tsx");
const workspace = read("src/app/voice-studio/workspace/page.tsx");
const portrait = read("src/components/vs/VoicePortrait.tsx");
const favoritesHook = read("src/hooks/use-voice-favorites.ts");
const favoritesApi = read("src/app/api/voice/favorites/route.ts");
const previewApi = read("src/app/api/voice/preview/route.ts");
const previewTexts = read("src/lib/vs/preview-texts.ts");
const digitalPicker = read("src/features/digital-human/SpeechVoicePicker.tsx");
const header = read("src/components/vs/Header.tsx");
const clonePage = read("src/app/voice-studio/clone/page.tsx");
const designPage = read("src/app/voice-studio/design/page.tsx");
const imitatePage = read("src/app/voice-studio/imitate/page.tsx");

includes(portrait, ["/avatars/voice-studio/portraits.webp", "getVoicePortraitPosition", "backgroundPosition"], "uniform portrait atlas");
includes(gallery, ["<FeaturedVoiceCard", "useVoiceFavorites", "RECOMMENDED_VOICE_IDS", "WEEKLY_VOICE_IDS", "VOICE_CURATION_DATE"], "voice gallery");
includes(featuredCard, ["<VoicePortrait", "loadPreview", "停止试听", "URL.revokeObjectURL"], "voice gallery card");
includes(workspace, [
  "<VoicePortrait", "useVoiceFavorites", "previewSequenceRef", "URL.revokeObjectURL",
  "aria-label={`${isThisPlaying ? '停止试听'", "aria-pressed={isFav}",
  // Option wrapping and control geometry are checked in desktop browser acceptance.
  "lg:grid-cols-[360px_minmax(0,1fr)]",
], "voice workspace interaction");
if (workspace.includes("previewLockRef")) throw new Error("voice workspace still ignores a second preview click while the first is loading");

includes(favoritesHook, [
  "workbenchUserStorageKey('vs_favorites',userId)", "Authorization:'Bearer '+token",
  "owner.current!==userId", "voice-favorites-updated",
], "account scoped favorites hook");
includes(favoritesApi, [
  ".eq('user_id', user.id)", "p_user_id: user.id", ".delete().eq('user_id', user.id)",
], "account scoped favorites API");
includes(previewApi, [
  "withAuth(req", "findVoiceBySpeakerId", ".eq('user_id',user.id)", "cachedVoicePreview",
  "cacheHit: cached.cacheHit", "resolveVoicePreviewText(category)",
], "fixed-text owned preview API");
includes(previewTexts, ["模拟真人", "resolveVoicePreviewText", "__default__"], "shared fixed preview text contract");
includes(digitalPicker, [
  "useVoiceFavorites(userId,token)", "搜索配音音色", "收藏音色", "VoicePortrait",
  "loadPreview", "clearCachedPreview", "停止试听所选音色", "URL.revokeObjectURL",
], "digital human voice picker");

if (/\/voice-studio\/(?:clone|design)/.test(header)) throw new Error("retired clone/design pages remain in the public voice navigation");
includes(clonePage, ["redirect('/voice-studio/imitate')"], "retired clone route");
includes(designPage, ["redirect('/voice-studio/imitate')"], "retired design route");
if (imitatePage.includes("训练为专属音色") || imitatePage.includes("跳转到声音复刻")) {
  throw new Error("voice imitation still advertises the retired cloning workflow");
}

console.log(JSON.stringify({ status: "passed", checks: [
  "uniform portrait atlas", "gallery curation", "preview switch and stop cleanup", "responsive workspace",
  "favorite persistence and account scope", "fixed-text owned preview", "digital-human search/favorite/preview",
  "retired clone/design public flow",
] }, null, 2));
