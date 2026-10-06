"use client";

const CLIENT_ERROR_ENDPOINT = "/api/client-error-report";
const MIN_REPORT_INTERVAL_MS = 30_000;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

let lastReportAt = 0;

/**
 * Send only a bounded framework digest to the isolated client telemetry sink.
 * The helper deliberately cannot accept Error objects or arbitrary metadata.
 */
export function reportClientRenderError(rawDigest?: string): void {
  if (typeof window === "undefined") return;

  const now = Date.now();
  if (now - lastReportAt < MIN_REPORT_INTERVAL_MS) return;
  lastReportAt = now;

  const digest = rawDigest && DIGEST_PATTERN.test(rawDigest) ? rawDigest : undefined;
  const payload = digest
    ? { source: "app_error_boundary", kind: "render_error", digest }
    : { source: "app_error_boundary", kind: "render_error" };

  void fetch(CLIENT_ERROR_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    credentials: "omit",
    keepalive: true,
    referrerPolicy: "no-referrer",
  }).catch(() => {
    // Telemetry is best-effort and must never recurse into the error boundary.
  });
}
