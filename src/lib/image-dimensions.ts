import { safeFetch } from "@/lib/safe-fetch";

export type ImageDimensions = { width: number; height: number };

export function parseImageDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG") {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if (buffer.length >= 10 && buffer.subarray(0, 3).toString("ascii") === "GIF") {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const type = buffer.subarray(12, 16).toString("ascii");
    if (type === "VP8X" && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height };
    }
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + segmentLength + 2 > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += 2 + segmentLength;
    }
  }
  return null;
}

export async function fetchRemoteImageDimensions(url: string): Promise<ImageDimensions | null> {
  const response = await safeFetch(url, {
    timeoutMs: 15_000,
    maxBytes: 64 * 1024,
    maxRedirects: 3,
    allowedContentTypes: ["image/*"],
    trustedHostnames: ["source.openclaw-token.shop", "flow.secure-skill.com"],
    headers: { Range: "bytes=0-65535" },
  });
  return parseImageDimensions(response.buffer);
}
