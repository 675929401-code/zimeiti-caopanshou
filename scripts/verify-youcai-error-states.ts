import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyUpstreamDramaFailure,
  describePublicDramaFailure,
  hasInternalProviderDetail,
  publicDramaFailureFromPayload,
} from "../src/lib/short-drama/public-drama-errors";

const providerDetail =
  'LLM API 403: {"error":"{\\"message\\":\\"该用户已被禁用 (request id: hidden)\\",\\"type\\":\\"new_api_error\\"}"}';
const modelFailure = classifyUpstreamDramaFailure(403, providerDetail);

assert.equal(hasInternalProviderDetail(providerDetail), true);
assert.equal(modelFailure.status, 503);
assert.equal(modelFailure.code, "DRAMA_MODEL_ACCESS_DENIED");
assert.equal(modelFailure.kind, "model");
assert.equal(modelFailure.retryable, true);
assert.equal(hasInternalProviderDetail(modelFailure.message), false);
assert.equal(hasInternalProviderDetail(modelFailure.guidance), false);

const clientFailure = publicDramaFailureFromPayload(503, {
  ok: false,
  code: "DRAMA_MODEL_ACCESS_DENIED",
  error: providerDetail,
});
assert.equal(clientFailure.code, "DRAMA_MODEL_ACCESS_DENIED");
assert.equal(clientFailure.message.includes("request id"), false);
assert.equal(clientFailure.message.includes("new_api_error"), false);

assert.equal(describePublicDramaFailure(401).kind, "authentication");
assert.equal(describePublicDramaFailure(402).kind, "credits");
assert.equal(describePublicDramaFailure(429).kind, "rate-limit");
assert.equal(
  describePublicDramaFailure(500, "DRAMA_PROJECT_IMPORT_FAILED").retryable,
  false,
);

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

const agent = source("src/features/official-core-routes/official-agent-route.tsx");
assert.match(agent, /state\.conversations/);
assert.match(agent, /data-history-source="youcai-agent-account-conversations"/);
assert.match(agent, /不混入主站其他智能体/);
assert.match(agent, /conversation\.agentId === MANGA_WORKBENCH_AGENT_ID/);

const film = source("src/features/youcai-film-studio/youcai-film-studio-portal.tsx");
assert.match(film, /reason: "missing-session" \| "expired-session"/);
assert.match(film, /data-project-state=\{projectState\.kind\}/);
assert.match(film, /项目服务暂时不可用，请稍后重试/);
assert.match(film, /data-testid="film-project-card-link"/);
assert.match(film, /href=\{`\/tools\/film-studio\/projects\/\$\{encodeURIComponent\(project\.id\)\}`\}/);

const api = source("src/app/api/short-drama/drama-script/route.ts");
assert.match(api, /publicFailurePayload/);
assert.match(api, /classifyUpstreamDramaFailure/);
assert.doesNotMatch(api, /error:\s*error instanceof Error \? error\.message/);

const wizard = source("src/features/youcai-drama-script/youcai-drama-script-wizard.tsx");
assert.match(wizard, /publicDramaFailureFromPayload/);
assert.match(wizard, /重新尝试/);
assert.match(wizard, /AppScopedLink as Link/);
assert.match(wizard, /href=\{feedback\.projectHref\}/);
assert.doesNotMatch(wizard, /readErrorMessage/);

console.log("verify-youcai-error-states: PASS");
console.log("- Agent history uses real main-site conversations and honest empty states");
console.log("- Film projects distinguish missing and expired sessions from service failures");
console.log("- Drama provider details are converted to safe public errors with retry/config guidance");
