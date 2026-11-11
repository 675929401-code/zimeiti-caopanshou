import { z } from "zod";

const referenceId = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/u);
/** References identify existing main-site records. They never grant access to a URL. */
export const NativeOwnedMediaRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image_record"), id: referenceId }).strict(),
  z.object({ kind: z.literal("image_asset"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("video_task"), id: referenceId }).strict(),
]);
export type NativeOwnedMediaRef = z.infer<typeof NativeOwnedMediaRefSchema>;
export const NativeMediaSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provider_asset"), assetId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("main_asset"), reference: NativeOwnedMediaRefSchema }).strict(),
]);
export type NativeMediaSource = z.infer<typeof NativeMediaSourceSchema>;
export function nativeMainMediaIdentity(ownerId: string, reference: NativeOwnedMediaRef): string {
  z.string().uuid().parse(ownerId); const ref = NativeOwnedMediaRefSchema.parse(reference);
  return `native-main:${ownerId}:${ref.kind}:${ref.id}`;
}
export function nativeMainMediaUuid(digest: string): string {
  z.string().regex(/^[a-f0-9]{64}$/u).parse(digest);
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
}

export function nativeMainMediaPath(reference: NativeOwnedMediaRef): string {
  const ref = NativeOwnedMediaRefSchema.parse(reference);
  if (ref.kind === "video_task") return `/api/video/storage/${encodeURIComponent(ref.id)}`;
  return `/api/media-history/content?${ref.kind === "image_asset" ? "assetId" : "recordId"}=${encodeURIComponent(ref.id)}`;
}
export function nativeMainMediaReference(value: string, origin = "https://native.invalid"): NativeOwnedMediaRef | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.hash) return null;
    let candidate: unknown;
    if (url.pathname.startsWith("/api/video/storage/") && !url.search) candidate = { kind: "video_task", id: decodeURIComponent(url.pathname.slice("/api/video/storage/".length)) };
    else if (url.pathname === "/api/media-history/content" && [...url.searchParams.keys()].length === 1) {
      if (url.searchParams.has("assetId")) candidate = { kind: "image_asset", id: url.searchParams.get("assetId") };
      else if (url.searchParams.has("recordId")) candidate = { kind: "image_record", id: url.searchParams.get("recordId") };
    }
    const parsed = NativeOwnedMediaRefSchema.safeParse(candidate);
    return parsed.success && new URL(nativeMainMediaPath(parsed.data), origin).href === url.href ? parsed.data : null;
  } catch { return null; }
}

