import { GeneratedImageReferenceSchema, generatedImageReferenceUri } from "./generated-image-reference";
import { resolveStoryboardExecutionMode, storyboardChainInputFingerprint, storyboardChainConfirmationFingerprint, storyboardChainDependencyFingerprint, storyboardChainFingerprint, type StoryboardChainRun, type StoryboardChainRequest } from "./storyboard-chain-contract";

export function storyboardChainPlanFingerprint(run: StoryboardChainRun): string {
  return storyboardChainFingerprint([run.id, resolveStoryboardExecutionMode(run), run.chainRevision || 1,
    run.cards.map(card => storyboardChainInputFingerprint(run, card))]);
}
export function storyboardChainContext(run: StoryboardChainRun, cardId: string, maxReferences: number): StoryboardChainRequest {
  if (maxReferences < 1) throw new Error("当前模型不支持参考图，无法开始串联；本次未提交任何生成。");
  const cards = [...run.cards].sort((a,b) => a.order-b.order);
  const index = cards.findIndex(card => card.id === cardId);
  if (index < 0) throw new Error("分镜已移除，串联停止。");
  const context: StoryboardChainRequest = { schema: "storyboard_chain_request.v1", projectId: run.id, cardId, chainRevision: run.chainRevision || 1 };
  if (!index) return context;
  const first = cards[0], previous = cards[index-1], confirmation = first.chainAnchorConfirmation;
  const imageRef = GeneratedImageReferenceSchema.parse(first.imageRef || { schema: "generated_image_ref.v1", recordId: first.imageRecordId });
  if (!confirmation || confirmation.recordId !== imageRef.recordId || confirmation.chainRevision !== context.chainRevision
    || confirmation.inputFingerprint !== storyboardChainInputFingerprint(run, first)) throw new Error("请先确认首段分镜并保存，再用于后续分镜。");
  context.anchor = { cardId: first.id, imageRef, confirmationFingerprint: storyboardChainConfirmationFingerprint(confirmation) };
  if (index > 1 && maxReferences >= 2) {
    const previousRef = GeneratedImageReferenceSchema.parse(previous.imageRef || { schema: "generated_image_ref.v1", recordId: previous.imageRecordId });
    if (previous.imageStatus !== "done") throw new Error("上一段未完成，串联已停止。");
    context.previous = { cardId: previous.id, imageRef: previousRef, dependencyFingerprint: storyboardChainDependencyFingerprint(run, previous) };
  }
  return context;
}
export function storyboardChainReferences(context: StoryboardChainRequest): string[] {
  return [...new Map([context.anchor?.imageRef, context.previous?.imageRef].filter((ref): ref is NonNullable<typeof ref> => Boolean(ref)).map(ref => [ref.recordId, ref])).values()].map(generatedImageReferenceUri);
}
/** No timer dispatch: each successor requires real delivery, persistence and readback. */
export async function runStoryboardChainQueue(input: { current: () => boolean; cardIds: string[];
  delivered: (id: string) => boolean; generate: (id: string) => Promise<boolean>;
  saveAndReadback: (id: string) => Promise<boolean>; anchorConfirmed: () => boolean;
}): Promise<"waiting" | "completed" | "stopped"> {
  for (let index=0; index<input.cardIds.length; index++) {
    if (!input.current()) return "stopped";
    const id = input.cardIds[index];
    if (!input.delivered(id) && !await input.generate(id)) return "stopped";
    if (!input.current() || !input.delivered(id) || !await input.saveAndReadback(id) || !input.current()) return "stopped";
    if (!index && !input.anchorConfirmed()) return "waiting";
  }
  return input.current() ? "completed" : "stopped";
}

export { storyboardChainManualReferences } from "./storyboard-chain-contract";

/** Compare a frozen request with current dependencies; late receipts remain historical when false. */
export function storyboardChainSnapshotMatches(run: StoryboardChainRun, cardId: string, snapshot: {
  prompt: string; modelId: string; aspectRatio: string; resolution: string; chainContext?: StoryboardChainRequest;
}): boolean {
  const card = run.cards.find(item => item.id === cardId);
  if (resolveStoryboardExecutionMode(run) !== "chained" || !card || !snapshot.chainContext || snapshot.prompt !== card.imagePrompt
    || snapshot.modelId !== run.imageModelId || snapshot.resolution !== run.imageResolution || snapshot.aspectRatio !== (run.imageRatio || run.ratio)) return false;
  try { return storyboardChainFingerprint(storyboardChainContext(run, cardId, snapshot.chainContext.previous ? 2 : 1)) === storyboardChainFingerprint(snapshot.chainContext); }
  catch { return false; }
}
