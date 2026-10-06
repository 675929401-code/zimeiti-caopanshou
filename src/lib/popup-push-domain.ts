export type PopupDismissBehavior = "session" | "persistent" | "always";

/**
 * The legacy column accepted free-form strings. Keep known aliases readable,
 * but expose one stable contract to the client:
 * - session: hide after closing for the current login/browser session;
 * - persistent: remember this popup id in this browser until its id changes;
 * - always: allow closing the current surface and offer it again on next entry.
 */
export function normalizePopupDismissBehavior(value: unknown): PopupDismissBehavior {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["persistent", "permanent", "once", "forever"].includes(normalized)) return "persistent";
  if (["always", "repeat", "every_visit"].includes(normalized)) return "always";
  return "session";
}
