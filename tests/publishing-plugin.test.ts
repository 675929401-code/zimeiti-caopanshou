import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublishingPluginRunner, inspectPublishingPlugin, projectPublishingAccount, projectPublishingReceipt, publishingPluginMessage } from "../src/lib/publishing-plugin";
import type { PublishingMutationResponse } from "../src/lib/publishing-contract";

const account = { type: "xhs", uid: "member-1", account: "creator", nickname: "创作者", loginCookie: "sensitive-fixture-cookie", unexpected: { secret: "hidden" } };
const expected = { platform: "xhs" as const, uid: "member-1", account: "creator", nickname: "创作者" };
const permit: PublishingMutationResponse = { ok: true, shouldExecute: true, task: { id: "00000000-0000-4000-8000-000000000001", draftId: "00000000-0000-4000-8000-000000000002", draftRevision: 1, accountId: "00000000-0000-4000-8000-000000000003", platform: "xhs", status: "awaiting_receipt", reportedSuccess: null, workId: null, shareLink: null, receiptSource: null, createdAt: "", updatedAt: "" } };
const params = () => ({ platform: "xhs" as const, type: "video" as const, title: "成片", desc: "正文", topics: [], video: new File(["fixture"], "video.mp4", { type: "video/mp4" }), cover: new File(["fixture"], "cover.png", { type: "image/png" }) });
const fixture = (overrides: Record<string, unknown> = {}) => ({ getVersion: async () => ({ version: "1.2.3" }), checkPermission: async () => ({ granted: true }), login: async () => account, publish: async () => ({ success: true, workId: "work-1", loginCookie: "sensitive-fixture-cookie" }), ...overrides });

test("missing, incomplete, unverifiable and unauthorized plugins fail before account access", async () => {
  for (const [source, code] of [[null, "not_installed"], [{}, "invalid_plugin"], [fixture({ getVersion: async () => ({ version: "untrusted" }) }), "version_invalid"], [fixture({ checkPermission: async () => ({ granted: false, error: "sensitive-fixture-cookie" }) }), "not_authorized"], [fixture({ checkPermission: async () => ({ granted: true, hostAccess: false }) }), "not_authorized"]] as const) {
    await assert.rejects(inspectPublishingPlugin("xhs", source), error => (error as { code: string }).code === code && !publishingPluginMessage(error).includes("sensitive-fixture-cookie"));
  }
});

test("account projection strips credentials, unknown fields and unsafe avatar addresses", async () => {
  assert.deepEqual(projectPublishingAccount({ ...account, avatar: "https://cdn.example.com/avatar?token=secret" }, "xhs"), expected);
  const result = await inspectPublishingPlugin("xhs", fixture());
  assert.deepEqual(result.account, expected);
  assert.doesNotMatch(JSON.stringify(result), /loginCookie|sensitive-fixture-cookie|unexpected|hidden/);
  await assert.rejects(inspectPublishingPlugin("douyin", fixture()), { code: "account_unavailable" });
});

test("a false or missing execution permission never calls the plugin", async () => {
  let calls = 0;
  const runner = createPublishingPluginRunner(fixture({ publish: async () => { calls++; return { success: true }; } }));
  await assert.rejects(runner.execute({ ...permit, shouldExecute: false }, expected, params()), { code: "permit_required" });
  await assert.rejects(runner.execute({ ok: true, shouldExecute: true }, expected, params()), { code: "permit_required" });
  assert.equal(calls, 0);
});

test("a changed current browser UID stops a claimed operation before publish", async () => {
  let calls = 0;
  const runner = createPublishingPluginRunner(fixture({ login: async () => ({ ...account, uid: "other-member" }), publish: async () => { calls++; } }));
  await assert.rejects(runner.execute(permit, expected, params()), { code: "account_changed" });
  assert.equal(calls, 0);
  await assert.rejects(runner.execute(permit, expected, params()), { code: "already_started" });
});

test("a main-site session change during plugin login stops the final external publish", async () => {
  let active = true;
  let calls = 0;
  const runner = createPublishingPluginRunner(fixture({ login: async () => { active = false; return account; }, publish: async () => { calls++; return { success: true }; } }));
  await assert.rejects(runner.execute(permit, expected, params(), undefined, () => active), { code: "session_changed" });
  assert.equal(calls, 0);
  await assert.rejects(runner.execute(permit, expected, params(), undefined, () => true), { code: "already_started" });
});

test("concurrent and later retries cannot publish an accepted task twice; File objects are passed directly", async () => {
  let calls = 0;
  const input = params();
  const runner = createPublishingPluginRunner(fixture({ publish: async (value: ReturnType<typeof params>, progress: (event: unknown) => void) => {
    calls++; assert.equal(value.video, input.video); assert.equal(value.cover, input.cover);
    progress({ stage: "upload", progress: 42, message: "sensitive-fixture-cookie", data: account });
    return { success: true, workId: "work-1", platformData: account };
  } }));
  const progress: unknown[] = [];
  const first = runner.execute(permit, expected, input, event => progress.push(event));
  await assert.rejects(runner.execute(permit, expected, input), { code: "already_started" });
  assert.deepEqual(await first, { success: true, workId: "work-1" });
  assert.deepEqual(progress, [{ stage: "upload", progress: 42 }]);
  assert.equal(calls, 1);
});

test("thrown raw errors and malformed receipts remain unknown and never expose secrets", async () => {
  const runner = createPublishingPluginRunner(fixture({ publish: async () => { throw new Error("loginCookie=sensitive-fixture-cookie"); } }));
  await assert.rejects(runner.execute(permit, expected, params()), error => (error as { code: string }).code === "publish_unknown" && !String(error).includes("sensitive-fixture-cookie"));
  assert.throws(() => projectPublishingReceipt({ success: "true", loginCookie: "sensitive-fixture-cookie" }, "xhs"), { code: "invalid_receipt" });
  assert.deepEqual(projectPublishingReceipt({ success: true, workId: "work-1", shareLink: "https://evil.example.com/collect", platformData: account }, "xhs"), { success: true, workId: "work-1" });
  assert.deepEqual(projectPublishingReceipt({ success: false, failReason: "loginCookie=sensitive-fixture-cookie" }, "xhs"), { success: false });
  assert.deepEqual(projectPublishingReceipt({ success: true, shareLink: "https://www.xiaohongshu.com/explore/123" }, "xhs"), { success: true, shareLink: "https://www.xiaohongshu.com/explore/123" });
});
