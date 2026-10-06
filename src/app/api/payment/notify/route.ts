// Core payment callback: verifies the provider signature and fulfills each
// order exactly once through the shared fulfillment service.

import { NextRequest, NextResponse } from "next/server";
import { verifyNotify as verifyXunhuNotify, XunhuNotifyParams } from "@/lib/xunhupay";
import { verifyNotify as verifyEPayNotify, EPayNotifyParams } from "@/lib/epay";
import { fulfillPaymentOrder } from "@/lib/payment-fulfillment";
import { createHash } from "node:crypto";

const MAX_CALLBACK_BODY_BYTES = 64 * 1024;
const MAX_CALLBACK_FIELDS = 64;
const MAX_CALLBACK_KEY_BYTES = 128;
const MAX_CALLBACK_VALUE_BYTES = 8 * 1024;

class PaymentCallbackRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PaymentCallbackRequestError";
  }
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeCallbackEntries(entries: Iterable<[string, unknown]>): Record<string, string> {
  const params: Record<string, string> = {};
  let fieldCount = 0;

  for (const [key, rawValue] of entries) {
    fieldCount += 1;
    if (fieldCount > MAX_CALLBACK_FIELDS) {
      throw new PaymentCallbackRequestError("too many callback fields", 400);
    }
    if (!key || utf8Size(key) > MAX_CALLBACK_KEY_BYTES) {
      throw new PaymentCallbackRequestError("invalid callback field name", 400);
    }
    if (typeof rawValue !== "string" || utf8Size(rawValue) > MAX_CALLBACK_VALUE_BYTES) {
      throw new PaymentCallbackRequestError("invalid callback field value", 400);
    }
    params[key] = rawValue;
  }

  return params;
}

async function readBoundedCallbackBody(request: NextRequest): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new PaymentCallbackRequestError("invalid content length", 400);
    }
    if (parsedLength > MAX_CALLBACK_BODY_BYTES) {
      throw new PaymentCallbackRequestError("callback body too large", 413);
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CALLBACK_BODY_BYTES) {
        await reader.cancel();
        throw new PaymentCallbackRequestError("callback body too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function parseCallbackParams(request: NextRequest): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.length > 256) {
    throw new PaymentCallbackRequestError("invalid content type", 400);
  }

  const body = await readBoundedCallbackBody(request);
  const bodyText = new TextDecoder().decode(body);

  try {
    if (contentType.includes("multipart/form-data")) {
      const boundedRequest = new Request("http://payment-callback.invalid", {
        method: "POST",
        headers: { "content-type": contentType },
        body: body.buffer as ArrayBuffer,
      });
      const formData = await boundedRequest.formData();
      return normalizeCallbackEntries(formData.entries());
    }

    if (contentType.includes("application/x-www-form-urlencoded")) {
      return normalizeCallbackEntries(new URLSearchParams(bodyText).entries());
    }

    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PaymentCallbackRequestError("invalid callback payload", 400);
    }
    return normalizeCallbackEntries(Object.entries(parsed));
  } catch (error) {
    if (error instanceof PaymentCallbackRequestError) throw error;
    throw new PaymentCallbackRequestError("invalid callback payload", 400);
  }
}

function callbackReference(value: string | null | undefined): string {
  if (!value) return "missing";
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// POST /api/payment/notify - asynchronous provider callback.
export async function POST(request: NextRequest) {
  try {
    const params = await parseCallbackParams(request);

    const hasEPaySignature = Boolean(params.trade_no && params.out_trade_no && params.trade_status);
    const hasXunhuSignature = Boolean(params.trade_order_id && params.transaction_id && params.hash);

    console.info("[payment callback] received", {
      providerHint: hasXunhuSignature ? "xunhupay" : hasEPaySignature ? "epay" : "unknown",
      orderRef: callbackReference(params.trade_order_id || params.out_trade_no),
      status: String(params.status || params.trade_status || "unknown").slice(0, 32),
    });

    if (hasXunhuSignature) {
      return await handleXunhuNotify(params as unknown as XunhuNotifyParams);
    }
    if (hasEPaySignature || params.trade_no) {
      return await handleEPayNotify(params as unknown as EPayNotifyParams);
    }
    return await handleXunhuNotify(params as unknown as XunhuNotifyParams);
  } catch (error) {
    if (error instanceof PaymentCallbackRequestError) {
      return new NextResponse("fail", { status: error.status });
    }
    console.error("[payment callback] processing error", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return new NextResponse("fail", { status: 500 });
  }
}

// GET /api/payment/notify - synchronous EPay return URL.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const outTradeNo = url.searchParams.get("out_trade_no");
  const tradeStatus = url.searchParams.get("trade_status");

  console.info("[payment callback GET] return", {
    orderRef: callbackReference(outTradeNo),
    status: String(tradeStatus || "unknown").slice(0, 32),
  });

  if (outTradeNo) {
    const resultUrl = new URL("/payment/result", request.nextUrl.origin);
    resultUrl.searchParams.set("order", outTradeNo);
    return NextResponse.redirect(resultUrl);
  }

  return NextResponse.json({ error: "missing order id" }, { status: 400 });
}

async function handleXunhuNotify(params: XunhuNotifyParams): Promise<NextResponse> {
  if (!await verifyXunhuNotify(params)) {
    console.error("[xunhupay callback] signature verification failed");
    return new NextResponse("fail", { status: 400 });
  }

  const { trade_order_id, total_fee, transaction_id, status } = params;
  if (status !== "OD") {
    console.log("[xunhupay callback] non-success status:", status);
    return new NextResponse("success", { status: 200 });
  }

  const result = await fulfillPaymentOrder({
    tradeOrderId: trade_order_id,
    provider: "xunhupay",
    providerTradeOrderId: trade_order_id,
    providerTransactionId: transaction_id,
    paidAmount: total_fee,
  });
  return result.success
    ? new NextResponse("success", { status: 200 })
    : new NextResponse("fail", { status: 500 });
}

async function handleEPayNotify(params: EPayNotifyParams): Promise<NextResponse> {
  if (!await verifyEPayNotify(params)) {
    console.error("[epay callback] signature verification failed");
    return new NextResponse("fail", { status: 400 });
  }

  const { out_trade_no, trade_no, money, trade_status } = params;
  if (trade_status !== "TRADE_SUCCESS") {
    console.log("[epay callback] non-success status:", trade_status);
    return new NextResponse("success", { status: 200 });
  }

  const result = await fulfillPaymentOrder({
    tradeOrderId: out_trade_no,
    provider: "epay",
    providerTradeOrderId: out_trade_no,
    providerTransactionId: trade_no,
    paidAmount: money,
  });
  return result.success
    ? new NextResponse("success", { status: 200 })
    : new NextResponse("fail", { status: 500 });
}
