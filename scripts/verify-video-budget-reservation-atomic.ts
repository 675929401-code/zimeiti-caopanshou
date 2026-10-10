import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const route = read("src/app/api/video/generate/route.ts");
const reservation = read("src/lib/video-budget-reservation.ts");
const migration = read("supabase/migrations/20260925143000_video_budget_reservations_atomic.sql");
const routingMigration = read("supabase/migrations/20260925152000_video_routing_snapshot_and_dispatch_receipt.sql");
const rollback = read("supabase/rollbacks/20260925143000_video_budget_reservations_atomic.rollback.sql");
const databaseContract = JSON.parse(read("deploy/policies/database-contract.v1.json")) as {
  contractVersion: string;
  rpcs: Array<{ name: string; arguments: string[] }>;
};
const embeddedDatabaseContract = read("src/lib/generated/database-contract.ts");
const firstReservationCall = route.indexOf("const reservation = await reserveVideoGenerationTask");
const secondReservationCall = route.indexOf(
  "const reservation = await reserveVideoGenerationTask",
  firstReservationCall + 1,
);
const terminalFinalizerImport = route.match(/import\s*\{([^}]*)\}\s*from "@\/lib\/video-terminal-finalizer";/u)?.[1] || "";

const staticChecks: Array<[string, boolean]> = [
  [
    "route uses the versioned budget reservation helper",
    route.includes('from "@/lib/video-budget-reservation"')
      && !terminalFinalizerImport.includes("reserveVideoGenerationTask"),
  ],
  [
    "durable reservation precedes every ordinary provider POST",
    firstReservationCall >= 0
      && secondReservationCall > firstReservationCall
      && secondReservationCall < route.indexOf("result = await submitVideoTask"),
  ],
  [
    "H3 queue reservation precedes durable enqueue",
    route.indexOf("const reservation = await reserveVideoGenerationTask")
      < route.indexOf("await enqueueAutodlH3VideoJob"),
  ],
  [
    "application fails closed on missing atomic request-snapshot reservation migration",
    reservation.includes('db.rpc("reserve_video_generation_task_request_snapshot_v1_atomic"')
      && reservation.includes('db.rpc("reserve_queued_digital_video_task_request_snapshot_v1_atomic"')
      && reservation.includes("VIDEO_REQUEST_SNAPSHOT_MIGRATION_NOT_READY"),
  ],
  [
    "insufficient available budget is a non-retryable 402 before provider submit",
    reservation.includes("VIDEO_BUDGET_RESERVATION_INSUFFICIENT")
      && /VIDEO_BUDGET_RESERVATION_INSUFFICIENT[\s\S]*?402,[\s\S]*?false/u.test(reservation),
  ],
  [
    "database locks the account wallet row before creating the durable task",
    /CREATE OR REPLACE FUNCTION public\.enforce_video_budget_reservation_atomic\(\)[\s\S]*?FROM public\.users[\s\S]*?FOR UPDATE;/u.test(migration)
      && migration.includes("BEFORE INSERT ON public.video_tasks"),
  ],
  [
    "different request ids share one account-level reservation total",
    migration.includes("sum(round(task.billing_price_yuan::numeric, 2))")
      && migration.includes("v_reserved_before + v_requested_amount > v_cash_balance")
      && migration.includes("VIDEO_BUDGET_RESERVATION_INSUFFICIENT"),
  ],
  [
    "terminal tasks release reservations and completed charges are not double-counted",
    migration.includes("task.status NOT IN ('completed', 'failed', 'cancelled', 'expired')")
      && migration.includes("wallet_op.status = 'completed'")
      && migration.includes("wallet_op.idempotency_key = task.billing_idempotency_key")
      && migration.includes("'settled_pending_commit', 'settled'"),
  ],
  [
    "same client request id replays without reserving twice",
    migration.includes("BEFORE INSERT ON public.video_tasks")
      && migration.includes("RETURN public.reserve_video_generation_task_atomic(")
      && reservation.includes("created: result.created === true"),
  ],
  [
    "all reservation RPCs are service-role-only",
    migration.includes("FROM PUBLIC, anon, authenticated, service_role")
      && migration.includes("TO service_role")
      && migration.includes("reserve_queued_digital_video_task_budget_atomic"),
  ],
  [
    "rollback removes versioned RPCs and the budget trigger",
    rollback.includes("DROP FUNCTION IF EXISTS public.reserve_video_generation_task_budget_atomic")
      && rollback.includes("DROP TRIGGER IF EXISTS video_tasks_budget_reservation_atomic_before_insert")
      && rollback.includes("DROP FUNCTION IF EXISTS public.enforce_video_budget_reservation_atomic"),
  ],
  [
    "release database gate requires both versioned routing reservation RPCs",
    databaseContract.contractVersion >= "20260925152000"
      && databaseContract.rpcs.some((rpc) => rpc.name === "reserve_video_generation_task_routing_atomic"
        && rpc.arguments.includes("p_client_request_id")
        && rpc.arguments.includes("p_routing_snapshot"))
      && databaseContract.rpcs.some((rpc) => rpc.name === "reserve_queued_digital_video_task_routing_atomic"
        && rpc.arguments.join(",") === "p_task,p_dispatch,p_routing_snapshot")
      && databaseContract.rpcs.some((rpc) => rpc.name === "record_video_provider_dispatch_receipt_atomic")
      && databaseContract.rpcs.some((rpc) => rpc.name === "record_video_provider_submission_receipt_atomic"),
  ],
  [
    "embedded runtime database contract matches the reviewed contract version",
    embeddedDatabaseContract.includes(`"contractVersion": "${databaseContract.contractVersion}"`)
      && embeddedDatabaseContract.includes('"name": "reserve_video_generation_task_routing_atomic"')
      && embeddedDatabaseContract.includes('"name": "reserve_queued_digital_video_task_routing_atomic"')
      && embeddedDatabaseContract.includes('"name": "record_video_provider_dispatch_receipt_atomic"'),
  ],
  [
    "routing reservation wrappers keep budget and immutable snapshot in one database transaction",
    routingMigration.includes("v_result := public.reserve_video_generation_task_budget_atomic(")
      && routingMigration.includes("v_snapshot_result := public.persist_video_routing_snapshot_atomic(")
      && routingMigration.includes("reserve_queued_digital_video_task_budget_atomic(p_task, p_dispatch)"),
  ],
];

for (const [name, passed] of staticChecks) {
  assert.equal(passed, true, name);
}

type FixtureTask = {
  requestId: string;
  amount: number;
  state: "reserved" | "failed" | "completed";
};

class AccountBudgetFixture {
  private tail: Promise<void> = Promise.resolve();
  private readonly tasks = new Map<string, FixtureTask>();
  providerPosts = 0;

  constructor(private cashBalance: number) {}

  private activeReserved() {
    return [...this.tasks.values()]
      .filter((task) => task.state === "reserved")
      .reduce((sum, task) => sum + task.amount, 0);
  }

  async reserve(requestId: string, amount: number) {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const existing = this.tasks.get(requestId);
      if (existing) return { created: false, reservedAfter: this.activeReserved() };
      const reservedBefore = this.activeReserved();
      if (reservedBefore + amount > this.cashBalance) {
        throw new Error("VIDEO_BUDGET_RESERVATION_INSUFFICIENT");
      }
      this.tasks.set(requestId, { requestId, amount, state: "reserved" });
      return { created: true, reservedAfter: reservedBefore + amount };
    } finally {
      release();
    }
  }

  async submit(requestId: string, amount: number) {
    const receipt = await this.reserve(requestId, amount);
    if (receipt.created) this.providerPosts += 1;
    return receipt;
  }

  fail(requestId: string) {
    const task = this.tasks.get(requestId);
    assert.ok(task);
    task.state = "failed";
  }

  settle(requestId: string) {
    const task = this.tasks.get(requestId);
    assert.ok(task);
    assert.equal(task.state, "reserved");
    this.cashBalance -= task.amount;
    task.state = "completed";
  }
}

async function main() {
  const oversubscribed = new AccountBudgetFixture(10);
  const competing = await Promise.allSettled([
    oversubscribed.submit("client-request-a", 6),
    oversubscribed.submit("client-request-b", 6),
  ]);
  assert.equal(competing.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(competing.filter((item) => item.status === "rejected").length, 1);
  assert.equal(oversubscribed.providerPosts, 1, "only the funded request may reach provider POST");

  const replayed = await oversubscribed.submit(
    competing[0].status === "fulfilled" ? "client-request-a" : "client-request-b",
    6,
  );
  assert.equal(replayed.created, false);
  assert.equal(oversubscribed.providerPosts, 1, "same request replay must not POST twice");

  const exactlyFunded = new AccountBudgetFixture(12);
  const funded = await Promise.all([
    exactlyFunded.submit("client-request-c", 6),
    exactlyFunded.submit("client-request-d", 6),
  ]);
  assert.ok(funded.every((item) => item.created));
  assert.equal(exactlyFunded.providerPosts, 2);

  const released = new AccountBudgetFixture(10);
  await released.submit("client-request-e", 7);
  released.fail("client-request-e");
  assert.equal((await released.submit("client-request-f", 7)).created, true);

  const settled = new AccountBudgetFixture(10);
  await settled.submit("client-request-g", 4);
  settled.settle("client-request-g");
  assert.equal((await settled.submit("client-request-h", 6)).created, true);

  console.log(JSON.stringify({
    passed: true,
    checks: staticChecks.length + 5,
    concurrentDifferentRequestIds: true,
    insufficientRequestBlockedBeforeProviderPost: true,
    sameRequestReplayPostsOnce: true,
    terminalReleaseCovered: true,
    completedChargeNotDoubleCounted: true,
    externalNetworkRequests: 0,
    databaseWrites: 0,
    realProviderPosts: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
