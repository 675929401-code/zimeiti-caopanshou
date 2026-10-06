import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const deployerPath = path.join(root, "scripts", "deploy-artifact-vnext.sh");
const deployer = fs.readFileSync(deployerPath, "utf8");

function sliceFunction(name, followingMarker) {
  const start = deployer.indexOf(`${name}() {`);
  const end = deployer.indexOf(followingMarker, start);
  assert.ok(start >= 0 && end > start, `unable to locate ${name} body`);
  return deployer.slice(start, end + 2);
}

function assertOrdered(label, text, tokens) {
  let previous = -1;
  for (const token of tokens) {
    const current = text.indexOf(token);
    assert.ok(current >= 0, `${label} is missing: ${token}`);
    assert.ok(current > previous, `${label} ordering is invalid at: ${token}`);
    previous = current;
  }
}

const nodeHeredocBodies = [...deployer.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/gmu)].map((match) => match[1]);
assert.ok(nodeHeredocBodies.length > 0, "deployer must contain embedded Node validators");
for (const [index, body] of nodeHeredocBodies.entries()) {
  const syntax = spawnSync(process.execPath, ["--check", "-"], { encoding: "utf8", input: body });
  assert.equal(syntax.status, 0, `embedded Node validator ${index + 1} is not valid JavaScript: ${syntax.stderr || syntax.stdout}`);
}

for (const marker of [
  'trap \'handle_termination HUP 129\' HUP',
  'trap \'handle_termination INT 130\' INT',
  'trap \'handle_termination TERM 143\' TERM',
  'ROLLBACK_ATTEMPTED="0"',
  'ROLLBACK_SUCCEEDED="0"',
  'verify_exact_active_composite()',
  'verify_exact_first_deploy_composite()',
  'FAILURE_CONTEXT="signal=$signal_name;exit=$signal_status"',
  'rm -- "$CURRENT_LINK" || pointer_ok=1',
  'verify_pm2_absent',
  'CURRENT_ASSET_BACKEND="$(read_asset_release_backend',
  'ASSET_TARGET_BACKEND="$(read_asset_release_backend',
  '[[ "$EUID" -eq 0 ]] || die "--execute requires EUID=0',
  'seal_candidate_release()',
  'verify_candidate_release_seal()',
  'chown --recursive --no-dereference -- root:root "$target"',
  'sealed candidate full SHA-256 inventory changed before activation',
]) {
  assert.ok(deployer.includes(marker), `deployment state-machine marker is missing: ${marker}`);
}

const finalCleanup = sliceFunction("final_cleanup", "\n}\ntrap final_cleanup EXIT");
const directHook = sliceFunction("direct_hook", "\n}\n\ncleanup_candidate()");
assertOrdered("final cleanup trap masking", finalCleanup, [
  "local exit_status=$?",
  "trap - EXIT ERR",
  "trap '' HUP INT TERM",
  "set +e",
  'rollback_release "EXIT cleanup before deployment commit',
]);
assert.match(finalCleanup, /exit "\$exit_status"/u, "final cleanup must preserve the triggering exit status");

const signalFunction = sliceFunction("handle_termination", "\n}\n\nunexpected_error()");
assertOrdered("termination handler masking", signalFunction, [
  "trap '' HUP INT TERM",
  "trap - ERR",
  "set +e",
  'FAILURE_CONTEXT="signal=$signal_name;exit=$signal_status"',
]);

const rollbackFunction = sliceFunction("rollback_release", "\n}\n\nhandle_termination()");
const firstRollbackCommand = rollbackFunction
  .split(/\r?\n/u)
  .slice(1)
  .map((line) => line.trim())
  .find((line) => line && !line.startsWith("#"));
assert.equal(firstRollbackCommand, "trap '' HUP INT TERM", "rollback must mask HUP/INT/TERM before any other command");
assertOrdered("rollback signal/idempotency commit", rollbackFunction, [
  "trap '' HUP INT TERM",
  "trap - ERR",
  "set +e",
  'if [[ "$ROLLBACK_ATTEMPTED" == "1" ]]',
  'ROLLBACK_ATTEMPTED="1"',
]);
assert.match(rollbackFunction, /rm -- "\$CURRENT_LINK" \|\| pointer_ok=1/u, "first-deploy current removal must capture failure");
assert.match(rollbackFunction, /verify_exact_first_deploy_composite "\$PREVIOUS_ASSET_TARGET"/u, "first-deploy rollback PASS must require the exact inactive composite");
assert.match(rollbackFunction, /validate_payload_inventory "\$PREVIOUS_TARGET"/u, "rollback to an older release must revalidate its full SHA-256 inventory");
assert.match(rollbackFunction, /verify_exact_active_composite/u, "rollback PASS must require the active composite identity verifier");

const firstComposite = sliceFunction("verify_exact_first_deploy_composite", "\n}\n\nverify_exact_active_composite()");
for (const marker of [
  '[[ -z "$PREVIOUS_TARGET" ]]',
  '[[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]',
  'link_resolves_to "$ASSET_CURRENT_LINK" "$expected_asset_target"',
  "verify_pm2_absent",
]) assert.ok(firstComposite.includes(marker), `first-deploy composite is missing: ${marker}`);

const sealFunction = sliceFunction("seal_candidate_release", "\n}\n\nverify_candidate_release_seal()");
for (const marker of [
  '[[ "$EUID" -eq 0 ]]',
  'chown root:root -- "$RELEASE_ROOT" "$RELEASES_ROOT" "$RELEASE_PARENT"',
  'chmod 0755 -- "$RELEASE_ROOT" "$RELEASES_ROOT"',
  'chmod 0555 -- "$RELEASE_PARENT"',
  'chown --recursive --no-dereference -- root:root "$target"',
  'find "$target" -type d -exec chmod 0555',
  'find "$target" -type f ! -perm /111 -exec chmod 0444',
]) assert.ok(sealFunction.includes(marker), `candidate seal is missing: ${marker}`);

const promotion = deployer.indexOf('if ! mv -Tn -- "$PAYLOAD_DIR" "$CANDIDATE"');
const promotedHash = deployer.indexOf('validate_payload_inventory "$CANDIDATE"', promotion);
const sealCall = deployer.indexOf('seal_candidate_release "$CANDIDATE"', promotedHash);
const sealVerification = deployer.indexOf('verify_candidate_release_seal "$CANDIDATE"', sealCall);
const preSwitchSealVerification = deployer.indexOf('verify_candidate_release_seal "$CANDIDATE"', sealVerification + 1);
const sealedHash = deployer.indexOf('validate_payload_inventory "$CANDIDATE"', preSwitchSealVerification);
const switchCommit = deployer.indexOf('SWITCH_STARTED="1"', sealedHash);
assert.ok(
  promotion >= 0 && promotedHash > promotion && sealCall > promotedHash && sealVerification > sealCall &&
    preSwitchSealVerification > sealVerification && sealedHash > preSwitchSealVerification && switchCommit > sealedHash,
  "promotion/full-SHA/seal/seal-verification/sealed-full-SHA/switch ordering is invalid",
);

const validatorStart = deployer.indexOf("validate_asset_release() {");
const validatorEnd = deployer.indexOf("\n}\n\nvalidate_asset_forward_compatibility()", validatorStart);
assert.ok(validatorStart >= 0 && validatorEnd > validatorStart, "unable to locate validate_asset_release body");
const validatorBody = deployer.slice(validatorStart, validatorEnd);
assert.doesNotMatch(validatorBody, /ASSET_DELIVERY_MODE/u, "asset validator must receive a per-release backend instead of reading global mode");

const firstProductionGate = deployer.indexOf('"production"; then');
const dataGate = deployer.indexOf('compare_data_snapshot "$DATA_BEFORE" "$DATA_AFTER_LIVE"');
const finalCompositeGate = deployer.indexOf('"precommit"; then');
const successWrite = deployer.indexOf("\\tSUCCESS\\t");
const deployCommit = deployer.indexOf('DEPLOY_COMPLETE="1"', successWrite);
assert.ok(firstProductionGate >= 0 && dataGate > firstProductionGate && finalCompositeGate > dataGate && successWrite > finalCompositeGate && deployCommit > successWrite,
  "production/data/final-composite/SUCCESS/commit gates are out of order");
assert.match(deployer.slice(finalCompositeGate, deployCommit), /trap '' HUP INT TERM/u, "SUCCESS commit boundary must mask termination signals");

function resolveBash() {
  const configured = process.env.GIT_BASH_PATH;
  if (configured) return configured;
  if (process.platform !== "win32") return "bash";
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
  ];
  for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, "bash.exe"));
    candidates.push(path.resolve(entry, "..", "bin", "bash.exe"));
    candidates.push(path.resolve(entry, "..", "usr", "bin", "bash.exe"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function bashPath(filePath) {
  if (process.platform !== "win32") return filePath;
  if (!/^[A-Za-z]:[\\/]/u.test(filePath)) return filePath;
  const normalized = filePath.replaceAll("\\", "/");
  const match = /^([A-Za-z]):(\/.*)$/u.exec(normalized);
  return match ? `/${match[1].toLowerCase()}${match[2]}` : normalized;
}

function runBash(bash, scriptPath, args) {
  return spawnSync(bash, [bashPath(scriptPath), ...args.map((value) => bashPath(value))], { encoding: "utf8" });
}

const bash = resolveBash();
assert.ok(bash, "Git Bash or system bash is required for deployment state-machine fault injection");
const dynamicResults = [];
const temporaryRoot = fs.mkdtempSync(path.join(process.platform === 'win32' ? path.resolve(root, '..', '运行日志') : os.tmpdir(), "deploy-state-machine-"));
try {
  const signalHarnessPath = path.join(temporaryRoot, "signal-harness.sh");
  const signalMarkerPath = path.join(temporaryRoot, "signal-events.log");
  const signalHarness = `#!/usr/bin/env bash
set -Eeuo pipefail
marker="$1"
signal_name="$2"
SWITCH_STARTED="$3"
SECOND_SIGNAL="$4"
DEPLOY_COMPLETE="0"
ROLLBACK_ATTEMPTED="0"
ROLLBACK_SUCCEEDED="0"
IN_ROLLBACK="0"
FAILURE_CONTEXT=""
rollback_release() {
  trap '' HUP INT TERM
  local reason="$1"
  trap - ERR
  set +e
  if [[ "$ROLLBACK_ATTEMPTED" == "1" ]]; then [[ "$ROLLBACK_SUCCEEDED" == "1" ]]; return; fi
  ROLLBACK_ATTEMPTED="1"
  printf 'ROLLBACK:%s\\n' "$reason" >>"$marker"
  if [[ "$SECOND_SIGNAL" == "1" ]]; then kill -TERM "$$"; fi
  ROLLBACK_SUCCEEDED="1"
}
${signalFunction}
trap 'printf "EXIT:%s:%s\\n" "$?" "$FAILURE_CONTEXT" >>"$marker"' EXIT
trap 'handle_termination HUP 129' HUP
trap 'handle_termination INT 130' INT
trap 'handle_termination TERM 143' TERM
kill -"$signal_name" "$$"
sleep 0.1
exit 99
`;
  fs.writeFileSync(signalHarnessPath, signalHarness, { mode: 0o700 });
  for (const testCase of [
    { signal: "HUP", status: 129 },
    { signal: "INT", status: 130 },
    { signal: "TERM", status: 143 },
  ]) {
    for (const switched of ["0", "1"]) {
      fs.writeFileSync(signalMarkerPath, "");
      const run = runBash(bash, signalHarnessPath, [signalMarkerPath, testCase.signal, switched, "0"]);
      assert.equal(run.status, testCase.status, `${testCase.signal} exit status mismatch: ${run.stderr || run.stdout}`);
      const events = fs.readFileSync(signalMarkerPath, "utf8");
      assert.equal((events.match(/^ROLLBACK:/gmu) ?? []).length, switched === "1" ? 1 : 0, `${testCase.signal} rollback count mismatch`);
      assert.match(events, new RegExp(`EXIT:${testCase.status}:signal=${testCase.signal};exit=${testCase.status}`, "u"));
      dynamicResults.push({ harness: "signal", signal: testCase.signal, switched: switched === "1", status: run.status });
    }
  }
  fs.writeFileSync(signalMarkerPath, "");
  const repeated = runBash(bash, signalHarnessPath, [signalMarkerPath, "TERM", "1", "1"]);
  assert.equal(repeated.status, 143, `secondary signal harness failed: ${repeated.stderr || repeated.stdout}`);
  const repeatedEvents = fs.readFileSync(signalMarkerPath, "utf8");
  assert.equal((repeatedEvents.match(/^ROLLBACK:/gmu) ?? []).length, 1, "secondary termination must not recurse into rollback");
  dynamicResults.push({ harness: "signal", signal: "TERM", switched: true, secondarySignalDuringRollback: true, status: repeated.status });

  const exitHarnessPath = path.join(temporaryRoot, "exit-harness.sh");
  const exitMarkerPath = path.join(temporaryRoot, "exit-events.log");
  const exitHeader = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'marker="$1"',
    'requested_status="$2"',
    'SECOND_SIGNAL="$3"',
    'SWITCH_STARTED="1"',
    'DEPLOY_COMPLETE="0"',
    'ROLLBACK_ATTEMPTED="0"',
    'ROLLBACK_SUCCEEDED="0"',
    'FAILURE_CONTEXT=""',
    'candidate_pid=""',
    'APP_TEMP_LINK=""',
    'ASSET_TEMP_LINK=""',
    'HISTORY_FD=""',
    'STAGING_DIR=""',
    'AUDIT_DIR=""',
    "cleanup_candidate() { printf 'CLEANUP\\n' >>\"$marker\"; }",
    "safe_remove_staging() { return 0; }",
    "rollback_release() {",
    "  trap '' HUP INT TERM",
    '  if [[ "$ROLLBACK_ATTEMPTED" == "1" ]]; then [[ "$ROLLBACK_SUCCEEDED" == "1" ]]; return; fi',
    '  ROLLBACK_ATTEMPTED="1"',
    "  printf 'ROLLBACK\\n' >>\"$marker\"",
    '  if [[ "$SECOND_SIGNAL" == "1" ]]; then kill -TERM "$$"; fi',
    '  ROLLBACK_SUCCEEDED="1"',
    "}",
  ].join("\n");
  const exitFooter = [
    "trap 'printf \"REENTER\\n\" >>\"$marker\"; exit 88' HUP INT TERM",
    "trap final_cleanup EXIT",
    'exit "$requested_status"',
    "",
  ].join("\n");
  fs.writeFileSync(exitHarnessPath, `${exitHeader}\nDIRECT_PREPARED=0\nDIRECT_ROLLBACK_COMPLETE=0\n${directHook}\n${finalCleanup}\n${exitFooter}`, { mode: 0o700 });
  for (const secondary of ["0", "1"]) {
    fs.writeFileSync(exitMarkerPath, "");
    const run = runBash(bash, exitHarnessPath, [exitMarkerPath, "7", secondary]);
    assert.equal(run.status, 7, `EXIT cleanup must preserve status 7: ${run.stderr || run.stdout}`);
    const events = fs.readFileSync(exitMarkerPath, "utf8");
    assert.equal((events.match(/^ROLLBACK$/gmu) ?? []).length, 1, "EXIT cleanup must attempt rollback exactly once");
    assert.equal((events.match(/^CLEANUP$/gmu) ?? []).length, 1, "EXIT cleanup must run candidate cleanup exactly once");
    assert.doesNotMatch(events, /^REENTER$/mu, "secondary signal must not re-enter EXIT cleanup");
    dynamicResults.push({ harness: "exit", originalStatus: 7, secondarySignalDuringRollback: secondary === "1", status: run.status });
  }

  const firstHarnessPath = path.join(temporaryRoot, "first-deploy-harness.sh");
  const firstHarnessHeader = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'test_root="$1"',
    'scenario="$2"',
    'CURRENT_LINK="$test_root/current"',
    'CANDIDATE="$test_root/candidate"',
    'PREVIOUS_ASSET_TARGET="$test_root/assets-previous"',
    'ASSET_CURRENT_LINK="$test_root/assets-current"',
    'APP_TEMP_LINK="$test_root/app-temp"',
    'ASSET_TEMP_LINK="$test_root/asset-temp"',
    'APP_NAME="agent-hub-web"',
    'LIVE_PORT="5000"',
    'SERVICE="voice"',
    'PREVIOUS_TARGET=""',
    'ROLLBACK_ATTEMPTED="0"',
    'ROLLBACK_SUCCEEDED="0"',
    'IN_ROLLBACK="0"',
    'PM2_PRESENT="0"',
    'PORT_PRESENT="0"',
    'FAIL_RM="0"',
    'CURRENT_MATCH="1"',
    'ASSET_MATCH="1"',
    'mkdir -p "$CANDIDATE" "$PREVIOUS_ASSET_TARGET"',
    ': >"$ASSET_CURRENT_LINK"',
    'case "$scenario" in',
    '  verify-clean|rollback-current|rollback-rm-fail) ;;',
    '  verify-current) : >"$CURRENT_LINK" ;;',
    '  verify-previous) PREVIOUS_TARGET="$test_root/old-release" ;;',
    '  verify-asset) ASSET_MATCH="0" ;;',
    '  verify-pm2) PM2_PRESENT="1" ;;',
    '  rollback-absent) ;;',
    '  rollback-unexpected) : >"$CURRENT_LINK"; CURRENT_MATCH="0" ;;',
    '  *) exit 91 ;;',
    'esac',
    'if [[ "$scenario" == "rollback-current" || "$scenario" == "rollback-rm-fail" ]]; then : >"$CURRENT_LINK"; fi',
    'if [[ "$scenario" == "rollback-rm-fail" ]]; then FAIL_RM="1"; fi',
    'cleanup_candidate() { :; }',
    'port_in_use() { [[ "$PORT_PRESENT" == "1" ]]; }',
    'link_resolves_to() { if [[ "$1" == "$CURRENT_LINK" ]]; then [[ "$CURRENT_MATCH" == "1" && -e "$CURRENT_LINK" ]]; else [[ "$1" == "$ASSET_CURRENT_LINK" && "$ASSET_MATCH" == "1" ]]; fi; }',
    'pm2() { if [[ "${1:-}" == "jlist" ]]; then [[ "$PM2_PRESENT" == "0" ]] && printf "[]" || printf "[{\\"name\\":\\"agent-hub-web\\"}]"; fi; return 0; }',
    'verify_pm2_absent() { [[ "$PM2_PRESENT" == "0" && "$PORT_PRESENT" == "0" ]]; }',
    'atomic_symlink() { return 0; }',
    'validate_payload_inventory() { return 0; }',
    'activate_pm2() { return 0; }',
    'verify_exact_active_composite() { return 0; }',
    'unexpected_error() { return 1; }',
    'rm() { if [[ "$FAIL_RM" == "1" && "${*: -1}" == "$CURRENT_LINK" ]]; then return 1; fi; command rm "$@"; }',
  ].join("\n");
  const firstHarnessFooter = [
    'if [[ "$scenario" == verify-* ]]; then',
    '  if verify_exact_first_deploy_composite "$PREVIOUS_ASSET_TARGET"; then exit 0; else exit 42; fi',
    'fi',
    'if rollback_release "fault-injection"; then exit 0; else exit 42; fi',
    "",
  ].join("\n");
  fs.writeFileSync(
    firstHarnessPath,
    `${firstHarnessHeader}\n${directHook}\n${firstComposite}\n${rollbackFunction}\n${firstHarnessFooter}`,
    { mode: 0o700 },
  );
  for (const testCase of [
    { scenario: "verify-clean", expected: 0 },
    { scenario: "verify-current", expected: 42 },
    { scenario: "verify-previous", expected: 42 },
    { scenario: "verify-asset", expected: 42 },
    { scenario: "verify-pm2", expected: 42 },
    { scenario: "rollback-current", expected: 0 },
    { scenario: "rollback-absent", expected: 0 },
    { scenario: "rollback-rm-fail", expected: 42 },
    { scenario: "rollback-unexpected", expected: 42 },
  ]) {
    const caseRoot = path.join(temporaryRoot, `first-${testCase.scenario}`);
    fs.mkdirSync(caseRoot, { recursive: true });
    const run = runBash(bash, firstHarnessPath, [caseRoot, testCase.scenario]);
    assert.equal(run.status, testCase.expected, `${testCase.scenario} fault injection mismatch: ${run.stderr || run.stdout}`);
    if (testCase.scenario === "rollback-current") {
      assert.equal(fs.existsSync(path.join(caseRoot, "current")), false, "successful first-deploy rollback must leave current absent");
    }
    dynamicResults.push({ harness: "first-deploy", scenario: testCase.scenario, status: run.status });
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  staticStateMachineChecks: true,
  embeddedNodeValidators: nodeHeredocBodies.length,
  bash,
  dynamicFaultInjectionChecks: dynamicResults,
})}\n`);
