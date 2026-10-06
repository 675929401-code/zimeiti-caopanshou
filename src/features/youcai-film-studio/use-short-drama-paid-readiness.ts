"use client";

import { useEffect, useState } from "react";

export type ShortDramaPaidReadiness =
  | { readonly status: "checking" }
  | { readonly status: "ready"; readonly storageMode: "native" }
  | {
      readonly status: "blocked";
      readonly code: string;
      readonly message: string;
      readonly storageMode: "compat" | "unavailable" | "unknown";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function useShortDramaPaidReadiness(): ShortDramaPaidReadiness {
  const [readiness, setReadiness] = useState<ShortDramaPaidReadiness>({ status: "checking" });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/short-drama/health", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (
        response.ok
        && isRecord(payload)
        && payload.ok === true
        && payload.storageMode === "native"
        && payload.nativeSchemaReady === true
        && payload.migrationStatus === "ready"
        && payload.paidModelCallsEnabled === true
      ) {
        setReadiness({ status: "ready", storageMode: "native" });
        return;
      }

      const storageMode = isRecord(payload) && payload.storageMode === "compat"
        ? "compat"
        : isRecord(payload) && payload.storageMode === "unavailable"
          ? "unavailable"
          : "unknown";
      const code = isRecord(payload) && typeof payload.code === "string"
        ? payload.code
        : "PROJECT_DATABASE_UNAVAILABLE";
      setReadiness({
        status: "blocked",
        code,
        message: code === "MIGRATION_NOT_READY"
          ? "影视工坊生成服务正在准备中；为保护项目和费用，本次不会提交。请稍后重试。"
          : "影视工坊生成服务状态暂时无法确认；本次不会提交或产生费用。请稍后重试。",
        storageMode,
      });
    }).catch(() => {
      if (controller.signal.aborted) return;
      setReadiness({
        status: "blocked",
        code: "PROJECT_DATABASE_UNAVAILABLE",
        message: "影视工坊付费生成状态暂时无法确认，已停止提交。",
        storageMode: "unknown",
      });
    });
    return () => controller.abort();
  }, []);

  return readiness;
}
