import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "./story-director-overtime-gate";

export function chatStreamWatchdogTimeout(agentId: unknown): number {
  return agentId === STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID || agentId === STORY_DIRECTOR_MOVIE_AGENT_ID ? 2_400_000 : 300_000;
}

type WatchdogController = Pick<AbortController, "signal" | "abort">;
type ExpiredStream = { conversationId: string; controller: WatchdogController; timeoutMs: number };

/** Timers belong to a controller registration, never to render/stream chunks. */
export function createChatStreamWatchdog<TTimer>(ports: {
  setTimeout: (callback: () => void, timeoutMs: number) => TTimer;
  clearTimeout: (timer: TTimer) => void;
  onExpire?: (stream: ExpiredStream) => boolean | void;
}) {
  type Entry = ExpiredStream & { timer?: TTimer; onAbort: () => void };
  const entries = new Map<string, Entry>();
  const clear = (conversationId: string, controller?: WatchdogController): void => {
    const entry = entries.get(conversationId);
    if (!entry || (controller && entry.controller !== controller)) return;
    entries.delete(conversationId);
    if (entry.timer !== undefined) ports.clearTimeout(entry.timer);
    entry.controller.signal.removeEventListener("abort", entry.onAbort);
  };
  return {
    register(conversationId: string, controller: WatchdogController, agentId: unknown): void {
      const existing = entries.get(conversationId);
      if (existing?.controller === controller) return;
      clear(conversationId);
      if (controller.signal.aborted) return;
      const entry: Entry = { conversationId, controller, timeoutMs: chatStreamWatchdogTimeout(agentId),
        onAbort: () => clear(conversationId, controller) };
      entries.set(conversationId, entry);
      controller.signal.addEventListener("abort", entry.onAbort, { once: true });
      entry.timer = ports.setTimeout(() => {
        // A cancelled callback already queued by the browser cannot affect its replacement.
        if (entries.get(conversationId) !== entry) return;
        clear(conversationId, controller);
        if (!controller.signal.aborted && ports.onExpire?.(entry) !== false) controller.abort();
      }, entry.timeoutMs);
    },
    clear,
    clearAll(): void { for (const conversationId of entries.keys()) clear(conversationId); },
    size(): number { return entries.size; },
  };
}
