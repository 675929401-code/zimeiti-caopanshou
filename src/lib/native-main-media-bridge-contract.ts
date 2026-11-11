import { z } from "zod";
import { NativeOwnedMediaRefSchema } from "./native-main-media-contract";
import { nativeAiCanonical } from "./native-ai-contract";

const id = z.string().uuid();
const key = z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const stamp = z.string().datetime({ offset: true });
export const NATIVE_MAIN_BRIDGE_MAX_IMAGE_BYTES = 20 * 1024 ** 2;
export const NATIVE_MAIN_BRIDGE_MAX_VIDEO_BYTES = 100 * 1024 ** 2;
export const NativeMainMediaBridgeMimeSchema = z.enum(["image/jpeg", "image/png", "video/mp4"]);
export const NativeMainMediaBridgePhaseSchema = z.enum(["sign", "put", "confirm"]);
export const NativeMainMediaBridgeStateSchema = z.enum(["prepared", "uploading", "confirming", "ready", "unknown", "failed_known"]);
export const NativeMainMediaBridgeRequestSchema = z.object({ requestKey: key, reference: NativeOwnedMediaRefSchema, mediaId: id }).strict();
export type NativeMainMediaBridgeRequest = z.infer<typeof NativeMainMediaBridgeRequestSchema>;
export const NativeMainMediaBridgeQuerySchema = z.union([
  z.object({ requestKey: key }).strict(),
  z.object({ bridgeId: id }).strict(),
]);
export type NativeMainMediaBridgeQuery = z.infer<typeof NativeMainMediaBridgeQuerySchema>;
export const NativeMainMediaBridgeFileSchema = z.object({ mime: NativeMainMediaBridgeMimeSchema, size: z.number().int().positive().max(NATIVE_MAIN_BRIDGE_MAX_VIDEO_BYTES), sha256: digest }).strict().refine(file => file.mime === "video/mp4" || file.size <= NATIVE_MAIN_BRIDGE_MAX_IMAGE_BYTES, "Image exceeds bridge limit");
export const NativeMainMediaBridgeSnapshotSchema = z.object({
  version: z.literal(1), reference: NativeOwnedMediaRefSchema, mediaId: id,
  namespace: z.string().min(1).max(200), sourceFingerprint: digest,
  file: NativeMainMediaBridgeFileSchema.safeExtend({ fileName: z.string().regex(/^native-bridge-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(?:jpg|png|mp4)$/u) }),
}).strict().superRefine((value, context) => {
  if ((value.reference.kind === "video_task") !== (value.file.mime === "video/mp4")) context.addIssue({ code: "custom", path: ["file", "mime"], message: "Source and file kind differ" });
  const suffix = value.file.mime === "image/jpeg" ? ".jpg" : value.file.mime === "image/png" ? ".png" : ".mp4";
  if (!value.file.fileName.endsWith(suffix)) context.addIssue({ code: "custom", path: ["file", "fileName"], message: "Filename and MIME differ" });
});
export type NativeMainMediaBridgeSnapshot = z.infer<typeof NativeMainMediaBridgeSnapshotSchema>;
export const NativeMainMediaBridgeResultReferenceSchema = z.object({ kind: z.literal("provider_asset"), assetId: id, mediaId: id }).strict();
export const NativeMainMediaBridgeDtoSchema = z.object({
  id, requestKey: key, reference: NativeOwnedMediaRefSchema, mediaId: id,
  state: NativeMainMediaBridgeStateSchema, revision: z.number().int().positive(), phase: NativeMainMediaBridgePhaseSchema.nullable(),
  file: NativeMainMediaBridgeFileSchema, connectionCurrent: z.boolean(), resultReference: NativeMainMediaBridgeResultReferenceSchema.nullable(),
  errorCode: z.string().max(100).nullable(), createdAt: stamp, updatedAt: stamp,
}).strict().superRefine((value, context) => {
  if (value.state === "ready" && !value.resultReference) context.addIssue({ code: "custom", path: ["resultReference"], message: "Ready requires a confirmed local provider asset reference" });
  if (value.state !== "ready" && value.resultReference) context.addIssue({ code: "custom", path: ["resultReference"], message: "Unconfirmed bridges cannot expose a usable provider asset" });
  if (value.resultReference && value.resultReference.mediaId !== value.mediaId) context.addIssue({ code: "custom", path: ["resultReference"], message: "Result must preserve the approved media identity" });
  if ((value.reference.kind === "video_task") !== (value.file.mime === "video/mp4")) context.addIssue({ code: "custom", path: ["file", "mime"], message: "Source and file kind differ" });
});
export type NativeMainMediaBridgeDto = z.infer<typeof NativeMainMediaBridgeDtoSchema>;
export const NativeMainMediaBridgeLookupSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }).strict(),
  z.object({ found: z.literal(true), bridge: NativeMainMediaBridgeDtoSchema }).strict(),
]);
export const NativeMainMediaBridgePhaseDtoSchema = z.object({
  phase: NativeMainMediaBridgePhaseSchema, state: z.enum(["pending", "claimed", "recorded", "unknown", "failed_known"]),
  dispatchId: id.nullable(), operationRequestKey: key, operationId: id.nullable(), assetId: id.nullable(),
  providerAssetId: z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/u).nullable(), claimedAt: stamp.nullable(), recordedAt: stamp.nullable(),
}).strict();
export type NativeMainMediaBridgePhaseDto = z.infer<typeof NativeMainMediaBridgePhaseDtoSchema>;
export const NativeMainMediaBridgeClaimSchema = z.object({ bridge: NativeMainMediaBridgeDtoSchema, phase: NativeMainMediaBridgePhaseDtoSchema, shouldDispatch: z.boolean() }).strict();
export const NativeMainMediaBridgeInvocationSchema = z.object({ bridge: NativeMainMediaBridgeDtoSchema, snapshot: NativeMainMediaBridgeSnapshotSchema, phase: NativeMainMediaBridgePhaseDtoSchema }).strict();
export const NativeMainMediaBridgeMutationSchema = z.object({ bridge: NativeMainMediaBridgeDtoSchema, alreadyFulfilled: z.boolean() }).strict();
export type NativeMainMediaBridgeMutation = z.infer<typeof NativeMainMediaBridgeMutationSchema>;
export const nativeMainMediaBridgeCanonical = nativeAiCanonical;

/** Container signatures complement actual MIME and bounded byte reads; no conversion is performed. */
export function nativeMainMediaBridgeMagicMatches(mime: z.infer<typeof NativeMainMediaBridgeMimeSchema>, bytes: Uint8Array): boolean {
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  if (bytes.length < 16 || String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") return false;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  const brand = String.fromCharCode(...bytes.slice(8, 12));
  return length >= 16 && length <= bytes.length && ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash", "cmfc", "cmfs"].includes(brand);
}
