import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const intakePath = path.resolve(root, "scripts/update-3d-story-director-intake-templates.ts");
const promptPath = path.resolve(root, "scripts/update-3d-story-director-breed-priority.ts");
const [intake, prompt] = await Promise.all([
  fs.readFile(intakePath, "utf8"),
  fs.readFile(promptPath, "utf8"),
]);

for (const [label, source] of [["intake", intake], ["prompt", prompt]]) {
  assert.doesNotMatch(source, /\.select\(["']\*["']\)/u, `${label} updater仍会读取并备份完整Agent行`);
  assert.match(source, /id,name,system_prompt,preset_fields,updated_at,deleted_at/u, `${label} updater缺少安全字段白名单`);
  assert.match(source, /\.eq\(["']updated_at["']/u, `${label} updater缺少updated_at CAS`);
  assert.match(source, /--include-local/u, `${label} updater缺少双源执行门禁`);
}

assert.match(intake, /targets\.push\(await updateOneSource\(localDb/u, "接收卡 updater未先写本地验收库");
assert.ok(
  intake.indexOf("targets.push(await updateOneSource(localDb") < intake.indexOf("updateOneSource(db, \"shared-cloud\""),
  "接收卡 updater双源写入顺序异常",
);
assert.match(intake, /function canonicalizeJson[\s\S]*Object\.keys\(record\)[\s\S]*\.sort\(\)/u, "接收卡 updater未使用递归规范化JSON哈希");
assert.match(intake, /compensations[\s\S]*restorePreset/u, "接收卡 updater缺少基于数据库实态的双源失败补偿");
assert.doesNotMatch(intake, /localResult\?\.appliedThisRun/u, "接收卡 updater仍用返回标志判断是否补偿");
assert.match(prompt, /requireLatestHistoryMatch: false/u, "提示词 updater补偿路径仍不能读取history暂时落后的状态");
assert.match(prompt, /ensureCurrentPromptInHistory/u, "提示词 updater缺少中断后历史自愈");
assert.match(prompt, /restorePromptSnapshot[\s\S]*compensations/u, "提示词 updater缺少按运行前快照恢复的双源补偿");
assert.doesNotMatch(prompt, /localResult\?\.appliedThisRun|if \(promptUpdated\)/u, "提示词 updater仍用返回标志判断是否补偿");

const secretKeyPattern = /api[_-]?(?:key|token)|service[_-]?role[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|secret|credential/iu;
const backupRoots = [
  path.resolve(root, "backups/story-director-intake-template-20260928"),
  path.resolve(root, "backups/story-director-breed-priority-20260928"),
];
const sensitiveFindings = [];

function inspectKeys(value, file, trail = []) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectKeys(item, file, [...trail, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (secretKeyPattern.test(key)) sensitiveFindings.push({ file, keyPath: [...trail, key].join(".") });
    inspectKeys(child, file, [...trail, key]);
  }
}

async function walk(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(entryPath);
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      inspectKeys(JSON.parse(await fs.readFile(entryPath, "utf8")), entryPath);
    }
  }
}

for (const backupRoot of backupRoots) await walk(backupRoot);
assert.deepEqual(sensitiveFindings, [], `故事导演备份仍含敏感字段：${JSON.stringify(sensitiveFindings)}`);

console.log(JSON.stringify({
  status: "passed",
  agentBackupColumnsWhitelisted: true,
  promptRollbackReadsIntermediateState: true,
  promptInterruptedStateReconciliation: true,
  intakeCanonicalJsonHash: true,
  intakeDualSourceCasAndCompensation: true,
  sensitiveBackupFields: 0,
  paidCalls: 0,
}, null, 2));
