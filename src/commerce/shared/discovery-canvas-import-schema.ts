import type {CanvasGraph, CanvasKind} from './canvas-schema';

export type DiscoveryJson = null | boolean | number | string | DiscoveryJson[] | {[key: string]: DiscoveryJson};
export type DiscoveryImportIssue = {
  severity: 'fatal' | 'execution' | 'review';
  code: string;
  path: string;
  message: string;
};
/** This is a caller-verified ownership/type mapping, never a URL to download. */
export type DiscoveryOwnedAssetMap = Record<string, {id: string; kind: Exclude<CanvasKind, 'text'>}>;
export type DiscoveryCanvasIds = {
  nodes: Record<string, string>;
  edges: Record<string, string>;
  groups: Record<string, string>;
};
/** Explicit evidence from a separately reviewed reference resolver. No label/index guessing. */
export type DiscoveryReferenceBinding = {
  label: string;
  sourceNodeLocalId: string;
  assetRef?: string;
  slot?: string;
  instanceId: string;
};
export type DiscoveryCanvasImportOptions = {
  assetMap: DiscoveryOwnedAssetMap;
  ids: DiscoveryCanvasIds;
  referenceBindings?: Record<string, DiscoveryReferenceBinding[]>;
};
export type DiscoveryNodeMigration = {
  sourceLocalId: string;
  targetId: string | null;
  sourceType: string;
  sourceRole: string;
  inputSlot: string | null;
  sourceVersion: number | null;
  zIndex: number | null;
  referenceOrderPublished: boolean;
  orderedSourceLocalIds: string[];
  orderedTargetNodeIds: string[];
  instructionSourceLocalIds: string[];
  referenceSourceLocalIds: string[];
  derivedSourceLocalIds: string[];
  prompt: string;
  outputText: string | null;
  outputAssetRef: string | null;
  logicalModelKey: string | null;
  imageSkillId: string | null;
  derivativeAction: string | null;
  parameters: Record<string, DiscoveryJson>;
  /** Layout/provenance/order are retained here when CanvasGraph has no corresponding field. */
  requiresReview: true;
};
export type DiscoveryCanvasImportResult = {
  /** True only when a complete local graph can be represented without guessing or omission. */
  ok: boolean;
  /** Import never asserts that a public workflow is executable on the local providers. */
  executionReady: false;
  graph: CanvasGraph | null;
  /** A cloned semantic source snapshot, with execution receipts/credentials removed. */
  sourceSnapshot: DiscoveryJson;
  issues: DiscoveryImportIssue[];
  migration: {
    schemaVersion: 1;
    nodes: DiscoveryNodeMigration[];
    groups: {sourceLocalId: string; targetId: string | null; zIndex: number | null; boundsPolicy: string | null}[];
    removedMetadataFields: number;
  };
};
