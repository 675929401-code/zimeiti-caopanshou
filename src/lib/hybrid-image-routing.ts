import type { Conversation, Message, OutputStyle } from "@/types/coze";

export interface HybridImageGenerationConfig {
  enabled?: boolean;
  model?: string;
  modelId?: string;
  routingMode?: "auto" | "manual" | "always";
  defaultCount?: number;
}

export interface HybridImageTask {
  order: number;
  label: string;
  title: string;
  prompt: string;
  count: number;
}

const IMAGE_INTENT_RE =
  /(画|绘制|生图|生成.*图|出图|做.*图|设计.*图|图片|图像|插画|海报|封面|头像|logo|Logo|视觉|分镜图|场景图|产品图)/i;

const IMAGE_MODEL_RE =
  /\b(gpt-image|glm-image|dall-e|stable-diffusion|sd3|flux|midjourney|doubao|豆包|seedream|seededit|cogview|ideogram|imagen|playground|kandinsky)\b/i;

const CHINESE_LABELS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

export function isImageGenerationModelName(modelName?: string | null): boolean {
  return IMAGE_MODEL_RE.test(modelName || "");
}

export function getHybridImageConfig(outputStyle?: OutputStyle | null): HybridImageGenerationConfig | null {
  const config = outputStyle?.hybridImageGeneration;
  if (!config?.enabled || !config.model) return null;
  return {
    enabled: true,
    model: config.model,
    modelId: config.modelId,
    routingMode: config.routingMode || "auto",
    defaultCount: Math.min(Math.max(Number(config.defaultCount || 1), 1), 6),
  };
}

export function shouldTriggerHybridImage(content: string, config?: HybridImageGenerationConfig | null): boolean {
  if (!config?.enabled || !config.model) return false;
  if (config.routingMode === "manual") return false;
  if (config.routingMode === "always") return true;
  return IMAGE_INTENT_RE.test(content);
}

export function createHybridImageTasks(content: string, config?: HybridImageGenerationConfig | null): HybridImageTask[] {
  const countMatch = content.match(/(?:生成|画|出|做|设计)?\s*([1-6一二三四五六])\s*(?:张|幅|个)\s*(?:图|图片|图像|海报|封面|头像|logo|Logo)?/);
  const parsedCount = countMatch ? normalizeCount(countMatch[1]) : 0;
  const count = Math.min(Math.max(parsedCount || config?.defaultCount || 1, 1), 6);

  const explicitTasks = extractExplicitTasks(content);
  if (explicitTasks.length > 0) {
    return explicitTasks.slice(0, 6);
  }

  if (count <= 1) {
    return [{
      order: 1,
      label: CHINESE_LABELS[0],
      title: inferTitle(content, 1),
      prompt: content,
      count: 1,
    }];
  }

  return Array.from({ length: count }, (_, index) => ({
    order: index + 1,
    label: CHINESE_LABELS[index],
    title: `第${CHINESE_LABELS[index]}张`,
    prompt: `${content}\n\n请生成第${CHINESE_LABELS[index]}张，保持用户给出的整体要求，但画面不要与其他序号重复。`,
    count: 1,
  }));
}

export function appendImageMemoryToMessage(message: Pick<Message, "content" | "generatedImages">): string {
  if (!message.generatedImages?.length) return message.content;
  const lines = message.generatedImages
    .slice()
    .sort((a, b) => (a.order || 999) - (b.order || 999))
    .map((img, index) => {
      const label = img.label || CHINESE_LABELS[index] || String(index + 1);
      const title = img.title || `第${label}张图片`;
      const prompt = img.sourcePrompt || img.revisedPrompt || "";
      return `第${label}张：${title}${prompt ? `；提示词：${prompt}` : ""}`;
    });
  return `${message.content}\n\n[图片生成记录]\n${lines.join("\n")}`;
}

export function summarizeConversationForImage(conversation: Conversation): string {
  const recent = (conversation.messages || [])
    .slice(-8)
    .map((msg) => {
      const role = msg.role === "user" ? "用户" : "助手";
      const content = appendImageMemoryToMessage(msg).replace(/\s+/g, " ").slice(0, 500);
      return `${role}：${content}`;
    })
    .join("\n");
  return recent ? `\n\n【同一对话上下文，仅用于保持连续记忆】\n${recent}` : "";
}

export function makeImageFilename(task: HybridImageTask, imageIndex = 0): string {
  const safeTitle = (task.title || `第${task.label}张`)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 24);
  const suffix = task.count > 1 ? `-${imageIndex + 1}` : "";
  return `${task.label}-${safeTitle}${suffix}.png`;
}

function normalizeCount(raw: string): number {
  const digit = Number(raw);
  if (Number.isFinite(digit) && digit > 0) return digit;
  const idx = CHINESE_LABELS.indexOf(raw);
  return idx >= 0 ? idx + 1 : 0;
}

function extractExplicitTasks(content: string): HybridImageTask[] {
  const lines = content
    .split(/\r?\n|；|;/)
    .map((line) => line.trim())
    .filter(Boolean);

  const tasks: HybridImageTask[] = [];
  for (const line of lines) {
    const match = line.match(/^(?:第?\s*([一二三四五六1-6])\s*(?:张|幅|个)?|([一二三四五六1-6])[、.．:：])\s*(.+)$/);
    if (!match) continue;
    const order = normalizeCount(match[1] || match[2]);
    if (!order || order > 6) continue;
    const prompt = match[3].trim();
    tasks.push({
      order,
      label: CHINESE_LABELS[order - 1] || String(order),
      title: inferTitle(prompt, order),
      prompt,
      count: 1,
    });
  }
  return tasks.sort((a, b) => a.order - b.order);
}

function inferTitle(text: string, order: number): string {
  const explicit = text.match(/(?:标题|名称|命名)\s*[:：]\s*([^\n，。；;]{2,24})/);
  if (explicit?.[1]) return explicit[1].trim();
  const compact = text
    .replace(/请|帮我|生成|绘制|画一张|画|图片|图像/g, "")
    .replace(/[，。；;:：]/g, " ")
    .trim()
    .slice(0, 18);
  return compact || `第${CHINESE_LABELS[order - 1] || order}张`;
}
