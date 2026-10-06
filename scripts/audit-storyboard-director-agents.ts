import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const AGENT_NAMES = [
  "故事版导演｜高能夸张",
  "故事版导演｜电影叙事",
  "故事版导演｜抒情情感",
] as const;

const CONFLICT_MARKERS = [
  "不输出JSON",
  "第一个代码框",
  "第二个代码框",
  "固定顺序永远是",
  "storyboard_segmented_copy",
  "storyboard_visual_style",
  "storyboard_character_setting",
  "# 全片资产锁定",
  "# 口播转故事的方法",
  "# 语义包装",
  "# 3D风格执行字典",
  "# 故事板生图Prompt写法",
  "# 图生视频Prompt写法",
  "# 固定输出格式",
] as const;

interface AuditPresetField {
  id?: unknown;
  type?: unknown;
  required?: unknown;
  options?: unknown;
}

interface AuditAgentRow {
  id: unknown;
  name: unknown;
  system_prompt: unknown;
  preset_fields: unknown;
  output_style: unknown;
  response_format: unknown;
  max_context_rounds: unknown;
  max_context_tokens: unknown;
  max_reply_tokens: unknown;
  is_active: unknown;
  category: unknown;
  guide_message: unknown;
  model: unknown;
  model_id: unknown;
  sort_order: unknown;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

async function main() {
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY
    || process.env.COZE_SUPABASE_ANON_KEY;
  if (!key) throw new Error("缺少 Supabase 访问密钥");

  const client = createClient(required("COZE_SUPABASE_URL"), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client
    .from("agents")
    .select([
      "id",
      "name",
      "description",
      "system_prompt",
      "preset_fields",
      "output_style",
      "max_context_rounds",
      "max_context_tokens",
      "max_reply_tokens",
      "response_format",
      "is_active",
      "category",
      "guide_message",
      "model",
      "model_id",
      "sort_order",
    ].join(","))
    .in("name", [...AGENT_NAMES])
    .is("deleted_at", null)
    .order("sort_order");
  if (error) throw error;

  const rows = (data ?? []) as unknown as AuditAgentRow[];
  const summary = rows.map((row) => {
    const prompt = typeof row.system_prompt === "string" ? row.system_prompt : "";
    const presetFields = Array.isArray(row.preset_fields)
      ? row.preset_fields as AuditPresetField[]
      : [];
    return {
      id: row.id,
      name: row.name,
      prompt_chars: prompt.length,
      preset_fields: presetFields.map((field) => ({
        id: field.id ?? null,
        type: field.type ?? null,
        required: field.required ?? null,
        option_count: Array.isArray(field.options) ? field.options.length : 0,
      })),
      output_style: row.output_style,
      response_format: row.response_format,
      context: {
        rounds: row.max_context_rounds,
        tokens: row.max_context_tokens,
        reply: row.max_reply_tokens,
      },
      is_active: row.is_active,
      category: row.category,
      guide_message: row.guide_message,
      model: row.model,
      model_id: row.model_id,
      sort_order: row.sort_order,
      conflict_markers: Object.fromEntries(
        CONFLICT_MARKERS.map((marker) => [marker, prompt.includes(marker)]),
      ),
      protocol_anchor: {
        fixed_output_count: prompt.split("# 固定输出格式").length - 1,
        preserved_prefix_chars: prompt.includes("# 固定输出格式")
          ? prompt.indexOf("# 固定输出格式")
          : 0,
      },
      layout_and_pacing_evidence: prompt
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /2×2|2\+3|连续时序|每格一行|Frame 1至Frame N|Frame 1 至 Frame N/.test(line))
        .slice(0, 12),
      video_method_excerpt: prompt.includes("# 图生视频Prompt写法")
        ? prompt
          .slice(
            prompt.indexOf("# 图生视频Prompt写法"),
            prompt.indexOf("# 固定输出格式") > 0
              ? prompt.indexOf("# 固定输出格式")
              : undefined,
          )
          .trim()
        : "",
    };
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
