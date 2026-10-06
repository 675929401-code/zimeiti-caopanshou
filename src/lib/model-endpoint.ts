/** Shared form/API validation. Never include credentials in an error message. */
export function modelEndpointError(value: string): string | null {
  if (!value.trim()) return "请填写中转站提供的 API 地址";
  try {
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname) throw new Error();
    if (url.username || url.password || url.search || url.hash) {
      return "API 地址不能包含账号、密码、查询参数或页面锚点；密钥请填入专用字段";
    }
    return null;
  } catch {
    return "请填写以 https:// 或 http:// 开头的 API 地址，不能填写邮箱或登录账号";
  }
}

export function modelStationLabel(value: string): string {
  if (modelEndpointError(value)) return "填写 API 地址后识别接入站点";
  const host = new URL(value.trim()).hostname;
  const names: Record<string, string> = {
    "token.secure-skill.com": "渠道 A", "gaorui.cc": "渠道 C",
    "www.autodl.art": "AutoDL 托管", "autodl.art": "AutoDL 托管",
    "yunwu.ai": "云雾", "api.vectorengine.ai": "向量引擎",
  };
  return names[host] ? `${names[host]} · ${host}` : host;
}

export function resolveVideoDetectionDraft(body: Record<string, unknown>, stored?: Record<string, unknown>) {
  const value = (field: string) => typeof body[field] === "string" ? String(body[field]).trim() : String(stored?.[field] || "").trim();
  const endpoint = value("api_endpoint");
  const error = modelEndpointError(endpoint);
  if (error) throw new Error(error);
  let key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!key && stored) {
    const previous = String(stored.api_endpoint || "");
    if (modelEndpointError(previous) || new URL(previous).origin !== new URL(endpoint).origin) {
      throw new Error("接入站点已改变，请填写新站点的密钥；不会将原密钥发送到其他站点");
    }
    key = String(stored.api_key || "");
  }
  if (!key) throw new Error("请填写 API 密钥");
  const modelName = value("model_name");
  if (!modelName) throw new Error("请填写模型 ID");
  return { apiEndpoint: endpoint, apiKey: key, modelName, provider: value("provider"), protocolType: value("protocol_type") };
}
