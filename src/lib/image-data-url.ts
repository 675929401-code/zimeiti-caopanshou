export type ParsedImageDataUrl = {
  bytes: Buffer;
  mimeType: string;
  extension: string;
};

export function parseImageDataUrl(value: string): ParsedImageDataUrl | null {
  if (!value.startsWith("data:")) return null;
  const separatorIndex = value.indexOf(",");
  if (separatorIndex <= 5) return null;

  const metadata = value.slice(5, separatorIndex);
  const metadataParts = metadata.split(";");
  const mimeType = metadataParts[0].toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/u.test(mimeType) || !metadataParts.slice(1).includes("base64")) return null;

  const encoded = value.slice(separatorIndex + 1);
  if (!encoded) return null;
  const extension = mimeType.split("/")[1].replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "png";

  return {
    bytes: Buffer.from(encoded, "base64"),
    mimeType,
    extension,
  };
}
