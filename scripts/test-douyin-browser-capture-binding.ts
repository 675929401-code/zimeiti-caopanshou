import assert from "node:assert/strict";
import fs from "node:fs";
import { executeToolCalls } from "../src/lib/skill-executor";

async function main() {
  const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
    || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8").replace(/^\uFEFF/u, "")) as { supabaseUrl:string; serviceRoleKey:string };
  assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321");
  const url = new URL("/rest/v1/agents", runtime.supabaseUrl);
  url.searchParams.set("select", "id,name,category,is_active,deleted_at");
  url.searchParams.set("name", "eq.对标账号拆解");
  const response = await fetch(url, { headers:{ apikey:runtime.serviceRoleKey, Authorization:`Bearer ${runtime.serviceRoleKey}` } });
  const agents = await response.json() as Array<{ id:string; name:string; category?:string; is_active?:boolean; deleted_at?:string|null }>;
  assert.ok(response.ok, `HTTP ${response.status}`);
  const agent = agents.find((item) => item.name === "对标账号拆解" && item.category === "商业定位IP" && item.is_active && !item.deleted_at);
  assert.ok(agent, "对标账号拆解 not found");

  const capture = {
    schema: "douyin_public_capture_v1",
    captured_at: new Date().toISOString(),
    page_url: "https://www.douyin.com/user/binding-test",
    visible_page_text: "浏览器助手绑定测试账号",
    loaded_post_count: 1,
    profile: { nickname: "浏览器助手绑定测试账号" },
    posts: [{
      aweme_id: "123456789",
      url: "https://www.douyin.com/video/123456789",
      description: "一条公开测试样本",
      statistics: { likes: 100 },
    }],
  };
  const results = await executeToolCalls(agent.id, [{
    id: "browser-capture-binding-test",
    type: "function",
    function: {
      name: "collect_douyin_public_profile",
      arguments: JSON.stringify({ capture_package: JSON.stringify(capture), sample_limit: 10 }),
    },
  }]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.success, true, results[0]?.content);
  const toolPayload = JSON.parse(results[0]?.content || "{}") as Record<string, unknown>;
  assert.equal(toolPayload.access_mode, "user_browser_capture_free");
  assert.equal((toolPayload.sample_summary as { requested?: number; collected?: number; author_unknown?: number })?.requested, 10);
  assert.equal((toolPayload.sample_summary as { requested?: number; collected?: number; author_unknown?: number })?.collected, 1);
  assert.equal((toolPayload.sample_summary as { requested?: number; collected?: number; author_unknown?: number })?.author_unknown, 1);
  assert.ok(String(toolPayload.untrusted_content_notice || "").includes("不可信外部资料"));
  console.log(JSON.stringify({
    passed: true,
    agentId: agent.id,
    tool: "collect_douyin_public_profile",
    accessMode: toolPayload.access_mode,
    requested: 10,
    collected: 1,
    authorUnknown: 1,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
