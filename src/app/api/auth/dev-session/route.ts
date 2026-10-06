import { NextRequest, NextResponse } from "next/server";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const WORKBENCH_HEADER = "ai-creation-studio-local";

type AdminRow = {
  id: string;
  username: string;
  display_name: string | null;
  credits: number | null;
  cash_balance: number | null;
};

async function findSandboxAdmin(): Promise<AdminRow> {
  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("users")
      .select("id, username, display_name, credits, cash_balance")
      .eq("role", "admin")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("No active administrator was found in realtime storage");
    return data as AdminRow;
  } catch (error) {
    console.error("[auth/dev-session] Cloud administrator lookup failed:", error);
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const hostname = request.nextUrl.hostname;
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  if (process.env.NODE_ENV === "production" || !isLoopback || request.headers.get("x-local-workbench") !== WORKBENCH_HEADER) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const data = await findSandboxAdmin();

    const token = await createToken({
      userId: data.id,
      username: data.username,
      role: "admin",
      displayName: data.display_name || "本地沙箱",
      sessionId: `sandbox-${crypto.randomUUID()}`,
    });

    return NextResponse.json({
      success: true,
      sandbox: true,
      token,
      user: {
        id: data.id,
        username: data.username,
        displayName: data.display_name || "本地沙箱",
        role: "admin",
        credits: Number(data.credits ?? 0),
        cashBalance: Number(data.cash_balance ?? 0),
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "本地沙箱会话创建失败",
    }, { status: 503 });
  }
}
