import { SafeFetchError } from "@/lib/safe-fetch";
import { readPublicImageResult, validatePublicImageResultUrl } from "@/lib/image-result-network";
import { AUTODL_H3_SELFHOST_PROVIDER, AUTODL_H3_SELFHOST_SECRET_REF, resolveAutodlH3SelfhostResultUrl, fetchAutodlH3SelfhostResult, readAutodlH3SelfhostResult } from "@/lib/autodl-h3-selfhost";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { providerMediaUrl } from "@/lib/generated-media-delivery";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type Delivery = { providerUrl?: unknown; provider?: unknown; apiEndpoint?: unknown; sourceExpiredAt?: unknown };

/** Use the same public-address policy for reading and forwarding owned results. */
export function validateProviderImageUrl(url: string) {
  return validatePublicImageResultUrl(url);
}

/** Only exact provider 404/410 is positive expiry evidence. */
export function confirmedImageSourceExpiry(error: unknown) {
  return error instanceof SafeFetchError && [404, 410].includes(error.upstreamStatus || 0);
}

export async function readProviderImage(response: Delivery, probeOnly = false, ownedRecord?: { recordId: string; userId: string }) {
  const url = providerMediaUrl(response.providerUrl);
  if (!url) throw new Error("IMAGE_PROVIDER_REFERENCE_INVALID");
  if (response.provider === AUTODL_H3_SELFHOST_PROVIDER) {
    // This helper validates the exact controlled endpoint/result-path binding;
    // arbitrary loopback or private addresses are never accepted by safeFetch.
    const endpoint = String(response.apiEndpoint || "");
    let recovery: { kind: "image"; expectedJobId: string; apiKey: string } | undefined;
    if (ownedRecord) {
      const { data, error } = await getSupabaseAdminClient().from("image_generation_requests").select("response")
        .eq("record_id", ownedRecord.recordId).eq("user_id", ownedRecord.userId)
        .eq("state", "completed").eq("delivery_state", "delivered").maybeSingle();
      const stored = data?.response as (Delivery & { deliveryMode?: unknown }) | undefined;
      if (error || !stored || stored.deliveryMode !== "provider_url" || stored.sourceExpiredAt
        || stored.providerUrl !== url || stored.provider !== AUTODL_H3_SELFHOST_PROVIDER || stored.apiEndpoint !== endpoint) throw new Error("IMAGE_H3_OWNER_BINDING_UNAVAILABLE");
      const boundUrl = new URL(resolveAutodlH3SelfhostResultUrl(String(stored.providerUrl), String(stored.apiEndpoint), { allowExpired: true }));
      recovery = { kind: "image", expectedJobId: boundUrl.pathname.slice("/v1/files/".length), apiKey: resolveProviderSecret(AUTODL_H3_SELFHOST_SECRET_REF) };
    }
    const result = await fetchAutodlH3SelfhostResult(url, endpoint, { timeoutMs: 20_000, headers: { Range: "bytes=0-0" }, ownedResultRecovery: recovery });
    const status = result.response.status;
    await result.response.body?.cancel().catch(() => undefined);
    if ([404, 410].includes(status)) throw new SafeFetchError("IMAGE_SOURCE_EXPIRED", "UPSTREAM_ERROR", 502, { upstreamStatus: status });
    if (!result.response.ok) throw new Error("IMAGE_SOURCE_CHECK_UNAVAILABLE");
    if (probeOnly) return null;
    return readAutodlH3SelfhostResult(result.finalUrl, endpoint, { maxBytes: 30 * 1024 * 1024, allowedContentTypes: ["image/png", "image/jpeg", "image/webp"], timeoutMs: 30_000 });
  }
  const result = await readPublicImageResult(url, {
    timeoutMs: 20_000, maxBytes: probeOnly ? 1 : 30 * 1024 * 1024, maxRedirects: 3,
    allowedContentTypes: ["image/png", "image/jpeg", "image/webp"],
    ...(probeOnly ? { headers: { Range: "bytes=0-0" } } : {}),
  });
  return probeOnly ? null : result;
}

export async function markImageProviderSourceExpired(recordId: string, userId: string, providerUrl: string) {
  const { error } = await getSupabaseAdminClient().rpc("mark_image_provider_source_expired", {
    p_record_id: recordId, p_user_id: userId, p_provider_url: providerUrl,
  });
  if (error) throw new Error("IMAGE_SOURCE_EXPIRY_NOT_CONFIRMED");
}

/** Bounded background checks, no media/ledger/task deletion or object upload. */
let checkCursor = "";
export async function checkImageProviderSourcesBatch() {
  const db = getSupabaseAdminClient();
  let query = db.from("image_generation_requests")
    .select("record_id,user_id,response")
    .eq("state", "completed").eq("delivery_state", "delivered")
    .eq("response->>deliveryMode", "provider_url")
    .is("response->>sourceExpiredAt", null)
    .order("record_id", { ascending: true }).limit(8);
  if (checkCursor) query = query.gt("record_id", checkCursor);
  const { data, error } = await query;
  if (error) throw new Error("IMAGE_SOURCE_ENUMERATION_UNAVAILABLE");
  if (!data?.length) { checkCursor = ""; return; }
  for (const row of data || []) {
    const delivery = row.response as Delivery;
    try { await readProviderImage(delivery, true, { recordId: String(row.record_id), userId: String(row.user_id) }); }
    catch (checkError) {
      if (confirmedImageSourceExpiry(checkError)) {
        await markImageProviderSourceExpired(String(row.record_id), String(row.user_id), String(delivery.providerUrl));
      }
      // Auth/network/type/size failures are unknown, never expiry.
    }
    checkCursor = String(row.record_id);
  }
}
