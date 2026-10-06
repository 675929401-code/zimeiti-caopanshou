import "server-only";

import {
  INCIDENT_SLO_SOURCE_BOUNDARIES,
  IncidentSloError,
  incidentSloExecutionPolicy,
  incidentSloSchemaUnavailable,
  normalizeIncidentSloDatabaseStatus,
  type IncidentSloControlCommand,
  type IncidentSloStatus,
} from "@/lib/incident-slo-control-plane";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type RpcResult = { data: unknown; error: unknown };
type RpcClient = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
};

function errorRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
}

function mapControlError(error: unknown): IncidentSloError {
  if (error instanceof IncidentSloError) return error;
  if (incidentSloSchemaUnavailable(error)) {
    return new IncidentSloError(
      "INCIDENT_SLO_SCHEMA_REQUIRED",
      "事故与 SLO 控制平面迁移尚未应用",
      503,
    );
  }
  const value = errorRecord(error);
  const code = typeof value.code === "string" ? value.code : "";
  const message = [value.message, value.details, value.hint]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
  if (code === "P0002" || /_NOT_FOUND/u.test(message)) {
    return new IncidentSloError("INCIDENT_SLO_NOT_FOUND", "事故控制对象不存在", 404);
  }
  if (code === "40001" || code === "23505" || /CONFLICT|ALREADY_SETTLED|INCIDENT_CLOSED/u.test(message)) {
    return new IncidentSloError("INCIDENT_SLO_CONFLICT", "事故状态已变化，请刷新后重试", 409);
  }
  if (code === "55P03" || code === "42501" || /LEASE_|OWNER_REQUIRED/u.test(message)) {
    return new IncidentSloError("INCIDENT_SLO_LEASE_INVALID", "事故所有权租约无效或已被占用", 409);
  }
  if (code === "22023" || /_INVALID|_REQUIRED/u.test(message)) {
    return new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "事故控制请求无效", 400);
  }
  return new IncidentSloError("INCIDENT_SLO_CONTROL_UNAVAILABLE", "事故控制平面暂不可用", 503);
}

async function rpc(name: string, args?: Record<string, unknown>): Promise<unknown> {
  const database = getSupabaseAdminClient() as unknown as RpcClient;
  const { data, error } = await database.rpc(name, args);
  if (error) throw mapControlError(error);
  return data;
}

export async function readIncidentSloStatus(): Promise<IncidentSloStatus> {
  try {
    const database = normalizeIncidentSloDatabaseStatus(
      await rpc("get_incident_slo_status"),
    );
    return {
      schemaVersion: 1,
      controlPlane: "incident_slo",
      phase: "foundation_only",
      migrationApplied: true,
      database,
      integration: {
        collectorsConnected: false,
        alertNotificationConnected: false,
        commandCenterConnected: false,
        workerHeartbeatConnected: false,
        actionExecutorConnected: false,
        postmortemPublisherConnected: false,
        connectedSources: [],
        pendingSources: INCIDENT_SLO_SOURCE_BOUNDARIES,
      },
      executionPolicy: incidentSloExecutionPolicy(),
    };
  } catch (error) {
    throw mapControlError(error);
  }
}

export async function executeIncidentSloControlCommand(
  command: IncidentSloControlCommand,
  actorId: string,
  requestKey: string,
): Promise<unknown> {
  const actor = actorId.trim();
  if (!actor || actor.length > 200) {
    throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "管理员身份无效", 400);
  }
  try {
    switch (command.kind) {
      case "claim_incident":
        return await rpc("claim_incident_slo_incident_cas", {
          p_incident_id: command.incidentId,
          p_actor_id: actor,
          p_expected_revision: command.expectedRevision,
          p_lease_seconds: command.leaseSeconds,
          p_request_key: requestKey,
        });
      case "transition_incident":
        return await rpc("transition_incident_slo_incident_cas", {
          p_incident_id: command.incidentId,
          p_actor_id: actor,
          p_lease_token: command.leaseToken,
          p_expected_revision: command.expectedRevision,
          p_target_status: command.targetStatus,
          p_request_key: requestKey,
          p_note: command.note,
        });
      case "request_recovery_probe":
        return await rpc("request_incident_slo_recovery_probe", {
          p_incident_id: command.incidentId,
          p_actor_id: actor,
          p_lease_token: command.leaseToken,
          p_expected_revision: command.expectedRevision,
          p_probe_key: command.probeKey,
          p_probe_kind: command.probeKind,
          p_request_key: requestKey,
          p_parameters: command.parameters,
        });
      case "record_recovery_probe_result":
        return await rpc("record_incident_slo_recovery_probe_result_cas", {
          p_incident_id: command.incidentId,
          p_probe_id: command.probeId,
          p_actor_id: actor,
          p_lease_token: command.leaseToken,
          p_expected_revision: command.expectedRevision,
          p_result_status: command.resultStatus,
          p_request_key: requestKey,
          p_summary: command.summary,
          p_evidence: command.evidence,
        });
      case "register_action":
        return await rpc("register_incident_slo_action_request", {
          p_incident_id: command.incidentId,
          p_actor_id: actor,
          p_lease_token: command.leaseToken,
          p_expected_revision: command.expectedRevision,
          p_mode: command.mode,
          p_action_kind: command.actionKind,
          p_request_key: requestKey,
          p_parameters: command.parameters,
        });
      case "link_postmortem":
        return await rpc("link_incident_slo_postmortem_cas", {
          p_incident_id: command.incidentId,
          p_actor_id: actor,
          p_expected_revision: command.expectedRevision,
          p_request_key: requestKey,
          p_status: command.status,
          p_summary: command.summary,
          p_root_cause: command.rootCause,
          p_action_items: command.actionItems,
          p_external_reference: command.externalReference,
        });
    }
  } catch (error) {
    throw mapControlError(error);
  }
}
