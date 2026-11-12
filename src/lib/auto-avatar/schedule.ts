import "server-only";
import { after } from "next/server";
import { shouldGenerateAvatar } from "./generator";
import { triggerAutoAvatar } from "./index";

export type AutoAvatarTarget = {
  agentId: string;
  name: string;
  description: string;
  avatar: string | null | undefined;
};

const MAX_AUTO_AVATARS_PER_REQUEST = 20;
const MAX_CONCURRENT_AUTO_AVATARS = 2;
const pending: Array<() => Promise<void>> = [];
let active = 0;

function drain(): void {
  while (active < MAX_CONCURRENT_AUTO_AVATARS && pending.length > 0) {
    const task = pending.shift();
    if (!task) return;
    active += 1;
    void task()
      .catch(() => {})
      .finally(() => {
        active -= 1;
        drain();
      });
  }
}

function enqueue(task: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    pending.push(async () => {
      try {
        await task();
      } finally {
        resolve();
      }
    });
    drain();
  });
}

/**
 * Schedule silent avatar generation for newly created agents.
 *
 * The route must return immediately; the actual provider call runs after the
 * response via Next's `after` boundary. Automatic generation is still gated by
 * the persisted `auto_avatar_enabled` switch inside `triggerAutoAvatar`, and is
 * capped per request so a bulk import cannot create an unbounded paid batch.
 */
export function scheduleAutoAvatarForCreatedAgents(
  targets: readonly AutoAvatarTarget[],
  ownerUserId?: string,
): void {
  const eligible = targets
    .filter((target) => shouldGenerateAvatar(target.avatar))
    .slice(0, MAX_AUTO_AVATARS_PER_REQUEST);
  if (eligible.length === 0) return;

  for (const target of eligible) {
    const run = () =>
      enqueue(() =>
        triggerAutoAvatar(
          target.agentId,
          target.name,
          target.description,
          target.avatar,
          { ownerUserId },
        ),
      );
    try {
      after(run);
    } catch {
      // Some non-route callers (contract tests / legacy local routes) have no
      // request context; retain the fire-and-forget fallback rather than
      // failing the agent save.
      void run();
    }
  }
}
