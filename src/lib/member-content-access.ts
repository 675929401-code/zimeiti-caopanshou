export type MemberContentIdentity = {
  userId: string;
  role: "admin" | "student";
};

export type MemberContentAccessDecision = "owner" | "admin_capability" | "denied";

export function memberContentAccessDecision(
  actor: MemberContentIdentity,
  ownerId: string,
): MemberContentAccessDecision {
  if (actor.userId && ownerId && actor.userId === ownerId) return "owner";
  if (actor.role === "admin" && actor.userId && ownerId) return "admin_capability";
  return "denied";
}
