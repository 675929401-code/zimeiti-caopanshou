#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertJsonSchema, canonicalJson, sha256 } from "./lib/json-schema-contract.mjs";

const LEVEL_RANK = Object.freeze({ FAST: 0, STANDARD: 1, FULL: 2 });
const RECEIPT_SCHEMA_VERSION = "zimeiti-release-change-scope-receipt.v1";
const POLICY_SCHEMA_VERSION = "zimeiti-release-change-scope-policy.v1";

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error("ARGUMENT_NAME_REQUIRED");
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed.set(token, next);
      index += 1;
    } else {
      parsed.set(token, "1");
    }
  }
  return parsed;
}

function readJson(filePath, errorCode) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(errorCode);
  }
}

function assertPolicy(policy) {
  if (policy?.schemaVersion !== POLICY_SCHEMA_VERSION) throw new Error("POLICY_SCHEMA_VERSION_INVALID");
  if (!policy.policyId || !Array.isArray(policy.pathRules) || !Array.isArray(policy.contentRiskRules)) {
    throw new Error("POLICY_SHAPE_INVALID");
  }
  for (const rule of [...policy.pathRules, ...policy.contentRiskRules]) {
    if (!rule.id || !(rule.level in LEVEL_RANK) || !Array.isArray(rule.patterns) || rule.patterns.length === 0) {
      throw new Error("POLICY_RULE_INVALID");
    }
    for (const pattern of rule.patterns) new RegExp(pattern, "iu");
  }
  for (const level of ["all", "FAST", "STANDARD", "FULL"]) {
    if (!Array.isArray(policy.requiredValidations?.[level])) throw new Error("POLICY_VALIDATIONS_INVALID");
  }
  if (!Array.isArray(policy.fastTargetedRegressionRules)) throw new Error("POLICY_FAST_REGRESSIONS_INVALID");
  for (const rule of policy.fastTargetedRegressionRules) {
    if (!rule.id || !Array.isArray(rule.patterns) || rule.patterns.length === 0
      || !rule.command || typeof rule.command.executable !== "string" || !Array.isArray(rule.command.args)) {
      throw new Error("POLICY_FAST_REGRESSION_RULE_INVALID");
    }
    for (const pattern of rule.patterns) new RegExp(pattern, "iu");
  }
  const browser = policy.browserAcceptance;
  if (!browser || !Number.isInteger(browser.minimumDistinctRoutes) || browser.minimumDistinctRoutes < 3
    || !Array.isArray(browser.defaultRoutes) || !Array.isArray(browser.blockedUnlessPolicyMappedPatterns)
    || !Array.isArray(browser.defaultRouteEligiblePatterns)
    || !Array.isArray(browser.routeRules)) throw new Error("POLICY_BROWSER_ACCEPTANCE_INVALID");
  for (const pattern of [...browser.blockedUnlessPolicyMappedPatterns, ...browser.defaultRouteEligiblePatterns]) new RegExp(pattern, "iu");
  for (const rule of browser.routeRules) {
    if (!rule.id || !Array.isArray(rule.patterns) || !Array.isArray(rule.routes)) throw new Error("POLICY_BROWSER_ROUTE_RULE_INVALID");
    for (const pattern of rule.patterns) new RegExp(pattern, "iu");
  }
  if (!policy.browserAcceptanceTrust?.path || !/^[a-f0-9]{64}$/u.test(policy.browserAcceptanceTrust.sha256 || "")
    || !policy.browserAcceptanceTrust.trustRootId) throw new Error("POLICY_BROWSER_TRUST_PIN_INVALID");
}

function normalizeRepoPath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  if (/[\\\u0000-\u001f\u007f]|\p{Bidi_Control}/u.test(candidate)) return null;
  if (candidate.startsWith("/") || /^[A-Za-z]:\//u.test(candidate)) return null;
  const parts = candidate.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  if (path.posix.normalize(candidate) !== candidate) return null;
  return candidate;
}

function git(root, argumentsList, options = {}) {
  return execFileSync("git", ["-C", root, ...argumentsList], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function resolveCommit(root, revision) {
  if (!revision || revision.startsWith("-")) throw new Error("GIT_REVISION_INVALID");
  try {
    return git(root, ["rev-parse", "--verify", `${revision}^{commit}`]).trim().toLowerCase();
  } catch {
    throw new Error("GIT_REVISION_UNRESOLVED");
  }
}

function parseNameStatus(raw) {
  const tokens = raw.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes = [];
  for (let index = 0; index < tokens.length; ) {
    const rawStatus = tokens[index++];
    const status = rawStatus?.slice(0, 1).toUpperCase() || "?";
    if (status === "R" || status === "C") {
      const previousPath = tokens[index++];
      const currentPath = tokens[index++];
      if (previousPath === undefined || currentPath === undefined) throw new Error("GIT_NAME_STATUS_TRUNCATED");
      changes.push({ status: rawStatus, previousPath, path: currentPath });
    } else {
      const currentPath = tokens[index++];
      if (currentPath === undefined) throw new Error("GIT_NAME_STATUS_TRUNCATED");
      changes.push({ status: rawStatus, previousPath: null, path: currentPath });
    }
  }
  return changes;
}

function changedLineText(patch) {
  return patch
    .split(/\r?\n/u)
    .filter((line) => (/^[+-]/u.test(line) && !/^\+\+\+|^---/u.test(line)))
    .map((line) => line.slice(1))
    .join("\n");
}

function loadGitRangeChanges(root, baseArgument, headArgument, rangeMode = "merge-base", trustedBase = true) {
  const base = resolveCommit(root, baseArgument);
  const head = resolveCommit(root, headArgument);
  if (!new Set(["merge-base", "direct"]).has(rangeMode)) throw new Error("GIT_RANGE_MODE_INVALID");
  try {
    git(root, ["merge-base", "--is-ancestor", base, head]);
  } catch {
    throw new Error("GIT_BASE_NOT_ANCESTOR");
  }
  const range = rangeMode === "direct" ? `${base}..${head}` : `${base}...${head}`;
  let changes;
  try {
    changes = parseNameStatus(git(root, ["diff", "--name-status", "-z", "--find-renames", range, "--"]));
  } catch {
    throw new Error("GIT_DIFF_INSPECTION_FAILED");
  }
  return {
    kind: "git-range",
    base,
    head,
    rangeMode,
    trustedBase,
    changes: changes.map((change) => {
      const normalizedPath = normalizeRepoPath(change.path);
      let content = "";
      if (normalizedPath && ["A", "M"].includes(change.status.slice(0, 1).toUpperCase())) {
        try {
          content = changedLineText(
            git(root, ["diff", "--no-ext-diff", "--unified=0", range, "--", normalizedPath]),
          );
        } catch {
          return { ...change, content: "", inspectionFailed: true };
        }
      }
      return { ...change, content, inspectionFailed: false };
    }),
  };
}

function loadFixtureChanges(filePath) {
  const fixture = readJson(filePath, "CHANGES_FIXTURE_INVALID");
  const changes = Array.isArray(fixture) ? fixture : fixture?.changes;
  if (!Array.isArray(changes)) throw new Error("CHANGES_FIXTURE_SHAPE_INVALID");
  return {
    kind: "fixture",
    base: null,
    head: null,
    rangeMode: null,
    trustedBase: false,
    changes: changes.map((change) => ({
      status: typeof change?.status === "string" ? change.status : "?",
      path: change?.path,
      previousPath: change?.previousPath ?? null,
      content: typeof change?.content === "string" ? change.content : "",
      inspectionFailed: change?.inspectionFailed === true,
    })),
  };
}

function matchesRule(value, rule) {
  return rule.patterns.some((pattern) => new RegExp(pattern, "iu").test(value));
}

function classifyPath(policy, repoPath) {
  const matches = policy.pathRules.filter((rule) => matchesRule(repoPath, rule));
  if (matches.length === 0) {
    return { level: "FULL", ruleIds: [], conflict: false, unknown: true };
  }
  const highestPrecedence = Math.max(...matches.map((rule) => Number(rule.precedence) || 0));
  const winningRules = matches.filter((rule) => (Number(rule.precedence) || 0) === highestPrecedence);
  const winningLevels = new Set(winningRules.map((rule) => rule.level));
  if (winningLevels.size > 1) {
    return {
      level: "FULL",
      ruleIds: winningRules.map((rule) => rule.id).sort(),
      conflict: true,
      unknown: false,
    };
  }
  return {
    level: winningRules[0].level,
    ruleIds: winningRules.map((rule) => rule.id).sort(),
    conflict: false,
    unknown: false,
  };
}

function targetedRegressionIds(policy, repoPath) {
  return (policy.fastTargetedRegressionRules || [])
    .filter((rule) => matchesRule(repoPath, rule))
    .map((rule) => rule.id)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeRoute(candidate) {
  if (typeof candidate !== "string" || !/^\/[A-Za-z0-9_./?=&%-]*$/u.test(candidate)
    || /[\u0000-\u001f\u007f]|\p{Bidi_Control}/u.test(candidate)) return null;
  return candidate;
}

function parseAcceptanceRoutes(value) {
  if (value === undefined || value === null || value === "") return [];
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { throw new Error("ACCEPTANCE_ROUTES_JSON_INVALID"); }
  if (!Array.isArray(parsed)) throw new Error("ACCEPTANCE_ROUTES_JSON_INVALID");
  const routes = parsed.map(normalizeRoute);
  if (routes.some((route) => !route) || new Set(routes).size !== routes.length) throw new Error("ACCEPTANCE_ROUTES_INVALID");
  return routes;
}

function derivePageRoute(repoPath) {
  const match = /^(?:src|voice-platform\/src)\/app\/(.+)\/page\.(?:ts|tsx|js|jsx)$/u.exec(repoPath);
  if (!match || match[1].split("/").some((part) => /^\(.*\)$|^\[.*\]$/u.test(part))) return null;
  return normalizeRoute(`/${match[1]}`);
}

function browserAcceptanceForChanges(policy, changes, explicitRoutes) {
  const browser = policy.browserAcceptance;
  const mappedRoutes = new Set();
  const routeRuleIds = new Set();
  const unresolvedPaths = new Set();
  let preciseRoute = null;
  for (const change of changes) {
    const repoPath = normalizeRepoPath(change.path);
    if (!repoPath) {
      unresolvedPaths.add("<unsafe-path>");
      continue;
    }
    let mapped = false;
    for (const rule of browser.routeRules) {
      if (matchesRule(repoPath, rule)) {
        mapped = true;
        routeRuleIds.add(rule.id);
        for (const route of rule.routes) mappedRoutes.add(route);
        preciseRoute ||= rule.routes[0] || null;
      }
    }
    const derived = derivePageRoute(repoPath);
    if (derived) {
      mapped = true;
      routeRuleIds.add("derived-static-page-route");
      mappedRoutes.add(derived);
      preciseRoute ||= derived;
    }
    const isDynamicPage = /^(?:src|voice-platform\/src)\/app\/.+\/page\.(?:ts|tsx|js|jsx)$/u.test(repoPath) && !derived;
    const policyBlocked = browser.blockedUnlessPolicyMappedPatterns.some((pattern) => new RegExp(pattern, "iu").test(repoPath));
    const defaultEligible = browser.defaultRouteEligiblePatterns.some((pattern) => new RegExp(pattern, "iu").test(repoPath));
    if (!mapped && (isDynamicPage || policyBlocked || !defaultEligible)) unresolvedPaths.add(repoPath);
  }
  if (mappedRoutes.size === 0 && unresolvedPaths.size === 0) {
    routeRuleIds.add("reviewed-default-desktop-smoke");
    for (const route of browser.defaultRoutes) mappedRoutes.add(route);
    preciseRoute = browser.defaultRoutes[0];
  }
  while (mappedRoutes.size < browser.minimumDistinctRoutes) {
    const next = browser.defaultRoutes.find((route) => !mappedRoutes.has(route));
    if (!next) break;
    mappedRoutes.add(next);
  }
  const requiredRoutes = [...mappedRoutes].sort((left, right) => left.localeCompare(right));
  const callerRoutesAccepted = explicitRoutes.length === 0
    || canonicalJson([...explicitRoutes].sort((left, right) => left.localeCompare(right))) === canonicalJson(requiredRoutes);
  if (!callerRoutesAccepted) unresolvedPaths.add("<caller-routes-not-policy-approved>");
  const explicitRoutesRequired = unresolvedPaths.size > 0;
  return {
    preciseRoute: preciseRoute || [...mappedRoutes][0],
    requiredRoutes,
    routeRuleIds: [...routeRuleIds].sort((left, right) => left.localeCompare(right)),
    explicitRoutesRequired,
    explicitRoutesProvided: explicitRoutes.length > 0 && callerRoutesAccepted,
    unresolvedPaths: [...unresolvedPaths].sort((left, right) => left.localeCompare(right)),
  };
}

function classifyChanges(policy, loaded, forcedFull, minimumLevel = "FAST", explicitRoutes = []) {
  const reasons = [];
  let failClosed = false;
  const changedFiles = [];

  if (forcedFull) {
    failClosed = true;
    reasons.push({ code: "FORCED_FULL_NO_TRUSTED_BASE", level: "FULL", path: null, ruleId: "forced-full" });
  }
  if (minimumLevel === "FULL" && !forcedFull) {
    failClosed = true;
    reasons.push({ code: "UNTRUSTED_RELEASE_BASE", level: "FULL", path: null, ruleId: "minimum-full" });
  }

  for (const rawChange of loaded.changes) {
    const status = String(rawChange.status || "?").slice(0, 1).toUpperCase();
    const repoPath = normalizeRepoPath(rawChange.path);
    const previousPath = rawChange.previousPath === null ? null : normalizeRepoPath(rawChange.previousPath);
    if (!repoPath || (rawChange.previousPath !== null && !previousPath)) {
      failClosed = true;
      changedFiles.push({
        status,
        path: "<unsafe-path>",
        previousPath: null,
        pathLevel: "FULL",
        pathRuleIds: [],
        contentRiskIds: [],
        targetedRegressionIds: [],
      });
      reasons.push({ code: "UNSAFE_OR_INVALID_PATH", level: "FULL", path: "<unsafe-path>", ruleId: null });
      continue;
    }

    const pathResult = classifyPath(policy, repoPath);
    const matchedContentRules = policy.contentRiskRules
      .filter((rule) => matchesRule(rawChange.content || "", rule));
    const contentRiskIds = matchedContentRules.map((rule) => rule.id).sort();
    let regressionIds = [];
    let pathLevel = pathResult.level;

    if (!policy.acceptedChangeStatuses.includes(status)) {
      pathLevel = "FULL";
      failClosed = true;
      reasons.push({ code: "NON_ADDITIVE_OR_UNKNOWN_STATUS", level: "FULL", path: repoPath, ruleId: null });
    }
    if (rawChange.inspectionFailed) {
      pathLevel = "FULL";
      failClosed = true;
      reasons.push({ code: "CONTENT_INSPECTION_FAILED", level: "FULL", path: repoPath, ruleId: null });
    }
    if (pathResult.unknown) {
      failClosed = true;
      reasons.push({ code: "UNKNOWN_PATH_CLASSIFICATION", level: "FULL", path: repoPath, ruleId: null });
    } else if (pathResult.conflict) {
      failClosed = true;
      reasons.push({ code: "PATH_CLASSIFICATION_CONFLICT", level: "FULL", path: repoPath, ruleId: null });
    } else {
      reasons.push({
        code: "PATH_RULE_MATCH",
        level: pathResult.level,
        path: repoPath,
        ruleId: pathResult.ruleIds.join("+") || null,
      });
    }
    for (const riskRule of matchedContentRules) {
      if (LEVEL_RANK[riskRule.level] > LEVEL_RANK[pathLevel]) pathLevel = riskRule.level;
      reasons.push({ code: "CONTENT_RISK_MATCH", level: riskRule.level, path: repoPath, ruleId: riskRule.id });
    }
    if (pathLevel === "FAST") {
      regressionIds = targetedRegressionIds(policy, repoPath);
      if (regressionIds.length === 0) {
        pathLevel = "STANDARD";
        reasons.push({
          code: "FAST_TARGETED_REGRESSION_UNMAPPED",
          level: "STANDARD",
          path: repoPath,
          ruleId: null,
        });
      } else {
        reasons.push({
          code: "FAST_TARGETED_REGRESSION_MAPPED",
          level: "FAST",
          path: repoPath,
          ruleId: regressionIds.join("+"),
        });
      }
    }

    changedFiles.push({
      status,
      path: repoPath,
      previousPath,
      pathLevel,
      pathRuleIds: pathResult.ruleIds,
      contentRiskIds,
      targetedRegressionIds: regressionIds,
    });
  }

  if (loaded.changes.length === 0) {
    failClosed = true;
    reasons.push({ code: "EMPTY_CHANGE_SET", level: "FULL", path: null, ruleId: null });
  }

  const browserAcceptance = browserAcceptanceForChanges(policy, loaded.changes, explicitRoutes);
  if (browserAcceptance.explicitRoutesRequired) {
    failClosed = true;
    reasons.push({ code: "BROWSER_ACCEPTANCE_ROUTES_UNRESOLVED", level: "FULL", path: null, ruleId: null });
  }

  changedFiles.sort((left, right) => `${left.path}\0${left.status}`.localeCompare(`${right.path}\0${right.status}`));
  reasons.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const levels = [
    forcedFull || loaded.changes.length === 0 || minimumLevel === "FULL"
      || browserAcceptance.explicitRoutesRequired ? "FULL" : "FAST",
    ...changedFiles.map((file) => file.pathLevel),
  ];
  const classification = levels.reduce((highest, level) =>
    LEVEL_RANK[level] > LEVEL_RANK[highest] ? level : highest,
  "FAST");

  return { classification, failClosed, reasons, changedFiles, browserAcceptance };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertSameArray(actual, expected, code) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(code);
}

function assertReceiptSemantic(receipt, policy, rawPolicy, root) {
  if (receipt.policy.id !== policy.policyId || receipt.policy.schemaVersion !== policy.schemaVersion) {
    throw new Error("RECEIPT_POLICY_IDENTITY_MISMATCH");
  }
  if (receipt.policy.sha256 !== sha256(rawPolicy)) throw new Error("RECEIPT_POLICY_SHA256_MISMATCH");

  const input = receipt.input;
  const commitPattern = /^[0-9a-f]{40,64}$/u;
  if (input.kind === "git-range") {
    if (!commitPattern.test(input.base || "") || !commitPattern.test(input.head || "")) {
      throw new Error("RECEIPT_GIT_RANGE_IDENTITY_INVALID");
    }
    if (!new Set(["merge-base", "direct"]).has(input.rangeMode)) throw new Error("RECEIPT_GIT_RANGE_MODE_INVALID");
    if (typeof input.trustedBase !== "boolean") throw new Error("RECEIPT_TRUSTED_BASE_INVALID");
    if (!new Set(["FAST", "FULL"]).has(input.minimumLevel)) throw new Error("RECEIPT_MINIMUM_LEVEL_INVALID");
  } else if (input.base !== null || input.head !== null) {
    throw new Error("RECEIPT_NON_GIT_RANGE_IDENTITY_INVALID");
  } else if (input.rangeMode !== null || input.trustedBase !== false
    || (input.kind === "forced-full" && input.minimumLevel !== "FULL")
    || (input.kind === "fixture" && !new Set(["FAST", "FULL"]).has(input.minimumLevel))) {
    throw new Error("RECEIPT_NON_GIT_RANGE_SEMANTICS_INVALID");
  }
  if (input.changeCount !== receipt.changedFiles.length) throw new Error("RECEIPT_CHANGE_COUNT_MISMATCH");
  if (input.kind === "forced-full" && (input.changeCount !== 0 || receipt.classification !== "FULL")) {
    throw new Error("RECEIPT_FORCED_FULL_SEMANTICS_INVALID");
  }

  if (input.kind === "git-range") {
    const loaded = loadGitRangeChanges(root, input.base, input.head, input.rangeMode, input.trustedBase);
    const recalculated = classifyChanges(policy, loaded, false, input.minimumLevel, input.acceptanceRoutes);
    if (input.changeCount !== loaded.changes.length
      || receipt.classification !== recalculated.classification
      || receipt.failClosed !== recalculated.failClosed
      || canonicalJson(receipt.changedFiles) !== canonicalJson(recalculated.changedFiles)
      || canonicalJson(receipt.reasons) !== canonicalJson(recalculated.reasons)
      || canonicalJson(receipt.browserAcceptance) !== canonicalJson(recalculated.browserAcceptance)) {
      throw new Error("RECEIPT_GIT_RANGE_RECLASSIFICATION_MISMATCH");
    }
  }
  if (!Array.isArray(input.acceptanceRoutes)) throw new Error("RECEIPT_ACCEPTANCE_ROUTES_INVALID");

  const calculatedLevel = receipt.changedFiles.reduce((highest, file) =>
    LEVEL_RANK[file.pathLevel] > LEVEL_RANK[highest] ? file.pathLevel : highest,
  input.kind === "forced-full" || input.changeCount === 0
    || receipt.browserAcceptance.explicitRoutesRequired ? "FULL" : "FAST");
  if (receipt.classification !== calculatedLevel) throw new Error("RECEIPT_CLASSIFICATION_MISMATCH");

  const required = uniqueSorted([
    ...policy.requiredValidations.all,
    ...policy.requiredValidations[receipt.classification],
  ]);
  const omitted = uniqueSorted(policy.validationCatalog.filter((item) => !required.includes(item)));
  assertSameArray(receipt.requiredValidations, required, "RECEIPT_REQUIRED_VALIDATIONS_MISMATCH");
  assertSameArray(receipt.omittedValidations, omitted, "RECEIPT_OMITTED_VALIDATIONS_MISMATCH");
  if (receipt.gate.requiredValidationCount !== required.length) throw new Error("RECEIPT_REQUIRED_COUNT_MISMATCH");
  if (receipt.gate.decision !== "CLASSIFICATION_ONLY"
    || receipt.gate.validationState !== "pending-required"
    || receipt.gate.releaseReady !== false) {
    throw new Error("RECEIPT_GATE_MUST_REMAIN_PENDING");
  }

  const { receiptId, ...payload } = receipt;
  const expectedReceiptId = `scope-${sha256(canonicalJson(payload)).slice(0, 24)}`;
  if (receiptId !== expectedReceiptId) throw new Error("RECEIPT_ID_MISMATCH");
}

function validateReceipt(receipt, schema, policy, rawPolicy, root) {
  assertJsonSchema(schema, receipt, "RECEIPT_JSON_SCHEMA_INVALID");
  assertReceiptSemantic(receipt, policy, rawPolicy, root);
}

function writeAtomically(filePath, body) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, absolute);
}

function appendGithubOutput(filePath, receipt, receiptSha256) {
  const lines = [
    `classification=${receipt.classification}`,
    `receipt_id=${receipt.receiptId}`,
    `receipt_sha256=${receiptSha256}`,
    `fail_closed=${receipt.failClosed ? "true" : "false"}`,
    `required_validations=${JSON.stringify(receipt.requiredValidations)}`,
  ];
  fs.appendFileSync(filePath, `${lines.join(os.EOL)}${os.EOL}`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.get("--root") || process.cwd());
  const policyPath = path.resolve(root, args.get("--policy") || "deploy/policies/release-change-scope.v1.json");
  const schemaPath = path.resolve(root, args.get("--schema") || "scripts/contracts/release-change-scope-receipt.v1.schema.json");
  const rawPolicy = fs.readFileSync(policyPath);
  const policy = JSON.parse(rawPolicy.toString("utf8"));
  const schema = readJson(schemaPath, "RECEIPT_SCHEMA_INVALID");
  assertPolicy(policy);

  if (args.has("--verify-receipt")) {
    const receipt = readJson(path.resolve(args.get("--verify-receipt")), "RECEIPT_JSON_INVALID");
    validateReceipt(receipt, schema, policy, rawPolicy, root);
    if (!args.has("--quiet")) {
      process.stdout.write(`${JSON.stringify({ receiptId: receipt.receiptId, classification: receipt.classification, valid: true })}\n`);
    }
    return;
  }

  const forceFull = args.has("--force-full-reason");
  const changesFile = args.get("--changes-file");
  const hasGitRange = args.has("--base") || args.has("--head");
  if (forceFull && (changesFile || hasGitRange)) throw new Error("FORCED_FULL_INPUT_CONFLICT");
  if (changesFile && hasGitRange) throw new Error("CHANGE_INPUT_CONFLICT");

  let loaded;
  const minimumLevel = args.get("--minimum-level") || (forceFull ? "FULL" : "FAST");
  if (!new Set(["FAST", "FULL"]).has(minimumLevel)) throw new Error("MINIMUM_LEVEL_INVALID");
  if (forceFull) {
    loaded = { kind: "forced-full", base: null, head: null, rangeMode: null, trustedBase: false, changes: [] };
  } else if (changesFile) {
    loaded = loadFixtureChanges(path.resolve(changesFile));
  } else if (args.has("--base") && args.has("--head")) {
    loaded = loadGitRangeChanges(
      root,
      args.get("--base"),
      args.get("--head"),
      args.get("--range-mode") || "merge-base",
      !args.has("--untrusted-base"),
    );
  } else {
    throw new Error("CHANGE_INPUT_REQUIRED");
  }

  const acceptanceRoutes = parseAcceptanceRoutes(args.get("--acceptance-routes-json"));
  const result = classifyChanges(policy, loaded, forceFull, minimumLevel, acceptanceRoutes);
  const requiredValidations = uniqueSorted([
    ...policy.requiredValidations.all,
    ...policy.requiredValidations[result.classification],
  ]);
  const omittedValidations = uniqueSorted(policy.validationCatalog.filter((item) => !requiredValidations.includes(item)));
  const receiptWithoutId = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    policy: {
      id: policy.policyId,
      schemaVersion: policy.schemaVersion,
      sha256: sha256(rawPolicy),
    },
    input: {
      kind: loaded.kind,
      base: loaded.base,
      head: loaded.head,
      rangeMode: loaded.rangeMode,
      trustedBase: loaded.trustedBase,
      minimumLevel,
      acceptanceRoutes,
      changeCount: loaded.changes.length,
    },
    classification: result.classification,
    failClosed: result.failClosed,
    reasons: result.reasons,
    changedFiles: result.changedFiles,
    browserAcceptance: result.browserAcceptance,
    requiredValidations,
    omittedValidations,
    gate: {
      decision: "CLASSIFICATION_ONLY",
      validationState: "pending-required",
      releaseReady: false,
      requiredValidationCount: requiredValidations.length,
    },
  };
  const receipt = {
    schemaVersion: receiptWithoutId.schemaVersion,
    receiptId: `scope-${sha256(canonicalJson(receiptWithoutId)).slice(0, 24)}`,
    ...Object.fromEntries(Object.entries(receiptWithoutId).slice(1)),
  };
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptSha256 = sha256(output);
  validateReceipt(receipt, schema, policy, rawPolicy, root);

  if (args.has("--output")) writeAtomically(args.get("--output"), output);
  if (args.has("--github-output")) appendGithubOutput(args.get("--github-output"), receipt, receiptSha256);
  if (!args.has("--quiet")) process.stdout.write(output);

  const expected = args.get("--expect");
  if (expected && expected !== receipt.classification) {
    process.stderr.write(`RELEASE_CHANGE_SCOPE_EXPECTATION_FAILED expected=${expected} actual=${receipt.classification}\n`);
    process.exitCode = 3;
  }
}

try {
  main();
} catch (error) {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  process.stderr.write(`RELEASE_CHANGE_SCOPE_GATE_FAILED ${code}\n`);
  process.exitCode = 2;
}
