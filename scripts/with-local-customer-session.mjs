#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SignJWT } from "jose";
import { parse as parseDotenv } from "dotenv";

const projectRoot = process.cwd();
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const target = process.argv[2];

assert.ok(target && target.startsWith("scripts/") && !target.includes(".."), "A workspace acceptance script is required");
process.argv.splice(2, 1);

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
const supabase = new URL(runtime.supabaseUrl);
assert.equal(supabase.origin, "http://127.0.0.1:54321", "Local acceptance database is required");

const localEnvironment = parseDotenv(await fs.readFile(path.join(projectRoot, ".env.local"), "utf8"));
// Keep the verifier and the preview on one loopback data authority. Inherited
// cloud settings can otherwise make a local browser inspect a different
// account or catalog without an obvious failure.
Object.assign(process.env, {
  COZE_SUPABASE_URL: runtime.supabaseUrl,
  COZE_SUPABASE_SERVICE_ROLE_KEY: runtime.serviceRoleKey,
  COZE_SUPABASE_ANON_KEY: runtime.anonKey,
  JWT_SECRET: runtime.jwtSecret,
  DATABASE_URL: runtime.databaseUrl,
  SHARED_CONFIGURATION_ENABLED: "1",
  SHARED_CONFIGURATION_SUPABASE_URL: runtime.supabaseUrl,
  SHARED_CONFIGURATION_SERVICE_ROLE_KEY: runtime.serviceRoleKey,
  LOCAL_ACCEPTANCE_PREVIEW: "true",
});
const originArgument = process.argv.find((argument) => argument.startsWith("--origin="));
const origin = String(
  originArgument?.slice("--origin=".length)
    || process.env.LOCAL_NAV_ORIGIN
    || "http://127.0.0.1:5000",
).replace(/\/$/u, "");
assert.ok(
  ["http://127.0.0.1:5000", "http://127.0.0.1:5002", "http://127.0.0.1:5010"].includes(origin),
  "Local acceptance origin is required",
);

const usersUrl = new URL("/rest/v1/users", supabase);
usersUrl.searchParams.set("select", "id,username,display_name,role,is_active,status,session_id");
usersUrl.searchParams.set("role", "eq.student");
usersUrl.searchParams.set("is_active", "eq.true");
usersUrl.searchParams.set("order", "updated_at.desc");
usersUrl.searchParams.set("limit", "100");

const usersResponse = await fetch(usersUrl, {
  headers: {
    apikey: runtime.serviceRoleKey,
    Authorization: `Bearer ${runtime.serviceRoleKey}`,
  },
  signal: AbortSignal.timeout(10_000),
});
const users = await usersResponse.json();
assert.ok(usersResponse.ok && Array.isArray(users), "Active local customer accounts could not be read");
const requestedUserId = String(process.env.LOCAL_ACCEPTANCE_USER_ID || "").trim();
const eligibleUsers = users.filter((user) => user?.id && user?.username
  && (user?.status == null || user.status === "active")
  && (!requestedUserId || user.id === requestedUserId));
assert.ok(eligibleUsers.length > 0, "One active local customer account is required");
const sessionsUrl = new URL("/rest/v1/user_auth_sessions", supabase);
sessionsUrl.searchParams.set("select", "user_id,session_id,created_at");
sessionsUrl.searchParams.set("user_id", `in.(${eligibleUsers.map((user) => user.id).join(",")})`);
sessionsUrl.searchParams.set("revoked_at", "is.null");
sessionsUrl.searchParams.set("expires_at", `gt.${new Date().toISOString()}`);
sessionsUrl.searchParams.set("order", "created_at.desc");
sessionsUrl.searchParams.set("limit", "100");
const sessionsResponse = await fetch(sessionsUrl, {
  headers: {
    apikey: runtime.serviceRoleKey,
    Authorization: `Bearer ${runtime.serviceRoleKey}`,
  },
  signal: AbortSignal.timeout(10_000),
});
const sessions = await sessionsResponse.json();
assert.ok(sessionsResponse.ok && Array.isArray(sessions), "Active local customer sessions could not be read");
const sessionCandidates = sessions.flatMap((session) => {
  const actor = eligibleUsers.find((user) => user.id === session?.user_id);
  const sessionId = String(session?.session_id || "").trim();
  return actor && sessionId ? [{ actor, sessionId }] : [];
});
let temporarySessionId = "";
if (sessionCandidates.length === 0) {
  const fixtureActor = eligibleUsers[0];
  temporarySessionId = `readonly-customer-${randomUUID()}`;
  const createSessionResponse = await fetch(new URL("/rest/v1/user_auth_sessions", supabase), {
    method: "POST",
    headers: {
      apikey: runtime.serviceRoleKey,
      Authorization: `Bearer ${runtime.serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: fixtureActor.id,
      session_id: temporarySessionId,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      revoked_at: null,
      revoke_reason: null,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(createSessionResponse.ok, "Temporary local customer session could not be created");
  sessionCandidates.push({ actor: fixtureActor, sessionId: temporarySessionId });
}

const secrets = [...new Set([
  process.env.JWT_SECRET,
  runtime.jwtSecret,
  localEnvironment.JWT_SECRET,
].map((value) => String(value || "").trim()).filter((value) => value.length >= 16))];
assert.ok(secrets.length > 0, "Local JWT secret is unavailable");

// Local previews can outlive a runtime switch, so select the matching key via
// a protected read-only endpoint. Never print or persist the candidate token,
// and never create a customer session only for acceptance.
let verifiedToken = "";
let actor = null;
for (const sessionCandidate of sessionCandidates) {
  for (const secret of secrets) {
    const candidate = await new SignJWT({
      userId: sessionCandidate.actor.id,
      username: sessionCandidate.actor.username,
      role: "student",
      displayName: sessionCandidate.actor.display_name || sessionCandidate.actor.username,
      sessionId: sessionCandidate.sessionId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30m")
      .sign(new TextEncoder().encode(secret));
    const identity = await fetch(`${origin}/api/media-history?limit=1&offset=0&category=all&kind=all&q=&includeTotal=true`, {
      headers: { Authorization: `Bearer ${candidate}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (identity.ok) {
      verifiedToken = candidate;
      actor = sessionCandidate.actor;
      break;
    }
  }
  if (verifiedToken) break;
}
assert.ok(verifiedToken, "Local preview customer session could not be verified");
assert.ok(actor, "Local preview customer identity could not be verified");
const readOnlyIdentity = {
  id: String(actor.id),
  username: String(actor.username),
  displayName: String(actor.display_name || actor.username),
  display_name: String(actor.display_name || actor.username),
  role: "student",
};

process.env.R267_CUSTOMER_TOKEN = verifiedToken;
process.env.LOCAL_NAV_ORIGIN = origin;
process.env.LOCAL_NAV_READONLY_CUSTOMER = JSON.stringify(readOnlyIdentity);

try {
  const targetModule = await import(pathToFileURL(path.resolve(projectRoot, target)).href);
  if (typeof targetModule.main === "function") await targetModule.main(process.argv.slice(2));
} finally {
  delete process.env.R267_CUSTOMER_TOKEN;
  delete process.env.LOCAL_NAV_ORIGIN;
  delete process.env.LOCAL_NAV_READONLY_CUSTOMER;
  if (temporarySessionId) {
    const cleanupUrl = new URL("/rest/v1/user_auth_sessions", supabase);
    cleanupUrl.searchParams.set("session_id", `eq.${temporarySessionId}`);
    const cleanupResponse = await fetch(cleanupUrl, {
      method: "DELETE",
      headers: {
        apikey: runtime.serviceRoleKey,
        Authorization: `Bearer ${runtime.serviceRoleKey}`,
        Prefer: "return=minimal",
      },
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(cleanupResponse.ok, "Temporary local customer session could not be removed");
    const cleanupCheck = await fetch(cleanupUrl, {
      headers: {
        apikey: runtime.serviceRoleKey,
        Authorization: `Bearer ${runtime.serviceRoleKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const cleanupRows = await cleanupCheck.json().catch(() => null);
    assert.ok(cleanupCheck.ok && Array.isArray(cleanupRows) && cleanupRows.length === 0, "Temporary local customer session residue detected");
  }
}
