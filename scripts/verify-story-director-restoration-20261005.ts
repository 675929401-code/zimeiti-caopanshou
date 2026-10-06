import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const runtimePath = resolve("../../../运行数据/自媒体操盘手/local-data-20260902/config/runtime.json");
const backupPath = resolve("backups/story-director-restoration-20261005-Codex/2026-10-05T11-14-00-552Z/before.json");
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const expected = {
  movie: { id: "agent-1786633444187-594spj", promptSha256: "0dda97aaa9a3693ff3ca4a3916653d04b648fd589865cce60ae5c81ae94ebc86" },
  high: { id: "agent-1786843330392-emdjv2", promptSha256: "3df48085ed01989449ddac142a029827432f153a4141abb81a5fc868e3a481c6" },
} as const;

type AgentRow = {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields: Array<Record<string, unknown>>;
  updated_at: string;
  deleted_at: string | null;
};

const durationOptions = (row: AgentRow): string[] => {
  const field = row.preset_fields.find((item) => item.id === "target_duration_seconds" || item.id === "segment_duration");
  return Array.isArray(field?.options) ? field.options.map(String) : [];
};

const protectedProjection = (rows: Array<Record<string, unknown>>) => rows.map((row) => ({
  id: row.id,
  name: row.name,
  system_prompt: row.system_prompt,
  preset_fields: row.preset_fields,
  updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ""),
}));

async function main(): Promise<void> {
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as {
    supabaseUrl?: string;
    ownerConnection?: pg.ClientConfig;
  };
  assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321", "只允许核验本地验收数据库");
  assert.ok(runtime.ownerConnection, "本地数据库连接缺失");
  const backup = JSON.parse(await readFile(backupPath, "utf8")) as { protectedBefore: Array<Record<string, unknown>> };
  const client = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-verify-story-director-restoration-20261005" });
  await client.connect();
  try {
    await client.query("begin read only");
    const result = await client.query<AgentRow>(
      "select id,name,system_prompt,preset_fields,updated_at,deleted_at from public.agents where id=any($1::text[]) order by id",
      [[expected.movie.id, expected.high.id]],
    );
    assert.equal(result.rows.length, 2, "双导演数量异常");
    const movie = result.rows.find((row) => row.id === expected.movie.id);
    const high = result.rows.find((row) => row.id === expected.high.id);
    assert.ok(movie && high, "双导演读取失败");
    assert.equal(movie.deleted_at, null);
    assert.equal(high.deleted_at, null);
    assert.equal(sha256(movie.system_prompt), expected.movie.promptSha256, "电影版恢复Prompt漂移");
    assert.equal(sha256(high.system_prompt), expected.high.promptSha256, "高能版恢复Prompt漂移");
    assert.deepEqual(durationOptions(movie), ["10秒版：每段3-4个镜头", "15秒版：每段4-5个镜头"]);
    assert.deepEqual(durationOptions(high), ["8秒版：每段3个镜头", "10秒版：每段3-4个镜头", "15秒版：每段4-6个镜头"]);
    for (const row of [movie, high]) {
      const model = row.preset_fields.find((field) => field.id === "video_model_profile");
      assert.equal(model?.label, "生成模型");
      assert.deepEqual(model?.options, [
        "自动通用（分镜工作台再选择模型）",
        "MiniMax H3（官方结构适配）",
        "Omni Flash（官方时序与音轨适配）",
        "Grok Imagine（官方图生视频适配）",
      ]);
      assert.ok(/生图\s*Prompt|生图Prompt/u.test(row.system_prompt), `${row.name}缺少生图Prompt`);
      assert.ok(/视频\s*Prompt|videoPrompt/u.test(row.system_prompt), `${row.name}缺少视频Prompt`);
      assert.match(row.system_prompt, /Frame/u);
      assert.match(row.system_prompt, /连续|连贯/u);
      assert.match(row.system_prompt, /MiniMax H3/u);
      assert.match(row.system_prompt, /Omni Flash/u);
      assert.match(row.system_prompt, /Grok Imagine/u);
    }
    assert.match(high.system_prompt, /全文包装账本与减法门/u);
    const protectedNow = await client.query<Record<string, unknown>>(
      "select id,name,system_prompt,preset_fields,updated_at from public.agents where name ilike '%架构师%' order by id",
    );
    assert.equal(protectedNow.rows.length, 5, "受保护架构师数量变化");
    assert.deepEqual(protectedProjection(protectedNow.rows), protectedProjection(backup.protectedBefore), "受保护的影像架构师发生变化");
    await client.query("rollback");
    console.log(JSON.stringify({
      status: "passed",
      networkRequests: 0,
      databaseWrites: 0,
      moviePromptSha256: sha256(movie.system_prompt),
      highPromptSha256: sha256(high.system_prompt),
      movieDurations: durationOptions(movie),
      highDurations: durationOptions(high),
      protectedArchitectCount: protectedNow.rows.length,
      protectedArchitectsUnchanged: true,
    }, null, 2));
  } finally {
    await client.end();
  }
}

void main();
