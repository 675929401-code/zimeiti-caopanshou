import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createClientAccountScope, type ClientAccountScope } from "../src/lib/client-account-scope";
import { featurePermissionForPath, hasFeaturePermission } from "../src/lib/member-permissions";

// Execute the production components and their lexical callbacks. Transport is
// deferred entirely in RAM, intentionally ignoring AbortSignal. No app server,
// credentials, database, browser storage or payment provider is contacted.
const files = ["src/lib/client-account-scope.ts", "src/components/member-permission-boundary.tsx", "src/app/profile/page.tsx"];
const checks: string[] = [];
const auth = (id = "owner-A", token = "ram-A", verified = true) => ({ isAuthenticated: verified, token, user: { id, role: "member" } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const permission = (userId: string) => ({ userId, role: "admin", integrityValid: true, featureNavigationKeys: [] });
async function tick() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

class Hooks {
  slots: unknown[] = [];
  writes: number[] = [];
  cursor = 0;
  commits: Array<() => void> = [];
  // This lexical-callback suite models committed renders only. Real abandoned
  // transitions and StrictMode are covered by the ReactDOM companion verifier.
  useLayoutEffect = (setup: () => void | (() => void), dependencies: unknown[]) => {
    const index = this.cursor++;
    const previous = this.slots[index] as { dependencies: unknown[]; cleanup?: () => void } | undefined;
    if (previous && dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset]))) return;
    this.commits.push(() => {
      previous?.cleanup?.();
      const cleanup = setup();
      this.slots[index] = { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    });
  };
  useState = (initial: unknown) => {
    const index = this.cursor++;
    if (!(index in this.slots)) this.slots[index] = typeof initial === "function" ? initial() : initial;
    return [this.slots[index], (value: unknown) => {
      this.writes.push(index);
      this.slots[index] = typeof value === "function" ? value(this.slots[index]) : value;
    }];
  };
  useRef = (initial: unknown) => {
    const index = this.cursor++;
    if (!(index in this.slots)) this.slots[index] = { current: initial };
    return this.slots[index];
  };
}

type Element = { type: unknown; key?: string; props: Record<string, any> };
function runtime(file: string, profile = false) {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let code = source;
  if (profile) {
    const content = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ProfilePageContent") as ts.FunctionDeclaration;
    assert.ok(content?.body, "production profile component exists");
    const setters: string[] = [], values: string[] = [], callbacks: string[] = [];
    for (const statement of content.body.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const item of statement.declarationList.declarations) {
        if (ts.isArrayBindingPattern(item.name)) {
          const names = item.name.elements.map(node => node.getText(ast));
          if (names.length === 2) { values.push(names[0]); setters.push(names[1]); }
        }
        if (ts.isIdentifier(item.name) && item.initializer && (ts.isArrowFunction(item.initializer) || ts.isCallExpression(item.initializer) && item.initializer.expression.getText(ast) === "useCallback")) callbacks.push(item.name.text);
      }
    }
    const recharge: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isJsxAttribute(node) && ["onCreditsUpdated", "onCashUpdated"].includes(node.name.getText(ast))) {
        const expression = (node.initializer as ts.JsxExpression).expression!;
        recharge.push(`${node.name.getText(ast)}: ${expression.getText(ast)}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(content);
    const insertion = content.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === "tabs"))!.getStart(ast);
    code = code.slice(0, insertion) + `globalThis.profileCallbacks = {${callbacks.join(",")},${recharge.join(",")}}; globalThis.profileValues={${values.join(",")}}; globalThis.profileSetters={${setters.join(",")}};\n` + code.slice(insertion);
    code += "\nglobalThis.ProfilePageContent=ProfilePageContent;";
  }
  code = code.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "");
  let active: Hooks;
  const calls: { url: string; request: RequestInit; pending: ReturnType<typeof deferred<any>> }[] = [];
  const effects: string[] = [];
  const context: Record<string, any> = {
    exports: {}, createClientAccountScope, featurePermissionForPath, hasFeaturePermission,
    AbortController, URLSearchParams, Map, Promise, FormData, Date, Event,
    crypto: { randomUUID: () => "ram-request-id" },
    console: { error: () => effects.push("console-error") },
    createContext: () => ({ Provider: "PermissionProvider" }),
    useContext: () => context.permissionValue,
    useState: (initial: unknown) => active.useState(initial),
    useRef: (initial: unknown) => active.useRef(initial),
    useLayoutEffect: (setup: () => void | (() => void), dependencies: unknown[]) => active.useLayoutEffect(setup, dependencies),
    useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, useEffect() {},
    useApp: () => ({ state: { auth: context.auth }, dispatch: () => effects.push("dispatch"),
      checkAuth: () => { effects.push("checkAuth"); return context.checkAuthResult?.promise || Promise.resolve(); },
      fetchAgents: async () => { effects.push("fetchAgents"); } }),
    useRouter: () => ({ push: () => effects.push("route"), replace: () => effects.push("route") }),
    useSearchParams: () => new URLSearchParams(), usePathname: () => context.pathname,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    alert: () => effects.push("alert"),
    window: { dispatchEvent: () => effects.push("event"), setTimeout: () => 1, clearTimeout() {}, location: { origin: "https://ram.invalid" } },
    navigator: { clipboard: { writeText: async () => {} } },
    normalizeDisplayText: (value: unknown, fallback: string) => String(value || fallback),
    normalizeQqEmail: (value: string) => value.trim().toLowerCase(), isQqEmail: (value: string) => /^\d+@qq\.com$/u.test(value),
    USER_PROFILE_AVATAR_PRESETS: [], buildInvitationShareText: () => "RAM",
    fetch: (url: string, request: RequestInit = {}) => {
      const pending = deferred<any>(); calls.push({ url, request, pending }); return pending.promise;
    },
  };
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) context[binding.name.text] ??= binding.name.text;
  }
  const jsx = (type: unknown, props: Record<string, any>, key?: string) => ({ type, props, key });
  context.require = (name: string) => { assert.equal(name, "react/jsx-runtime", "all imports must remain blocked"); return { jsx, jsxs: jsx, Fragment: "Fragment" }; };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context, { filename: file });
  function render(name: string, hooks: Hooks, argument?: unknown): Element {
    active = hooks; hooks.cursor = 0;
    const element = (context.exports[name] || context[name])(argument);
    if (name === "MemberPermissionProvider") context.permissionValue = element.props.value;
    for (const commit of hooks.commits.splice(0)) commit();
    return element;
  }
  return { context, calls, effects, render };
}

async function permissionRace(mode: "success" | "failure" | "401" | "json-late", change: "account" | "logout" | "token" = "account") {
  const r = runtime(files[1]), hooks = new Hooks(); r.context.auth = auth();
  r.render("MemberPermissionProvider", hooks, { children: "safe" });
  const a = r.context.permissionValue.refresh();
  const lateJson = deferred<unknown>();
  if (mode === "json-late") { r.calls[0].pending.resolve({ ok: true, status: 200, json: () => lateJson.promise }); await tick(); }
  r.context.auth = change === "logout" ? auth("owner-A", "ram-A", false) : change === "token" ? auth("owner-A", "ram-rotated") : auth("owner-B", "ram-B");
  r.render("MemberPermissionProvider", hooks, { children: "safe" });
  assert.equal(r.context.permissionValue.snapshot, null, "first render must hide A snapshot");
  assert.equal(r.context.permissionValue.status, change === "logout" ? "anonymous" : "loading");
  if (change !== "logout") {
    const b = r.context.permissionValue.refresh();
    r.calls[1].pending.resolve(response({ permission: { ...permission(r.context.auth.user.id), revision: "new" } })); await b;
  }
  if (mode === "failure") r.calls[0].pending.reject(new Error("RAM failure"));
  else if (mode === "json-late") lateJson.resolve({ permission: permission("owner-A") });
  else r.calls[0].pending.resolve(response(mode === "401" ? {} : { permission: permission("owner-A") }, mode === "401" ? 401 : 200));
  await a; r.render("MemberPermissionProvider", hooks, { children: "safe" });
  assert.equal(r.context.permissionValue.status, change === "logout" ? "anonymous" : "ready");
  assert.equal(r.context.permissionValue.snapshot?.userId ?? null, change === "logout" ? null : r.context.auth.user.id);
  if (change !== "logout") assert.equal(r.context.permissionValue.snapshot.revision, "new", "same-user token rotation must also drop the old response");
  checks.push(`permission-${mode}-${change}`);
}

function profileRuntime() {
  const r = runtime(files[2], true), parent = new Hooks(), child = new Hooks(); r.context.auth = auth();
  const tree = r.render("default", parent);
  const element = tree.props.children as Element;
  const scope = element.props.scope as ClientAccountScope;
  r.render("ProfilePageContent", child, { scope });
  const rotate = (next = auth("owner-B", "ram-B")) => { r.context.auth = next; return r.render("default", parent).props.children as Element; };
  return { ...r, parent, child, scope, element, rotate };
}

async function profileLateRead(name: string, mode: "success" | "failure" | "401" = "success", change: "account" | "logout" | "token" = "account") {
  const r = profileRuntime();
  const pending = r.context.profileCallbacks[name]();
  const count = r.calls.length; assert.ok(count > 0);
  r.rotate(change === "logout" ? auth("owner-A", "ram-A", false) : change === "token" ? auth("owner-A", "ram-rotated") : undefined);
  r.child.writes.length = 0; r.effects.length = 0;
  for (const call of r.calls) {
    if (mode === "failure") call.pending.reject(new Error("RAM failure"));
    else call.pending.resolve(response({ user: { id: "owner-A" }, success: true, data: { transactions: [] }, notifications: [], codes: [], records: [], stats: {}, benefits: [] }, mode === "401" ? 401 : 200));
  }
  await pending;
  assert.equal(r.child.writes.length, 0, `${name}: no stale state write, including finally`);
  assert.equal(r.effects.length, 0, `${name}: no stale global effect`);
  assert.equal(r.calls.length, count, `${name}: no follow-up transport`);
  checks.push(`profile-${name}-${mode}-${change}`);
}

async function main() {
  for (const mode of ["success", "failure", "401", "json-late"] as const) await permissionRace(mode);
  for (const change of ["logout", "token"] as const) for (const mode of ["success", "failure", "401"] as const) await permissionRace(mode, change);
  {
    const r = runtime(files[1]), hooks = new Hooks(); r.context.auth = auth();
    r.render("MemberPermissionProvider", hooks, { children: "safe" });
    const older = r.context.permissionValue.refresh(), newer = r.context.permissionValue.refresh();
    r.calls[1].pending.resolve(response({ permission: permission("owner-A") })); await newer;
    r.calls[0].pending.resolve(response({}, 401)); await older;
    r.render("MemberPermissionProvider", hooks, { children: "safe" }); assert.equal(r.context.permissionValue.status, "ready");
    checks.push("permission-same-scope-latest-refresh-wins");
    r.context.auth = auth("owner-B", "ram-B");
    r.render("MemberPermissionProvider", hooks, { children: "safe" });
    assert.equal(r.context.permissionValue.status, "loading"); assert.equal(r.context.permissionValue.snapshot, null);
    checks.push("permission-old-ready-hidden-before-effect-on-first-frame");
    r.context.auth = auth(); r.render("MemberPermissionProvider", hooks, { children: "safe" });
    const wrong = r.context.permissionValue.refresh(); r.calls[2].pending.resolve(response({ permission: permission("owner-B") })); await wrong;
    r.render("MemberPermissionProvider", hooks, { children: "safe" }); assert.equal(r.context.permissionValue.status, "error"); assert.equal(r.context.permissionValue.snapshot, null);
    checks.push("permission-rejects-wrong-userId");
    r.context.auth = auth("owner-A", "ram-A", false);
    r.render("MemberPermissionProvider", hooks, { children: "safe" }); await r.context.permissionValue.refresh();
    assert.equal(r.calls.length, 3, "unverified cached identity cannot request permissions"); checks.push("permission-no-storage-identity-fallback");
    r.context.auth = auth("owner-B", "ram-B"); r.context.permissionValue = { status: "ready", snapshot: permission("owner-A"), error: "" }; r.context.pathname = "/cover";
    const denied = r.render("MemberFeatureBoundary", new Hooks(), { children: "private-content" });
    assert.notEqual(denied.props.children, "private-content"); checks.push("boundary-checks-current-auth-owner");
    for (const pathname of ["/commerce", "/youcai"]) { r.context.pathname = pathname; const gate = r.render("MemberFeatureBoundary", new Hooks(), { children: "private-content" }); assert.equal(gate.type, "FeatureComingSoonOverlay"); }
    checks.push("commerce-youcai-gates-preserved");
  }
  for (const name of ["loadData", "refreshAssets", "loadTransactions", "loadInvitationData", "loadUserNotifications"]) {
    for (const mode of ["success", "failure", "401"] as const) await profileLateRead(name, mode);
  }
  await profileLateRead("loadData", "success", "logout"); await profileLateRead("loadTransactions", "success", "token");
  {
    const r = profileRuntime();
    for (const field of ["setOldPassword", "setNewPassword", "setConfirmPassword", "setPhoneInput", "setEmailInput", "setEmailCode", "setCamiCode"]) r.context.profileSetters[field]("A-private-value");
    for (const field of ["setUser", "setAssets", "setTxData"]) r.context.profileSetters[field]({ id: "A-private-value" });
    for (const field of ["setTransactions", "setInviteRecords", "setUserNotifications"]) r.context.profileSetters[field]([{ id: "A-private-value" }]);
    r.context.profileSetters.setInviteCodes([{ id: "A" }]);
    const next = r.rotate(); assert.notEqual(next.key, r.element.key);
    assert.ok(!["ram-A", "ram-B"].some(value => String(next.key).includes(value)));
    r.render("ProfilePageContent", new Hooks(), { scope: next.props.scope });
    for (const field of ["user", "assets", "txData"]) assert.equal(r.context.profileValues[field], null);
    for (const field of ["transactions", "inviteCodes", "inviteRecords", "userNotifications"]) assert.equal(r.context.profileValues[field].length, 0);
    for (const field of ["oldPassword", "newPassword", "confirmPassword", "phoneInput", "emailInput", "emailCode", "camiCode"]) assert.equal(r.context.profileValues[field], "");
    assert.equal(r.context.profileValues.rechargeOpen, false);
    checks.push("profile-key-remount-clears-all-private-state-and-forms");
    const transition = r.rotate(auth("owner-B", "ram-B", false));
    assert.equal(transition.props.scope, undefined); assert.equal(transition.props.role, "status");
    checks.push("profile-unverified-transition-first-frame-hides-subtree");
    checks.push("opaque-react-key-does-not-contain-token");
  }
  for (const name of ["saveAvatarPreset", "uploadAvatar", "handleMarkUserNotificationRead", "handleRedeemCamiFromNotification", "handleCamiRedeem"]) {
    const r = profileRuntime();
    if (name === "handleCamiRedeem") { r.context.profileSetters.setCamiCode("RAM-CODE"); r.render("ProfilePageContent", r.child, { scope: r.scope }); }
    const pending = r.context.profileCallbacks[name](name === "uploadAvatar" ? { type: "image/png", size: 1 } : "ram-item");
    assert.equal(r.calls.length, 1); r.rotate(); r.child.writes.length = 0; r.effects.length = 0;
    r.calls[0].pending.resolve(response({ success: true, avatarUrl: "/ram-avatar.png" })); await pending;
    assert.equal(r.child.writes.length, 0); assert.equal(r.effects.length, 0); assert.equal(r.calls.length, 1);
    checks.push(`profile-stale-${name}-no-write-or-global-effect`);
  }
  for (const name of ["loadData", "refreshAssets", "loadTransactions", "loadInvitationData", "loadUserNotifications", "saveAvatarPreset", "handleCamiRedeem"]) {
    const r = profileRuntime(), json = deferred<unknown>();
    if (name === "handleCamiRedeem") { r.context.profileSetters.setCamiCode("RAM-CODE"); r.render("ProfilePageContent", r.child, { scope: r.scope }); }
    const pending = r.context.profileCallbacks[name](name === "saveAvatarPreset" ? "/ram-avatar.png" : undefined);
    for (let index = 0; index < r.calls.length; index++) r.calls[index].pending.resolve(index === 0 ? { ok: true, status: 200, json: () => json.promise } : response({ success: true }));
    await tick(); r.rotate(); r.child.writes.length = 0; r.effects.length = 0;
    json.resolve({ user: { id: "owner-A" }, success: true, data: { transactions: [] }, notifications: [], codes: [] }); await pending;
    assert.equal(r.child.writes.length, 0); assert.equal(r.effects.length, 0);
    checks.push(`profile-${name}-late-json-discarded`);
  }
  {
    const r = profileRuntime(), callbacks = r.context.profileCallbacks; r.rotate();
    callbacks.onCreditsUpdated(99); callbacks.onCashUpdated(88);
    assert.equal(r.effects.length, 0); assert.equal(r.calls.length, 0);
    for (const name of ["loadData", "refreshAssets", "loadTransactions", "loadInvitationData", "loadUserNotifications", "saveAvatarPreset"]) await callbacks[name]("ram-item");
    assert.equal(r.calls.length, 0); checks.push("expired-retained-callbacks-cannot-request-or-dispatch");
  }
  {
    const r = profileRuntime(); r.context.profileSetters.setCamiCode("RAM-CODE"); r.render("ProfilePageContent", r.child, { scope: r.scope });
    r.context.checkAuthResult = deferred<void>();
    const pending = r.context.profileCallbacks.handleCamiRedeem();
    r.calls[0].pending.resolve(response({ success: true })); await tick();
    assert.ok(r.effects.includes("checkAuth")); r.rotate(); r.effects.length = 0;
    r.context.checkAuthResult.resolve(); await pending;
    assert.equal(r.effects.includes("fetchAgents"), false); checks.push("scope-rechecked-after-checkAuth-before-agent-sync");
  }
  {
    const r = profileRuntime();
    for (const direction of ["recharge", "consume"]) for (const type of ["all", "credits", "cash"]) {
      r.context.profileSetters.setTxDirection(direction); r.context.profileSetters.setTxType(type); r.render("ProfilePageContent", r.child, { scope: r.scope });
      const pending = r.context.profileCallbacks.loadTransactions(3, false), call = r.calls.at(-1)!;
      const url = new URL(call.url, "https://ram.invalid"); assert.equal(url.searchParams.get("transactionType"), direction); assert.equal(url.searchParams.get("type"), type); assert.equal(url.searchParams.get("page"), "3");
      call.pending.resolve(response({ success: true, data: { transactions: [] } })); await pending;
    }
    checks.push("transaction-direction-cash-credits-and-pagination-preserved");
  }
  const output = `.codex-evidence/ui-delivery-20261101-741dc69c/account-race/lexical-${Date.now()}`;
  mkdirSync(output, { recursive: true });
  const report = { ok: true, checkCount: checks.length, checks, productionAstExecution: true, abortSignalIntentionallyIgnored: true,
    actualNetworkRequests: 0, databaseCalls: 0, paidCalls: 0, browserAcceptance: "NOT_RUN_BY_SCOPED_WORKER",
    sha256: Object.fromEntries([...files, "scripts/verify-account-scope-race-zero-network.ts"].map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])) };
  writeFileSync(`${output}/zero-network-report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
