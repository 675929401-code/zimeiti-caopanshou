function cancellationConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isSafeRelativeCancellationPath(value: unknown, requireTaskPlaceholder = false): boolean {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  return !requireTaskPlaceholder || path.includes("{id}") || path.includes("{task_id}");
}

/**
 * A feature flag alone is not an API contract.  DashScope is the only built-in
 * provider whose public cancellation protocol is implemented here.  Every
 * other provider must supply a complete, same-origin cancel + confirmation
 * contract before the UI may claim that a submitted task can be interrupted.
 */
export function supportsConfirmedVideoCancellation(protocolType: unknown, protocolConfig: unknown): boolean {
  const protocol = String(protocolType || "").trim();
  const config = cancellationConfig(protocolConfig);
  if (protocol.startsWith("autodl_")) return false;
  if (config.supports_remote_cancel !== true) return false;
  if (protocol === "dashscope_video_retalk" || protocol === "dashscope_wan_s2v") return true;

  const method = String(config.cancel_method || "").trim().toUpperCase();
  const placement = String(config.cancel_task_id_placement || "").trim().toLowerCase();
  if (method !== "POST" && method !== "DELETE") return false;
  if (!['path', 'query', 'json'].includes(placement)) return false;
  if (!isSafeRelativeCancellationPath(config.cancel_path, placement === "path")) return false;
  if (!isSafeRelativeCancellationPath(config.cancel_confirm_path, true)) return false;
  if (placement !== "path" && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(String(config.cancel_task_id_field || "").trim())) {
    return false;
  }
  return true;
}

/**
 * Preserve the provider's terminal meaning separately from the platform's
 * legacy `failed` status.  Only an exact cancellation word is accepted;
 * generic failure/termination states are not proof of a user cancellation.
 */
export function isProviderCancellationStatus(value: unknown): boolean {
  const status = String(value ?? "").trim().toLowerCase();
  return status === "cancelled" || status === "canceled";
}

export type VideoCancellationTransport = {
  url: string;
  method: "POST" | "DELETE";
  body?: string;
  confirmationUrl?: string;
};

function cancellationPath(value: unknown) {
  const configured = String(value || "").trim();
  if (!isSafeRelativeCancellationPath(configured)) {
    throw new Error("VIDEO_CANCELLATION_PATH_INVALID");
  }
  return configured;
}

function replaceTaskId(path: string, taskId: string) {
  return path.replaceAll("{id}", encodeURIComponent(taskId)).replaceAll("{task_id}", encodeURIComponent(taskId));
}

/**
 * Builds only same-origin cancellation URLs from the immutable submission
 * snapshot.  A mutable catalogue edit can never redirect an accepted task.
 */
export function buildVideoCancellationTransport(input: {
  protocolType: unknown;
  apiEndpoint: unknown;
  protocolConfig: unknown;
  taskId: string;
}): VideoCancellationTransport {
  const taskId = String(input.taskId || "").trim();
  if (!taskId || !/^[A-Za-z0-9:_-]{1,240}$/u.test(taskId)) throw new Error("VIDEO_CANCELLATION_TASK_ID_INVALID");
  const endpoint = new URL(String(input.apiEndpoint || ""));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("VIDEO_CANCELLATION_ENDPOINT_INVALID");
  const config = input.protocolConfig && typeof input.protocolConfig === "object" && !Array.isArray(input.protocolConfig)
    ? input.protocolConfig as Record<string, unknown> : {};
  const protocolType = String(input.protocolType || "");
  if (!supportsConfirmedVideoCancellation(protocolType, config)) {
    throw new Error("VIDEO_CANCELLATION_CONTRACT_UNVERIFIED");
  }

  // DashScope documents POST /api/v1/tasks/{id}/cancel and requires a status
  // read to prove that the exact task reached CANCELED.  The POST response is
  // only a request id and is not sufficient cancellation evidence by itself.
  if (protocolType === "dashscope_video_retalk" || protocolType === "dashscope_wan_s2v") {
    const origin = endpoint.origin;
    const taskPath = `/api/v1/tasks/${encodeURIComponent(taskId)}`;
    return {
      url: `${origin}${taskPath}/cancel`,
      method: "POST",
      confirmationUrl: `${origin}${taskPath}`,
    };
  }

  const method = String(config.cancel_method || "").toUpperCase();
  if (method !== "POST" && method !== "DELETE") throw new Error("VIDEO_CANCELLATION_METHOD_INVALID");
  const placement = String(config.cancel_task_id_placement || "").toLowerCase();
  if (!['path', 'query', 'json'].includes(placement)) throw new Error("VIDEO_CANCELLATION_ID_PLACEMENT_INVALID");
  const rawPath = cancellationPath(config.cancel_path);
  const url = new URL(replaceTaskId(rawPath, taskId), endpoint.origin);
  const taskIdField = String(config.cancel_task_id_field || "").trim();
  if (placement !== "path" && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(taskIdField)) {
    throw new Error("VIDEO_CANCELLATION_ID_FIELD_INVALID");
  }
  let body: string | undefined;
  if (placement === "query") url.searchParams.set(taskIdField, taskId);
  if (placement === "json") body = JSON.stringify({ [taskIdField]: taskId });
  const confirmPath = String(config.cancel_confirm_path || "").trim();
  const confirmationUrl = new URL(replaceTaskId(cancellationPath(confirmPath), taskId), endpoint.origin).toString();
  return { url: url.toString(), method, body, confirmationUrl };
}

/** Acceptance/HTTP 200 alone is not a terminal cancellation acknowledgement. */
export function confirmedVideoCancellation(value: unknown, expectedTaskId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.success === false || envelope.error) return false;
  const result = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : envelope.task && typeof envelope.task === "object" && !Array.isArray(envelope.task)
      ? envelope.task as Record<string, unknown>
      : envelope.output && typeof envelope.output === "object" && !Array.isArray(envelope.output)
        ? envelope.output as Record<string, unknown> : envelope;
  if (result.success === false || result.error) return false;
  const returnedId = result.task_id ?? result.taskId ?? result.id;
  // A bare `{ status: "cancelled" }` response is not proof that this exact
  // task was cancelled.  Require the provider acknowledgement to bind the
  // terminal state to the requested upstream task id.
  if (returnedId === undefined || String(returnedId) !== expectedTaskId) return false;
  const status = String(result.status ?? result.state ?? result.task_status ?? "").toLowerCase();
  return status === "cancelled" || status === "canceled";
}
