import assert from "node:assert/strict";
import { test } from "node:test";
import { appendPublishingTopics, buildNativePluginPlatformConfig, isSamePublishingAccount, nativeAspectRatioInRange, nativeAspectRatioMatches, nativeCalendarRange, normalizePublishingTopics, prepareNativePluginContent, validateNativePublishingMedia } from "../src/lib/publishing-native";
import { createPublishingPluginRunner, searchPublishingActivities, searchPublishingLocations, type PublishingPluginParams } from "../src/lib/publishing-plugin";

test("adapted topic normalization preserves native deduplication and does not append duplicate hashtags", () => {
  assert.deepEqual(normalizePublishingTopics(["##AI[话题]#", "ai", " 生活 ", "#生活#", "#"]), ["AI", "生活"]);
  assert.equal(appendPublishingTopics("今天 #AI", ["ai", "#生活", "生活"]), "今天 #AI\n#生活");
});
test("native account identity requires the same platform and ratio helpers reject malformed media", () => {
  assert.equal(isSamePublishingAccount({ id: "1", platform: "xhs" }, { id: "1", platform: "wxSph" }), false);
  assert.equal(isSamePublishingAccount({ id: "1", platform: "xhs", uid: "u" }, { id: "2", platform: "xhs", uid: "u" }), true);
  assert.equal(nativeAspectRatioMatches(1080, 1920, 9 / 16), true);
  assert.equal(nativeAspectRatioInRange(1080, 1920, 0.5, 1), true);
  for (const dimensions of [[0, 1], [1, 0], [-1, 3], [Infinity, 4], [NaN, 1]]) assert.equal(nativeAspectRatioMatches(dimensions[0], dimensions[1], 1), false);
});
test("native parameter projection retains all selected fields and excludes unrelated data", () => {
  assert.deepEqual(buildNativePluginPlatformConfig("xhs", { xhs: { declaration: 2 } }), { userDeclarationBind: { origin: 2 } });
  const metadata = { width: 1080, height: 1920, duration: 12.5, size: 42 };
  const poi = { poiId: "poi", poiName: "公园", poiCheckSum: "checksum", longitude: 120, latitude: 30 };
  const event = { eventTopicId: "evt", eventName: "活动", eventAttendCount: 2 };
  const options = { wxSph: { poiInfo: { ...poi, unexpected: "ignored" }, event, extLink: "https://example.com/article", postFlag: 1 as const, unexpected: "ignored" } };
  assert.deepEqual(buildNativePluginPlatformConfig("wxSph", options, metadata), { wxSph: { videoMetadata: metadata, poiInfo: poi, event, extLink: options.wxSph.extLink, postFlag: 1 } });
  assert.equal(buildNativePluginPlatformConfig("douyin", options, metadata), undefined);
});
test("calendar uses complete Monday-first month/week ranges across a year boundary", () => {
  const month = nativeCalendarRange(new Date(2027, 0, 1), "month");
  assert.equal(month.days.length, 42); assert.equal(month.start.getDay(), 1);
  assert.equal(month.days[0].getFullYear(), 2026);
  assert.equal(nativeCalendarRange(new Date(2027, 0, 3), "week").days.length, 7);
});
test("native preflight counts UTF-16 title and cleaned body, merges body hashtags and rejects overflow before claim", () => {
  assert.deepEqual(prepareNativePluginContent("xhs", "😀".repeat(10), "a".repeat(1000) + " #生活", ["生活"]), { title: "😀".repeat(10), desc: "a".repeat(1000), topics: ["生活"], errors: [] });
  assert.ok(prepareNativePluginContent("xhs", "😀".repeat(11), "", []).errors.length);
  assert.ok(prepareNativePluginContent("wxSph", "a".repeat(17), "", []).errors.length);
  assert.ok(prepareNativePluginContent("xhs", "", "正文 #六", ["一", "二", "三", "四", "五"]).errors.length);
  assert.ok(prepareNativePluginContent("xhs", "", "正文 # 重写", []).errors.length);
  assert.ok(prepareNativePluginContent("xhs", "", "#生活 #生活", []).errors.length);
  assert.equal(prepareNativePluginContent("wxSph", "", "正文", Array.from({length: 12}, (_, i) => String(i))).errors.length, 0);
});
test("native media preflight catches actual size and duration without restricting saved drafts", () => {
  const image = { role: "image", fileName: "1.png", type: "image/png", size: 64 };
  assert.deepEqual(validateNativePublishingMedia("xhs", "image", [image]), []);
  assert.ok(validateNativePublishingMedia("xhs", "image", [{ ...image, size: 20 * 1024 ** 2 + 1 }]).length);
  assert.ok(validateNativePublishingMedia("wxSph", "video", [{role: "video", fileName: "1.mp4", type: "video/mp4", size: 1024, width: 1920, height: 1080, duration: 3601}], image).length);
  assert.ok(validateNativePublishingMedia("xhs", "video", [{role: "video", fileName: "1.mp4", type: "video/mp4", size: 1024, duration: 2}]).length);
});
const fixture = (overrides: Record<string, unknown> = {}) => ({
  getVersion: async () => ({ version: "3.3.11" }), checkPermission: async () => ({ granted: true }),
  login: async () => ({ type: "xhs", uid: "u", nickname: "作者", account: "creator" }),
  publish: async () => ({ success: true }), ...overrides,
});
const expected = { platform: "xhs" as const, uid: "u", nickname: "作者", account: "creator" };
test("image order reaches the plugin intact; one permit cannot be dispatched twice", async () => {
  const images = [new File(["2"], "2.png", { type: "image/png" }), new File(["1"], "1.jpg", { type: "image/jpeg" })];
  let calls = 0;
  const runner = createPublishingPluginRunner(fixture({ publish: async (params: PublishingPluginParams) => { calls++; assert.equal(params.type, "image"); assert.deepEqual(params.images, images); return { success: true }; } }));
  const permit = { attemptId: "attempt", shouldExecute: true, platform: "xhs" as const };
  const params: PublishingPluginParams = { platform: "xhs", type: "image", images, title: "", desc: "图片内容", topics: [] };
  assert.deepEqual(await runner.executeNative(permit, expected, params), { success: true });
  await assert.rejects(runner.executeNative(permit, expected, params), { code: "already_started" });
  assert.equal(calls, 1);
});
test("native dispatch blocks unconfigured transports, image/video mismatches and missing wx metadata", async () => {
  let calls = 0;
  const runner = createPublishingPluginRunner(fixture({ publish: async () => { calls++; } }));
  const params: PublishingPluginParams = { platform: "douyin", type: "image", images: [new File(["1"], "1.jpg", { type: "image/jpeg" })], title: "", desc: "", topics: [] };
  await assert.rejects(runner.executeNative({ attemptId: "a", shouldExecute: true, platform: "douyin" }, { ...expected, platform: "douyin" }, params), { code: "transport_unavailable" });
  const wx: PublishingPluginParams = { platform: "wxSph", type: "video", video: new File(["1"], "1.mp4", { type: "video/mp4" }), cover: new File(["1"], "1.jpg", { type: "image/jpeg" }), title: "", desc: "", topics: [] };
  await assert.rejects(runner.executeNative({ attemptId: "b", shouldExecute: true, platform: "wxSph" }, { ...expected, platform: "wxSph" }, wx), { code: "media_invalid" });
  assert.equal(calls, 0);
});
test("location/activity search exposes only the native safe projection", async () => {
  const plugin = fixture({
    wxSphSearchLocation: async () => [{ poiId: "p", poiName: "公园", poiCheckSum: "check", latitude: 30, longitude: 120, rawCredential: "ignored" }, { poiName: "no id" }],
    wxSphSearchActivity: async () => [{ eventTopicId: "e", eventName: "活动", eventCreatorNickname: "作者", rawCredential: "ignored" }],
  });
  assert.deepEqual(await searchPublishingLocations("公园", plugin), [{ poiId: "p", poiName: "公园", poiCheckSum: "check", latitude: 30, longitude: 120 }]);
  assert.deepEqual(await searchPublishingActivities("活动", plugin), [{ eventTopicId: "e", eventName: "活动", eventCreatorNickname: "作者" }]);
  await assert.rejects(searchPublishingLocations("公园", fixture()), { code: "search_unavailable" });
});
