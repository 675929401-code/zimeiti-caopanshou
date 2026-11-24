import type { NextRequest } from "next/server";
import { POST as receivePaymentNotification } from "../notify/route";

export async function POST(request: NextRequest) {
  if (process.env.LOCAL_ACCEPTANCE_PREVIEW !== "true") return new Response(null, { status: 404 });
  return receivePaymentNotification(request);
}

