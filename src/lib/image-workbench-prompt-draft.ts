export const IMAGE_WORKBENCH_PROMPT_DRAFT_KEY = "image_workbench_prompt_draft_v2";

const MAX_DRAFT_JOBS = 40;
const MAX_PROMPT_LENGTH = 12_000;
const MAX_REFERENCE_COUNT = 8;
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export type ImageWorkbenchPromptDraft = {
  version: 1;
  savedAt: number;
  jobs: Array<{ id: string; prompt: string }>;
  /** Only the count is retained. Browser File/blob/data-url content is never persisted. */
  referenceCount: number;
};

export function parseImageWorkbenchPromptDraft(raw: string | null): ImageWorkbenchPromptDraft | null {
  if (!raw || raw.length > 512_000) return null;
  try {
    const value = JSON.parse(raw) as Partial<ImageWorkbenchPromptDraft>;
    if (!value || value.version !== 1 || !Number.isFinite(value.savedAt) || !Array.isArray(value.jobs)) return null;
    const seen = new Set<string>();
    const jobs: ImageWorkbenchPromptDraft["jobs"] = [];
    for (const candidate of value.jobs.slice(0, MAX_DRAFT_JOBS)) {
      const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
      const prompt = typeof candidate?.prompt === "string" ? candidate.prompt : "";
      if (!SAFE_JOB_ID.test(id) || seen.has(id) || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) continue;
      seen.add(id);
      jobs.push({ id, prompt });
    }
    const rawReferenceCount = Number(value.referenceCount);
    const referenceCount = Number.isInteger(rawReferenceCount)
      ? Math.max(0, Math.min(MAX_REFERENCE_COUNT, rawReferenceCount))
      : 0;
    if (!jobs.length && referenceCount === 0) return null;
    return { version: 1, savedAt: Number(value.savedAt), jobs, referenceCount };
  } catch {
    return null;
  }
}

export function serializeImageWorkbenchPromptDraft(
  jobs: Array<{ id: string; prompt: string }>,
  referenceCount: number,
  savedAt = Date.now(),
): string | null {
  const safeJobs: ImageWorkbenchPromptDraft["jobs"] = [];
  const seen = new Set<string>();
  for (const candidate of jobs.slice(0, MAX_DRAFT_JOBS)) {
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const prompt = typeof candidate.prompt === "string" ? candidate.prompt : "";
    if (!SAFE_JOB_ID.test(id) || seen.has(id) || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) continue;
    seen.add(id);
    safeJobs.push({ id, prompt });
  }
  if (!safeJobs.length) return null;
  return JSON.stringify({
    version: 1,
    savedAt: Number.isFinite(savedAt) ? savedAt : Date.now(),
    jobs: safeJobs,
    referenceCount: Number.isInteger(referenceCount)
      ? Math.max(0, Math.min(MAX_REFERENCE_COUNT, referenceCount))
      : 0,
  } satisfies ImageWorkbenchPromptDraft);
}
