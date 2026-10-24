#!/usr/bin/env node
// Local admin CAS only. Never dispatch providers, retry, roll back, or reapply.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { runtimeIdentity } from "./verify-image-workbench-live-e2e.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://127.0.0.1:5000";
const FROM_ID = "76b48548-6542-4908-a9f7-10835d2528bb";
const TO_ID = "3af4f2e6-a51f-44f6-ad17-9e6412147c81";
const TO_NAME = "claude-opus-5-5";
export const TARGETS = Object.freeze([
  Object.freeze({ id: "agent-1786633444187-594spj", revision: 37,
    promptSha256: "bb8aeb3ffdd26e0db8e21a0be49875e28df6a4923ae73eee282000f966ff6891" }),
  Object.freeze({ id: "agent-1786843330392-emdjv2", revision: 40,
    promptSha256: "6b2b060dae959488e2b894f38a76a18365f7825a5afa04484907e1dee321620a" }),
]);
const sha = value => createHash("sha256").update(value).digest("hex");
const ensure = (condition, code) => { if (!condition) throw new Error(code); };
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));
const codeFor = error => /^REBIND_[A-Z0-9_]+$/u.test(error?.message || "") ? error.message : "REBIND_STOPPED_READ_EVIDENCE";
const mutable = new Set(["model_id", "model", "config_revision", "updated_at"]);
const protectedConfig = row => Object.fromEntries(Object.entries(row).filter(([key]) => !mutable.has(key)));

export function parseArgs(args) {
  const values = {}, flags = new Set();
  for (const arg of args) {
    if (["--execute", "--self-test"].includes(arg)) {
      ensure(!flags.has(arg), "REBIND_DUPLICATE_ARGUMENT"); flags.add(arg); continue;
    }
    const match = /^--(run-id|source-version|build-id)=(.+)$/u.exec(arg);
    ensure(match && !Object.hasOwn(values, match[1]), "REBIND_ARGUMENT_INVALID");
    values[match[1]] = match[2];
  }
  if (flags.has("--self-test")) { ensure(args.length === 1, "REBIND_SELF_TEST_ONLY"); return { selfTest: true }; }
  ensure(/^[A-Za-z0-9_-]{8,100}$/u.test(values["run-id"] || ""), "REBIND_RUN_ID_REQUIRED");
  ensure(Boolean(values["source-version"] && values["build-id"]), "REBIND_RUNTIME_PINS_REQUIRED");
  return { execute: flags.has("--execute"), ...values };
}

export function agentSummary(row) {
  return { id: row.id, revision: Number(row.config_revision), promptSha256: sha(row.system_prompt || ""),
    modelId: row.model_id ?? null, modelName: row.model ?? null,
    responseFormat: row.response_format ?? null, maxReplyTokens: row.max_reply_tokens ?? null,
    timeout: row.timeout ?? null, outputStyleSha256: digest(row.output_style ?? null),
    protectedConfigSha256: digest(protectedConfig(row)) };
}

export function validateBefore(rows, targets = TARGETS) {
  ensure(Array.isArray(rows), "REBIND_AGENTS_INVALID");
  return targets.map(target => {
    const matches = rows.filter(row => row.id === target.id);
    ensure(matches.length === 1, "REBIND_DIRECTOR_REQUIRED");
    const row = matches[0];
    ensure(row.is_active === true && row.source === "llm", "REBIND_ACTIVE_LLM_REQUIRED");
    ensure(row.config_revision === target.revision, "REBIND_REVISION_DRIFT");
    ensure(sha(row.system_prompt || "") === target.promptSha256, "REBIND_PROMPT_DRIFT");
    ensure(row.model_id === FROM_ID && row.model === "gpt-6.1-sol", "REBIND_SOURCE_MODEL_DRIFT");
    ensure(row.response_format !== "json_object", "REBIND_AGENT_FORMAT_FORBIDDEN");
    return row;
  });
}

export function validateModel(model, eligible) {
  ensure(model?.id === TO_ID && model.model_name === TO_NAME && model.model_type === "text", "REBIND_TARGET_MODEL_MISMATCH");
  ensure(model.is_active === true && model.api_key_configured === true && eligible(model), "REBIND_TARGET_MODEL_UNAVAILABLE");
  ensure(model.response_format !== "json_object", "REBIND_TARGET_MODEL_FORMAT_FORBIDDEN");
  return { id: model.id, modelName: model.model_name, active: true, credentialConfigured: true,
    responseFormat: model.response_format ?? null };
}

export function verifyMutation(before, after) {
  ensure(after?.id === before.id && after.config_revision === before.config_revision + 1, "REBIND_READBACK_REVISION_DRIFT");
  ensure(after.model_id === TO_ID && after.model === TO_NAME, "REBIND_READBACK_MODEL_DRIFT");
  ensure(digest(protectedConfig(after)) === digest(protectedConfig(before)), "REBIND_PROTECTED_CONFIG_CHANGED");
}

function verifyInventory(before, after, completed) {
  ensure(Array.isArray(after) && before.length === after.length, "REBIND_INVENTORY_CHANGED");
  for (const row of before) {
    const matches = after.filter(candidate => candidate.id === row.id);
    ensure(matches.length === 1, "REBIND_INVENTORY_CHANGED");
    if (completed.has(row.id)) verifyMutation(row, matches[0]);
    else ensure(digest(row) === digest(matches[0]), "REBIND_OTHER_CONFIG_CHANGED");
  }
}

export async function runRebind({ execute, readAgents, readModel, readRuntime, readActor, writeBinding, save,
  eligible, targets = TARGETS }) {
  let beforeRows, runtimeBefore, actorBefore, rollback = [];
  const completed = new Set(), progress = [];
  try {
    runtimeBefore = await readRuntime();
    actorBefore = await readActor();
    ensure(actorBefore?.role === "admin" && actorBefore.id, "REBIND_ADMIN_REQUIRED");
    beforeRows = await readAgents();
    const rows = validateBefore(beforeRows, targets);
    const model = validateModel(await readModel(), eligible);
    const before = rows.map(agentSummary);
    // Only non-secret bindings and immutable hashes are retained for manual recovery.
    rollback = before.map(row => ({ agentId: row.id, originalModelId: row.modelId,
      originalModelName: row.modelName, originalRevision: row.revision,
      promptSha256: row.promptSha256, protectedConfigSha256: row.protectedConfigSha256 }));
    await save("before.json", { mode: execute ? "execute" : "plan", runtimeBefore,
      actorId: actorBefore.id, before, targetModel: model, rollback, providerCalls: 0 });
    if (execute) {
      for (const target of targets) {
        ensure(digest(await readRuntime()) === digest(runtimeBefore), "REBIND_RUNTIME_CHANGED");
        ensure(digest(await readActor()) === digest(actorBefore), "REBIND_ACTOR_CHANGED");
        validateModel(await readModel(), eligible);
        const currentRows = await readAgents();
        verifyInventory(beforeRows, currentRows, completed);
        const body = { agentId: target.id, expected_revision: target.revision, model_id: TO_ID };
        await save(`${target.id}-intent.json`, { ...body, fromModelId: FROM_ID, promptSha256: target.promptSha256 });
        const operation = { agentId: target.id, expectedRevision: target.revision, state: "dispatched" };
        progress.push(operation);
        // One independent CAS per director; neither conflicts nor uncertain replies are retried.
        const result = await writeBinding(body);
        operation.httpStatus = result.status;
        await save(`${target.id}-response.json`, { agentId: target.id, httpStatus: result.status, ok: result.ok });
        ensure(result.ok, "REBIND_CAS_REJECTED_OR_UNKNOWN");
        operation.state = "acknowledged";
        const after = await readAgents();
        const expectedCompleted = new Set([...completed, target.id]);
        verifyInventory(beforeRows, after, expectedCompleted);
        completed.add(target.id);
        operation.state = "verified";
        await save(`${target.id}-readback.json`, agentSummary(after.find(row => row.id === target.id)));
      }
    }
    const afterRows = await readAgents();
    verifyInventory(beforeRows, afterRows, completed);
    const runtimeAfter = await readRuntime();
    ensure(digest(runtimeAfter) === digest(runtimeBefore), "REBIND_RUNTIME_CHANGED");
    ensure(digest(await readActor()) === digest(actorBefore), "REBIND_ACTOR_CHANGED");
    validateModel(await readModel(), eligible);
    const report = { success: true, mode: execute ? "execute" : "plan", runtimeBefore, runtimeAfter,
      before, after: targets.map(target => agentSummary(afterRows.find(row => row.id === target.id))),
      rollback, progress, adminWrites: progress.length, providerCalls: 0, automaticRetries: 0,
      automaticRollback: false, automaticReapply: false };
    await save("report.json", report);
    return report;
  } catch (error) {
    const [agents, runtime] = await Promise.allSettled([readAgents(), readRuntime()]);
    const report = { success: false, mode: execute ? "execute" : "plan", errorCode: codeFor(error),
      runtimeBefore: runtimeBefore ?? null, runtimeAfter: runtime.status === "fulfilled" ? runtime.value : null,
      before: Array.isArray(beforeRows) ? targets.map(target => beforeRows.find(row => row.id === target.id)).filter(Boolean).map(agentSummary) : [],
      after: agents.status === "fulfilled" && Array.isArray(agents.value)
        ? targets.map(target => agents.value.find(row => row.id === target.id)).filter(Boolean).map(agentSummary) : null,
      afterReadbackStatus: agents.status, rollback, progress, adminWrites: progress.length, providerCalls: 0,
      automaticRetries: 0, automaticRollback: false, automaticReapply: false,
      recovery: "Inspect original operation and current revision; never repeat this run automatically." };
    await save("failure.json", report);
    return report;
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.selfTest) return selfTest();
  ensure(process.env.LOCAL_NAV_ORIGIN === ORIGIN, "REBIND_LOCAL_ORIGIN_REQUIRED");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  ensure(token && stepUp, "REBIND_CONTROLLED_STEP_UP_REQUIRED");
  const directory = path.join(ROOT, ".codex-evidence/storyboard-foundation-20261020", options["run-id"]);
  await fs.mkdir(directory, { recursive: false });
  const pins = { origin: ORIGIN, expectedSourceVersion: options["source-version"], expectedBuildId: options["build-id"] };
  const api = async (endpoint, body) => {
    const response = await fetch(ORIGIN + endpoint, { method: body ? "PUT" : "GET",
      headers: { Authorization: `Bearer ${token}`, "x-admin-step-up": stepUp, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
    if (body) { await response.body?.cancel(); return { ok: response.ok, status: response.status }; }
    ensure(response.ok, "REBIND_ADMIN_READ_FAILED");
    return response.json();
  };
  const { isPublishedTextModelEligible } = await tsImport("../src/lib/text-model-eligibility.ts", import.meta.url);
  const report = await runRebind({ execute: options.execute,
    eligible: isPublishedTextModelEligible,
    readRuntime: () => runtimeIdentity(pins),
    readActor: async () => { const body = await api("/api/auth/me"); return { id: body.user?.id, role: body.user?.role }; },
    readAgents: async () => { const body = await api("/api/admin/agents?include_prompt=1&include_internal=1&include_configuration=1");
      return Array.isArray(body) ? body : body.agents; },
    readModel: async () => (await api("/api/admin/models")).models?.find(row => row.id === TO_ID),
    writeBinding: body => api("/api/admin/agents", body),
    save: (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" }),
  });
  console.log(JSON.stringify({ success: report.success, mode: report.mode, errorCode: report.errorCode || null,
    adminWrites: report.adminWrites, providerCalls: 0, directory }));
  if (!report.success) process.exitCode = 1;
}

async function selfTest() {
  let assertions = 0;
  const yes = run => { run(); assertions++; };
  const no = run => yes(() => assert.throws(run));
  const args = ["--run-id=rebind_fixture01", "--source-version=R1214", "--build-id=fixture-build"];
  yes(() => assert.equal(parseArgs(args).execute, false));
  yes(() => assert.equal(parseArgs([...args, "--execute"]).execute, true));
  for (const extras of [["--execute", "--execute"], ["--rollback-reapply"], ["--origin=https://example.com"],
    ["--run-id=../escape"], ["--model-id=other"], ["--self-test"]]) no(() => parseArgs([...args, ...extras]));
  no(() => parseArgs(args.slice(0, 1)));
  const targets = TARGETS.map((target, index) => ({ ...target, promptSha256: sha(`fixture-prompt-${index}`) }));
  const fixtureRows = targets.map((target, index) => ({ id: target.id, source: "llm", is_active: true,
    config_revision: target.revision, system_prompt: `fixture-prompt-${index}`, model_id: FROM_ID, model: "gpt-6.1-sol",
    response_format: "text", max_reply_tokens: 32768, timeout: 300, output_style: { schema_version: "v6" } }));
  const model = { id: TO_ID, model_name: TO_NAME, model_type: "text", is_active: true, api_key_configured: true, response_format: "text" };
  yes(() => validateBefore(fixtureRows, targets));
  for (const changes of [{ config_revision: 0 }, { system_prompt: "changed" }, { model_id: TO_ID },
    { is_active: false }, { response_format: "json_object" }]) no(() => validateBefore([{ ...fixtureRows[0], ...changes }, fixtureRows[1]], targets));
  yes(() => validateModel(model, () => true));
  for (const change of [{ is_active: false }, { api_key_configured: false }, { response_format: "json_object" },
    { model_name: "other" }, { model_type: "image" }]) no(() => validateModel({ ...model, ...change }, () => true));
  no(() => validateModel(model, () => false));
  const changed = { ...fixtureRows[0], model_id: TO_ID, model: TO_NAME, config_revision: 38 };
  yes(() => verifyMutation(fixtureRows[0], changed));
  for (const fields of [{ timeout: 301 }, { max_reply_tokens: 123 }, { response_format: "json_object" },
    { system_prompt: "changed" }, { config_revision: 39 }]) no(() => verifyMutation(fixtureRows[0], { ...changed, ...fields }));
  for (const scenario of ["plan", "success", "second-conflict", "unknown-first", "protected-change", "runtime-drift",
    "other-change", "target-unavailable", "actor-drift"]) {
    const rows = [...structuredClone(fixtureRows), { id: "unrelated-agent", config_revision: 19, timeout: 120 }];
    let writes = 0, runtimeReads = 0, actorReads = 0;
    const evidence = {};
    const report = await runRebind({ execute: scenario !== "plan", targets, eligible: () => true,
      readAgents: async () => structuredClone(rows),
      readModel: async () => scenario === "target-unavailable" ? { ...model, api_key_configured: false } : model,
      readRuntime: async () => ({ buildId: scenario === "runtime-drift" && ++runtimeReads > 1 ? "changed" : "fixture" }),
      readActor: async () => ({ id: scenario === "actor-drift" && ++actorReads > 1 ? "other-admin" : "fixture-admin", role: "admin" }),
      save: async (name, value) => { ensure(!Object.hasOwn(evidence, name), "REBIND_TEST_OVERWRITE"); evidence[name] = structuredClone(value); },
      writeBinding: async body => {
        writes++;
        assert.deepEqual(Object.keys(body).sort(), ["agentId", "expected_revision", "model_id"]);
        const row = rows.find(item => item.id === body.agentId);
        assert.equal(row.config_revision, body.expected_revision);
        if (scenario === "second-conflict" && writes === 2) return { ok: false, status: 409 };
        row.model_id = body.model_id; row.model = TO_NAME; row.config_revision++;
        if (scenario === "unknown-first") throw new Error("network-private-diagnostic");
        if (scenario === "protected-change") row.timeout++;
        if (scenario === "other-change") rows[2].timeout++;
        return { ok: true, status: 200 };
      },
    });
    yes(() => assert.equal(report.success, ["plan", "success"].includes(scenario)));
    yes(() => assert.equal(writes, ["plan", "runtime-drift", "target-unavailable", "actor-drift"].includes(scenario) ? 0
      : ["unknown-first", "protected-change", "other-change"].includes(scenario) ? 1 : 2));
    yes(() => assert.equal(report.adminWrites, writes));
    yes(() => assert.equal(report.automaticRollback, false));
    yes(() => assert.equal(report.automaticRetries, 0));
    if (scenario === "second-conflict") {
      yes(() => assert.equal(report.after[0].modelId, TO_ID));
      yes(() => assert.equal(report.after[1].modelId, FROM_ID));
      yes(() => assert.equal(report.progress[0].state, "verified"));
    }
  }
  console.log(JSON.stringify({ success: true, selfTest: true, assertions, networkCalls: 0, providerCalls: 0, businessWrites: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(JSON.stringify({ success: false, errorCode: codeFor(error),
    automaticRetries: 0, automaticRollback: false })); process.exitCode = 1; });
}
