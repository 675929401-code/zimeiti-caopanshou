import "server-only";

import { NextRequest, NextResponse } from "next/server";
import {
  memberContentAccessDecision,
  type MemberContentIdentity,
} from "@/lib/member-content-access";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

export type MemberContentAuthorization =
  | {
      ok: true;
      delegated: boolean;
      // A delegated, task-bound media ticket uses the resource owner identity.
      // Downstream playback endpoints can keep strict owner checks without
      // turning role=admin into a durable cross-user bypass.
      deliveryIdentity: MemberContentIdentity;
    }
  | { ok: false; response: NextResponse };

export async function authorizeMemberContentDiscovery(
  request: NextRequest,
  actor: MemberContentIdentity,
  options: { requireStepUp?: boolean; operation: string },
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  if (actor.role !== "admin") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "无权查找其他会员内容", code: "MEMBER_CONTENT_DISCOVERY_FORBIDDEN" },
        { status: 403 },
      ),
    };
  }
  const authorization = await authorizeAdminCapability(request, "member_content.view", {
    requireStepUp: options.requireStepUp === true,
    operation: options.operation,
  });
  return authorization.ok ? { ok: true } : authorization;
}

export async function authorizeMemberContentAccess(
  request: NextRequest,
  actor: MemberContentIdentity,
  ownerId: string,
  options: { requireStepUp?: boolean; operation: string },
): Promise<MemberContentAuthorization> {
  const decision = memberContentAccessDecision(actor, ownerId);
  if (decision === "owner") {
    return { ok: true, delegated: false, deliveryIdentity: actor };
  }
  if (decision === "denied") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "无权访问该会员内容", code: "MEMBER_CONTENT_FORBIDDEN" },
        { status: 403 },
      ),
    };
  }

  const authorization = await authorizeAdminCapability(request, "member_content.view", {
    requireStepUp: options.requireStepUp === true,
    operation: options.operation,
  });
  if (!authorization.ok) return authorization;
  if (authorization.actor.userId !== actor.userId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "管理员身份与媒体访问身份不一致", code: "MEMBER_CONTENT_ACTOR_MISMATCH" },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true,
    delegated: true,
    deliveryIdentity: { userId: ownerId, role: "student" },
  };
}
