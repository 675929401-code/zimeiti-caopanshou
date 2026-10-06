import { createHmac, timingSafeEqual } from "node:crypto";
import { getJwtSecretString } from "@/lib/auth";

const MAX_SIGNED_URL_LIFETIME_MS = 60 * 60 * 1000;
const LOCAL_VIDEO_SIGNATURE_PREFIX = "extract-local-video";
const OWNED_ASSET_SIGNATURE_PREFIX = "extract-owned-asset";
const TEMPORARY_VIDEO_SIGNATURE_PREFIX = "extract-temporary-video";

function signaturePayload(url: string, expires: number): string {
  return `${expires}\n${url}`;
}

export function createExtractDownloadSignature(url: string, expires: number): string {
  return createHmac("sha256", getJwtSecretString())
    .update(signaturePayload(url, expires))
    .digest("hex");
}

export function createSignedExtractDownloadParams(url: string, lifetimeMs = 30 * 60 * 1000): {
  expires: string;
  sig: string;
} {
  const boundedLifetime = Math.floor(Math.max(60_000, Math.min(lifetimeMs, MAX_SIGNED_URL_LIFETIME_MS)));
  const expires = Date.now() + boundedLifetime;
  return {
    expires: String(expires),
    sig: createExtractDownloadSignature(url, expires),
  };
}

export function verifyExtractDownloadSignature(
  url: string,
  expiresValue: string | null,
  signatureValue: string | null,
  now = Date.now(),
): boolean {
  if (!expiresValue || !signatureValue || !/^\d{13}$/u.test(expiresValue) || !/^[a-f\d]{64}$/iu.test(signatureValue)) {
    return false;
  }
  const expires = Number(expiresValue);
  if (!Number.isSafeInteger(expires) || expires < now || expires - now > MAX_SIGNED_URL_LIFETIME_MS) {
    return false;
  }
  const expected = Buffer.from(createExtractDownloadSignature(url, expires), "hex");
  const received = Buffer.from(signatureValue, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createSignedExtractLocalVideoParams(
  fileHash: string,
  lifetimeMs = 30 * 60 * 1000,
): { expires: string; sig: string } {
  return createSignedExtractDownloadParams(`${LOCAL_VIDEO_SIGNATURE_PREFIX}:${fileHash}`, lifetimeMs);
}

export function verifyExtractLocalVideoSignature(
  fileHash: string,
  expiresValue: string | null,
  signatureValue: string | null,
  now = Date.now(),
): boolean {
  return verifyExtractDownloadSignature(
    `${LOCAL_VIDEO_SIGNATURE_PREFIX}:${fileHash}`,
    expiresValue,
    signatureValue,
    now,
  );
}

export function createSignedExtractTemporaryVideoParams(
  fileHash: string,
  ownerId: string,
  lifetimeMs = 30 * 60 * 1000,
): { expires: string; sig: string } {
  return createSignedExtractDownloadParams(
    `${TEMPORARY_VIDEO_SIGNATURE_PREFIX}:${ownerId}:${fileHash}`,
    lifetimeMs,
  );
}

export function verifyExtractTemporaryVideoSignature(
  fileHash: string,
  ownerId: string,
  expiresValue: string | null,
  signatureValue: string | null,
  now = Date.now(),
): boolean {
  return verifyExtractDownloadSignature(
    `${TEMPORARY_VIDEO_SIGNATURE_PREFIX}:${ownerId}:${fileHash}`,
    expiresValue,
    signatureValue,
    now,
  );
}

export function createSignedExtractOwnedAssetParams(
  assetId: string,
  lifetimeMs = 5 * 60 * 1000,
): { expires: string; sig: string } {
  return createSignedExtractDownloadParams(`${OWNED_ASSET_SIGNATURE_PREFIX}:${assetId}`, lifetimeMs);
}

export function verifyExtractOwnedAssetSignature(
  assetId: string,
  expiresValue: string | null,
  signatureValue: string | null,
  now = Date.now(),
): boolean {
  return verifyExtractDownloadSignature(
    `${OWNED_ASSET_SIGNATURE_PREFIX}:${assetId}`,
    expiresValue,
    signatureValue,
    now,
  );
}
