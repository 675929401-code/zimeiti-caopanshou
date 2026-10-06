export type SupportedAudioExtension = 'mp3' | 'wav' | 'ogg' | 'm4a' | 'aac' | 'opus';

export type AudioSignature = {
  container: 'mp3' | 'wav' | 'ogg' | 'mp4' | 'aac';
  codec?: 'opus';
  canonicalMime: string;
  allowedExtensions: readonly SupportedAudioExtension[];
  allowedMimeTypes: readonly string[];
};

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function hasAscii(bytes: Uint8Array, value: string, searchLength = 256): boolean {
  const haystack = ascii(bytes, 0, Math.min(bytes.length, searchLength));
  return haystack.includes(value);
}

export function inspectAudioSignature(bytes: Uint8Array): AudioSignature | null {
  if (bytes.length < 4) return null;

  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return {
      container: 'wav',
      canonicalMime: 'audio/wav',
      allowedExtensions: ['wav'],
      allowedMimeTypes: ['audio/wav', 'audio/x-wav', 'audio/wave'],
    };
  }

  const looksLikeId3 = ascii(bytes, 0, 3) === 'ID3';
  const looksLikeMp3Frame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (looksLikeId3 || looksLikeMp3Frame) {
    return {
      container: 'mp3',
      canonicalMime: 'audio/mpeg',
      allowedExtensions: ['mp3'],
      allowedMimeTypes: ['audio/mpeg', 'audio/mp3'],
    };
  }

  if (ascii(bytes, 0, 4) === 'OggS') {
    const opus = hasAscii(bytes, 'OpusHead');
    return {
      container: 'ogg',
      codec: opus ? 'opus' : undefined,
      canonicalMime: opus ? 'audio/opus' : 'audio/ogg',
      allowedExtensions: opus ? ['opus', 'ogg'] : ['ogg'],
      allowedMimeTypes: opus ? ['audio/opus', 'audio/ogg'] : ['audio/ogg'],
    };
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    return {
      container: 'mp4',
      canonicalMime: 'audio/mp4',
      allowedExtensions: ['m4a'],
      allowedMimeTypes: ['audio/mp4', 'audio/x-m4a'],
    };
  }

  const looksLikeAdts = bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (looksLikeAdts) {
    return {
      container: 'aac',
      canonicalMime: 'audio/aac',
      allowedExtensions: ['aac'],
      allowedMimeTypes: ['audio/aac'],
    };
  }

  return null;
}

function extensionFromName(fileName: string): string {
  const last = fileName.trim().toLowerCase().split('.').pop();
  return last && last !== fileName.trim().toLowerCase() ? last : '';
}

export function validateAudioFileSignature(input: {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
}): AudioSignature & { extension: SupportedAudioExtension } {
  const signature = inspectAudioSignature(input.bytes);
  if (!signature) throw new Error('AUDIO_SIGNATURE_UNRECOGNIZED');

  const extension = extensionFromName(input.fileName);
  if (!signature.allowedExtensions.includes(extension as SupportedAudioExtension)) {
    throw new Error('AUDIO_EXTENSION_SIGNATURE_MISMATCH');
  }

  const declaredMime = String(input.mimeType || '').split(';', 1)[0].trim().toLowerCase();
  if (declaredMime && !signature.allowedMimeTypes.includes(declaredMime)) {
    throw new Error('AUDIO_MIME_SIGNATURE_MISMATCH');
  }

  return { ...signature, extension: extension as SupportedAudioExtension };
}
