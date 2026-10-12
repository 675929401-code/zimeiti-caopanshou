import { z } from "zod";

export const GeneratedImageReferenceSchema = z.object({
  schema: z.literal("generated_image_ref.v1"),
  recordId: z.string().regex(/^[a-f0-9]{64}$/u),
  transform: z.object({
    kind: z.literal("crop"), x: z.number().int().safe().nonnegative(), y: z.number().int().safe().nonnegative(),
    width: z.number().int().safe().positive(), height: z.number().int().safe().positive(),
  }).strict().optional(),
}).strict();
export type GeneratedImageReference = z.infer<typeof GeneratedImageReferenceSchema>;

export function generatedImageReferenceUri(value: GeneratedImageReference): string {
  const ref = GeneratedImageReferenceSchema.parse(value);
  const crop = ref.transform;
  return `generated-image://${ref.recordId}${crop ? `?crop=${crop.x},${crop.y},${crop.width},${crop.height}` : ""}`;
}

export function parseGeneratedImageReferenceUri(value: unknown): GeneratedImageReference | null {
  if (typeof value !== "string") return null;
  const match = /^generated-image:\/\/([a-f0-9]{64})(?:\?crop=(0|[1-9]\d*),(0|[1-9]\d*),([1-9]\d*),([1-9]\d*))?$/u.exec(value);
  if (!match) return null;
  const parsed = GeneratedImageReferenceSchema.safeParse({ schema: "generated_image_ref.v1", recordId: match[1],
    ...(match[2] !== undefined ? { transform: { kind: "crop", x: Number(match[2]), y: Number(match[3]), width: Number(match[4]), height: Number(match[5]) } } : {}) });
  return parsed.success ? parsed.data : null;
}

export function generatedImagePreviewUrl(ref: GeneratedImageReference) {
  return `/api/media-history/content?recordId=${GeneratedImageReferenceSchema.parse(ref).recordId}`;
}

/** Closed typed representations for the video adapter's existing image slots. */
export function parseGeneratedVideoImageInputs(body: Record<string, unknown>) {
  const typed = new Map<string, GeneratedImageReference>();
  const one = (refKey: string, urlKey: string) => {
    if (!(refKey in body)) {
      const value = body[urlKey];
      if (value == null) return undefined;
      if (typeof value !== "string") throw new Error("GENERATED_IMAGE_INPUT_INVALID");
      return value;
    }
    if (urlKey in body || (refKey === "image_ref" && "image_storage_key" in body)) throw new Error("GENERATED_IMAGE_REFERENCE_CONFLICT");
    const ref = GeneratedImageReferenceSchema.parse(body[refKey]);
    typed.set(urlKey, ref);
    return generatedImageReferenceUri(ref);
  };
  const imageUrl = one("image_ref", "image_url");
  const lastFrameUrl = one("last_frame_ref", "last_frame_url");
  const referenceImageUrl = one("reference_image_ref", "reference_image_url");
  let referenceImageUrls = body.reference_image_urls as string[] | undefined;
  if ("reference_image_inputs" in body) {
    if ("reference_image_urls" in body || !Array.isArray(body.reference_image_inputs) || body.reference_image_inputs.length > 32) throw new Error("GENERATED_IMAGE_REFERENCE_LIST_INVALID");
    referenceImageUrls = body.reference_image_inputs.map((item, index) => {
      if (typeof item === "string") {
        if (!item.trim() || parseGeneratedImageReferenceUri(item)) throw new Error("GENERATED_IMAGE_REFERENCE_LIST_INVALID");
        return item.trim();
      }
      const ref = GeneratedImageReferenceSchema.parse(item);
      typed.set(`reference_image_urls[${index}]`, ref);
      return generatedImageReferenceUri(ref);
    });
  }
  return { imageUrl, lastFrameUrl, referenceImageUrl, referenceImageUrls, typed };
}
