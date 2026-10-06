import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/app/api/image/generate/route.ts", "utf8");
const workflowStart = source.indexOf('if (effectiveMode === "workflow")');
const localStart = source.indexOf("let finalFailure", workflowStart);
assert.ok(workflowStart > 0 && localStart > workflowStart);
const workflow = source.slice(workflowStart, localStart);

assert.match(workflow, /explicitImageProviderRejection\(workflowResp\.status, errText\)/u,
  "workflow HTTP failures must use the same explicit-rejection classifier as local image channels");
assert.match(workflow, /IMAGE_WORKFLOW_RESULT_UNKNOWN/u,
  "opaque workflow 5xx/transport/empty outcomes must remain unknown");
assert.match(workflow, /parsedWorkflow\.payload && !hasImageUpstreamAcceptanceSignal\(parsedWorkflow\.payload\)/u,
  "an error payload with an accepted task signal must not be declared terminal");
assert.doesNotMatch(workflow, /if \(extractedUrls\.length === 0\) \{\s*throw new ImageRequestRejectedError/u,
  "an empty success envelope alone cannot authorize a fresh provider request");

console.log(JSON.stringify({
  ok: true,
  workflowOpaque5xx: "unknown",
  acceptedErrorEvent: "unknown",
  emptyEnvelope: "unknown",
  automaticFallbackPosts: 0,
  realProviderRequests: 0,
  databaseWrites: 0,
}, null, 2));
