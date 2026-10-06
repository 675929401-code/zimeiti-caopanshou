import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { createToken, getJwtSecretKey, verifyTokenSignature, type JWTPayload } from "../src/lib/auth";
import { createAdminTokenAuthorizer, type CurrentAdminUser } from "../src/lib/admin-auth";

// Contract fixtures only: no database reads/writes, upstream calls or account mutations.
const principal: JWTPayload = {
  userId: randomUUID(), username: "authorization-contract", role: "admin", displayName: "authorization-contract",
  sessionId: "session-current",
};
const baseline: CurrentAdminUser = {
  id: principal.userId, username: principal.username, email: null, role: "admin", status: "active",
  is_active: true, display_name: null, member_status: null, credits: 0, cash_balance: 0, allowed_categories: null,
  session_id: principal.sessionId || null,
};
let currentUser: CurrentAdminUser | null = { ...baseline };
let queryCount = 0;
let databaseFailure = false;
const authorize = createAdminTokenAuthorizer({
  verifySignature: verifyTokenSignature,
  async findCurrentUser() {
    queryCount++;
    if (databaseFailure) throw new Error("isolated lookup failure");
    return currentUser;
  },
});

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? routeFiles(file) : entry.name === "route.ts" ? [file] : [];
  });
}

interface SourceEvidence {
  file: string;
  source: string;
}

function resolveAliasModule(modulePath: string): string | null {
  const base = join("src", ...modulePath.split("/"));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function delegatedHandlerImports(source: string): Array<{ localName: string; file: string }> {
  const imports: Array<{ localName: string; file: string }> = [];
  const namedAliasImport = /import\s*\{([^}]*)\}\s*from\s*["']@\/([^"']+)["'];?/gu;
  for (const match of source.matchAll(namedAliasImport)) {
    const moduleFile = resolveAliasModule(match[2]);
    if (!moduleFile) continue;
    for (const rawSpecifier of match[1].split(",")) {
      const specifier = rawSpecifier.trim();
      if (!specifier || specifier.startsWith("type ")) continue;
      const [importedName, localName = importedName] = specifier.split(/\s+as\s+/u);
      if (!/^(?:create.*Handler|.*RouteHandler|withAdminAuth|authorizeAdminToken|authorizeAdminCapability|verifyAdminToken|requireCommerceAdmin)$/u.test(importedName)) continue;
      if (!new RegExp(`\\b${localName}\\s*\\(`, "u").test(source)) continue;
      imports.push({ localName, file: moduleFile });
    }
  }
  return imports;
}

function collectAuthorizationEvidence(routeFile: string): SourceEvidence[] {
  const collected: SourceEvidence[] = [];
  const queued: Array<{ file: string; depth: number }> = [{ file: routeFile, depth: 0 }];
  const seen = new Set<string>();
  while (queued.length > 0) {
    const current = queued.shift();
    if (!current || seen.has(current.file)) continue;
    seen.add(current.file);
    const source = readFileSync(current.file, "utf8");
    collected.push({ file: current.file, source });
    if (current.depth >= 3) continue;
    for (const delegated of delegatedHandlerImports(source)) {
      if (!seen.has(delegated.file)) queued.push({ file: delegated.file, depth: current.depth + 1 });
    }
  }
  return collected;
}

async function main() {
  // A per-process random key prevents fixture tokens from ever authenticating to the running site.
  process.env.JWT_SECRET = `${randomUUID()}-${randomUUID()}`;
  const token = await createToken(principal);
  let result = await authorize(token);
  assert.equal(result.ok, true, "active database administrator is allowed");
  assert.equal(queryCount, 1, "one authorization performs exactly one user lookup");

  currentUser = { ...baseline, role: "student" };
  result = await authorize(token);
  assert.equal(result.ok, false, "the same still-valid JWT loses administrator access immediately after demotion");
  if (!result.ok) assert.equal(result.status, 403);

  for (const state of [
    { is_active: false, status: "active" },
    { is_active: true, status: "blocked" },
    { is_active: true, status: "suspended" },
    { is_active: true, status: "disabled" },
    { is_active: null, status: "active" },
  ]) {
    currentUser = { ...baseline, ...state };
    result = await authorize(token);
    assert.equal(result.ok, false, "disabled or ambiguous database access must fail closed");
    if (!result.ok) assert.equal(result.status, 403);
  }

  currentUser = { ...baseline, status: null };
  assert.equal((await authorize(token)).ok, true, "legacy null status remains valid only with explicit is_active=true");
  currentUser = { ...baseline };
  currentUser = { ...baseline, session_id: "session-newer" };
  result = await authorize(token);
  assert.equal(result.ok, false, "a newer login revokes the previous JWT immediately");
  if (!result.ok) assert.equal(result.code, "SESSION_REVOKED");
  currentUser = { ...baseline };
  const staleStudentClaim = await createToken({ ...principal, role: "student" });
  assert.equal((await authorize(staleStudentClaim)).ok, true, "database role is authoritative in both directions");

  currentUser = null;
  result = await authorize(token);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 401);
  currentUser = { ...baseline, id: randomUUID() };
  assert.equal((await authorize(token)).ok, false, "mismatched database identity cannot authenticate");

  databaseFailure = true;
  result = await authorize(token);
  assert.equal(result.ok, false, "database failure cannot fall back to token.role");
  if (!result.ok) assert.equal(result.status, 503);
  databaseFailure = false;
  currentUser = { ...baseline };

  const expired = await new SignJWT({ ...principal })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(getJwtSecretKey());
  const queriesBeforeInvalidTokens = queryCount;
  for (const invalid of [expired, "invalid.token.value", "", null]) {
    result = await authorize(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 401);
  }
  assert.equal(queryCount, queriesBeforeInvalidTokens, "invalid credentials are rejected before database access");

  const routes = routeFiles("src/app/api/admin");
  const delegatedRouteEvidence: Array<{ route: string; files: string[] }> = [];
  const currentAdminGuard = /\b(?:authorizeAdminToken|authorizeAdminCapability|verifyAdminToken|withAdminAuth|requireCommerceAdmin)\b/u;
  for (const file of routes) {
    if (file.replaceAll("\\", "/").endsWith("/security-events/internal/route.ts")) continue;
    const routeSource = readFileSync(file, "utf8");
    const directGuard = currentAdminGuard.test(routeSource);
    const evidence = directGuard ? [{ file, source: routeSource }] : collectAuthorizationEvidence(file);
    const authorizationSource = evidence.map((item) => item.source).join("\n");
    assert.doesNotMatch(
      authorizationSource,
      /\b(?:verifyToken|jwtVerify)\s*\(/u,
      `${file}: raw JWT verification must not authorize administrators`,
    );
    assert.match(
      authorizationSource,
      currentAdminGuard,
      `${file}: current administrator guard required (directly or through an invoked local route handler)`,
    );
    if (!directGuard && evidence.length > 1) {
      delegatedRouteEvidence.push({ route: file, files: evidence.slice(1).map((item) => item.file) });
    }
  }
  const middleware = readFileSync("src/lib/api-middleware.ts", "utf8");
  const adminSection = middleware.slice(middleware.indexOf("export async function withAdminAuth"), middleware.indexOf("export async function withOptionalAuth"));
  assert.match(adminSection, /authorizeAdminToken/u);
  assert.doesNotMatch(adminSection, /return withAuth|\.from\("users"\)/u, "administrator wrapper must not perform a second user lookup");

  console.log(JSON.stringify({
    passed: true, checks: ["active admin", "same JWT after demotion", "session revocation", "disabled states", "missing identity", "database failure", "expired/illegal token", "no duplicate lookup", "admin route coverage"],
    adminRouteCount: routes.length, protectedUserRoutes: routes.length - 1,
    delegatedRouteEvidence,
    paidRequests: 0, databaseWrites: 0,
    evidenceLevel: "isolated signature/policy execution plus source coverage; not live HTTP E2E",
  }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "authorization regression failed"); process.exitCode = 1; });
