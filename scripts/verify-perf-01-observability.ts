import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createOperationPerformanceTrace,
  type OperationPerformanceDomain,
  type OperationPerformanceEvent,
  type OperationPerformancePhase,
} from "../src/lib/operation-performance-trace";

class FixtureClock {
  private milliseconds = 0;

  now() { return this.milliseconds; }
  isoNow() { return new Date(1_800_000_000_000 + this.milliseconds).toISOString(); }
  advance(milliseconds: number) { this.milliseconds += milliseconds; }
}

interface FixturePath {
  name: string;
  domain: OperationPerformanceDomain;
  operation: string;
  route: string;
  taskId?: string;
  agentId?: string;
  phases: Array<[OperationPerformancePhase, number]>;
}

const fixtures: FixturePath[] = [
  {
    name: "agent-chat",
    domain: "chat",
    operation: "chat.agent_stream",
    route: "/api/chat?debug=secret",
    taskId: "chat-task-0001",
    agentId: "agent-copywriter-0001",
    phases: [
      ["request.received", 0],
      ["auth.permission", 7],
      ["database.read", 11],
      ["upstream.wait", 380],
      ["response.first_byte", 24],
      ["result.persistence", 18],
      ["response.terminal", 9],
    ],
  },
  {
    name: "extract-status",
    domain: "extract",
    operation: "extract.status_load",
    route: "/api/extract/status?client_request_id=private",
    taskId: "extract-task-0001",
    phases: [
      ["request.received", 0],
      ["auth.permission", 5],
      ["database.read", 31],
      ["response.terminal", 3],
    ],
  },
  {
    name: "admin-read",
    domain: "admin",
    operation: "admin.read_load",
    route: "/api/admin/product-usage?range=24h",
    phases: [
      ["request.received", 0],
      ["auth.permission", 8],
      ["database.read", 42],
      ["response.terminal", 6],
    ],
  },
];

const allEvents: OperationPerformanceEvent[] = [];
for (const fixture of fixtures) {
  const clock = new FixtureClock();
  const events: OperationPerformanceEvent[] = [];
  const trace = createOperationPerformanceTrace({
    domain: fixture.domain,
    operation: fixture.operation,
    route: fixture.route,
    requestId: `request-${fixture.name}-0001`,
    traceId: `trace-${fixture.name}-0001`,
    userId: "raw-user-account@example.test",
    accountId: "18800000000",
    taskId: fixture.taskId,
    agentId: fixture.agentId,
  }, (event) => { events.push(event); }, clock);

  for (const [phase, duration] of fixture.phases) {
    clock.advance(duration);
    trace.checkpoint(phase, phase === "request.received" ? { outcome: "in_progress" } : {});
  }

  assert.equal(new Set(events.map((event) => event.request_id)).size, 1, `${fixture.name}: request correlation drift`);
  assert.equal(new Set(events.map((event) => event.trace_id)).size, 1, `${fixture.name}: trace correlation drift`);
  assert.equal(new Set(events.map((event) => event.account_ref)).size, 1, `${fixture.name}: account correlation drift`);
  assert.deepEqual(events.map((event) => event.phase), fixture.phases.map(([phase]) => phase));
  assert.deepEqual(events.map((event) => event.duration_ms), fixture.phases.map(([, duration]) => duration));
  assert.equal(events.at(-1)?.elapsed_ms, fixture.phases.reduce((sum, [, duration]) => sum + duration, 0));
  assert.ok(events.every((event) => event.route === fixture.route.split("?", 1)[0]));
  assert.ok(events.every((event) => !JSON.stringify(event).includes("raw-user-account")));
  assert.ok(events.every((event) => !JSON.stringify(event).includes("18800000000")));
  allEvents.push(...events);
}

assert.ok(allEvents.some((event) => event.phase === "upstream.wait"), "chat upstream wait is not observable");
assert.ok(allEvents.some((event) => event.phase === "response.first_byte"), "chat first byte is not observable");
assert.ok(allEvents.some((event) => event.phase === "result.persistence"), "chat persistence is not observable");

const failureClock = new FixtureClock();
const failureSafeTrace = createOperationPerformanceTrace({
  domain: "admin",
  operation: "admin.failure_safe",
  route: "/api/admin/read",
  userId: "private-user",
}, () => { throw new Error("fixture sink unavailable"); }, failureClock);
assert.doesNotThrow(() => failureSafeTrace.checkpoint("request.received"));

const enrichedEvents: OperationPerformanceEvent[] = [];
const enrichedTrace = createOperationPerformanceTrace({
  domain: "chat",
  operation: "chat.identity_enrichment",
  route: "/api/chat",
  requestId: "request-enrichment-0001",
}, (event) => { enrichedEvents.push(event); }, new FixtureClock());
enrichedTrace.checkpoint("request.received", { outcome: "in_progress" });
enrichedTrace.enrichIdentity({ userId: "raw-user", accountId: "raw-account", taskId: "task-enrichment-0001", agentId: "agent-enrichment-0001" });
enrichedTrace.checkpoint("auth.permission");
assert.equal(enrichedEvents[0]?.user_ref, null);
assert.match(enrichedEvents[1]?.user_ref || "", /^usr_[a-f0-9]{16}$/u);
assert.match(enrichedEvents[1]?.account_ref || "", /^acct_[a-f0-9]{16}$/u);
assert.equal(enrichedEvents[1]?.task_id, "task-enrichment-0001");
assert.equal(enrichedEvents[1]?.agent_id, "agent-enrichment-0001");

const recorderSource = readFileSync("src/lib/operation-flight-recorder.ts", "utf8");
const serverRecorderSource = recorderSource.slice(recorderSource.indexOf("export async function recordServerOperationPerformanceEventBestEffort"));
assert.match(recorderSource, /recordServerOperationPerformanceEventBestEffort/u);
assert.match(recorderSource, /source:\s*"server"/u);
assert.match(recorderSource, /user_id:\s*input\.user_ref \|\| input\.account_ref/u);
assert.match(recorderSource, /request_id:\s*input\.request_id/u);
assert.match(recorderSource, /account_ref:\s*input\.account_ref/u);
assert.match(recorderSource, /task_id:\s*input\.task_id/u);
assert.match(recorderSource, /agent_id:\s*input\.agent_id/u);
assert.match(recorderSource, /return false/u);
assert.doesNotMatch(serverRecorderSource, /prompt_text|request_body|response_body|api_key|authorization/iu);

console.log(`PASS PERF-01 shared trace contract: ${fixtures.length} paths, ${allEvents.length} correlated phase events, zero provider/database calls`);
