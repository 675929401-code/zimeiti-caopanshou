import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import type { AuthUser } from "../src/lib/api-middleware";
import { NativeHostSessionSchema } from "../src/lib/native-operations-contract";
import { isUserProfileAvatarReference, USER_PROFILE_AVATAR_PRESETS, userProfileAvatarProxyUrl } from "../src/lib/user-profile-avatar";

type Row = Record<string, unknown>;
const owner = "00000000-0000-4000-8000-000000000001";
const foreign = "00000000-0000-4000-8000-000000000002";
const user: AuthUser = { id: owner, role: "student", email: "synthetic@example.invalid" };
const context = { origin: "https://host.example", session: "fixture.session.token" };
const key = `user-profile-avatars/2026/11/10/${owner}-0123456789abcdef.webp`;
const avatar = userProfileAvatarProxyUrl(key, "local");
let readProfile: typeof import("../src/lib/server/native-profile-service").readNativeProfile;
let updateProfile: typeof import("../src/lib/server/native-profile-service").updateNativeProfile;
let readAvatar: typeof import("../src/lib/server/native-profile-service").readNativeProfileAvatar;
let createAvatarHandler: typeof import("../src/lib/server/native-profile-service").createNativeProfileAvatarHandler;
const originalFetch = globalThis.fetch;
let escapedNetwork = 0;
before(async () => {
  globalThis.fetch = async () => { escapedNetwork++; throw new Error("UNEXPECTED_NETWORK_ESCAPE"); };
  const actual = await import("../src/lib/server/native-profile-service");
  readProfile = actual.readNativeProfile; updateProfile = actual.updateNativeProfile; readAvatar = actual.readNativeProfileAvatar; createAvatarHandler = actual.createNativeProfileAvatarHandler;
});
after(() => { globalThis.fetch = originalFetch; assert.equal(escapedNetwork, 0); });
function selfFixture() {
  let name = "原昵称", id = owner, currentAvatar = avatar;
  const writes: Row[] = [], requests: NextRequest[] = [];
  const dependencies = {
    readSelf: async (request: NextRequest) => {
      requests.push(request); assert.equal(request.nextUrl.pathname, "/api/auth/me"); assert.equal(request.headers.get("cookie"), "auth_token=fixture.session.token"); assert.equal(request.headers.get("authorization"), null);
      return Response.json({ user: { id, username: "immutable-login", displayName: name, avatarUrl: currentAvatar, role: "student", credits: 900, password_hash: "MUST_NOT_ESCAPE", providerAccountId: "MUST_NOT_ESCAPE" } });
    },
    updateSelf: async (request: NextRequest) => {
      assert.equal(request.nextUrl.pathname, "/api/auth/me"); assert.equal(request.method, "PUT"); assert.equal(request.headers.get("cookie"), "auth_token=fixture.session.token");
      const payload = await request.json() as Row; writes.push(payload); assert.deepEqual(Object.keys(payload), ["display_name"]); name = String(payload.display_name);
      return Response.json({ success: true });
    },
  };
  return { dependencies, writes, requests, setOwner(value: string) { id = value; }, setAvatar(value: string) { currentAvatar = value; } };
}

test("profile reads the fixed main self handler and projects only the original safe DTO", async () => {
  const fixture = selfFixture();
  const result = await readProfile(user, context, fixture.dependencies);
  assert.deepEqual(result, { id: owner, _id: owner, name: "原昵称", avatar });
  assert(!JSON.stringify(result).includes("MUST_NOT_ESCAPE")); assert(!JSON.stringify(result).includes("immutable-login"));
  fixture.setOwner(foreign);
  await assert.rejects(readProfile(user, context, fixture.dependencies), error => (error as Row).code === "NATIVE_PROFILE_OWNER_MISMATCH");
});

test("nickname update forwards only normalized display_name to the main self handler", async () => {
  const fixture = selfFixture();
  const result = await updateProfile(user, { name: "  新昵称  ", avatar }, context, fixture.dependencies);
  assert.equal(result.name, "新昵称"); assert.equal(result.avatar, avatar);
  assert.deepEqual(fixture.writes, [{ display_name: "新昵称" }]);
});

test("profile writes reject immutable identity, contact, role, membership, password and wallet keys", async () => {
  for (const field of ["id", "username", "phone", "email", "role", "member_status", "cash_balance", "credits", "password", "password_hash", "providerAccountId"]) {
    const fixture = selfFixture();
    await assert.rejects(updateProfile(user, { name: "新昵称", [field]: "forged" }, context, fixture.dependencies), error => (error as Row).code === "NATIVE_PROFILE_INPUT_INVALID");
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.requests.length, 0);
  }
  for (const name of ["单", "x".repeat(21), "昵称\n伪造", "昵称\u202e", "昵称\u200b", "   "]) {
    const fixture = selfFixture();
    await assert.rejects(updateProfile(user, { name }, context, fixture.dependencies), error => (error as Row).code === "NATIVE_PROFILE_INPUT_INVALID");
    assert.equal(fixture.writes.length, 0);
  }
});

test("a valid avatar address shape never authorizes a foreign or stale avatar reference", async () => {
  const otherAvatar = userProfileAvatarProxyUrl(key.replace(owner, foreign), "local");
  assert.equal(isUserProfileAvatarReference(otherAvatar), true);
  for (const changed of [otherAvatar, USER_PROFILE_AVATAR_PRESETS[0].src, ""]) {
    const fixture = selfFixture();
    await assert.rejects(updateProfile(user, { name: "新昵称", avatar: changed }, context, fixture.dependencies), error => (error as Row).code === "NATIVE_PROFILE_AVATAR_CHANGED");
    assert.equal(fixture.writes.length, 0);
  }
  for (const changed of ["https://evil.example/avatar.png", "/api/native-operations/assets/10000000-0000-4000-8000-000000000001/content", "data:image/png;base64,AAAA"]) {
    const fixture = selfFixture();
    await assert.rejects(updateProfile(user, { name: "新昵称", avatar: changed }, context, fixture.dependencies), error => (error as Row).code === "NATIVE_PROFILE_AVATAR_INVALID");
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.requests.length, 0);
  }
});

test("self-handler failure and malformed success are preserved as failures", async () => {
  const fixture = selfFixture();
  await assert.rejects(updateProfile(user, { name: "新昵称" }, context, { ...fixture.dependencies, updateSelf: async () => Response.json({ error: "synthetic" }, { status: 503 }) }), error => (error as Row).status === 503);
  await assert.rejects(updateProfile(user, { name: "新昵称" }, context, { ...fixture.dependencies, updateSelf: async () => Response.json({ success: false }) }), error => (error as Row).code === "NATIVE_PROFILE_RESPONSE_INVALID");
  await assert.rejects(readProfile(user, { ...context, session: undefined }, fixture.dependencies), error => (error as Row).code === "SESSION_EXPIRED");
});

test("canonical avatar references reject encoded paths, extra query, unsupported providers and credential parameters", () => {
  assert(isUserProfileAvatarReference(avatar));
  assert(isUserProfileAvatarReference(userProfileAvatarProxyUrl(`user-profile-avatars/nested/2026/11/${owner}-0123456789abcdef.webp`, "tencent_cos")));
  assert.equal(isUserProfileAvatarReference(userProfileAvatarProxyUrl(`user-profile-avatars${owner}-0123456789abcdef.webp`, "local")), false);
  assert.equal(isUserProfileAvatarReference(userProfileAvatarProxyUrl(`user-profile-avatars2026/11/${owner}-0123456789abcdef.webp`, "local")), false);
  for (const preset of USER_PROFILE_AVATAR_PRESETS) assert(isUserProfileAvatarReference(preset.src));
  const invalid = [
    `${avatar}&w=128`, `${avatar}&token=synthetic`, `${avatar}&provider=local`, `${avatar}#fragment`, avatar.replace("provider=local", "provider=other"),
    avatar.replace("user-profile-avatars", "other-avatars"), avatar.replace("%2F2026", "%2F..%2F2026"), avatar.replace("%2F2026", "%252F2026"),
    avatar.replace("%2F2026", "/2026"), "/api/avatars?key=user-profile-avatars%2Fsecret.svg&provider=local", "//evil.example/api/avatars?key=a",
    "/avatars/profile-generated/profile-avatar-99.webp", "https://host.example" + avatar,
  ];
  for (const value of invalid) assert.equal(isUserProfileAvatarReference(value), false, value);
  assert(NativeHostSessionSchema.shape.user.shape.avatarUrl.safeParse(avatar).success);
  assert(!NativeHostSessionSchema.shape.user.shape.avatarUrl.safeParse(`${avatar}&token=synthetic`).success);
});

function avatarDatabase(row: Row | null, error: Row | null = null) {
  let ownerFilter: unknown;
  const db = { from(table: string) { assert.equal(table, "user_profile_avatars"); const query = {
    select: (columns: string) => { assert.equal(columns, "user_id,avatar_url,storage_provider,storage_key,source"); return query; },
    eq: (field: string, value: unknown) => { assert.equal(field, "user_id"); ownerFilter = value; return query; },
    maybeSingle: async () => { assert.equal(ownerFilter, owner); return { data: row, error }; },
  }; return query; } };
  return db as never;
}
test("host session avatar read verifies the owner table and canonicalizes controlled storage", async () => {
  assert.equal(await readAvatar(avatarDatabase({ user_id: owner, source: "upload", storage_key: key, storage_provider: "local", avatar_url: "ignored" }), user), avatar);
  assert.equal(await readAvatar(avatarDatabase({ user_id: owner, source: "preset", avatar_url: USER_PROFILE_AVATAR_PRESETS[0].src }), user), USER_PROFILE_AVATAR_PRESETS[0].src);
  assert.equal(await readAvatar(avatarDatabase(null, { code: "42P01" }), user), "");
  assert.equal(await readAvatar(avatarDatabase({ user_id: owner, source: "upload", storage_key: "other/path.webp", storage_provider: "local" }), user), "");
  await assert.rejects(readAvatar(avatarDatabase({ user_id: foreign }), user), error => (error as Row).code === "NATIVE_PROFILE_OWNER_MISMATCH");
  await assert.rejects(readAvatar(avatarDatabase(null, { code: "XX000" }), user), error => (error as Row).status === 503);
});

test("legacy avatar reads require exact owner, provider, historical key and saved URL without guessing a replacement key", async () => {
  for (const [provider, legacyKey] of [["tencent_cos", `user-profile-avatars2026/11/10/${owner}-0123456789abcdef.webp`], ["coze_s3", `user-profile-avatars${owner}-0123456789abcdef.webp`]]) {
    const legacyUrl = userProfileAvatarProxyUrl(legacyKey, provider as "tencent_cos" | "coze_s3");
    const saved = { user_id: owner, source: "upload", storage_key: legacyKey, storage_provider: provider, avatar_url: legacyUrl };
    assert.equal(await readAvatar(avatarDatabase(saved), user), legacyUrl);
    assert.equal(await readAvatar(avatarDatabase({ ...saved, avatar_url: "" }), user), "");
    assert.equal(await readAvatar(avatarDatabase({ ...saved, storage_key: legacyKey.replace(owner, foreign) }), user), "");
    assert.equal(await readAvatar(avatarDatabase({ ...saved, storage_provider: "local" }), user), "");
    const fixture = selfFixture(); fixture.setAvatar(legacyUrl);
    assert.equal((await readProfile(user, context, fixture.dependencies)).avatar, legacyUrl);
    fixture.setAvatar(legacyUrl.replace(owner, foreign));
    assert.equal((await readProfile(user, context, fixture.dependencies)).avatar, "");
  }
});

function uploadRequest(extra: Record<string, string> = {}) {
  const body = new FormData(); body.set("file", new File([new Uint8Array([1, 2, 3])], "synthetic.png", { type: "image/png" }));
  return new NextRequest("https://host.example/api/native-operations/profile-avatar", { method: "POST", headers: {
    host: "host.example", origin: "https://host.example", cookie: "auth_token=fixture.session.token; native_host_csrf=csrf-fixture", "x-native-actor-id": owner, "x-native-csrf": "csrf-fixture", ...extra,
  }, body });
}
function avatarFixture() {
  let calls = 0, csrfValid = true, saved = () => Response.json({ success: true, avatarUrl: avatar, providerAccountId: "MUST_NOT_ESCAPE" });
  const handler = createAvatarHandler({
    authenticate: async (_request, run) => run(user, {} as never), access: async () => ({ revision: 4, checksum: "fixture-checksum" }),
    csrf: async (actor, session, header, cookie, binding) => { assert.equal(actor, owner); assert.equal(session, context.session); assert.equal(header, "csrf-fixture"); assert.equal(cookie, "csrf-fixture"); assert.equal(binding, "student:4:fixture-checksum"); return csrfValid; },
    upload: async request => { calls++; const form = await request.formData(); assert.equal((form.get("file") as File).name, "synthetic.png"); return saved(); },
    preset: async request => { calls++; assert.equal(request.nextUrl.pathname, "/api/auth/avatar"); const value = await request.json(); assert.deepEqual(Object.keys(value), ["presetUrl"]); return Response.json({ success: true, avatarUrl: value.presetUrl }); },
  });
  return { handler, calls: () => calls, rejectCsrf() { csrfValid = false; }, setResponse(value: () => Response) { saved = value; } };
}
test("avatar BFF forwards the actual file to the fixed main handler and returns only the saved safe reference", async () => {
  const fixture = avatarFixture(); const response = await fixture.handler(uploadRequest());
  assert.equal(response.status, 200); assert.equal(fixture.calls(), 1);
  assert.deepEqual(await response.json(), { code: 0, data: { avatarUrl: avatar }, message: "" });
  assert(response.headers.get("cache-control")?.includes("no-store"));
});

test("avatar BFF rejects missing cookie, bearer override, actor change, cross origin and CSRF before main upload", async () => {
  for (const [headers, status] of [
    [{ cookie: "" }, 401], [{ authorization: "Bearer forged" }, 401], [{ "x-native-actor-id": foreign }, 409], [{ origin: "https://evil.example" }, 403], [{ "sec-fetch-site": "cross-site" }, 403],
  ] as const) {
    const fixture = avatarFixture(); assert.equal((await fixture.handler(uploadRequest(headers))).status, status); assert.equal(fixture.calls(), 0);
  }
  const fixture = avatarFixture(); fixture.rejectCsrf(); assert.equal((await fixture.handler(uploadRequest())).status, 403); assert.equal(fixture.calls(), 0);
});

test("avatar BFF preserves main upload failure and rejects an untrusted success reference", async () => {
  const fixture = avatarFixture(); fixture.setResponse(() => Response.json({ error: "头像仅支持PNG、JPEG或WebP", code: "INTERNAL_SYNTHETIC" }, { status: 415 }));
  const rejected = await fixture.handler(uploadRequest()); assert.equal(rejected.status, 415); assert.equal((await rejected.json()).code, "NATIVE_PROFILE_AVATAR_FAILED");
  fixture.setResponse(() => Response.json({ success: true, avatarUrl: "https://evil.example/avatar.png" }));
  assert.equal((await fixture.handler(uploadRequest())).status, 503);
});

test("preset BFF accepts only the existing main-site preset closed set", async () => {
  for (const [value, expected] of [[{ presetUrl: USER_PROFILE_AVATAR_PRESETS[0].src }, 200], [{ presetUrl: avatar }, 400], [{ presetUrl: USER_PROFILE_AVATAR_PRESETS[0].src, userId: foreign }, 400]] as const) {
    const fixture = avatarFixture();
    const request = new NextRequest("https://host.example/api/native-operations/profile-avatar", { method: "PUT", headers: { host: "host.example", origin: "https://host.example", cookie: "auth_token=fixture.session.token; native_host_csrf=csrf-fixture", "x-native-actor-id": owner, "x-native-csrf": "csrf-fixture", "content-type": "application/json" }, body: JSON.stringify(value) });
    assert.equal((await fixture.handler(request)).status, expected); assert.equal(fixture.calls(), expected === 200 ? 1 : 0);
  }
});
