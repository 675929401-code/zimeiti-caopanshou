import { PENDING_TEXT_USER_ACCESS } from "@/lib/model-activation-gate";

type Row = Record<string, unknown>;
type ReadResult = { data: Row | null; error?: unknown };

export class TextModelGenerationAdmissionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TextModelGenerationAdmissionError";
  }
}

/**
 * A catalogue flag may be kept true by the visibility invariant. Read current
 * operational state separately so a warm configuration cache cannot bypass a
 * just-published pending state. The isolated admin diagnostic is a separate API.
 */
export async function currentTextModelGenerationAdmission(
  selected: Row | null,
  readCurrent: (id: string) => PromiseLike<ReadResult>,
): Promise<Row | null> {
  const id = String(selected?.id || "").trim();
  if (!id) return selected; // Preserve legacy administrator custom bindings.
  const current = await readCurrent(id);
  if (current.error || !current.data || current.data.id !== id) {
    throw new TextModelGenerationAdmissionError("MODEL_ADMISSION_READ_FAILED", "当前模型调用状态无法核实，本次未调用模型，请刷新后重试");
  }
  if (current.data.user_access === PENDING_TEXT_USER_ACCESS) {
    throw new TextModelGenerationAdmissionError("MODEL_PENDING_ACTIVATION", "当前模型配置待验证或待启用，请先在后台完成真实文字验证并启用；本次未调用模型");
  }
  return {
    ...selected,
    is_active: current.data.is_active,
    is_hidden: current.data.is_hidden,
    user_access: current.data.user_access,
  };
}
