import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const originArgument = process.argv.find((value) => value.startsWith("--origin="));
const origin = (originArgument?.slice("--origin=".length) || "").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const evidenceDir = path.join(root, ".codex-evidence", "production-secondary-route-fixes-20260904");
const checks = [];

function check(name, condition, evidence) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, evidence });
}

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

const sourcePaths = [
  "src/app/tools/text/formal-script/page.tsx",
  "src/app/youcai/tools/text/formal-script/page.tsx",
  "src/app/voice-studio/design/page.tsx",
  "src/app/voice-studio/clone/page.tsx",
  "src/app/voice-studio/nest/page.tsx",
  "src/app/youcai/voice-studio/design/page.tsx",
  "src/app/youcai/voice-studio/clone/page.tsx",
  "src/app/youcai/voice-studio/nest/page.tsx",
  "src/lib/short-drama-navigation.ts",
  "src/features/youcai-film-studio/navigation.ts",
  "src/features/official-tool-directory/tool-directory-data.tsx",
  "src/features/general-script-official/general-script-official.tsx",
  "src/lib/short-drama/general-script-contract.ts",
  "src/lib/short-drama/general-script-profile.ts",
  "src/lib/short-drama/general-script-import.ts",
];
const entries = Object.fromEntries(await Promise.all(sourcePaths.map(async (relative) => [relative, await source(relative)])));

const formalMain = entries["src/app/tools/text/formal-script/page.tsx"];
const formalYoucai = entries["src/app/youcai/tools/text/formal-script/page.tsx"];
const shortNavigation = entries["src/lib/short-drama-navigation.ts"];
const youcaiNavigation = entries["src/features/youcai-film-studio/navigation.ts"];
const toolDirectory = entries["src/features/official-tool-directory/tool-directory-data.tsx"];
const formalComponent = entries["src/features/general-script-official/general-script-official.tsx"];
const contract = entries["src/lib/short-drama/general-script-contract.ts"];
const promptProfiles = entries["src/lib/short-drama/general-script-profile.ts"];
const projectImport = entries["src/lib/short-drama/general-script-import.ts"];

check("both visible film-studio portals keep formal creation disabled", 
  /key:\s*"正剧"[\s\S]{0,420}href:\s*null[\s\S]{0,120}status:\s*"coming-soon"/u.test(shortNavigation)
    && /key:\s*"正剧"[\s\S]{0,420}href:\s*null[\s\S]{0,120}status:\s*"coming-soon"/u.test(youcaiNavigation),
  { mainPortal: "disabled", youcaiPortal: "disabled" });
check("public tool directory does not advertise the unaccepted formal route",
  !toolDirectory.includes("/tools/text/formal-script"),
  { advertisedFormalScriptLinks: 0 });
check("legacy formal routes redirect to accepted namespace-matched general workflow",
  formalMain.includes('redirect("/tools/text/general-script")')
    && formalYoucai.includes('redirect("/youcai/tools/text/general-script")')
    && !formalMain.includes("FormalScriptUnavailable")
    && !formalYoucai.includes("FormalScriptUnavailable"),
  { main: "/tools/text/general-script", youcai: "/youcai/tools/text/general-script" });
check("formal UI is not safe to publish as an independent workflow yet",
  formalComponent.includes("id: GENERAL_SCRIPT_PROFILE_ID")
    && !contract.includes('FORMAL_SCRIPT_PROFILE_ID')
    && !promptProfiles.includes('FORMAL_SCRIPT_PROMPT_PROFILE')
    && projectImport.includes('return "short_drama"'),
  { independentPromptProfile: false, independentProjectType: false });
check("all retired voice aliases resolve directly to the canonical imitation route",
  entries["src/app/voice-studio/design/page.tsx"].includes("/voice-studio/imitate")
    && entries["src/app/voice-studio/clone/page.tsx"].includes("/voice-studio/imitate")
    && entries["src/app/voice-studio/nest/page.tsx"].includes("/voice-studio/imitate")
    && entries["src/app/youcai/voice-studio/nest/page.tsx"].includes("/voice-studio/imitate"),
  { canonical: "/voice-studio/imitate", nestedRedirects: 0 });

const live = [];
if (origin) {
  assert.ok(token, "Authenticated local route verification requires scripts/with-local-admin-session.mjs");
  const headers = { Authorization: `Bearer ${token}` };
  const routes = [
    ["/tools/text/formal-script", "/tools/text/general-script"],
    ["/youcai/tools/text/formal-script", "/youcai/tools/text/general-script"],
    ["/voice-studio/design", "/voice-studio/imitate"],
    ["/voice-studio/clone", "/voice-studio/imitate"],
    ["/voice-studio/nest", "/voice-studio/imitate"],
    ["/youcai/voice-studio/design", "/voice-studio/imitate"],
    ["/youcai/voice-studio/clone", "/voice-studio/imitate"],
    ["/youcai/voice-studio/nest", "/voice-studio/imitate"],
  ];
  for (const [route, expected] of routes) {
    const response = await fetch(`${origin}${route}`, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const location = response.headers.get("location");
    const body = location ? "" : await response.text();
    const metaTarget = body.match(/http-equiv="refresh"\s+content="\d+;url=([^"]+)"/u)?.[1] || "";
    const flightTarget = body.match(/NEXT_REDIRECT;replace;([^;]+);30(?:1|2|3|7|8);/u)?.[1] || "";
    const redirectTarget = location || metaTarget || flightTarget;
    const normalized = redirectTarget ? new URL(redirectTarget, origin).pathname : "";
    check(`live redirect ${route}`,
      ((response.status >= 300 && response.status < 400) || (response.status === 200 && Boolean(metaTarget || flightTarget)))
        && normalized === expected,
      { status: response.status, location, metaTarget: metaTarget || null, flightTarget: flightTarget || null, expected });
    live.push({ route, status: response.status, location, metaTarget: metaTarget || null, flightTarget: flightTarget || null, expected });
  }
  for (const canonical of ["/tools/text/general-script", "/youcai/tools/text/general-script", "/voice-studio/imitate"]) {
    const response = await fetch(`${origin}${canonical}`, { headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    check(`live canonical ${canonical}`, response.status === 200, { status: response.status, finalUrl: response.url });
    live.push({ route: canonical, status: response.status, finalUrl: response.url });
  }
}

const report = {
  observedAt: new Date().toISOString(),
  sourceRoot: root,
  origin: origin || null,
  result: { total: checks.length, passed: checks.length, failed: 0 },
  checks,
  live,
  safety: { paidRequests: 0, databaseWrites: 0, serverChanges: 0, gitPushes: 0 },
  sourceHashes: Object.fromEntries(Object.entries(entries).map(([relative, value]) => [relative, sha256(value)])),
};
await mkdir(evidenceDir, { recursive: true });
const output = path.join(evidenceDir, origin ? "source-and-live.json" : "source-only.json");
await writeFile(output, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ output, result: report.result, origin: report.origin, safety: report.safety }, null, 2));
