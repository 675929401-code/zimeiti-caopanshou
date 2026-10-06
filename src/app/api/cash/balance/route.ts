import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";

export async function GET(req: NextRequest) {
  return withAuth(req, async (user) => {
    const balance = Number(user.cashBalance);
    if (!Number.isFinite(balance)) {
      return NextResponse.json(
        { error: "实时余额数据暂不可用", code: "REALTIME_DATA_UNAVAILABLE" },
        { status: 503 },
      );
    }

    // withAuth has already read the current user row, including cash_balance.
    // Returning that authenticated snapshot avoids a duplicate database roundtrip
    // and keeps identity and balance from coming from two different reads.
    return NextResponse.json({ balance });
  });
}
