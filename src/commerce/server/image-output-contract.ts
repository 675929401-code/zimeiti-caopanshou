import sharp from 'sharp';
import { normalizeImageFormat, type ImageOutputFormat } from '../image-input-contract';

export type GeneratedImageOutput = {
  bytes: Buffer;
  type: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  normalized: boolean;
};

const RESOLUTION_SIDE: Readonly<Record<string, number>> = Object.freeze({ '1K': 1024, '2K': 2048, '4K': 4096 });

export function imageTargetDimensions(aspectRatio: unknown, resolution: unknown) {
  if (typeof aspectRatio !== 'string' || typeof resolution !== 'string') throw Error('图片输出缺少画幅或分辨率合同');
  const parts = aspectRatio.trim().split(':');
  if (parts.length !== 2) throw Error('图片输出画幅合同无效');
  const widthRatio = Number(parts[0]), heightRatio = Number(parts[1]), side = RESOLUTION_SIDE[resolution.trim().toUpperCase()];
  if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio) || widthRatio <= 0 || heightRatio <= 0 || !side) throw Error('图片输出画幅或分辨率合同无效');
  return {
    width: Math.round(side * Math.sqrt(widthRatio / heightRatio) / 8) * 8,
    height: Math.round(side * Math.sqrt(heightRatio / widthRatio) / 8) * 8,
  };
}

function mimeFor(format: ImageOutputFormat) { return `image/${format === 'JPEG' ? 'jpeg' : format.toLowerCase()}`; }
function sharpFormat(format: ImageOutputFormat) { return format === 'JPEG' ? 'jpeg' : format.toLowerCase() as 'png' | 'webp'; }

export async function inspectGeneratedImageOutput(bytes: Buffer, type: string, aspectRatio: unknown, resolution: unknown, format?: unknown) {
  const target = imageTargetDimensions(aspectRatio, resolution), metadata = await sharp(bytes).metadata();
  const width = Number(metadata.width || 0), height = Number(metadata.height || 0), expectedFormat = normalizeImageFormat(format);
  if (!width || !height) throw Error('图片结果无法读取像素尺寸');
  const issues: string[] = [];
  if (width !== target.width || height !== target.height) issues.push(`分辨率应为 ${target.width}×${target.height}，实际为 ${width}×${height}`);
  if (expectedFormat && type !== mimeFor(expectedFormat)) issues.push(`格式应为 ${mimeFor(expectedFormat)}，实际为 ${type}`);
  return { width, height, targetWidth: target.width, targetHeight: target.height, type, expectedType: expectedFormat ? mimeFor(expectedFormat) : type, issues };
}

export async function normalizeGeneratedImageOutput(downloaded: { bytes: Buffer; type: string }, aspectRatio: unknown, resolution: unknown, format?: unknown): Promise<GeneratedImageOutput> {
  const target = imageTargetDimensions(aspectRatio, resolution), metadata = await sharp(downloaded.bytes).metadata();
  const sourceWidth = Number(metadata.width || 0), sourceHeight = Number(metadata.height || 0);
  if (!sourceWidth || !sourceHeight) throw Error('模型返回的图片无法读取像素尺寸');
  const expectedRatio = target.width / target.height, actualRatio = sourceWidth / sourceHeight;
  if (Math.abs(Math.log(actualRatio / expectedRatio)) > 0.025) throw Error(`模型返回画幅与请求不符：请求 ${aspectRatio}，实际 ${sourceWidth}×${sourceHeight}`);
  if (sourceWidth < target.width || sourceHeight < target.height) throw Error(`模型返回分辨率低于请求：需要 ${target.width}×${target.height}，实际 ${sourceWidth}×${sourceHeight}`);
  const outputFormat = normalizeImageFormat(format) || (downloaded.type === 'image/jpeg' ? 'JPEG' : downloaded.type === 'image/webp' ? 'WEBP' : 'PNG');
  const outputType = mimeFor(outputFormat), needsResize = sourceWidth !== target.width || sourceHeight !== target.height, needsFormat = downloaded.type !== outputType;
  let bytes = downloaded.bytes;
  if (needsResize || needsFormat) bytes = await sharp(downloaded.bytes).resize(target.width, target.height, { fit: 'fill' }).toFormat(sharpFormat(outputFormat)).toBuffer();
  const final = await inspectGeneratedImageOutput(bytes, outputType, aspectRatio, resolution, outputFormat);
  if (final.issues.length) throw Error(`图片结果规格归一化失败：${final.issues.join('；')}`);
  return { bytes, type: outputType, width: final.width, height: final.height, sourceWidth, sourceHeight, normalized: needsResize || needsFormat };
}
