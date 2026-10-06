import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DECODED_IMAGE_BYTES = 256 * 1024 * 1024;

export type ValidatedImage = {
  format: "png" | "jpeg" | "webp" | "gif";
  width?: number;
  height?: number;
};

export class InvalidImageFileError extends Error {
  readonly code = "IMAGE_DECODE_FAILED";

  constructor(message = "生成图片文件损坏或无法解码") {
    super(message);
    this.name = "InvalidImageFileError";
  }
}

function validatePng(bytes: Buffer): ValidatedImage {
  if (bytes.length < 45 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new InvalidImageFileError("PNG 文件头无效");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let hasHeader = false;
  let hasEnd = false;
  const imageData: Buffer[] = [];

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + length + 4;
    if (length > bytes.length || nextOffset > bytes.length) {
      throw new InvalidImageFileError("PNG 数据块长度无效");
    }
    const type = bytes.toString("ascii", typeOffset, typeOffset + 4);
    const data = bytes.subarray(dataOffset, dataOffset + length);
    if (type === "IHDR") {
      if (length !== 13) throw new InvalidImageFileError("PNG 画布信息无效");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      hasHeader = width > 0 && height > 0;
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      hasEnd = true;
      offset = nextOffset;
      break;
    }
    offset = nextOffset;
  }

  if (!hasHeader || !hasEnd || imageData.length === 0) {
    throw new InvalidImageFileError("PNG 缺少必要数据块");
  }
  try {
    const decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: MAX_DECODED_IMAGE_BYTES });
    if (!decoded.length) throw new Error("empty image data");
  } catch {
    throw new InvalidImageFileError("PNG 像素数据损坏，无法完整解码");
  }
  return { format: "png", width, height };
}

export function validateImageFile(bytes: Buffer, mimeType = ""): ValidatedImage {
  if (!bytes.length) throw new InvalidImageFileError("图片文件为空");
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || mimeType.includes("png")) {
    return validatePng(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes.length < 4 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      throw new InvalidImageFileError("JPEG 文件不完整");
    }
    return { format: "jpeg" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { format: "webp" };
  }
  if (bytes.length >= 13 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return { format: "gif" };
  }
  throw new InvalidImageFileError("生成结果不是可识别的图片文件");
}
