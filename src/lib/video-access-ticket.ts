import { createHash } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { getJwtSecretString } from "@/lib/auth";

import { getSupabaseClient } from '@/storage/database/supabase-client';
import { isUserAccountDisabled } from '@/lib/user-account-status';

export type VideoAccessScope = "playback" | "download" | "thumbnail";

export type VideoAccessIdentity = {
  userId: string;
  role: "admin" | "student";
};

type VideoAccessTicketPayload = VideoAccessIdentity & {
  purpose: "video-access";
  taskId: string;
  scope: VideoAccessScope;
};

const DEFAULT_TTL_SECONDS = 15 * 60;

function ticketSecret() {
  const digest = createHash("sha256")
    .update(`${getJwtSecretString()}:video-access:v1`)
    .digest();
  return new Uint8Array(digest);
}

export async function createVideoAccessTicket(input: {
  taskId: string;
  userId: string;
  role: "admin" | "student";
  scope: VideoAccessScope;
  ttlSeconds?: number;
}) {
  const ttlSeconds = Math.max(60, Math.min(input.ttlSeconds || DEFAULT_TTL_SECONDS, 30 * 60));
  return new SignJWT({
    purpose: "video-access",
    taskId: input.taskId,
    userId: input.userId,
    role: input.role,
    scope: input.scope,
  } satisfies VideoAccessTicketPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(ticketSecret());
}

export async function verifyVideoAccessTicket(
  ticket: string,
  expected: { taskId: string; scope: VideoAccessScope },
): Promise<VideoAccessIdentity | null> {
  try {
    const { payload } = await jwtVerify(ticket, ticketSecret());
    if (
      payload.purpose !== "video-access"
      || payload.taskId !== expected.taskId
      || payload.scope !== expected.scope
      || typeof payload.userId !== "string"
      || (payload.role !== "admin" && payload.role !== "student")
    ) {
      return null;
    }
    const { data: user, error } = await getSupabaseClient().from('users')
      .select('id,role,status,is_active').eq('id', payload.userId).maybeSingle();
    if (error || !user || isUserAccountDisabled(user)) return null;
    return { userId: user.id, role: user.role === 'admin' ? 'admin' : 'student' };
  } catch {
    return null;
  }
}

export async function createVideoAccessUrl(input: {
  taskId: string;
  userId: string;
  role: "admin" | "student";
  scope: VideoAccessScope;
  filename?: string;
  source?: "origin";
  forCapture?: boolean;
}) {
  const ticket = await createVideoAccessTicket(input);
  if (input.scope === "thumbnail") {
    return `/api/video/thumbnail/${encodeURIComponent(input.taskId)}?${new URLSearchParams({ media_ticket: ticket }).toString()}`;
  }
  const pathname = input.scope === "download" ? "/api/video/proxy-download" : "/api/video/proxy";
  const params = new URLSearchParams({
    [input.scope === "download" ? "taskId" : "id"]: input.taskId,
    media_ticket: ticket,
  });
  if (input.filename) params.set("name", input.filename);
  if (input.source) params.set("source", input.source);
  if (input.forCapture) params.set("forCapture", "1");
  return `${pathname}?${params.toString()}`;
}
