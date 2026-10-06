import { stat } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';

import { withAuth } from '@/lib/api-middleware';
import { verifyExtractTemporaryVideoSignature } from '@/lib/extract-download-signature';
import { isExtractLocalVideoHash, resolveExtractLocalVideoPath } from '@/lib/extract-local-video-cache';
import { findOwnedLinkExtractedVoice, registerCustomVoiceAsset, toPublicCustomVoice } from '@/lib/server/custom-voice-assets';
import { extractAudioFromLocalVideo } from '@/lib/vs/link-extractor';
import { normalizeReferenceAudioDuration } from '@/lib/vs/reference-audio-contract';

export const runtime = 'nodejs';

const MAX_LOCAL_VIDEO_BYTES = 300 * 1024 * 1024;

function boundedText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function resolveOwnedTemporaryVideo(value: unknown, userId: string): string {
  if (typeof value !== 'string' || !value.startsWith('/api/extract/local-video?')) {
    throw new Error('REFERENCE_VIDEO_URL_INVALID');
  }
  const parsed = new URL(value, 'http://voice.local');
  if (parsed.origin !== 'http://voice.local' || parsed.pathname !== '/api/extract/local-video' || parsed.hash) {
    throw new Error('REFERENCE_VIDEO_URL_INVALID');
  }
  const allowed = new Set(['file', 'owner', 'expires', 'sig']);
  if ([...parsed.searchParams.keys()].some(key => !allowed.has(key))) {
    throw new Error('REFERENCE_VIDEO_URL_INVALID');
  }
  if ([...allowed].some(key => parsed.searchParams.getAll(key).length !== 1)) {
    throw new Error('REFERENCE_VIDEO_URL_INVALID');
  }

  const fileHash = parsed.searchParams.get('file') || '';
  const ownerId = parsed.searchParams.get('owner') || '';
  if (!isExtractLocalVideoHash(fileHash) || ownerId !== userId) {
    throw new Error('REFERENCE_VIDEO_OWNER_MISMATCH');
  }
  if (!verifyExtractTemporaryVideoSignature(
    fileHash,
    ownerId,
    parsed.searchParams.get('expires'),
    parsed.searchParams.get('sig'),
  )) {
    throw new Error('REFERENCE_VIDEO_URL_EXPIRED');
  }
  return resolveExtractLocalVideoPath(fileHash);
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (user) => {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    let duration: number;
    let videoPath: string;
    try {
      duration = normalizeReferenceAudioDuration(body.duration);
      videoPath = resolveOwnedTemporaryVideo(body.temporaryVideoUrl, user.id);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'REFERENCE_VIDEO_INVALID';
      const expired = code === 'REFERENCE_VIDEO_URL_EXPIRED';
      const invalidDuration = code.startsWith('参考音频截取时长');
      return NextResponse.json({
        success: false,
        code: invalidDuration ? 'INVALID_DURATION' : code,
        message: invalidDuration
          ? code
          : expired
            ? '视频临时文件已过期，请重新提取'
            : '视频临时文件无效或不属于当前账号',
      }, { status: expired ? 410 : 400 });
    }

    try {
      const extractionRequestId = boundedText(body.extractionRequestId, 160);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(extractionRequestId)) {
        return NextResponse.json({
          success: false,
          code: 'EXTRACTION_REQUEST_ID_INVALID',
          message: '缺少稳定的提取请求标识，请重新发起视频提取',
        }, { status: 400 });
      }
      const existing = await findOwnedLinkExtractedVoice(user.id, extractionRequestId);
      if (existing) {
        return NextResponse.json({
          success: true,
          data: {
            audioAssetId: existing.id,
            audioFormat: existing.format.toLowerCase(),
            duration: existing.duration,
            title: existing.name,
            platform: existing.sourceInfo?.platform || '',
            cover: existing.sourceInfo?.cover || '',
            voice: toPublicCustomVoice(existing),
            source: 'owned-temporary-video',
            reused: true,
          },
        });
      }
      const videoStat = await stat(videoPath);
      if (!videoStat.isFile() || videoStat.size < 1_000 || videoStat.size > MAX_LOCAL_VIDEO_BYTES) {
        return NextResponse.json({
          success: false,
          code: 'REFERENCE_VIDEO_FILE_INVALID',
          message: '视频临时文件损坏，请重新提取',
        }, { status: 422 });
      }

      const result = await extractAudioFromLocalVideo(videoPath, duration, {
        title: boundedText(body.title, 100),
        cover: boundedText(body.cover, 2_000),
        platform: boundedText(body.platform, 40),
      });
      const voice = await registerCustomVoiceAsset({
        bytes: result.wav,
        originalFileName: 'reference.wav',
        declaredMimeType: 'audio/wav',
        name: result.title || '链接提取参考音频',
        userId: user.id,
        userName: user.displayName || user.email || user.id,
        duration: result.duration,
        source: 'link-extracted',
        sourceInfo: {
          platform: result.platform,
          cover: result.cover,
          extractionRequestId,
        },
      });
      return NextResponse.json({
        success: true,
        data: {
          audioAssetId: voice.id,
          audioFormat: 'wav',
          duration: result.duration,
          title: result.title,
          cover: result.cover,
          platform: result.platform,
          voice: toPublicCustomVoice(voice),
          source: 'owned-temporary-video',
        },
      });
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      console.error('[VoiceReferenceExtraction] local extraction failed:', diagnostic.slice(0, 240));
      const durationInvalid = diagnostic === 'CUSTOM_VOICE_DURATION_INVALID'
        || diagnostic.includes('14 秒')
        || diagnostic.includes('14-30');
      return NextResponse.json(
        {
          success: false,
          code: durationInvalid ? 'REFERENCE_AUDIO_DURATION_INVALID' : 'VIDEO_AUDIO_EXTRACTION_FAILED',
          message: durationInvalid
            ? '源视频中的有效音频不足 14 秒，请更换更长的视频'
            : '音频提取暂时未完成，请稍后用同一链接重试',
        },
        { status: durationInvalid ? 422 : 502 },
      );
    }
  });
}
