import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

/** Sensitive model metadata may only be returned to a verified administrator. */
export async function isVerifiedAdminModelRequest(request: Request): Promise<boolean> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return false;
  const payload = await verifyToken(token).catch(() => null);
  if (!payload?.userId || payload.role !== "admin") return false;

  try {
    const { data, error } = await getSupabaseClient()
      .from("users")
      .select("role, status")
      .eq("id", payload.userId)
      .single();
    return !error
      && data?.role === "admin"
      && data?.status !== "suspended"
      && data?.status !== "blocked";
  } catch {
    return false;
  }
}
