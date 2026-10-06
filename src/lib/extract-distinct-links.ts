import { NextRequest, NextResponse } from "next/server";

export type LinkPlan = { uniqueLinks: string[]; inputToUnique: number[]; firstInputIndices: number[]; duplicateCount: number };
export type DistinctVideoRequestPlan = LinkPlan & { originalLinks: string[] };

/** Keep every query parameter, its order, the path and fragment. No URL resolving or tracking removal. */
export function extractionLinkIdentity(input: string): string {
  const text = input.trim();
  // A full share sentence can contain multiple links or instructions; merge only
  // the exact same sentence. Pure URLs use standard host/default-port normalization.
  if (!/\s/u.test(text)) {
    try {
      const url = new URL(text);
      if (url.protocol === "https:" || url.protocol === "http:") return `url:${url.href}`;
    } catch { /* Non-URL share text retains its exact content identity. */ }
  }
  return `text:${text}`;
}

export function planDistinctExtractionLinks(links: string[], firstShareText?: string): LinkPlan {
  const uniqueLinks: string[] = [], inputToUnique: number[] = [], firstInputIndices: number[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < links.length; index += 1) {
    const linkIdentity = extractionLinkIdentity(links[index]);
    // An optional share sentence must never alias a different actual links[0].
    // Its interpretation depends on the selected provider, so isolate it.
    const identity = index === 0 && firstShareText && extractionLinkIdentity(firstShareText) !== linkIdentity
      ? `first-share:${linkIdentity}:${extractionLinkIdentity(firstShareText)}` : linkIdentity;
    let uniqueIndex = seen.get(identity);
    if (uniqueIndex === undefined) {
      uniqueIndex = uniqueLinks.length; seen.set(identity, uniqueIndex);
      uniqueLinks.push(links[index]); firstInputIndices.push(index);
    }
    inputToUnique.push(uniqueIndex);
  }
  return { uniqueLinks, inputToUnique, firstInputIndices, duplicateCount: links.length - uniqueLinks.length };
}

function resultMappingUnknown() {
  return NextResponse.json({
    success: false,
    error: "批量提取返回的结果数量无法对应输入，请保留原请求号核对，不要重新提交",
    error_code: "EXTRACTION_RESULT_MAPPING_UNKNOWN",
    provider_call_started: true,
    retry_safe: false,
    charged: null,
  }, { status: 503 });
}

async function expandDistinctExtractionResponse(input: {
  response: Response;
  field: "videos" | "texts";
  plan: LinkPlan;
  originalLinks: string[];
  allowAlreadyExpanded?: boolean;
}) {
  if (!input.response.ok || !input.plan.duplicateCount) return input.response;
  let output: Record<string, unknown>;
  try { output = await input.response.clone().json(); } catch { return input.response; }
  const results = output[input.field];
  if (!Array.isArray(results)) return resultMappingUnknown();

  const alreadyExpanded = input.allowAlreadyExpanded && results.length === input.originalLinks.length;
  if (!alreadyExpanded && results.length !== input.plan.uniqueLinks.length) return resultMappingUnknown();
  const mapped = alreadyExpanded ? results : input.plan.inputToUnique.map((uniqueIndex, inputIndex) => ({
    ...results[uniqueIndex], row: inputIndex, input_index: inputIndex,
    source_index: input.plan.firstInputIndices[uniqueIndex],
    duplicate_of: input.plan.firstInputIndices[uniqueIndex] === inputIndex ? null : input.plan.firstInputIndices[uniqueIndex],
  }));
  const responseHeaders = new Headers(input.response.headers); responseHeaders.delete("content-length");
  return NextResponse.json({ ...output, [input.field]: mapped, input_count: input.originalLinks.length,
    unique_count: input.plan.uniqueLinks.length, duplicate_count: input.plan.duplicateCount,
    input_to_unique: input.plan.inputToUnique }, { status: input.response.status, headers: responseHeaders });
}

export async function readDistinctVideoRequestPlan(request: NextRequest): Promise<DistinctVideoRequestPlan | null> {
  let body: Record<string, unknown>;
  try { body = await request.clone().json(); } catch { return null; }
  if (body.extraction_mode !== "video" || !Array.isArray(body.links) || body.links.length < 1 || body.links.length > 30
    || body.links.some(link => typeof link !== "string" || !link.trim())) return null;
  const originalLinks = body.links as string[];
  return { originalLinks, ...planDistinctExtractionLinks(originalLinks) };
}

export function validDistinctVideoCheckpointCardinality(plan: DistinctVideoRequestPlan, resultCount: number) {
  return resultCount === plan.uniqueLinks.length
    || (plan.duplicateCount > 0 && resultCount === plan.originalLinks.length);
}

export function expandDistinctVideoRecoveryResponse(
  response: Response,
  plan: DistinctVideoRequestPlan,
) {
  return expandDistinctExtractionResponse({
    response,
    field: "videos",
    plan,
    originalLinks: plan.originalLinks,
    allowAlreadyExpanded: true,
  });
}

/** Must be INSIDE the exactly-once wrapper: the original input/key owns the whole execution. */
export function withDistinctExtractionLinks(
  handler: (request: NextRequest) => Promise<Response>,
  isSingleTextInput: (input: string) => boolean,
) {
  return async (request: NextRequest): Promise<Response> => {
    let body: Record<string, unknown>;
    try { body = await request.clone().json(); } catch { return handler(request); }
    if (!body || !Array.isArray(body.links) || body.links.length < 2 || body.links.length > 30
      || body.links.some(link => typeof link !== "string" || !link.trim())
      || !["video", "text", "batch"].includes(String(body.extraction_mode))) return handler(request);
    const links = body.links as string[];
    const shareText = typeof body.douyin_share_text === "string" ? body.douyin_share_text : undefined;
    if (body.extraction_mode !== "video" && shareText && extractionLinkIdentity(shareText) !== extractionLinkIdentity(links[0])) {
      return NextResponse.json({ success: false, error: "批量提取请逐行粘贴视频链接；完整分享文案请使用单条提取，避免不同解析渠道错配结果", error_code: "EXTRACTION_BATCH_SHARE_INPUT_AMBIGUOUS", provider_call_started: false, charged: false }, { status: 400 });
    }
    // Video handlers use links only; they intentionally ignore douyin_share_text.
    const plan = planDistinctExtractionLinks(links);
    if (!plan.duplicateCount) return handler(request);
    // Creator/search workflows can return many items per input and have their own
    // dedicated UI/API. Refuse ambiguous duplicate list mapping before provider work.
    if (body.extraction_mode !== "video" && links.some((link, index) => !isSingleTextInput(index === 0 && shareText ? shareText : link))) {
      return NextResponse.json({ success: false, error: "批量链接列表中的重复博主或搜索输入无法逐条对应，请使用博主主页或关键词搜索入口", error_code: "EXTRACTION_DUPLICATE_INPUT_AMBIGUOUS", provider_call_started: false, charged: false }, { status: 400 });
    }
    const headers = new Headers(request.headers); headers.delete("content-length");
    const response = await handler(new NextRequest(request.url, { method: "POST", headers, body: JSON.stringify({ ...body, links: plan.uniqueLinks }) }));
    // An uncertain provider/settlement response is never converted into success.
    if (!response.ok) return response;
    const field = body.extraction_mode === "video" ? "videos" : "texts";
    return expandDistinctExtractionResponse({ response, field, plan, originalLinks: links });
  };
}
