import { PlatformSettingValidationError } from "@/lib/platform-settings-contract";

export const MAX_PAYMENT_CONFIG_BODY_BYTES = 64 * 1024;

type PaymentConfigBodyRequest = Pick<Request, "headers" | "body">;

export async function readBoundedPaymentConfigBody(request: PaymentConfigBodyRequest): Promise<unknown> {
  const declaredLengthHeader = request.headers.get("content-length");
  if (declaredLengthHeader !== null) {
    if (!/^\d+$/u.test(declaredLengthHeader)) {
      throw new PlatformSettingValidationError("支付配置请求长度无效", "PAYMENT_CONFIG_REQUEST_INVALID");
    }
    const declaredLength = Number(declaredLengthHeader);
    if (!Number.isSafeInteger(declaredLength)) {
      throw new PlatformSettingValidationError("支付配置请求长度无效", "PAYMENT_CONFIG_REQUEST_INVALID");
    }
    if (declaredLength > MAX_PAYMENT_CONFIG_BODY_BYTES) {
      throw new PlatformSettingValidationError("支付配置请求超过 64KB", "PAYMENT_CONFIG_REQUEST_TOO_LARGE");
    }
  }

  if (!request.body) {
    throw new PlatformSettingValidationError("请求体不是有效 JSON", "PAYMENT_CONFIG_REQUEST_INVALID");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PAYMENT_CONFIG_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative even if cancellation fails.
        }
        throw new PlatformSettingValidationError("支付配置请求超过 64KB", "PAYMENT_CONFIG_REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PlatformSettingValidationError) throw error;
    throw new PlatformSettingValidationError("支付配置请求体读取失败", "PAYMENT_CONFIG_REQUEST_INVALID");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new PlatformSettingValidationError("请求体不是有效 JSON", "PAYMENT_CONFIG_REQUEST_INVALID");
  }
}
