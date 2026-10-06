// eslint-disable-next-line no-restricted-imports -- This guarded public facade deliberately reuses the existing durable executor without changing the excluded module.
import {
  GET as readDurableScriptHistory,
  POST as executeDurableScript,
} from "@/app/api/short-drama/script/route";
import { createGeneralScriptRouteBoundary } from "@/lib/general-script/general-script-route-boundary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Platform-owned front door for the general and formal script pages.
 *
 * The durable executor is temporarily shared with the film-studio service, but
 * this adapter keeps public pages out of the excluded /api/short-drama namespace
 * and prevents other surfaces from crossing through the generic entry point.
 */
const boundary = createGeneralScriptRouteBoundary({
  readHistory: readDurableScriptHistory,
  execute: executeDurableScript,
});

export const GET = boundary.GET;
export const POST = boundary.POST;
