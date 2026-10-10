export function videoGenerateAudioForSubmission(
  supportsGenerateAudioToggle: boolean,
  storedValue: boolean | undefined,
): boolean | undefined {
  return supportsGenerateAudioToggle ? (storedValue ?? true) : undefined;
}

export function restoreVideoGenerateAudio(value: boolean | null | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
