import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { IMAGE_FAILURE_HISTORY_SURFACE } from "@/lib/image-failure-history";
import {
  IMAGE_UNRESOLVED_REQUEST_LIMIT,
  toImageUnresolvedRequestReference,
  type ImageUnresolvedRequestRow,
} from "@/lib/image-unresolved-requests";

export const dynamic = "force-dynamic";

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function isUnresolvedRecoveryMigrationNotReady(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = String(record.code || "");
  const detail = [record.message, record.details, record.hint].map((value) => String(value || "")).join(" ");
  return ["42P01", "42703", "PGRST202", "PGRST204", "PGRST205"].includes(code)
    || /image_generation_requests|request_snapshot|schema cache|does not exist|could not find/iu.test(detail);
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db = authenticatedDb as SupabaseClient;
    try {
      const columns = "client_idempotency_key,client_trace_id,payload_fingerprint,state,response,delivery_state,delivery_asset_id,updated_at";
      const targetCount = IMAGE_UNRESOLVED_REQUEST_LIMIT + 1;
      const pageSize = 250;
      const readState = async (state: "intent" | "failed_unknown" | "completed") => {
        const records: NonNullable<ReturnType<typeof toImageUnresolvedRequestReference>>[] = [];
        let offset = 0;
        while (records.length < targetCount) {
          let query = db.from("image_generation_requests")
            .select(columns)
            .eq("user_id", user.id)
            .eq("request_snapshot->>surface", IMAGE_FAILURE_HISTORY_SURFACE)
            .eq("state", state)
            .order("updated_at", { ascending: false })
            .range(offset, offset + pageSize - 1);
          // Completed rows are unresolved only while delivery is held. Filtering
          // this in SQL avoids walking an arbitrarily large delivered history.
          if (state === "completed") query = query.eq("delivery_state", "held");
          const result = await query;
          if (result.error) throw result.error;
          const rows = (result.data || []) as ImageUnresolvedRequestRow[];
          for (const row of rows) {
            const record = toImageUnresolvedRequestReference(row);
            if (record) records.push(record);
            if (records.length >= targetCount) break;
          }
          if (rows.length < pageSize) break;
          offset += pageSize;
        }
        return records;
      };

      // Read each unresolved state independently. The old fixed 101-row window
      // could be filled with already-delivered/terminal rows and hide an older
      // real unknown request forever after a cross-browser refresh.
      const candidates = (await Promise.all([
        readState("intent"),
        readState("failed_unknown"),
        readState("completed"),
      ])).flat().sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      const seen = new Set<string>();
      const records = candidates.filter((record) => {
        const identity = `${record.generationKey}\u0000${record.generationTraceId}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
      return response({
        records: records.slice(0, IMAGE_UNRESOLVED_REQUEST_LIMIT),
        truncated: records.length > IMAGE_UNRESOLVED_REQUEST_LIMIT,
      });
    } catch (error) {
      if (isUnresolvedRecoveryMigrationNotReady(error)) {
        return response({
          records: [],
          truncated: false,
          recoveryReady: false,
          code: "IMAGE_UNRESOLVED_RECOVERY_MIGRATION_NOT_READY",
        });
      }
      console.error("[Image/Unresolved] read failed:", error instanceof Error ? error.name : "UnknownError");
      return response({
        error: "未决生图任务暂时无法同步；请勿重复提交",
        code: "IMAGE_UNRESOLVED_RECOVERY_UNAVAILABLE",
      }, 503);
    }
  });
}
