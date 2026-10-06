import sharp from 'sharp';

const MAX_REFERENCE_SIDE = 2048;
const MAX_REFERENCE_BYTES = 1_000_000;

export type ProviderImageReference = {
  dataUrl: string;
  type: string;
  width: number;
  height: number;
  bytes: number;
  normalized: boolean;
};

const allowedType = (type: string) => /^image\/(png|jpeg|webp)$/u.test(type);

/**
 * Keeps the immutable source asset unchanged while producing a bounded,
 * deterministic provider payload. Large source images otherwise make a
 * multi-reference request exceed relay/provider JSON limits before generation.
 */
export async function providerImageReferenceDataUrl(bytes: Buffer, type: string): Promise<ProviderImageReference> {
  if (!allowedType(type)) throw Error('参考图格式不受支持');
  const metadata = await sharp(bytes).metadata();
  const sourceWidth = Number(metadata.width || 0), sourceHeight = Number(metadata.height || 0);
  if (!sourceWidth || !sourceHeight) throw Error('参考图像素尺寸无法读取');
  if (sourceWidth <= MAX_REFERENCE_SIDE && sourceHeight <= MAX_REFERENCE_SIDE && bytes.length <= MAX_REFERENCE_BYTES) {
    return { dataUrl: `data:${type};base64,${bytes.toString('base64')}`, type, width: sourceWidth, height: sourceHeight, bytes: bytes.length, normalized: false };
  }

  const attempts = [
    { side: 2048, quality: 92 },
    { side: 1792, quality: 88 },
    { side: 1536, quality: 86 },
    { side: 1280, quality: 84 },
  ];
  let output: Buffer = Buffer.alloc(0), width = 0, height = 0;
  for (const attempt of attempts) {
    output = await sharp(bytes)
      .rotate()
      .resize({ width: attempt.side, height: attempt.side, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: attempt.quality, alphaQuality: 100, effort: 4 })
      .toBuffer();
    const current = await sharp(output).metadata();
    width = Number(current.width || 0); height = Number(current.height || 0);
    if (output.length <= MAX_REFERENCE_BYTES) break;
  }
  if (!width || !height || output.length > MAX_REFERENCE_BYTES) throw Error('参考图压缩后仍超过模型请求上限');
  return { dataUrl: `data:image/webp;base64,${output.toString('base64')}`, type: 'image/webp', width, height, bytes: output.length, normalized: true };
}
