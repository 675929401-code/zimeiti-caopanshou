/** A status code alone is not proof of usable credentials or model capability. */
export function modelProbeFailure(status: number, detail = "") {
  if (/insufficient.*(?:balance|quota)|余额不足|额度不足|arrearage|quota.*exhaust/i.test(detail)) return { diagnosticCode: "UPSTREAM_BALANCE", message: "上游余额或额度不足；保留模型配置，不能据此判定密钥失效" };
  if (status === 429) return { diagnosticCode: "RATE_LIMITED", message: "上游限流，尚未确认本次调用可用；不会隐藏或删除模型" };
  if (status === 401) return { diagnosticCode: "AUTH_REJECTED", message: "上游拒绝鉴权，请核对密钥、所属渠道和账号状态" };
  if (status === 403) return { diagnosticCode: "PERMISSION_DENIED", message: "上游拒绝访问，请核对分组权限或访问限制；不直接判定密钥过期" };
  if (status === 404) return { diagnosticCode: "ENDPOINT_OR_MODEL", message: "接口或指定模型不存在，请核对文档、版本路径和模型ID" };
  if (status >= 500) return { diagnosticCode: "UPSTREAM_ERROR", message: `上游服务异常（${status}）；保留配置，未判定为密钥失效` };
  return { diagnosticCode: "PROTOCOL_ERROR", message: `调用未通过（${status}），需核对接口协议和请求参数` };
}
