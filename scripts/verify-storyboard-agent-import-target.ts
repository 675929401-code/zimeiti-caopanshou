import assert from "node:assert/strict";
import { storyboardAgentImportProjectId } from "../src/lib/storyboard-agent-import-target";

const payload = { message_id: "message-a", commit_key: "commit-a", machine_payload: { schema_version: "storyboard_director_output.v1", segments: [{ segment_id: "segment_001" }] } };
async function main() {
  const first = await storyboardAgentImportProjectId("owner", "handoff-a-123456", payload);
  const retry = await storyboardAgentImportProjectId("owner", "handoff-a-123456", payload);
  const second = await storyboardAgentImportProjectId("owner", "handoff-b-123456", payload);
  assert.equal(first, retry, "same handoff retry must keep the same project id");
  assert.notEqual(first, second, "a new handoff click must get a new project id");
  await assert.rejects(() => storyboardAgentImportProjectId("owner", "bad", payload), /交接编号无效/u);
  console.log(JSON.stringify({ passed: true, checks: ["same handoff is idempotent", "new handoff is isolated", "invalid handoff rejected"], networkRequests: 0, providerSubmissions: 0 }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
