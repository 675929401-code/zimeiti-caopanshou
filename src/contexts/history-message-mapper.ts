import type { Agent, Message } from "@/types/coze";

type HistoryMessageRow = Record<string, unknown>;

function mapGeneratedImages(rawContent: string): {
  content: string;
  generatedImages?: Message["generatedImages"];
} {
  try {
    if (!rawContent.startsWith('{"type":"image_gallery"') && !rawContent.startsWith('{"type": "image_gallery"')) {
      return { content: rawContent };
    }
    const parsed = JSON.parse(rawContent) as {
      type?: unknown;
      prompt?: unknown;
      images?: unknown;
    };
    if (parsed.type !== "image_gallery" || !Array.isArray(parsed.images)) return { content: rawContent };

    const imagePrompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    const generatedImages = (parsed.images as NonNullable<Message["generatedImages"]>).map((image, index) => {
      const order = Math.min(40, Math.max(1, Math.floor(Number(image.order) || index + 1)));
      const title = image.title || `图片${order}`;
      return {
        ...image,
        order,
        label: image.label || `任务${order}`,
        title,
        sourcePrompt: image.sourcePrompt || imagePrompt || image.revisedPrompt,
        filename: image.filename || `${String(order).padStart(2, "0")}-${title}.png`,
      };
    });
    const imageSummary = generatedImages
      .map((image, index) => `${image.label || index + 1}. ${image.title || "图片"}${image.sourcePrompt || image.revisedPrompt ? `：${image.sourcePrompt || image.revisedPrompt}` : ""}`)
      .join("\n");
    return {
      content: `[图片生成记录] 共 ${generatedImages.length} 张图片${imagePrompt ? `；原始提示词：${imagePrompt}` : ""}${imageSummary ? `\n${imageSummary}` : ""}`,
      generatedImages,
    };
  } catch {
    return { content: rawContent };
  }
}

export function mapHistoryMessages(input: unknown): Message[] {
  if (!Array.isArray(input)) return [];
  return input.map((value, index) => {
    const row: HistoryMessageRow = value && typeof value === "object" ? value as HistoryMessageRow : {};
    const rawContent = typeof row.content === "string" ? row.content : "";
    const mappedContent = mapGeneratedImages(rawContent);
    const createdAt = row.timestamp ?? row.created_at;
    const parsedTimestamp = typeof createdAt === "number" ? createdAt : Date.parse(String(createdAt || ""));
    const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now() + index;
    return {
      id: typeof row.id === "string" && row.id ? row.id : `history_${timestamp}_${index}`,
      role: row.role === "user" ? "user" : "assistant",
      content: mappedContent.content,
      displayContent: typeof row.displayContent === "string"
        ? row.displayContent
        : typeof row.display_content === "string" ? row.display_content : undefined,
      agentId: typeof row.agentId === "string"
        ? row.agentId
        : typeof row.agent_id === "string" ? row.agent_id : undefined,
      agentName: typeof row.agentName === "string"
        ? row.agentName
        : typeof row.agent_name === "string" ? row.agent_name : undefined,
      agentIconUrl: typeof row.agentIconUrl === "string"
        ? row.agentIconUrl
        : typeof row.agent_icon_url === "string" ? row.agent_icon_url : undefined,
      images: Array.isArray(row.images) ? row.images.filter((item): item is string => typeof item === "string") : undefined,
      generatedImages: mappedContent.generatedImages,
      reasoningContent: typeof row.reasoningContent === "string"
        ? row.reasoningContent
        : typeof row.reasoning_content === "string" ? row.reasoning_content : undefined,
      timestamp,
    } satisfies Message;
  });
}

export function enrichHistoryMessageIdentity(
  messages: Message[],
  agents: Array<Pick<Agent, "id" | "botId" | "name" | "iconUrl">>,
  fallbackAgentId?: string | null,
): Message[] {
  let changed = false;
  const enriched = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const identity = message.agentId || fallbackAgentId || "";
    if (!identity) return message;
    const agent = agents.find((candidate) => candidate.id === identity || candidate.botId === identity);
    if (!agent) return message;

    const agentId = message.agentId || agent.id;
    const agentName = message.agentName || agent.name;
    const agentIconUrl = message.agentIconUrl || agent.iconUrl || "";
    if (
      agentId === message.agentId
      && agentName === message.agentName
      && agentIconUrl === (message.agentIconUrl || "")
    ) return message;

    changed = true;
    return { ...message, agentId, agentName, agentIconUrl };
  });
  return changed ? enriched : messages;
}
