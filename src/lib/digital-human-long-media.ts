import 'server-only';

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { safeFetch } from '@/lib/safe-fetch';
import { validateUploadBuffer } from '@/lib/file-upload-security';
import { resolveAppRuntimeDir } from '@/lib/runtime-paths';
import { storageManager, type StorageProviderType } from '@/storage/object';
import {
  cutLongDigitalHumanMediaFiles,
  mergeLongDigitalHumanVideoFiles,
} from '@/lib/digital-human-long-media-local';

export { cutLongDigitalHumanMediaFiles, mergeLongDigitalHumanVideoFiles } from '@/lib/digital-human-long-media-local';

const VIDEO_PROVIDER: StorageProviderType = 'tencent_cos';

type OwnedFile = {
  id: string;
  storage_key: string;
  storage_provider: StorageProviderType;
  file_category: 'audio' | 'video';
  content_type: string;
  source: string;
};

export type LongMediaSegment = {
  id: string;
  ordinal: number;
  start_seconds: number;
  duration_seconds: number;
  prepared_person_asset_id?: string | null;
  prepared_audio_asset_id?: string | null;
};

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function objectKeyFromUri(value: string) {
  const match = value.match(/^object:\/\/tencent_cos\/([^?#]+)$/u);
  if (!match) throw new Error('DIGITAL_HUMAN_LONG_OBJECT_URI_INVALID');
  return decodeURIComponent(match[1]);
}

export async function ownedPersistentVideoReceipt(userId: string, storageUrl: string) {
  const storageKey = objectKeyFromUri(storageUrl);
  const { data, error } = await getSupabaseAdminClient().from('user_files')
    .select('id,storage_key,storage_provider').eq('user_id', userId).eq('storage_key', storageKey)
    .eq('file_category', 'video').eq('source', 'video-generation').limit(1).maybeSingle();
  if (error || !data?.id || data.storage_provider !== VIDEO_PROVIDER) {
    throw new Error('DIGITAL_HUMAN_LONG_RESULT_RECEIPT_MISSING');
  }
  const bytes = await storageManager.read(storageKey, VIDEO_PROVIDER);
  return { assetId: String(data.id), storageUrl, sha256: sha256(bytes) };
}

export async function persistLongSegmentProviderVideo(input: {
  resultUrl: string;
  segmentId: string;
  parentId: string;
  userId: string;
}) {
  const downloaded = await safeFetch(input.resultUrl, {
    maxBytes: 512 * 1024 * 1024,
    timeoutMs: 5 * 60_000,
    maxRedirects: 3,
    allowedContentTypes: ['video/mp4', 'video/quicktime', 'application/octet-stream'],
  });
  const detected = validateUploadBuffer(downloaded.buffer, downloaded.contentType);
  if (!detected.contentType.startsWith('video/')) throw new Error('DIGITAL_HUMAN_LONG_PROVIDER_RESULT_INVALID');
  const digest = sha256(downloaded.buffer);
  const uploaded = await storageManager.upload(downloaded.buffer, `${input.segmentId}.mp4`, 'video/mp4', {
    providerType: VIDEO_PROVIDER, strictProvider: true, requireOwnershipRecord: true,
    category: 'video', prefix: `videos/digital-human-long/${input.parentId}/segments/`,
    fileName: `${input.segmentId}.mp4`, userId: input.userId, source: 'video-generation',
    meta: { taskId: input.segmentId, parentId: input.parentId, sha256: digest },
  });
  const assetId = await assetIdForStorageKey(input.userId, uploaded.key, 'video');
  return {
    assetId,
    storageUrl: `object://${VIDEO_PROVIDER}/${encodeURIComponent(uploaded.key)}`,
    sha256: digest,
  };
}

async function ownedFile(userId: string, assetId: string, category: 'audio' | 'video'): Promise<OwnedFile> {
  const { data, error } = await getSupabaseAdminClient().from('user_files')
    .select('id,storage_key,storage_provider,file_category,content_type,source')
    .eq('id', assetId).eq('user_id', userId).eq('file_category', category)
    .in('source', ['digital-human-input', 'voice-generation', 'video-generation'])
    .maybeSingle();
  if (error || !data) throw new Error('DIGITAL_HUMAN_LONG_ASSET_UNAVAILABLE');
  return data as OwnedFile;
}

async function assetIdForStorageKey(userId: string, storageKey: string, category: 'audio' | 'video') {
  const { data, error } = await getSupabaseAdminClient().from('user_files').select('id')
    .eq('user_id', userId).eq('storage_key', storageKey).eq('file_category', category)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error || !data?.id) throw new Error('DIGITAL_HUMAN_LONG_ASSET_RECEIPT_MISSING');
  return String(data.id);
}

async function runtimeDirectory(prefix: string) {
  const root = path.join(/* turbopackIgnore: true */ resolveAppRuntimeDir(), 'digital-human-long');
  return mkdtemp(path.join(root, `${prefix}-`)).catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(root, { recursive: true });
    return mkdtemp(path.join(root, `${prefix}-`));
  });
}

export async function prepareLongDigitalHumanSegment(input: {
  parentId: string;
  userId: string;
  sourceVideoAssetId: string;
  sourceAudioAssetId: string;
  sourceVideoDurationSeconds: number;
  segment: LongMediaSegment;
}) {
  if (input.segment.prepared_person_asset_id && input.segment.prepared_audio_asset_id) {
    return {
      personAssetId: input.segment.prepared_person_asset_id,
      audioAssetId: input.segment.prepared_audio_asset_id,
    };
  }
  const [video, audio] = await Promise.all([
    ownedFile(input.userId, input.sourceVideoAssetId, 'video'),
    ownedFile(input.userId, input.sourceAudioAssetId, 'audio'),
  ]);
  const [videoBytes, audioBytes] = await Promise.all([
    storageManager.read(video.storage_key, video.storage_provider),
    storageManager.read(audio.storage_key, audio.storage_provider),
  ]);
  const directory = await runtimeDirectory('segment');
  const sourceVideo = path.join(directory, 'source-video');
  const sourceAudio = path.join(directory, 'source-audio');
  const outputVideo = path.join(directory, 'person.mp4');
  const outputAudio = path.join(directory, 'speech.wav');
  try {
    await Promise.all([writeFile(sourceVideo, videoBytes, { flag: 'wx' }), writeFile(sourceAudio, audioBytes, { flag: 'wx' })]);
    await cutLongDigitalHumanMediaFiles({
      videoPath: sourceVideo,
      audioPath: sourceAudio,
      videoDurationSeconds: input.sourceVideoDurationSeconds,
      startSeconds: Number(input.segment.start_seconds),
      durationSeconds: Number(input.segment.duration_seconds),
      outputVideoPath: outputVideo,
      outputAudioPath: outputAudio,
    });
    const [preparedVideo, preparedAudio] = await Promise.all([readFile(outputVideo), readFile(outputAudio)]);
    const prefix = `digital-human-long/${input.parentId}/segments/${input.segment.ordinal}/`;
    const [uploadedVideo, uploadedAudio] = await Promise.all([
      storageManager.upload(preparedVideo, 'person.mp4', 'video/mp4', {
        providerType: VIDEO_PROVIDER, strictProvider: true, requireOwnershipRecord: true,
        category: 'video', prefix, fileName: 'person.mp4', userId: input.userId,
        source: 'digital-human-input', meta: { parentId: input.parentId, segmentId: input.segment.id },
      }),
      storageManager.upload(preparedAudio, 'speech.wav', 'audio/wav', {
        providerType: VIDEO_PROVIDER, strictProvider: true, requireOwnershipRecord: true,
        category: 'audio', prefix, fileName: 'speech.wav', userId: input.userId,
        source: 'digital-human-input', meta: { parentId: input.parentId, segmentId: input.segment.id },
      }),
    ]);
    const [personAssetId, audioAssetId] = await Promise.all([
      assetIdForStorageKey(input.userId, uploadedVideo.key, 'video'),
      assetIdForStorageKey(input.userId, uploadedAudio.key, 'audio'),
    ]);
    return { personAssetId, audioAssetId };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function mergeLongDigitalHumanSegments(input: {
  parentId: string;
  userId: string;
  segments: Array<{ ordinal: number; result_storage_url: string }>;
}) {
  const sorted = [...input.segments].sort((a, b) => a.ordinal - b.ordinal);
  if (sorted.some((item, index) => item.ordinal !== index)) throw new Error('DIGITAL_HUMAN_LONG_MERGE_SEQUENCE_INVALID');
  const directory = await runtimeDirectory('merge');
  try {
    const sourcePaths: string[] = [];
    for (const [index, segment] of sorted.entries()) {
      const bytes = await storageManager.read(objectKeyFromUri(segment.result_storage_url), VIDEO_PROVIDER);
      const sourcePath = path.join(directory, `source-${String(index).padStart(4, '0')}.mp4`);
      await writeFile(sourcePath, bytes, { flag: 'wx' });
      sourcePaths.push(sourcePath);
    }
    const outputPath = path.join(directory, 'complete.mp4');
    await mergeLongDigitalHumanVideoFiles(sourcePaths, outputPath);
    const output = await readFile(outputPath);
    const digest = sha256(output);
    const uploaded = await storageManager.upload(output, `${input.parentId}.mp4`, 'video/mp4', {
      providerType: VIDEO_PROVIDER, strictProvider: true, requireOwnershipRecord: true,
      category: 'video', prefix: 'videos/digital-human-long/', fileName: `${input.parentId}.mp4`,
      userId: input.userId, source: 'video-generation',
      meta: { taskId: input.parentId, sha256: digest, segmentCount: String(sorted.length) },
    });
    const assetId = await assetIdForStorageKey(input.userId, uploaded.key, 'video');
    return {
      assetId,
      storageUrl: `object://${VIDEO_PROVIDER}/${encodeURIComponent(uploaded.key)}`,
      sha256: digest,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
