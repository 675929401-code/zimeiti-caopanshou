export interface ConversationOwnershipStore {
  getOwner(conversationId: string): Promise<string | null>;
  create(conversationId: string, userId: string): Promise<"created" | "conflict">;
}

export class ConversationNotFoundError extends Error {
  constructor() {
    super("Conversation is not available");
    this.name = "ConversationNotFoundError";
  }
}

export async function ensureConversationOwnership(
  store: ConversationOwnershipStore,
  conversationId: string,
  userId: string,
): Promise<void> {
  const existingOwner = await store.getOwner(conversationId);
  if (existingOwner) {
    if (existingOwner !== userId) throw new ConversationNotFoundError();
    return;
  }

  const createResult = await store.create(conversationId, userId);
  if (createResult === "created") return;

  const ownerAfterConflict = await store.getOwner(conversationId);
  if (ownerAfterConflict !== userId) throw new ConversationNotFoundError();
}
