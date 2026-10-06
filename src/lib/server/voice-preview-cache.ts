import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAppDataDir } from '@/lib/runtime-paths';

// Some provider responses omit duration; zero means unknown until playback.
export type VoicePreviewAudio = { audioUrl: string; duration: number };
export type VoicePreviewCacheInput = {
  speakerId: string;
  text: string;
  providerIdentity: string;
  /** Null only for a verified public catalog voice, never a private voice. */
  ownerId: string | null;
};
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 30 * 24 * 60 * 60 * 1000;
type CachedResult = { audio: VoicePreviewAudio; cacheHit: boolean };
const scope = globalThis as typeof globalThis & { __voicePreviewInFlight?: Map<string, Promise<CachedResult>> };
const inFlight = scope.__voicePreviewInFlight || (scope.__voicePreviewInFlight = new Map());

function validAudio(value: unknown): value is VoicePreviewAudio {
  if (!value || typeof value !== 'object') return false;
  const audio = value as VoicePreviewAudio;
  const valid = typeof audio.audioUrl === 'string'
    && audio.audioUrl.length < MAX_FILE_BYTES
    && /^data:audio\/(?:mp3|mpeg|wav);base64,[A-Za-z0-9+/]+={0,2}$/u.test(audio.audioUrl)
    && Number.isFinite(audio.duration) && audio.duration >= 0;
  if (!valid) return false;
  const header = Buffer.from(audio.audioUrl.slice(audio.audioUrl.indexOf(',') + 1, audio.audioUrl.indexOf(',') + 33), 'base64');
  return header.subarray(0, 3).toString() === 'ID3'
    || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)
    || (header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WAVE');
}

/** Fixed-text samples persist outside the public web root. Auth and private
 * voice ownership must be checked by the route before reading this cache.
 * In-flight deduplication covers one application process; the on-disk result
 * survives restarts. A multi-node installation needs a shared dispatch lock.
 */
export function createVoicePreviewCache(directory: string) {
  return async (input: VoicePreviewCacheInput, synthesize: () => Promise<VoicePreviewAudio>): Promise<CachedResult> => {
    if (!input.speakerId || !input.text || !input.providerIdentity || input.ownerId === '') throw new Error('Invalid preview cache identity');
    const key = createHash('sha256').update(JSON.stringify(['v1', input.ownerId, input.speakerId, input.text, input.providerIdentity])).digest('hex');
    const file = path.join(directory, key + '.json');
    const pending = inFlight.get(file);
    if (pending) return pending;
    const work = (async (): Promise<CachedResult> => {
      try {
        const info = await stat(file);
        if (info.isFile() && info.size <= MAX_FILE_BYTES) {
          const saved = JSON.parse(await readFile(file, 'utf8'));
          if (saved.key === key && saved.expiresAt > Date.now() && validAudio(saved.audio)) return { audio: saved.audio, cacheHit: true };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      // Only this callback may consume a synthesis-rate allowance or invoke
      // the provider. Cached reads and concurrent followers never do either.
      const audio = await synthesize();
      if (!validAudio(audio)) throw new Error('Invalid preview audio');
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporary, JSON.stringify({ key, expiresAt: Date.now() + CACHE_MS, audio }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } catch {
        // The real audio is already available. Deliver it so the browser can
        // cache it instead of encouraging another paid synthesis after a disk error.
        console.warn('[VoicePreview] Unable to persist the completed sample');
      } finally { await unlink(temporary).catch(() => {}); }
      return { audio, cacheHit: false };
    })();
    inFlight.set(file, work);
    try { return await work; } finally { if (inFlight.get(file) === work) inFlight.delete(file); }
  };
}

export function cachedVoicePreview(input: VoicePreviewCacheInput, synthesize: () => Promise<VoicePreviewAudio>) {
  return createVoicePreviewCache(path.join(resolveAppDataDir(), 'voice-previews'))(input, synthesize);
}

export function voicePreviewProviderIdentity(apiKey: string, resourceId?: string) {
  return JSON.stringify(['mp3/16000/v1', process.env.VOLCENGINE_API_BASE || 'https://openspeech.bytedance.com', resourceId || '', apiKey]);
}
