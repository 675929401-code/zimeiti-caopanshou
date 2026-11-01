import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const path = resolve(process.cwd(), "../运行日志/三视觉资产十秒闭环-20261019/benchmark-research-20261020/task-ledger.json");
const ledger = JSON.parse(await readFile(path, "utf8"));
ledger.updatedAt = new Date().toISOString().slice(0, 10);
ledger.phase = "prompt_v2_activated_text_route_pending";
ledger.status = "in_progress";
const statuses = {
  R03: ["done_verified", "sample-matrix-v1.json + sources/ + frame-manifest-v1.json"],
  R04: ["done_with_boundary", "real-frame-analysis-v1.json; audio content remains inferred"],
  R05: ["done_first_pass", "real-frame-analysis-v1.json; six samples x twenty dimensions"],
  R06: ["partial_pending_grid_samples", "six real videos contained no verified 4/5-grid sample"],
  R07: ["done_candidate_v2", "prompt-candidates-v2/static-qa-v2.json + reverse-decomposition-report-v1.md"],
  R08: ["done_runtime_readback", "prompt-activation-v2/report.json; v2 prompt hashes and revisions read back"],
  R09: ["in_progress_route_pending", "ab-test-r1; v2 route canary pending after prior HTTP503 aborted"],
  R10: ["locked_until_text_gate", "image generation not run"],
  R11: ["locked_until_asset_evidence", "real storyboard image not run"],
  R12: ["locked_until_image_evidence", "Omni video not run"],
};
for (const task of ledger.tasks || []) {
  const update = statuses[task.id];
  if (!update) continue;
  task.status = update[0];
  task.evidence = update[1];
  delete task.blockedBy;
}
ledger.knownUnfinished = [
  "四格/五格真实对标样本仍未取得，四格默认和五格授权属于产品合同，不是本轮视频证据",
  "六条样本的音频流已确认，但音乐/环境声/动作声/旁白混音尚未独立听辨",
  "v2双路平台/api/llm文本canary尚未形成双路可解析结果：最新为HTTP503 This operation was aborted；此前HTTP428管理员复验门",
  "真实人物/宠物身份参考、按sceneId后置环境资产、真实四宫格图片和Omni视频均未生成",
  "图片ready index与一次性生图/视频账务读回尚未执行",
];
ledger.completedEvidence = {
  videos: 6,
  uniqueCreators: 5,
  keyframes: 36,
  spokenText: 6,
  audioStream: 6,
  audioMix: "not_independently_verified",
  analysis20d: 6,
  promptCandidateStaticQa: "passed",
  promptRuntimeActivation: "passed_v2_readback",
  promptProviderCanary: "pending_dual_route_result",
  images: 0,
  videosGenerated: 0,
};
await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ phase: ledger.phase, status: ledger.status, tasks: ledger.tasks.map((task) => ({ id: task.id, status: task.status })) }, null, 2));
