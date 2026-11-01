import { createHash } from "node:crypto";

/** Irreversible server-only credential scope; never return/log its input. */
export function gaoruiCredentialBindingFingerprint(input: { secret: string; modelId: string; endpoint: string }): string {
  return createHash("sha256").update(JSON.stringify([
    "gaorui-person-asset-credential.v1", gaoruiProviderOrigin(input.endpoint), input.modelId, input.secret,
  ])).digest("hex");
}

/** Server-issued authority for a private Gaorui person-reference asset. */
export type GaoruiTrustedPersonAssetData = Readonly<{
  operationId: string;
  userId: string;
  ownedAssetId: string;
  contentSha256: string;
  modelId: string;
  modelName: "seedance-2.0-fast";
  endpointOrigin: "https://gaorui.cc";
  credentialBindingFingerprint: string;
  sourceUrl: string;
  assetId: string;
  assetUrl: string;
  type: "image";
  role: "reference_image";
  purpose: "person_reference";
}>;

declare const gaoruiTrustedAssetBrand: unique symbol;
export type GaoruiTrustedPersonAsset = GaoruiTrustedPersonAssetData & {
  readonly [gaoruiTrustedAssetBrand]: true;
};

// A JSON body, persisted snapshot, or object spread cannot recreate authority.
const issuedAssets = new WeakSet<object>();

export function gaoruiProviderOrigin(endpoint: string): "https://gaorui.cc" {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error("GAORUI_ASSET_ENDPOINT_INVALID"); }
  if (parsed.origin !== "https://gaorui.cc" || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error("GAORUI_ASSET_ENDPOINT_INVALID");
  }
  return "https://gaorui.cc";
}

/** Internal issuer: only the owned-asset preparation service may call this. */
export function issueGaoruiTrustedPersonAsset(data: GaoruiTrustedPersonAssetData): GaoruiTrustedPersonAsset {
  const asset = Object.freeze({ ...data }) as GaoruiTrustedPersonAsset;
  issuedAssets.add(asset);
  return asset;
}

export type GaoruiPersonAssetScope = {
  modelName: string;
  endpoint: string;
  userId: string;
  ownedAssetId: string;
  modelId: string;
  credentialBindingFingerprint: string;
  sourceUrl: string;
  /** The documented image asset can serve these two video image roles. */
  nativeRole: "first_frame" | "reference_image";
};

export function assertGaoruiTrustedPersonAsset(
  value: unknown,
  scope: GaoruiPersonAssetScope,
): GaoruiTrustedPersonAssetData {
  if (!value || typeof value !== "object" || !issuedAssets.has(value)) {
    throw new Error("GAORUI_PERSON_ASSET_UNTRUSTED");
  }
  const asset = value as GaoruiTrustedPersonAsset;
  if (scope.modelName !== "seedance-2.0-fast" || asset.modelName !== scope.modelName
    || asset.endpointOrigin !== gaoruiProviderOrigin(scope.endpoint)
    || asset.type !== "image" || asset.role !== "reference_image" || asset.purpose !== "person_reference"
    || !["first_frame", "reference_image"].includes(scope.nativeRole)
    || asset.userId !== scope.userId || asset.ownedAssetId !== scope.ownedAssetId
    || asset.modelId !== scope.modelId || asset.credentialBindingFingerprint !== scope.credentialBindingFingerprint
    || asset.sourceUrl !== scope.sourceUrl) {
    throw new Error("GAORUI_PERSON_ASSET_SCOPE_MISMATCH");
  }
  return asset;
}
