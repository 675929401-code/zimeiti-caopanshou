type StoryboardVideoPromptOptions = {
  prompt: string;
  duration: number;
  // Stored runs may still carry narration, but narration is metadata and is
  // never mixed into the user's provider prompt.
  narration?: string;
};

export function inferStoryboardNarration(label?: string) {
  const value = String(label || "").trim();
  if (!value) return "";
  const separator = value.indexOf("｜");
  return separator >= 0 ? value.slice(separator + 1).trim() : "";
}

export function narrationCharacterCount(narration?: string) {
  return String(narration || "").match(/[\p{Script=Han}\p{Number}]/gu)?.length || 0;
}

// Compatibility export only. The workbench sends the user's prompt verbatim;
// technical settings travel in their dedicated request fields.
export function storyboardVideoRuntimeGuard(_duration: number) {
  return "";
}

export function buildStoryboardVideoPrompt({ prompt }: StoryboardVideoPromptOptions) {
  return prompt.trim();
}
