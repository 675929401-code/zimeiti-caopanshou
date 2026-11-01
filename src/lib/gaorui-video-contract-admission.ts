/** Bind an implemented wire contract to its provider endpoint, protocol family and exact model. */
export type GaoruiVideoContractIdentity = {
  protocol_type?: unknown;
  model_name?: unknown;
  api_endpoint?: unknown;
  api_protocol_config?: unknown;
};

export function gaoruiVideoCreateContractAdmission(model: GaoruiVideoContractIdentity | null | undefined) {
  if (model?.protocol_type !== "gaorui_video"
    || (model.model_name !== "seedance-2.0" && model.model_name !== "seedance-2.5")) {
    return { ready: true, code: "", message: "" } as const;
  }
  let endpointBound = false;
  try {
    const endpoint = new URL(String(model.api_endpoint || ""));
    endpointBound = endpoint.protocol === "https:" && endpoint.hostname === "gaorui.cc" && !endpoint.port
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      && ["", "/", "/v1", "/v1/"].includes(endpoint.pathname);
  } catch { /* Invalid endpoints never acquire a native contract. */ }
  if (!endpointBound) return { ready: false, code: "GAORUI_SEEDANCE_ENDPOINT_BINDING_INVALID", message: "Seedance 原生合同须绑定高瑞 HTTPS 站点根路径或 /v1，本次未提交上游" } as const;
  const config = model.api_protocol_config && typeof model.api_protocol_config === "object" && !Array.isArray(model.api_protocol_config)
    ? model.api_protocol_config as Record<string, unknown> : {};
  if (config.protocol_family !== "seedance_native_content") return { ready: false, code: "GAORUI_SEEDANCE_PROTOCOL_FAMILY_REQUIRED", message: "缺少 Seedance 原生 content 协议族绑定，本次未提交上游" } as const;
  return { ready: true, code: "", message: "" } as const;
}
