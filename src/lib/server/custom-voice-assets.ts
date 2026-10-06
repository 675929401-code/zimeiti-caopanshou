import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { atomicWriteJsonSync } from '@/lib/atomic-file';
import { validateAudioFileSignature, type SupportedAudioExtension } from '@/lib/audio-file-signature';
import { probeGeneratedAudioDuration } from '@/lib/digital-human-media';
import { deleteFile, getSignedUrl, readFileContent, uploadFile } from '@/lib/storage';
import { isProductionRuntime, resolveAppDataFile } from '@/lib/runtime-paths';
import {
  REFERENCE_AUDIO_MAX_DURATION_SECONDS,
  REFERENCE_AUDIO_MIN_DURATION_SECONDS,
} from '@/lib/vs/reference-audio-contract';

export const MAX_CUSTOM_VOICE_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_CUSTOM_VOICE_USER_BYTES = 5 * 1024 * 1024 * 1024;

export interface StoredCustomVoice {
  id: string;
  name: string;
  userId: string;
  userName: string;
  fileKey: string;
  size: number;
  format: string;
  mimeType: string;
  duration?: number;
  createdAt: string;
  gender: 'female' | 'male';
  source?: 'upload' | 'link-extracted';
  sourceInfo?: Record<string, string>;
}

export type CustomVoiceWithUrl = StoredCustomVoice & { url: string };
export type PublicCustomVoice = Pick<CustomVoiceWithUrl,
  'id' | 'url' | 'name' | 'size' | 'format' | 'duration' | 'createdAt' | 'gender' | 'source'
>;

export function toPublicCustomVoice(voice: CustomVoiceWithUrl): PublicCustomVoice {
  return {
    id: voice.id,
    url: voice.url,
    name: voice.name,
    size: voice.size,
    format: voice.format,
    duration: voice.duration,
    createdAt: voice.createdAt,
    gender: voice.gender,
    source: voice.source,
  };
}

let customVoiceMutationTail: Promise<void> = Promise.resolve();

async function withCustomVoiceMutation<T>(mutation: () => Promise<T> | T): Promise<T> {
  const previous = customVoiceMutationTail;
  let release: () => void = () => undefined;
  customVoiceMutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await mutation();
  } finally {
    release();
  }
}

function readCustomVoices(): StoredCustomVoice[] {
  const dataFile = resolveAppDataFile('custom-voices.json');
  try {
    if (!fs.existsSync(dataFile)) {
      if (isProductionRuntime()) throw new Error(`Required runtime data file is missing: ${dataFile}`);
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as Array<StoredCustomVoice & { url?: string }>;
    return parsed.map(({ url: legacySignedUrl, mimeType, ...voice }) => {
      void legacySignedUrl;
      return {
        ...voice,
        mimeType: mimeType || `audio/${voice.format.toLowerCase()}`,
      };
    });
  } catch (error) {
    if (isProductionRuntime()) throw error;
    return [];
  }
}

function saveCustomVoices(voices: StoredCustomVoice[]): void {
  atomicWriteJsonSync(resolveAppDataFile('custom-voices.json'), voices);
}

export async function withFreshCustomVoiceUrl(voice: StoredCustomVoice): Promise<CustomVoiceWithUrl> {
  return { ...voice, url: await getSignedUrl(voice.fileKey, 3600) };
}

export async function listOwnedCustomVoices(userId: string): Promise<CustomVoiceWithUrl[]> {
  return Promise.all(readCustomVoices().filter((voice) => voice.userId === userId).map(withFreshCustomVoiceUrl));
}

export function getOwnedCustomVoice(userId: string, id: string): StoredCustomVoice | null {
  return readCustomVoices().find((voice) => voice.id === id && voice.userId === userId) || null;
}

export async function findOwnedLinkExtractedVoice(
  userId: string,
  extractionRequestId: string,
): Promise<CustomVoiceWithUrl | null> {
  const normalized = extractionRequestId.trim().slice(0, 160);
  if (!normalized) return null;
  const voice = readCustomVoices().find((entry) => entry.userId === userId
    && entry.source === 'link-extracted'
    && entry.sourceInfo?.extractionRequestId === normalized);
  return voice ? withFreshCustomVoiceUrl(voice) : null;
}

export async function readOwnedCustomVoiceAudio(userId: string, id: string): Promise<{
  voice: StoredCustomVoice;
  bytes: Buffer;
  extension: SupportedAudioExtension;
  duration: number;
}> {
  const voice = getOwnedCustomVoice(userId, id);
  if (!voice) throw new Error('CUSTOM_VOICE_NOT_FOUND');
  const bytes = await readFileContent(voice.fileKey);
  if (bytes.length === 0 || bytes.length > MAX_CUSTOM_VOICE_FILE_BYTES) {
    throw new Error('CUSTOM_VOICE_OBJECT_SIZE_INVALID');
  }
  const signature = validateAudioFileSignature({
    bytes,
    fileName: `reference.${voice.format.toLowerCase()}`,
    mimeType: voice.mimeType,
  });
  const duration = await probeGeneratedAudioDuration(bytes, `.${signature.extension}`);
  if (duration < REFERENCE_AUDIO_MIN_DURATION_SECONDS || duration > REFERENCE_AUDIO_MAX_DURATION_SECONDS) {
    throw new Error('CUSTOM_VOICE_DURATION_INVALID');
  }
  return { voice, bytes, extension: signature.extension, duration };
}

export async function registerCustomVoiceAsset(input: {
  bytes: Buffer;
  originalFileName: string;
  declaredMimeType?: string;
  name: string;
  userId: string;
  userName: string;
  gender?: 'female' | 'male';
  duration?: number;
  source?: 'upload' | 'link-extracted';
  sourceInfo?: Record<string, string>;
}): Promise<CustomVoiceWithUrl> {
  if (input.bytes.length === 0 || input.bytes.length > MAX_CUSTOM_VOICE_FILE_BYTES) {
    throw new Error('CUSTOM_VOICE_FILE_SIZE_INVALID');
  }
  const signature = validateAudioFileSignature({
    bytes: input.bytes,
    fileName: input.originalFileName,
    mimeType: input.declaredMimeType,
  });
  const actualDuration = await probeGeneratedAudioDuration(input.bytes, `.${signature.extension}`);
  if (actualDuration < REFERENCE_AUDIO_MIN_DURATION_SECONDS || actualDuration > REFERENCE_AUDIO_MAX_DURATION_SECONDS) {
    throw new Error('CUSTOM_VOICE_DURATION_INVALID');
  }
  const voiceName = input.name.trim().slice(0, 80);
  if (!voiceName) throw new Error('CUSTOM_VOICE_NAME_REQUIRED');

  const extractionRequestId = input.source === 'link-extracted'
    ? String(input.sourceInfo?.extractionRequestId || '').trim().slice(0, 160)
    : '';
  if (extractionRequestId) {
    const existing = readCustomVoices().find((voice) => voice.userId === input.userId
      && voice.source === 'link-extracted'
      && voice.sourceInfo?.extractionRequestId === extractionRequestId);
    if (existing) return withFreshCustomVoiceUrl(existing);
  }

  const existingBytes = readCustomVoices()
    .filter((voice) => voice.userId === input.userId)
    .reduce((sum, voice) => sum + voice.size, 0);
  if (existingBytes + input.bytes.length > MAX_CUSTOM_VOICE_USER_BYTES) {
    throw new Error('CUSTOM_VOICE_QUOTA_EXCEEDED');
  }

  const date = new Date().toISOString().slice(0, 10);
  const objectKey = `custom-voices/${date}/${Date.now()}-${randomUUID()}.${signature.extension}`;
  const fileKey = await uploadFile(input.bytes, objectKey, signature.canonicalMime);
  const voice: StoredCustomVoice = {
    id: `custom_${randomUUID()}`,
    name: voiceName,
    userId: input.userId,
    userName: input.userName,
    fileKey,
    size: input.bytes.length,
    format: signature.extension.toUpperCase(),
    mimeType: signature.canonicalMime,
    duration: actualDuration,
    createdAt: new Date().toISOString(),
    gender: input.gender || 'female',
    source: input.source || 'upload',
    sourceInfo: input.sourceInfo,
  };

  try {
    const saved = await withCustomVoiceMutation(() => {
      const voices = readCustomVoices();
      const duplicate = extractionRequestId
        ? voices.find((entry) => entry.userId === input.userId
          && entry.source === 'link-extracted'
          && entry.sourceInfo?.extractionRequestId === extractionRequestId)
        : undefined;
      if (duplicate) return { created: false, voice: duplicate };
      const used = voices
        .filter((entry) => entry.userId === input.userId)
        .reduce((sum, entry) => sum + entry.size, 0);
      if (used + input.bytes.length > MAX_CUSTOM_VOICE_USER_BYTES) return null;
      voices.push(voice);
      saveCustomVoices(voices);
      return { created: true, voice };
    });
    if (!saved) throw new Error('CUSTOM_VOICE_QUOTA_EXCEEDED');
    if (!saved.created) {
      await deleteFile(fileKey).catch(() => undefined);
      return withFreshCustomVoiceUrl(saved.voice);
    }
  } catch (error) {
    await deleteFile(fileKey).catch(() => undefined);
    throw error;
  }

  return withFreshCustomVoiceUrl(voice);
}

export async function renameOwnedCustomVoice(userId: string, id: string, name: string): Promise<CustomVoiceWithUrl | null> {
  const normalized = name.trim().slice(0, 80);
  if (!normalized) throw new Error('CUSTOM_VOICE_NAME_REQUIRED');
  const updated = await withCustomVoiceMutation(() => {
    const voices = readCustomVoices();
    const index = voices.findIndex((voice) => voice.id === id && voice.userId === userId);
    if (index < 0) return null;
    voices[index] = { ...voices[index], name: normalized };
    saveCustomVoices(voices);
    return voices[index];
  });
  return updated ? withFreshCustomVoiceUrl(updated) : null;
}

export async function deleteOwnedCustomVoice(userId: string, id: string): Promise<boolean> {
  const removed = await withCustomVoiceMutation(() => {
    const voices = readCustomVoices();
    const index = voices.findIndex((voice) => voice.id === id && voice.userId === userId);
    if (index < 0) return null;
    const [voice] = voices.splice(index, 1);
    saveCustomVoices(voices);
    return voice;
  });
  if (!removed) return false;
  try {
    await deleteFile(removed.fileKey);
  } catch {
    await withCustomVoiceMutation(() => {
      const voices = readCustomVoices();
      if (!voices.some((voice) => voice.id === removed.id && voice.userId === removed.userId)) {
        voices.push(removed);
        saveCustomVoices(voices);
      }
    });
    throw new Error('CUSTOM_VOICE_FILE_DELETE_FAILED');
  }
  return true;
}
