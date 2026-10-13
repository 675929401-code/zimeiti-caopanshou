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
  'candidate-log.v2 service=${service} release=${releaseId}',
  'published candidate log payload digest is invalid',
  '--property=ReadOnlyPaths --property=ReadWritePaths --property=InaccessiblePaths',
  '--property=CapabilityBoundingSet --property=AmbientCapabilities --property=RestrictNamespaces',
  '--property=KillMode --property=RuntimeMaxUSec --property=TimeoutStopUSec --property=UMask',
  'LEGACY_BASELINE_RECEIPT_PATH',
  'legacyFileInventory',
  'DIRECT_HOOK_PM2_CONFIG_SHA256',
  'DIRECT_TRANSACTION_ROOT',
  'media-worker-state.json',
  'direct_hook rollback-persisted',
  'chmod 0600 -- "$PM2_DUMP_PATH"',
]) {
  assert.ok(deployer.includes(marker), `deployment state-machine marker is missing: ${marker}`);
}
assert.ok(
  deployer.includes('archive contains special or malformed permission bits')
    && deployer.includes('archive contains a group/other-writable entry'),
  "archive audit must reject special and group/other-writable modes before permission-preserving extraction",
);
assert.ok(
  deployer.includes('--no-same-owner --same-permissions'),
  "execute extraction must preserve the already-audited signed inventory modes",
);
assert.ok(
  !deployer.includes('--no-same-owner --no-same-permissions'),
  "execute extraction must not mask signed modes through the deployer's restrictive umask",
);
for (const marker of [
  'candidate_active_state="$(systemctl show --property=ActiveState',
  'candidate_process_uid="$(awk \'$1 == "Uid:"',
  '"$candidate_active_state" == "active" && "$candidate_process_uid" == "$CANDIDATE_UID"',
  "candidate sandbox did not reach a stable dedicated non-root process identity",
  "candidate sandbox main PID changed during process identity verification",
  "candidate sandbox main PID changed after environment/status verification",
]) assert.ok(deployer.includes(marker), `stable non-root candidate identity gate is missing: ${marker}`);
for (const marker of [
  'chown root:"$CANDIDATE_GID" -- "$STAGING_ROOT"',
  'chmod 0710 -- "$STAGING_ROOT"',
  '"0:$CANDIDATE_GID:710"',
  "execute-only candidate-group traversal",
]) assert.ok(deployer.includes(marker), `least-privilege candidate staging traversal is missing: ${marker}`);
for (const marker of [
  'CANDIDATE_NODE_BIN="/usr/local/libexec/zimeiti/node-v24.19.0"',
  'CANDIDATE_NODE_SHA256="bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12"',
  'require_trusted_root_executable "$CANDIDATE_NODE_BIN" "candidate Node runtime"',
  "deployment and candidate Node runtimes are not byte-identical",
  'NODE_BIN="$CANDIDATE_NODE_BIN"',
]) assert.ok(deployer.includes(marker), `candidate runtime trust/access contract is missing: ${marker}`);

const finalCleanup = sliceFunction("final_cleanup", "\n}\ntrap final_cleanup EXIT");
const directHook = sliceFunction("direct_hook", "\n}\n\nvalidate_direct_hook_configuration()");
const activatePm2 = sliceFunction("activate_pm2", "\n}\n\nverify_pm2_identity()");
const verifyPm2Identity = sliceFunction("verify_pm2_identity", "\n}\n\nverify_pm2_dump_identity()");
const verifyPm2Dump = sliceFunction("verify_pm2_dump_identity", "\n}\n\npersist_pm2_state()");
const verifyPm2Absent = sliceFunction("verify_pm2_absent", "\n}\n\nverify_exact_first_deploy_composite()");
assert.doesNotMatch(activatePm2, /startOrReload/u, "activation must discard cached PM2 cwd/script slots");
assertOrdered("PM2 replacement", activatePm2, [
  'pm2 stop "$APP_NAME"',
  'if port_in_use "$LIVE_PORT"',
  'pm2 delete "$APP_NAME"',
  "verify_pm2_absent || return 1",
  'pm2 start "$config_path" --only "$APP_NAME"',
]);
const candidateCgroupEmpty = sliceFunction("candidate_cgroup_empty", "\n}\n\ncandidate_unit_stopped()");
const candidateUnitStopped = sliceFunction("candidate_unit_stopped", "\n}\n\nwait_candidate_unit_stopped()");
const waitCandidateUnitStopped = sliceFunction("wait_candidate_unit_stopped", "\n}\n\npublish_candidate_log()");
const publishCandidateLog = sliceFunction("publish_candidate_log", "\n}\n\ncleanup_candidate()");
const cleanupCandidate = sliceFunction("cleanup_candidate", "\n}\n\nsafe_remove_staging()");
const harnessCandidateCgroupEmpty = candidateCgroupEmpty.replace(
  'cgroup_path="/sys/fs/cgroup$control_group"',
  'cgroup_path="$CGROUP_ROOT$control_group"',
);
assert.notEqual(harnessCandidateCgroupEmpty, candidateCgroupEmpty, "candidate cleanup harness must redirect cgroup reads into its fixture root");
assertOrdered("final cleanup trap masking", finalCleanup, [
  "local exit_status=$?",
  "trap - EXIT ERR",
  "trap '' HUP INT TERM",
  "set +e",
  'rollback_release "EXIT cleanup before deployment commit',
]);
assert.match(finalCleanup, /exit "\$exit_status"/u, "final cleanup must preserve the triggering exit status");
assertOrdered("direct prepare fallback", finalCleanup, [
  'if [[ "$DIRECT_PREPARED" == "1"',
  '[[ ! -f "${DIRECT_TRANSACTION_ROOT:-}/media-worker-state.json" ]]',
  "direct_hook rollback-before",
  "direct_hook rollback-after",
  "direct_hook rollback-persisted",
]);

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
assertOrdered("rollback worker persistence transaction", rollbackFunction, [
  "direct_hook rollback-before",
  "direct_hook rollback-after",
  "persist_pm2_state",
  "direct_hook rollback-persisted",
  'ROLLBACK_SUCCEEDED="1"',
]);

for (const marker of [
  "DIRECT_HOOK_PM2_CONFIG_PATH",
  "DIRECT_HOOK_PM2_CONFIG_SHA256",
  "DIRECT_TRANSACTION_ROOT",
  "DIRECT_HOOK_DIRECTORY_UNSAFE",
  "DIRECT_HOOK_PM2_CONFIG_CHANGED",
  "DIRECT_TRANSACTION_PARENT_UNSAFE",
]) assert.ok(directHook.includes(marker), `direct worker hook trust boundary is missing: ${marker}`);

const productionWorkerTransaction = [
  "direct_hook prepare",
  "direct_hook activated",
  "direct_hook precommit",
  "persist_pm2_state",
  "direct_hook persisted",
  'DEPLOY_COMPLETE="1"',
].map((marker) => ({ marker, index: deployer.lastIndexOf(marker) }));
for (let index = 0; index < productionWorkerTransaction.length; index += 1) {
  const current = productionWorkerTransaction[index];
  assert.ok(current.index >= 0, `production worker transaction is missing: ${current.marker}`);
  if (index > 0) assert.ok(current.index > productionWorkerTransaction[index - 1].index,
    `production worker transaction ordering is invalid at: ${current.marker}`);
}

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

const inventoryFunction = sliceFunction("validate_payload_inventory", "\n}\n\nseal_candidate_release()");
for (const marker of [
  'local mode_contract="${2:-manifest}"',
  '"$mode_contract" == "manifest" || "$mode_contract" == "sealed"',
  'node - "$payload" "$mode_contract"',
  'modeContract === "sealed"',
  'item.kind === "directory" ? 0o555',
  '((item.mode & 0o111) !== 0 ? 0o555 : 0o444)',
]) assert.ok(inventoryFunction.includes(marker), `sealed inventory mode contract is missing: ${marker}`);
for (const marker of [
  'validate_payload_inventory "$current_target" sealed',
  'validate_payload_inventory "$PREVIOUS_TARGET" sealed',
  'validate_payload_inventory "$CANDIDATE" sealed',
]) assert.ok(deployer.includes(marker), `sealed release inventory call is missing: ${marker}`);

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

const compatibilityStart = deployer.indexOf("validate_asset_forward_compatibility() {");
const compatibilityEnd = deployer.indexOf("\n}\n\ncapture_data_snapshot()", compatibilityStart);
assert.ok(compatibilityStart >= 0 && compatibilityEnd > compatibilityStart, "unable to locate forward asset compatibility body");
const compatibilityBody = deployer.slice(compatibilityStart, compatibilityEnd);
for (const marker of [
  'require_trusted_controller_file "$ASSET_POLICY_TRANSITION_VERIFIER"',
  "ASSET_POLICY_TRANSITION_VERIFIER_SHA256",
  '--current-manifest "$current_manifest"',
  '--next-manifest "$next_manifest"',
  '^/data/direct-deploy/incoming/run-[0-9]+/control/receipts/',
  '"$receipt_real" != "$CONTROL_PLANE_ROOT/"*',
  '--receipt-sha256 "${ASSET_POLICY_TRANSITION_SHA256,,}"',
]) assert.ok(compatibilityBody.includes(marker), `forward asset compatibility gate is missing: ${marker}`);

const trustedControllerStart = deployer.indexOf("require_trusted_controller_file() {");
const trustedControllerEnd = deployer.indexOf("\n}\n\nrun_production_preflight()", trustedControllerStart);
assert.ok(trustedControllerStart >= 0 && trustedControllerEnd > trustedControllerStart, "unable to locate trusted controller file validator");
const trustedControllerBody = deployer.slice(trustedControllerStart, trustedControllerEnd);
for (const marker of [
  "stat -c '%u:%g:%a:%h'",
  "IFS=: read -r uid gid mode links",
  "stat -c '%u:%g:%a'",
  "IFS=: read -r uid gid mode",
]) assert.ok(trustedControllerBody.includes(marker), `trusted controller metadata parser is missing: ${marker}`);
assert.doesNotMatch(trustedControllerBody, /stat -c '[^']*%F/u, "trusted controller metadata must not depend on localized multi-word file-type text");

const storageGuardStart = deployer.indexOf("run_storage_boot_guard() {");
const storageGuardEnd = deployer.indexOf("\n}\n\nrequire_trusted_controller_file()", storageGuardStart);
assert.ok(storageGuardStart >= 0 && storageGuardEnd > storageGuardStart, "unable to locate storage boot guard");
const storageGuardBody = deployer.slice(storageGuardStart, storageGuardEnd);
assert.ok(storageGuardBody.includes('require_trusted_controller_file "$STORAGE_GUARD_PATH"'), "storage guard must reuse the common trusted-file validator");
assert.doesNotMatch(storageGuardBody, /stat -c/u, "storage guard must not duplicate trusted-file metadata parsing");
assert.doesNotMatch(deployer, /stat -c '[^']*%F/u, "deployment security gates must use shell file predicates plus locale-independent numeric stat fields");

const runtimeAlignmentStart = deployer.indexOf("validate_predeploy_runtime_alignment() {");
const runtimeAlignmentEnd = deployer.indexOf("\n}\n\nassert_regular_directory()", runtimeAlignmentStart);
assert.ok(runtimeAlignmentStart >= 0 && runtimeAlignmentEnd > runtimeAlignmentStart, "unable to locate predeploy runtime alignment gate");
const runtimeAlignmentBody = deployer.slice(runtimeAlignmentStart, runtimeAlignmentEnd);
for (const marker of [
  '[[ -f "$PM2_STATE_ROOT/pm2.pid" && ! -L "$PM2_STATE_ROOT/pm2.pid" ]]',
  "plan mode must not start a daemon",
  "unmanaged PM2 process claims live port",
  "PM2 cwd does not match current pointer",
  'grep -Fq "pid=$pm2_pid,"',
]) assert.ok(runtimeAlignmentBody.includes(marker), `predeploy runtime alignment gate is missing: ${marker}`);
const runtimeAlignmentCall = deployer.indexOf("\nvalidate_predeploy_runtime_alignment\n");
const planSuccess = deployer.indexOf("PASS PLAN ONLY:");
assert.ok(runtimeAlignmentCall >= 0 && runtimeAlignmentCall < planSuccess, "runtime topology must be checked before a plan can pass");

const pm2DumpVerifierStart = deployer.indexOf("verify_pm2_dump_identity() {");
const pm2DumpVerifierEnd = deployer.indexOf("\n}\n\npersist_pm2_state()", pm2DumpVerifierStart);
assert.ok(pm2DumpVerifierStart >= 0 && pm2DumpVerifierEnd > pm2DumpVerifierStart, "unable to locate PM2 dump identity verifier");
const pm2DumpVerifierBody = deployer.slice(pm2DumpVerifierStart, pm2DumpVerifierEnd);
for (const marker of [
  'require_trusted_controller_file "$PM2_DUMP_PATH"',
  "PM2 dump contains another active claimant",
  "PM2 dump cwd mismatch",
  "PM2 dump release identity environment mismatch",
  "PM2 dump Web asset identity mismatch",
]) assert.ok(pm2DumpVerifierBody.includes(marker), `PM2 dump verifier is missing: ${marker}`);
const pm2PersistStart = deployer.indexOf("persist_pm2_state() {");
const pm2PersistEnd = deployer.indexOf("\n}\n\nlink_resolves_to()", pm2PersistStart);
assert.ok(pm2PersistStart >= 0 && pm2PersistEnd > pm2PersistStart, "unable to locate PM2 persistence function");
const pm2PersistBody = deployer.slice(pm2PersistStart, pm2PersistEnd);
for (const marker of ["pm2 save --force", 'sync -f "$PM2_DUMP_PATH"', "verify_pm2_dump_identity"]) {
  assert.ok(pm2PersistBody.includes(marker), `PM2 persistence function is missing: ${marker}`);
}
const pm2SuccessPersistCall = deployer.lastIndexOf('persist_pm2_state "$CANDIDATE"');
const successHistoryWrite = deployer.indexOf("SUCCESS\\t%s\\t%s");
assert.ok(pm2SuccessPersistCall >= 0 && successHistoryWrite > pm2SuccessPersistCall, "PM2 reboot state must be persisted before deployment SUCCESS is committed");
const rollbackPersistCall = deployer.indexOf('persist_pm2_state "$PREVIOUS_TARGET"');
assert.ok(rollbackPersistCall >= 0 && rollbackPersistCall < pm2SuccessPersistCall, "rollback must persist the restored PM2 state");
const policyTransitionVerifier = fs.readFileSync(path.join(root, "scripts", "asset-policy-transition-proof-vnext.mjs"), "utf8");
for (const marker of [
  "required-paths-additive-only",
  "asset policy fields other than requiredPaths changed",
  "next asset policy removes a required path",
  "new asset release deletes an active URL",
  "new asset release mutates an active immutable URL",
  "transition receipt generator identity/SHA is unsupported",
  "transition receipt is not bound to the supplied manifests/policies",
]) assert.ok(policyTransitionVerifier.includes(marker), `asset policy transition verifier is missing: ${marker}`);

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
  // Stateful PM2 fixture models cached cwd/script on reload and shares state
  // across the real activation subshell. It never starts a daemon or listener.
  const pm2FixturePath = path.join(temporaryRoot, "pm2-fixture.cjs");
  fs.writeFileSync(pm2FixturePath, String.raw`
const fs = require('node:fs');
const [statePath, action, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const name = args[0];
const matches = state.processes.filter(p => p.name === state.name);
if (action === 'jlist') {
  if (state.scenario === 'jlist-fail') process.exit(2);
  process.stdout.write(JSON.stringify(state.processes));
} else if (action === 'port') {
  process.exit(state.portHeld || matches.some(p => p.pm2_env.status === 'online') ? 0 : 1);
} else if (action === 'stop' || action === 'delete') {
  if (name !== state.name) throw Error('unrelated process mutation');
  state.events.push(action); save();
  if (state.scenario === action + '-fail') process.exit(3);
  if (action === 'stop') for (const p of matches) p.pm2_env.status = 'stopped';
  else if (state.scenario !== 'delete-retained') state.processes = state.processes.filter(p => p.name !== name);
  save();
} else if (action === 'start' || action === 'startOrReload') {
  if (args.join(' ').indexOf('--only ' + state.name) < 0) throw Error('missing exact --only');
  const config = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  state.events.push(action); save();
  if (state.scenario === 'start-fail') process.exit(4);
  const env = {status:'online', pm_cwd:config.target, pm_exec_path:config.script};
  for (const key of ['RELEASE_ID','DEPLOY_COMMIT_SHA','EXPECTED_BUILD_ID','RELEASE_SOURCE_VERSION','RELEASE_BUILD_OUTPUT_DIGEST','ASSET_DIGEST','ASSET_MANIFEST_SHA256','COZE_PROJECT_ENV']) env[key] = process.env[key];
  env.PORT = state.port;
  if (action === 'startOrReload' && matches.length) {
    env.pm_cwd = matches[0].pm2_env.pm_cwd;
    env.pm_exec_path = matches[0].pm2_env.pm_exec_path;
  } else if (matches.length) throw Error('start retained a previous slot');
  state.processes = state.processes.filter(p => p.name !== state.name);
  state.processes.push({name:state.name,pid:4242,pm2_env:env}); save();
} else if (action === 'dump') {
  fs.writeFileSync(args[0], JSON.stringify(state.processes.map(p => ({name:p.name,...p.pm2_env}))));
} else if (action === 'corrupt') {
  matches[0].pm2_env[args[0]] = args[1]; save();
} else throw Error('unexpected fixture action ' + action);
`);
  const activationHarnessPath = path.join(temporaryRoot, "activation-rollback-harness.sh");
  const activationHarness = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
test_root="$1"
PM2_FIXTURE="$2"
SERVICE="$3"
scenario="$4"
STATE_FILE="$test_root/state.json"
EVENTS_FILE="$test_root/hooks.log"
RELEASE_ROOT="$test_root"
APP_NAME="agent-hub-$SERVICE"
LIVE_PORT="5000"
[[ "$SERVICE" != voice ]] || LIVE_PORT="5001"
RELEASE_ID="candidate-operation"
COMMIT_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ACTUAL_SHA256="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
ASSET_DIGEST="candidate-assets"
ASSET_MANIFEST_SHA256="candidate-manifest"
SOURCE_VERSION="candidate-source"
BUILD_OUTPUT_DIGEST="candidate-output"
APP_DATA_DIR="$test_root/data"
APP_RUNTIME_DIR="$test_root/runtime"
COMMERCE_DATA_DIR="$test_root/commerce"
COMMERCE_DISCOVERY_CATALOG="$test_root/catalog"
COMMERCE_GATEWAY_KEY_FILE="$test_root/key"
IDEMPOTENCY_DIR="$test_root/idempotency"
BACKUP_ROOT="$test_root/backups"
ASSET_CURRENT_LINK="$test_root/assets-current"
VOICE_DATABASE_PATH="$test_root/voice.db"
VOICE_REFERENCE_AUDIO_ROOT="$test_root/reference"
UPLOAD_ROOT="$test_root/uploads"
CURRENT_LINK="$test_root/current"
CANDIDATE="$test_root/new"
PREVIOUS_TARGET="$test_root/old"
PREVIOUS_RELEASE_ID="previous-release"
PREVIOUS_COMMIT_SHA="cccccccccccccccccccccccccccccccccccccccc"
PREVIOUS_BUILD_ID="previous-build"
PREVIOUS_SOURCE_VERSION="previous-source"
PREVIOUS_BUILD_OUTPUT_DIGEST="previous-output"
PREVIOUS_ASSET_TARGET="$test_root/old-assets"
PREVIOUS_ASSET_DIGEST="previous-assets"
PREVIOUS_ASSET_MANIFEST_SHA256="previous-manifest"
PREVIOUS_BASELINE_MODE="$scenario"
DIRECT_HOOK_PATH="fixture-hook"
DIRECT_HOOK_SHA256="fixture-sha"
DIRECT_HOOK_PM2_CONFIG_PATH="$PREVIOUS_TARGET/.release/ecosystem.config.cjs"
DIRECT_HOOK_PM2_CONFIG_SHA256="fixture-config-sha"
DIRECT_TRANSACTION_ROOT="/data/direct-deploy/transactions/candidate-operation-bbbbbbbbbbbb"
DIRECT_PREPARED="1"
DIRECT_ROLLBACK_COMPLETE="0"
ROLLBACK_ATTEMPTED="0"
ROLLBACK_SUCCEEDED="0"
IN_ROLLBACK="0"
SWITCH_STARTED="1"
DEPLOY_COMPLETE="0"
FAILURE_CONTEXT="fixture-production-composite"
DEPLOY_ACTOR="fixture"
APP_TEMP_LINK=""
ASSET_TEMP_LINK=""
STAGING_DIR=""
AUDIT_DIR=""
candidate_unit=""
node() {
  # Trust-file validation has separate security coverage. Keep the real hook's
  # shell transaction binding and dispatch, while avoiding privileged fixtures.
  if [[ "$1" == - && "$2" == "$DIRECT_HOOK_PATH" ]]; then cat >/dev/null; return 0; fi
  if [[ "$1" == "$DIRECT_HOOK_PATH" ]]; then
    [[ "$3" == /data/direct-deploy/transactions/candidate-operation-bbbbbbbbbbbb ]] || return 1
    printf '%s:%s\n' "$2" "$RELEASE_ID" >>"$EVENTS_FILE"
    return 0
  fi
  command node "$@"
}
pm2() { command node "$PM2_FIXTURE" "$STATE_FILE" "$@"; }
port_in_use() { pm2 port; }
sleep() { :; }
ss() { printf 'LISTEN pid=4242,\n'; }
cleanup_candidate() { :; }
safe_remove_staging() { :; }
validate_payload_inventory() { :; }
atomic_symlink() { :; }
unexpected_error() { return 1; }
require_trusted_controller_file() { :; }
PM2_DUMP_PATH="$test_root/dump.json"
verify_exact_active_composite() {
  verify_pm2_identity "$1" "$2" "$3" "$4" "$6" "$7" "$8" "$9"
}
verify_legacy_active_composite() { verify_exact_active_composite "$@"; }
persist_pm2_state() {
  pm2 dump "$PM2_DUMP_PATH"
  verify_pm2_dump_identity "$@"
}
`;
  const activationFooter = String.raw`
if [[ "$scenario" == *-fail || "$scenario" == duplicate || "$scenario" == port-held || "$scenario" == delete-retained ]]; then
  if activate_pm2 "$CANDIDATE/.release/ecosystem.config.cjs" "$RELEASE_ID" "$COMMIT_SHA" candidate-build candidate-assets candidate-manifest candidate-source candidate-output; then exit 90; fi
  [[ "$RELEASE_ID" == candidate-operation && "$ASSET_DIGEST" == candidate-assets ]] || exit 91
  exit 42
fi
activate_pm2 "$CANDIDATE/.release/ecosystem.config.cjs" "$RELEASE_ID" "$COMMIT_SHA" candidate-build candidate-assets candidate-manifest candidate-source candidate-output
[[ "$RELEASE_ID" == candidate-operation && "$ASSET_DIGEST" == candidate-assets ]] || exit 91
verify_pm2_identity "$CANDIDATE" "$RELEASE_ID" "$COMMIT_SHA" candidate-build candidate-assets candidate-manifest candidate-source candidate-output
persist_pm2_state "$CANDIDATE" "$RELEASE_ID" "$COMMIT_SHA" candidate-build candidate-assets candidate-manifest candidate-source candidate-output
for field in pm_cwd pm_exec_path; do
  wrong="$PREVIOUS_TARGET"
  [[ "$field" != pm_exec_path ]] || wrong="$PREVIOUS_TARGET/server.js"
  pm2 corrupt "$field" "$wrong"
  if verify_pm2_identity "$CANDIDATE" "$RELEASE_ID" "$COMMIT_SHA" candidate-build candidate-assets candidate-manifest candidate-source candidate-output; then exit 92; fi
  if persist_pm2_state "$CANDIDATE" "$RELEASE_ID" "$COMMIT_SHA" candidate-build candidate-assets candidate-manifest candidate-source candidate-output; then exit 93; fi
  correct="$CANDIDATE"
  [[ "$field" != pm_exec_path ]] || correct="$CANDIDATE/server.js"
  pm2 corrupt "$field" "$correct"
done
rollback_release fixture-failed-production
[[ "$RELEASE_ID" == candidate-operation && "$ASSET_DIGEST" == candidate-assets && "$ROLLBACK_SUCCEEDED" == 1 && "$DIRECT_ROLLBACK_COMPLETE" == 1 ]] || exit 94
exec {HISTORY_FD}>"$test_root/history.tsv"
trap final_cleanup EXIT
exit 7
`;
  fs.writeFileSync(activationHarnessPath,
    `${activationHarness}\n${activatePm2}\n${verifyPm2Identity}\n${verifyPm2Dump}\n${verifyPm2Absent}\n${directHook}\n${rollbackFunction}\n${finalCleanup}\n${activationFooter}`);
  for (const service of ["web", "voice"]) {
    for (const scenario of ["native", "legacy", "initially-absent", "jlist-fail", "stop-fail", "delete-fail", "start-fail", "duplicate", "port-held", "delete-retained"]) {
      const caseRoot = path.join(temporaryRoot, `activation-${service}-${scenario}`);
      fs.mkdirSync(caseRoot, { recursive: true });
      for (const targetName of ["old", "new"]) {
        const target = path.join(caseRoot, targetName);
        fs.mkdirSync(path.join(target, ".release"), { recursive: true });
        fs.writeFileSync(path.join(target, "server.js"), "// sealed fixture entrypoint\n");
        fs.writeFileSync(path.join(target, ".release", "ecosystem.config.cjs"), JSON.stringify({ target, script: path.join(target, "server.js") }));
      }
      const sentinel = { name: "voice-studio", pid: 9876, pm2_env: { status: "online", pm_cwd: "unrelated", pm_exec_path: "unrelated", PORT: "9999" } };
      const previous = { name: `agent-hub-${service}`, pid: 4242, pm2_env: { status: "online", pm_cwd: path.join(caseRoot, "old"), pm_exec_path: path.join(caseRoot, "old", "server.js") } };
      fs.writeFileSync(path.join(caseRoot, "state.json"), JSON.stringify({ name: previous.name, port: service === "web" ? "5000" : "5001", scenario, portHeld: scenario === "port-held", events: [], processes: [sentinel, ...(scenario === "initially-absent" ? [] : [previous]), ...(scenario === "duplicate" ? [previous] : [])] }));
      const run = runBash(bash, activationHarnessPath, [caseRoot, pm2FixturePath, service, scenario]);
      const success = scenario === "native" || scenario === "legacy" || scenario === "initially-absent";
      assert.equal(run.status, success ? 7 : 42, `${service}/${scenario} activation regression failed: ${run.stderr || run.stdout}`);
      const state = JSON.parse(fs.readFileSync(path.join(caseRoot, "state.json"), "utf8"));
      assert.deepEqual(state.processes.find(p => p.name === "voice-studio"), sentinel, "unrelated PM2 application must remain unchanged");
      if (success) {
        assert.deepEqual(state.events, [...(scenario === "initially-absent" ? [] : ["stop", "delete"]), "start", "stop", "stop", "delete", "start"]);
        const restored = state.processes.find(p => p.name === previous.name);
        assert.equal(fs.realpathSync(restored.pm2_env.pm_cwd), fs.realpathSync(path.join(caseRoot, "old")));
        assert.equal(fs.realpathSync(restored.pm2_env.pm_exec_path), fs.realpathSync(path.join(caseRoot, "old", "server.js")));
        assert.equal(restored.pm2_env.RELEASE_ID, "previous-release");
        assert.deepEqual(fs.readFileSync(path.join(caseRoot, "hooks.log"), "utf8").trim().split(/\r?\n/u), ["rollback-before:candidate-operation", "rollback-after:candidate-operation", "rollback-persisted:candidate-operation"]);
        const history = fs.readFileSync(path.join(caseRoot, "history.tsv"), "utf8").trim().split("\t");
        assert.equal(history[1], "FAILED");
        assert.equal(history[2], "candidate-operation");
        assert.equal(history[4], "b".repeat(64));
        assert.equal(history[5], "a".repeat(40));
        assert.equal(history[6], "candidate-assets");
      } else if (scenario !== "start-fail") {
        assert.ok(!state.events.includes("start"), "a failed stop/delete/quiescence/absence prerequisite must prevent start");
      }
      dynamicResults.push({ harness: "activation-rollback", service, scenario, status: run.status, unrelatedAppPreserved: true });
    }
  }

  const candidateLogHarnessPath = path.join(temporaryRoot, "candidate-log-harness.sh");
  const candidateLogHarness = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'CANDIDATE_PRIVATE_LOG="$1"',
    'CANDIDATE_LOG="$2"',
    'scenario="$3"',
    'SERVICE="web"',
    'RELEASE_ID="V999.1-aaaaaaaaaaaa"',
    'CANDIDATE_UID="$(node - "$CANDIDATE_PRIVATE_LOG" <<\'NODE\'\nconst fs=require("node:fs");process.stdout.write(String(fs.statSync(process.argv[2]).uid));\nNODE\n)"',
    'case "$scenario" in',
    '  fresh) publish_candidate_log ;;',
    '  existing-valid) publish_candidate_log; publish_candidate_log ;;',
    '  existing-zero) : >"$CANDIDATE_LOG"; publish_candidate_log ;;',
    '  existing-truncated) printf \'candidate-log.v2 service=web release=V999.1-aaaaaaaaaaaa source_bytes=1\\n\' >"$CANDIDATE_LOG"; publish_candidate_log ;;',
    '  existing-tampered) printf \'candidate-log.v2 service=web release=V999.1-aaaaaaaaaaaa source_bytes=1 source_tail_bytes=1 payload_bytes=1 payload_sha256=%064d\\nX\' 0 >"$CANDIDATE_LOG"; publish_candidate_log ;;',
    '  *) exit 91 ;;',
    'esac',
    "",
  ].join("\n");
  fs.writeFileSync(candidateLogHarnessPath, `${publishCandidateLog}\n${candidateLogHarness}`, { mode: 0o700 });
  for (const testCase of [
    { scenario: "fresh", expectedStatus: 0 },
    { scenario: "existing-valid", expectedStatus: 0 },
    { scenario: "existing-zero", expectedStatus: 1 },
    { scenario: "existing-truncated", expectedStatus: 1 },
    { scenario: "existing-tampered", expectedStatus: 1 },
  ]) {
    const caseRoot = path.join(temporaryRoot, `candidate-log-${testCase.scenario}`);
    fs.mkdirSync(caseRoot, { recursive: true });
    const privateLog = path.join(caseRoot, "candidate-private.log");
    const publishedLog = path.join(caseRoot, "candidate-public.log");
    const privateContent = "boot ok\\napi_key=private-value\\nfinal line\\n";
    fs.writeFileSync(privateLog, privateContent, { mode: 0o600 });
    const run = runBash(bash, candidateLogHarnessPath, [privateLog, publishedLog, testCase.scenario]);
    assert.equal(run.status, testCase.expectedStatus, `${testCase.scenario} candidate-log fault injection mismatch: ${run.stderr || run.stdout}`);
    assert.equal(fs.readFileSync(privateLog, "utf8"), privateContent, `${testCase.scenario} must retain the private candidate log`);
    if (testCase.expectedStatus === 0) {
      const published = fs.readFileSync(publishedLog, "utf8");
      assert.match(published, /^candidate-log\.v2 service=web release=V999\.1-aaaaaaaaaaaa source_bytes=[0-9]+ source_tail_bytes=[0-9]+ payload_bytes=[0-9]+ payload_sha256=[a-f0-9]{64}\n/u);
      assert.match(published, /api_key=\[REDACTED\]/u);
      assert.doesNotMatch(published, /private-value/u);
    } else {
      assert.ok(fs.existsSync(publishedLog), `${testCase.scenario} fault fixture must remain available for diagnosis`);
    }
    dynamicResults.push({ harness: "candidate-log", scenario: testCase.scenario, status: run.status, privateLogRetained: true });
  }

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
    'candidate_unit=""',
    'candidate_cgroup=""',
    'CANDIDATE_LOG=""',
    'CANDIDATE_PRIVATE_LOG=""',
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

  const candidateCleanupHarnessPath = path.join(temporaryRoot, "candidate-cleanup-harness.sh");
  const candidateCleanupMarkerPath = path.join(temporaryRoot, "candidate-cleanup-events.log");
  const candidateCleanupHeader = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'marker="$1"',
    'scenario="$2"',
    'test_root="$3"',
    'CGROUP_ROOT="$test_root/cgroup"',
    'STAGING_ROOT="$test_root/staging-root"',
    'STAGING_DIR="$STAGING_ROOT/candidate-staging"',
    'RELEASE_ROOT="$test_root/releases"',
    'AUDIT_DIR=""',
    'PAYLOAD_DIR=""',
    'candidate_pid="4242"',
    'candidate_unit="zimeiti-candidate-web-4321.service"',
    'candidate_cgroup="/system.slice/$candidate_unit"',
    'CANDIDATE_LOG=""',
    'CANDIDATE_PRIVATE_LOG=""',
    'CANDIDATE_UID="4242"',
    'SERVICE="web"',
    'RELEASE_ID="V999.1-aaaaaaaaaaaa"',
    'APP_TEMP_LINK=""',
    'ASSET_TEMP_LINK=""',
    'HISTORY_FD=""',
    'SWITCH_STARTED="0"',
    'DEPLOY_COMPLETE="0"',
    'ROLLBACK_ATTEMPTED="0"',
    'ROLLBACK_SUCCEEDED="0"',
    'IN_ROLLBACK="0"',
    'FAILURE_CONTEXT=""',
    'DIRECT_PREPARED="0"',
    'DIRECT_ROLLBACK_COMPLETE="0"',
    'STATE="active"',
    'MAIN_PID="4242"',
    'POPULATED="1"',
    'PHASE="direct"',
    'mkdir -p "$CGROUP_ROOT$candidate_cgroup" "$STAGING_DIR"',
    "write_cgroup_state() { printf 'populated %s\\n' \"$POPULATED\" >\"$CGROUP_ROOT$candidate_cgroup/cgroup.events\"; }",
    "write_cgroup_state",
    "systemctl() {",
    '  local action="${1:-}" property',
    "  shift || true",
    '  case "$action" in',
    "    show)",
    '      property="${1#--property=}"',
    '      case "$property" in',
    "        LoadState) printf 'loaded\\n' ;;",
    "        ActiveState) printf '%s\\n' \"$STATE\" ;;",
    "        MainPID) printf '%s\\n' \"$MAIN_PID\" ;;",
    "        ControlGroup) printf '%s\\n' \"$candidate_cgroup\" ;;",
    "        *) return 64 ;;",
    "      esac",
    "      ;;",
    "    stop)",
    '      [[ "${1:-}" == "--" && "${2:-}" == "$candidate_unit" ]] || return 66',
    "      printf 'STOP:%s\\n' \"$PHASE\" >>\"$marker\"",
    '      if [[ "$scenario" == "stop-inactive" ]]; then STATE="inactive"; MAIN_PID="0"; POPULATED="0"; write_cgroup_state; fi',
    "      ;;",
    "    kill)",
    '      [[ "${1:-}" == "--kill-whom=all" && "${2:-}" == "--signal=SIGKILL" && "${3:-}" == "--" && "${4:-}" == "$candidate_unit" ]] || return 67',
    "      printf 'KILL:%s\\n' \"$PHASE\" >>\"$marker\"",
    '      if [[ "$scenario" == "kill-recovery" ]]; then STATE="inactive"; MAIN_PID="0"; POPULATED="0"; write_cgroup_state; fi',
    "      ;;",
    "    reset-failed) printf 'RESET:%s\\n' \"$PHASE\" >>\"$marker\" ;;",
    "    *) return 65 ;;",
    "  esac",
    "}",
    "sleep() { :; }",
    "publish_candidate_log() { printf 'PUBLISH:%s\\n' \"$PHASE\" >>\"$marker\"; }",
    "safe_remove_staging() { printf 'REMOVE:%s\\n' \"$PHASE\" >>\"$marker\"; command rm -rf -- \"$STAGING_DIR\"; }",
    "direct_hook() { return 0; }",
    "rollback_release() { return 0; }",
  ].join("\n");
  const candidateCleanupFooter = [
    "set +e",
    "cleanup_candidate",
    'direct_status="$?"',
    "set -e",
    "printf 'DIRECT:%s:unit=%s:pid=%s:cgroup=%s:state=%s:populated=%s\\n' \"$direct_status\" \"$candidate_unit\" \"$candidate_pid\" \"$candidate_cgroup\" \"$STATE\" \"$POPULATED\" >>\"$marker\"",
    'candidate_pid="4242"',
    'candidate_unit="zimeiti-candidate-web-4321.service"',
    'candidate_cgroup="/system.slice/$candidate_unit"',
    'STATE="active"',
    'MAIN_PID="4242"',
    'POPULATED="1"',
    'PHASE="final"',
    "write_cgroup_state",
    "trap final_cleanup EXIT",
    "exit 0",
    "",
  ].join("\n");
  fs.writeFileSync(
    candidateCleanupHarnessPath,
    `${candidateCleanupHeader}\n${harnessCandidateCgroupEmpty}\n${candidateUnitStopped}\n${waitCandidateUnitStopped}\n${cleanupCandidate}\n${finalCleanup}\n${candidateCleanupFooter}`,
    { mode: 0o700 },
  );
  for (const testCase of [
    { scenario: "stop-inactive", expectedStatus: 0, expectedDirectStatus: 0, expectedKillCount: 0, expectedStagingRemoved: true },
    { scenario: "kill-recovery", expectedStatus: 0, expectedDirectStatus: 0, expectedKillCount: 2, expectedStagingRemoved: true },
    { scenario: "kill-stuck", expectedStatus: 1, expectedDirectStatus: 1, expectedKillCount: 2, expectedStagingRemoved: false },
  ]) {
    const caseRoot = path.join(temporaryRoot, `candidate-cleanup-${testCase.scenario}`);
    fs.mkdirSync(caseRoot, { recursive: true });
    fs.writeFileSync(candidateCleanupMarkerPath, "");
    const run = runBash(bash, candidateCleanupHarnessPath, [candidateCleanupMarkerPath, testCase.scenario, caseRoot]);
    assert.equal(run.status, testCase.expectedStatus, `${testCase.scenario} candidate cleanup status mismatch: ${run.stderr || run.stdout}`);
    const events = fs.readFileSync(candidateCleanupMarkerPath, "utf8");
    const directMatch = /^DIRECT:(\d+):unit=([^:]*):pid=([^:]*):cgroup=([^:]*):state=([^:]*):populated=([^:\r\n]*)$/mu.exec(events);
    assert.ok(directMatch, `${testCase.scenario} candidate cleanup did not report its direct state: ${events}`);
    assert.equal(Number(directMatch[1]), testCase.expectedDirectStatus, `${testCase.scenario} direct cleanup status mismatch`);
    const killCount = (events.match(/^KILL:/gmu) ?? []).length;
    assert.equal(killCount, testCase.expectedKillCount, `${testCase.scenario} systemctl kill count mismatch`);
    const stagingPath = path.join(caseRoot, "staging-root", "candidate-staging");
    assert.equal(fs.existsSync(stagingPath), !testCase.expectedStagingRemoved, `${testCase.scenario} staging retention mismatch`);
    if (testCase.expectedDirectStatus === 0) {
      assert.deepEqual(directMatch.slice(2), ["", "", "", "inactive", "0"], `${testCase.scenario} must clear candidate handles only after inactive/MainPID=0/populated=0`);
      assert.match(events, /^REMOVE:final$/mu, `${testCase.scenario} final cleanup must allow staging removal`);
    } else {
      assert.deepEqual(
        directMatch.slice(2),
        ["zimeiti-candidate-web-4321.service", "4242", "/system.slice/zimeiti-candidate-web-4321.service", "active", "1"],
        `${testCase.scenario} must retain candidate handles and STATE after an unconfirmed kill`,
      );
      assert.doesNotMatch(events, /^REMOVE:/mu, `${testCase.scenario} final cleanup must not call safe_remove_staging`);
      assert.match(run.stderr, /CLEANUP BLOCKED: candidate unit remains controlled/u, `${testCase.scenario} must report blocked candidate cleanup`);
      assert.match(run.stderr, /CLEANUP RETAINED:/u, `${testCase.scenario} must report retained staging`);
    }
    dynamicResults.push({
      harness: "candidate-cleanup",
      scenario: testCase.scenario,
      directCleanupStatus: Number(directMatch[1]),
      killCount,
      stagingRemoved: testCase.expectedStagingRemoved,
      status: run.status,
    });
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
    'PERSIST_FAIL="0"',
    'FAIL_RM="0"',
    'CURRENT_MATCH="1"',
    'ASSET_MATCH="1"',
    'mkdir -p "$CANDIDATE" "$PREVIOUS_ASSET_TARGET"',
    ': >"$ASSET_CURRENT_LINK"',
    'case "$scenario" in',
    '  verify-clean|rollback-current|rollback-rm-fail|rollback-persist-fail) ;;',
    '  verify-current) : >"$CURRENT_LINK" ;;',
    '  verify-previous) PREVIOUS_TARGET="$test_root/old-release" ;;',
    '  verify-asset) ASSET_MATCH="0" ;;',
    '  verify-pm2) PM2_PRESENT="1" ;;',
    '  rollback-absent) ;;',
    '  rollback-unexpected) : >"$CURRENT_LINK"; CURRENT_MATCH="0" ;;',
    '  *) exit 91 ;;',
    'esac',
    'if [[ "$scenario" == "rollback-current" || "$scenario" == "rollback-rm-fail" || "$scenario" == "rollback-persist-fail" ]]; then : >"$CURRENT_LINK"; fi',
    'if [[ "$scenario" == "rollback-rm-fail" ]]; then FAIL_RM="1"; fi',
    'if [[ "$scenario" == "rollback-persist-fail" ]]; then PERSIST_FAIL="1"; fi',
    'cleanup_candidate() { :; }',
    'port_in_use() { [[ "$PORT_PRESENT" == "1" ]]; }',
    'link_resolves_to() { if [[ "$1" == "$CURRENT_LINK" ]]; then [[ "$CURRENT_MATCH" == "1" && -e "$CURRENT_LINK" ]]; else [[ "$1" == "$ASSET_CURRENT_LINK" && "$ASSET_MATCH" == "1" ]]; fi; }',
    'pm2() { if [[ "${1:-}" == "jlist" ]]; then [[ "$PM2_PRESENT" == "0" ]] && printf "[]" || printf "[{\\"name\\":\\"agent-hub-web\\"}]"; fi; return 0; }',
    'verify_pm2_absent() { [[ "$PM2_PRESENT" == "0" && "$PORT_PRESENT" == "0" ]]; }',
    'atomic_symlink() { return 0; }',
    'validate_payload_inventory() { return 0; }',
    'activate_pm2() { return 0; }',
    'verify_exact_active_composite() { return 0; }',
    'persist_pm2_state() { [[ "$PERSIST_FAIL" == "0" ]]; }',
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
    { scenario: "rollback-persist-fail", expected: 42 },
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
