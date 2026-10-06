import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const ROOT = process.cwd();
const paths = {
  engineer: resolve(ROOT, "scripts", "migrations", "20260814_agent_engineer_5_1.sql"),
  engineerRollback: resolve(ROOT, "scripts", "migrations", "20260814_agent_engineer_5_1_rollback.sql"),
  storyBlocked: resolve(ROOT, "scripts", "migrations", "20260814_storyboard_director_agents_v6.sql"),
  story: resolve(ROOT, "scripts", "migrations", "20260814_storyboard_director_agents_v6_1.sql"),
  storyRollback: resolve(ROOT, "scripts", "migrations", "20260814_storyboard_director_agents_v6_1_rollback.sql"),
};
const sql = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, "utf8")])) as Record<keyof typeof paths, string>;

const STORY_TARGETS = [
  { id: "agent-1786633444187-594spj", mode: "high_energy" },
  { id: "agent-1786642714227-e1zid1", mode: "cinematic" },
  { id: "agent-1786642714448-m6iaou", mode: "lyrical" },
] as const;

function assertTransaction(value: string) {
  assert.match(value, /^\s*(?:--[^\n]*\n)*BEGIN;/i);
  assert.match(value, /COMMIT;\s*$/i);
}

function assertBalancedDollarQuotes(value: string) {
  const tags = value.match(/\$[A-Za-z_][A-Za-z0-9_]*\$/g) ?? [];
  const counts = new Map<string, number>();
  for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  for (const [tag, count] of counts) {
    assert.equal(count % 2, 0, `unbalanced SQL dollar quote ${tag}`);
  }
}

for (const value of [sql.engineer, sql.engineerRollback, sql.story, sql.storyRollback]) {
  assertTransaction(value);
  assertBalancedDollarQuotes(value);
  assert.doesNotMatch(value, /to_jsonb\s*\(\s*agents\s*\)/i);
  assert.doesNotMatch(value, /['"](?:api_key|proxy_url|provider|user_id|credits)['"]/i);
}

assert.match(sql.storyBlocked, /Blocked obsolete migration/);
assert.match(sql.storyBlocked, /RAISE EXCEPTION/);
assert.match(sql.engineer, /agent_engineer_5_1 preflight failed/);
assert.match(sql.engineer, /agent_engineer_5_1 postcondition failed/);
assert.match(sql.story, /storyboard v6\.1 preflight failed/);
assert.match(sql.story, /storyboard v6\.1 postcondition failed/);
assert.match(sql.engineer, /ENABLE ROW LEVEL SECURITY/);
assert.match(sql.story, /ENABLE ROW LEVEL SECURITY/);
assert.match(sql.engineer, /REVOKE ALL .* anon, authenticated/i);
assert.match(sql.story, /REVOKE ALL .* anon, authenticated/i);
assert.match(sql.engineer, /ON CONFLICT \(migration_key, agent_id\) DO NOTHING/);
assert.match(sql.story, /ON CONFLICT \(migration_key, agent_id\) DO NOTHING/);
assert.match(sql.engineer, /NOT EXISTS \([\s\S]*WHERE agent_id = 'agent-1781690935600-gkt1xg'/);
assert.match(sql.story, /NOT EXISTS \([\s\S]*prompt_versions\.agent_id = agents\.id/);
assert.match(sql.story, /left\(\s*agent\.system_prompt/);
assert.match(sql.story, /strpos\(agent\.system_prompt, '# 固定输出格式'\)/);

for (const target of STORY_TARGETS) {
  assert.ok(sql.story.includes(target.id));
  assert.ok(sql.storyRollback.includes(target.id));
  assert.ok(sql.story.includes(target.mode));
}
assert.ok(sql.engineer.includes("agent-1781690935600-gkt1xg"));
assert.ok(sql.engineerRollback.includes("agent-1781690935600-gkt1xg"));

const protocolTail = sql.story.match(/\$protocol\$([\s\S]*?)\$protocol\$/)?.[1];
if (!protocolTail || protocolTail.length <= 1000) {
  throw new Error("storyboard v6.1 protocol tail is missing or unexpectedly short");
}
const verifiedProtocolTail: string = protocolTail;
for (const marker of [
  "storyboard_director_output.v1",
  "panel_count",
  "layout",
  "pacing_mode",
  "actual_shot_count",
  "panoramic_anchor_role",
  "storyboard_image_prompt",
  "image_to_video_prompt",
  "semantic_visualizations",
]) {
  assert.ok(verifiedProtocolTail.includes(marker));
}
assert.ok(verifiedProtocolTail.includes("top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel"));
assert.ok(verifiedProtocolTail.includes("视频面板数与实际镜头数解耦"));

const replacementBlock = sql.story.slice(
  sql.story.indexOf("system_prompt = replace("),
  sql.story.indexOf("|| replace(protocol.tail"),
);
const targetedReplacements = [...replacementBlock.matchAll(/\n\s*'([^'\r\n]+)',\r?\n\s*'([^'\r\n]+)'/g)]
  .map((match) => [match[1], match[2]] as const);
assert.equal(targetedReplacements.length, 7, "expected seven exact layout/pacing replacements");

async function main() {
const url = process.env.COZE_SUPABASE_URL;
const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error("缺少只读验证所需 Supabase 配置");
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await client
  .from("agents")
  .select("id,name,system_prompt,preset_fields,output_style")
  .in("id", STORY_TARGETS.map((target) => target.id))
  .is("deleted_at", null);
if (error) throw error;
assert.equal(data?.length, STORY_TARGETS.length);

const preserved = STORY_TARGETS.map((target) => {
  const row = data?.find((item) => item.id === target.id);
  assert.ok(row && typeof row.system_prompt === "string");
  const current = row.system_prompt;
  const firstAnchor = current.indexOf("# 固定输出格式");
  assert.ok(firstAnchor > 0);
  assert.equal(current.indexOf("# 固定输出格式", firstAnchor + 1), -1);
  const prefix = current.slice(0, firstAnchor);
  const revisedPrefix = targetedReplacements.reduce((value, [before, after]) => {
    assert.ok(value.includes(before) || value.includes(after), `unknown replacement source for ${target.id}`);
    return value.replace(before, after);
  }, prefix);
  const next = `${revisedPrefix}${verifiedProtocolTail.replaceAll("{{DIRECTOR_MODE}}", target.mode)}`;
  for (const marker of [
    "# 全片资产锁定",
    "# 口播转故事的方法",
    "# 语义包装",
    "# 3D风格执行字典",
    "# 故事板生图Prompt写法",
    "# 图生视频Prompt写法",
  ]) {
    assert.ok(next.includes(marker));
  }
  assert.ok(next.includes(`director_mode 固定为 ${target.mode}`));
  assert.ok(next.includes("storyboard_director_output.v1"));
  assert.ok(next.includes("故事板面板只是视觉素材与动作覆盖，不是切镜清单"));
  assert.ok(next.includes("top four panels in a 2x2 grid, bottom Frame 5 full-width panoramic panel"));
  assert.ok(!next.includes("四格每格约2至2.5秒；五格每格约1.6至2.2秒"));
  assert.ok(!next.includes("不输出JSON"));
  return {
    id: target.id,
    current_chars: current.length,
    core_region_chars: prefix.length,
    targeted_replacements: targetedReplacements.length,
    projected_chars: next.length,
  };
});

console.log(JSON.stringify({
  ok: true,
  paid_model_calls: 0,
  static_migration_checks: 37,
  original_v6_blocked: true,
  story_core_preservation: preserved,
}, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
