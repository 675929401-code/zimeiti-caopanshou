/** Admin-only connection identity; never infer official access from a model name. */
export function modelConnectionSummary(endpoint: string, config?: Record<string, unknown>) {
  let host = "";
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { /* Incomplete draft. */ }
  const official: Record<string, string> = {
    "visual.volcengineapi.com": "火山引擎", "ark.cn-beijing.volces.com": "火山方舟",
    "dashscope.aliyuncs.com": "阿里云", "dashscope-intl.aliyuncs.com": "阿里云国际",
    "api.deepseek.com": "DeepSeek", "open.bigmodel.cn": "智谱",
    "api.openai.com": "OpenAI", "api.anthropic.com": "Anthropic",
  };
  const relays: Record<string, string> = {
    "token.secure-skill.com": "Secure Skill · 渠道A", "gaorui.cc": "高端平台 · 渠道C",
    "s.lconai.com": "LC · 渠道B", "n.lconai.com": "LC · 渠道B",
    "pro.nat6.net": "算力橙 · 渠道LC", "api.vectorengine.ai": "向量引擎",
  };
  const group = String(
    config?.connection_group
      || config?.provider_group_name
      || config?.provider_channel
      || config?.group_name
      || config?.provider_group_id
      || config?.group_id
      || "",
  ).trim();
  if (official[host]) return { kind: "official", label: "官方直连", provider: official[host], host, group: "官方账户权限" };
  if (host === "autodl.art" || host === "www.autodl.art") return { kind: "hosted", label: "托管服务", provider: "AutoDL", host, group: group || "工作流分组" };
  if (["127.0.0.1", "localhost", "[::1]"].includes(host)) return { kind: "selfhost", label: "自部署", provider: host, host, group: group || "独立实例" };
  return { kind: host ? "relay" : "unconfigured", label: host ? "中转渠道" : "待配置", provider: relays[host] || host || "未填写接口", host, group: group || "分组待核对" };
}

/** Preserve prices such as 0.495; a card must not disguise the stored amount. */
export function formatModelPrice(value: unknown): string {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "待配置";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 8, useGrouping: false });
}
