const VIDEO_TYPE_BY_EXTENSION = Object.freeze([
  { pattern: /\.mp4(?:\?|$)/iu, contentType: "video/mp4" },
  { pattern: /\.m4v(?:\?|$)/iu, contentType: "video/mp4" },
  { pattern: /\.webm(?:\?|$)/iu, contentType: "video/webm" },
  { pattern: /\.(?:mov|qt)(?:\?|$)/iu, contentType: "video/quicktime" },
]);

function normalizedDeclaredType(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

export function sniffVideoContentType(prefix: Uint8Array): string | null {
  if (prefix.length >= 12 && ascii(prefix, 4, 8) === "ftyp") {
    return ascii(prefix, 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (prefix.length >= 4
      && prefix[0] === 0x1a
      && prefix[1] === 0x45
      && prefix[2] === 0xdf
      && prefix[3] === 0xa3) {
    return "video/webm";
  }
  return null;
}

export function inferVideoContentType(input: {
  declaredContentType?: string | null;
  sourceUrl: string;
  prefix?: Uint8Array | null;
  cachedContentType?: string | null;
}): string | null {
  const declared = normalizedDeclaredType(input.declaredContentType || "");
  if (declared.startsWith("video/")) return declared;
  for (const candidate of VIDEO_TYPE_BY_EXTENSION) {
    if (candidate.pattern.test(input.sourceUrl)) return candidate.contentType;
  }
  if (input.prefix) {
    const sniffed = sniffVideoContentType(input.prefix);
    if (sniffed) return sniffed;
  }
  const cached = normalizedDeclaredType(input.cachedContentType || "");
  return cached.startsWith("video/") ? cached : null;
}
