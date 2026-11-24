import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { listPatrolChannels, probeChannelArrears } from "@/lib/server/ops-channel-patrol";
import { ensureOpsPatrolScheduler, opsPatrolSchedulerStatus, readPatrolHistory, runAndPersistPatrol } from "@/lib/server/ops-patrol-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store, max-age=0" };

let inFlight: Promise<unknown> | null = null;

export async function GET(request: NextRequest) {
  // Channel inventory is not sensitive: it is derived from enabled model
  // endpoints. Balances and cached snapshots still require the step-up grant.
  const managed = await authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "ops_channel_patrol_view",
  });
  if (managed.ok) {
    ensureOpsPatrolScheduler();
    try {
      const [payload, runtime] = await Promise.all([listPatrolChannels(), readPatrolHistory()]);
      return NextResponse.json({
        ok: true,
        ...payload,
        ...runtime,
        scheduler: opsPatrolSchedulerStatus(),
        locked: false,
      }, { headers: noStore });
    } catch (error) {
      return NextResponse.json(
        { ok: false, code: "OPS_PATROL_UNAVAILABLE", error: error instanceof Error ? error.message : "巡检数据读取失败" },
        { status: 503, headers: noStore },
      );
    }
  }
  const readOnly = await authorizeAdminCapability(request, "models.view", { operation: "ops_channel_inventory_view" });
  if (!readOnly.ok) return readOnly.response;
  try {
    const payload = await listPatrolChannels();
    return NextResponse.json({
      ok: true,
      channels: payload.channels,
      lastRun: null,
      scheduler: opsPatrolSchedulerStatus(),
      locked: true,
    }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "OPS_PATROL_UNAVAILABLE", error: error instanceof Error ? error.message : "巡检数据读取失败" },
      { status: 503, headers: noStore },
    );
  }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "ops_channel_patrol_run",
  });
  if (!authorization.ok) return authorization.response;
  if (inFlight) {
    return NextResponse.json({ ok: false, code: "OPS_PATROL_RUNNING", error: "巡检正在进行，请稍候" }, { status: 429, headers: noStore });
  }
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === "arrears") {
      inFlight = probeChannelArrears();
      const arrears = await inFlight as Awaited<ReturnType<typeof probeChannelArrears>>;
      return NextResponse.json({ ok: true, arrears }, { headers: noStore });
    }
    if (body?.action === "full") {
      // One-click physical exam: free connectivity/catalog probe first, then the
      // 1-token arrears probe; the UI warns about the minimal cost before calling.
      const snapshot = await runAndPersistPatrol(true);
      return NextResponse.json({ ok: true, snapshot, arrears: snapshot.arrears ?? null }, { headers: noStore });
    }
    inFlight = runAndPersistPatrol();
    const snapshot = await inFlight as Awaited<ReturnType<typeof runAndPersistPatrol>>;
    return NextResponse.json({ ok: true, snapshot }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "OPS_PATROL_FAILED", error: error instanceof Error ? error.message : "巡检执行失败" },
      { status: 500, headers: noStore },
    );
  } finally {
    inFlight = null;
  }
}
