export const AUTHORIZED_SPEAKER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/u;

export type PublicSpeakerAuthorization = { speakerId: string; isActive: boolean };

export async function resolveAuthorizedVoiceSpeaker(input: {
  userId: string;
  speakerId: string;
  publicCatalog: PublicSpeakerAuthorization[];
  findCompletedOwnedSpeaker: (userId: string, speakerId: string) => Promise<boolean>;
}): Promise<string | null> {
  const speakerId = String(input.speakerId || '').trim();
  if (!AUTHORIZED_SPEAKER_ID_PATTERN.test(speakerId)) return null;
  const published = input.publicCatalog.find((voice) => voice.speakerId === speakerId);
  if (published) return published.isActive ? speakerId : null;
  return await input.findCompletedOwnedSpeaker(input.userId, speakerId) ? speakerId : null;
}
