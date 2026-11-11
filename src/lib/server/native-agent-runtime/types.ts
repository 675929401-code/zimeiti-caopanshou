import type { NativeAgentRuntimeConfigSnapshot } from "../../native-agent-runtime-contract";
import type { NativeAgentTool } from "../../native-agent-contract";

export type NativeAgentRuntimeIdentity = Readonly<{ ownerId: string; taskId: string; turnId: string }>;
export type NativeAgentReadDraftArgs = Extract<NativeAgentTool, { kind: "read_draft" }>["args"];
export type NativeAgentSaveDraftArgs = Extract<NativeAgentTool, { kind: "save_draft" }>["args"];

export interface NativeAgentSdkTurnInput extends NativeAgentRuntimeIdentity {
  configSnapshot: NativeAgentRuntimeConfigSnapshot;
  prompt: string;
  resumeSessionId?: string;
  resumeCheckpointHash?: string;
  signal?: AbortSignal;
}
export interface NativeAgentRuntimeEvent extends NativeAgentRuntimeIdentity {
  sequence: number;
  kind: "sdk_session" | "sdk_message" | "model_call_started" | "model_call_completed" | "tool_started" | "tool_completed" | "runtime_terminal";
  payload: Record<string, unknown>;
}
export interface NativeAgentRuntimeToolContext extends NativeAgentRuntimeIdentity {
  invocationId: string;
  signal: AbortSignal;
}
export interface NativeAgentRuntimeModelCall extends NativeAgentRuntimeIdentity {
  callId: string;
  role: "default";
  configSnapshot: NativeAgentRuntimeConfigSnapshot;
  requestBody: Record<string, unknown>;
  signal: AbortSignal;
}
export interface NativeAgentSdkRuntimePorts {
  /** Dedicated persistent runtime data directory, outside the product source. */
  runtimeRoot: string;
  /** Existing Windows SDK prerequisite only; the Bash model tool remains disabled. */
  gitBashPath?: string;
  modelCall(input: NativeAgentRuntimeModelCall): Promise<Response>;
  readDraft(args: NativeAgentReadDraftArgs, context: NativeAgentRuntimeToolContext): Promise<unknown>;
  saveDraft(args: NativeAgentSaveDraftArgs, context: NativeAgentRuntimeToolContext): Promise<unknown>;
  /** Must resolve only after the event is durably persisted. Rejection stops execution. */
  emit(event: NativeAgentRuntimeEvent): Promise<void>;
  /** Optional internal diagnostics. Never use as a browser event or terminal outcome. */
  diagnostic?(message: string): void;
}
export interface NativeAgentSdkTurnResult {
  state: "completed" | "failed_known" | "unknown";
  sessionId: string | null;
  checkpointHash: string | null;
  responseText: string;
  modelCalls: number;
  toolCalls: number;
  errorCode?: string;
}
