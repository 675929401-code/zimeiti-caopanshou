import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import pg from "pg";
import {
  VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
  isReleaseVerifiedVideoChannelHealth,
} from "../src/lib/video-channel-health-release";
import {
  PRODUCTION_DATABASE_CONTRACT,
  validateProductionDatabaseOpenApi,
} from "../src/lib/production-database-readiness";
import { assertSharedAgentBatchCasCandidateCaptured } from "./lib/shared-agent-batch-cas-candidate-gate";
import { assertForwardMigrationRoot } from "./lib/forward-migration-source-validator.mjs";
import { validateOpenApi as validatePreflightOpenApi } from "./create-production-preflight-receipt.mjs";

const { Client } = pg;

const read = (file: string) => readFileSync(file, "utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const migrationReleasePolicy = JSON.parse(read("deploy/policies/release-policy.json")) as {
  database?: {
    rollbackRoot?: string;
    legacyRollbackRelocations?: Array<{ from: string; to: string; sha256: string }>;
  };
};
const forwardMigrationRoot = assertForwardMigrationRoot({
  projectRoot: process.cwd(),
  migrationRoot: "supabase/migrations",
  rollbackRoot: migrationReleasePolicy.database?.rollbackRoot || "supabase/rollbacks",
  legacyRollbackRelocations: migrationReleasePolicy.database?.legacyRollbackRelocations || [],
  gitIndexMode: "required",
});
const forwardMigrationCoverage = [
  ...forwardMigrationRoot.gitIndex.trackedForwardPaths.map((file: string) => ({ file, source: "head-index-worktree" })),
  ...forwardMigrationRoot.gitIndex.stagedNewForwardPaths.map((file: string) => ({ file, source: "index-new-worktree" })),
  ...forwardMigrationRoot.gitIndex.untrackedNewForwardPaths.map((file: string) => ({ file, source: "untracked-new-worktree" })),
].sort((left, right) => left.file.localeCompare(right.file));
const forwardMigrationCoverageSha256 = sha256(JSON.stringify(forwardMigrationCoverage));
const contract = JSON.parse(read("deploy/policies/database-contract.v1.json")) as {
  contractVersion: string;
  requiredProbeRole: string;
  liveCatalogChecks?: {
    mode: string;
    requiredAfterMigrationApply: boolean;
    requiredBeforeCandidateActivation: boolean;
    migrationLedger: {
      relation: string;
      hashColumn: string;
      hashAlgorithm: string;
      requiredMigrations: Array<{ version: string; file: string; sha256: string }>;
    };
    relationSemantics: Array<{
      relation: string;
      requiredOwnerRelation?: string;
      rlsRequired?: boolean;
      forbiddenPrivilegePrincipals?: string[];
      requiredColumns: Array<{ name: string; type: string }>;
      requiredConstraints: Array<{ name: string; validated: boolean; definitionTokens: string[] }>;
    }>;
    h3ProviderUrlPredicate: { signature: string; ownerRelation: string; securityDefinerRequired: boolean; volatility: string; strict: boolean; searchPath: string[]; requiredExecuteGrantee: string; sourceSha256: string; sourceMigration: string };
    triggerSemantics: Array<{
      relation: string;
      name: string;
      function: string;
      enabled: boolean;
    }>;
    functionDependencyEdges: Array<{ caller: string; callee: string; ownerRelation: string }>;
    functionSecurityGroups: Array<{
      id: string;
      ownerRelation: string;
      ownerMustMatchRelationOwner: boolean;
      requiredOwnerRole?: string;
      requiredSourceSha256?: Record<string, string>;
      securityDefinerRequired: boolean;
      searchPath: string[];
      additionalSettings?: string[];
      requiredNonOwnerExecuteGrantees: string[];
      allowedEffectiveExecutePrincipals: string[];
      superuserInherentPrivilegeExcluded: boolean;
      forbiddenExecutePrincipals: string[];
      functions: string[];
      requiredDefinitionTokens?: Record<string, string[]>;
    }>;
  };
  tables: Array<{ name: string; columns: string[] }>;
  rpcs: Array<{ name: string; arguments: string[] }>;
  rollbackArtifacts?: Array<{
    forwardMigration: string;
    rollback?: string;
    rollbackSha256?: string;
    mode: string;
    preserves: string[];
    blocksWhen: string[];
  }>;
};

// Candidate-aware fail-closed gate. The formal contract is refreshed only by
// the database control-plane owner after local apply/readiness evidence exists.
// Until then, any release path that invokes this verifier is intentionally
// blocked rather than silently omitting migration 1400.
assertSharedAgentBatchCasCandidateCaptured(contract);

const table = (name: string) => contract.tables.find((entry) => entry.name === name);
const rpc = (name: string) => contract.rpcs.find((entry) => entry.name === name);

assert.equal(contract.contractVersion, "20261104010000");
assert.deepEqual(PRODUCTION_DATABASE_CONTRACT, contract, "embedded database contract is stale");
assert.equal(contract.requiredProbeRole, "service_role");
const liveCatalogChecks = (() => {
  const configured = contract.liveCatalogChecks;
  assert.ok(configured, "database contract missing live catalog checks");
  return configured;
})();
assert.equal(liveCatalogChecks.mode, "read-only-postgresql-catalog");
assert.equal(liveCatalogChecks.requiredAfterMigrationApply, true);
assert.equal(liveCatalogChecks.requiredBeforeCandidateActivation, true);
assert.equal(liveCatalogChecks.migrationLedger.relation, "supabase_migrations.schema_migrations");
assert.equal(liveCatalogChecks.migrationLedger.hashColumn, "hash");
assert.equal(liveCatalogChecks.migrationLedger.hashAlgorithm, "sha256-source-bytes");
assert.deepEqual(liveCatalogChecks.relationSemantics, [
  {
    relation: "public.image_generation_requests",
    requiredColumns: [
      { name: "provider_dispatch_receipt", type: "jsonb" },
      { name: "provider_submission_receipt", type: "jsonb" },
    ],
    requiredConstraints: [
      {
        name: "image_generation_requests_provider_receipt_order",
        validated: true,
        definitionTokens: ["provider_submission_receipt IS NULL", "provider_dispatch_receipt IS NOT NULL"],
      },
    ],
  },
  {
    relation: "public.video_reference_asset_cleanup_outbox",
    requiredOwnerRelation: "public.video_tasks",
    rlsRequired: true,
    forbiddenPrivilegePrincipals: ["PUBLIC", "anon", "authenticated", "service_role"],
    requiredColumns: [
      { name: "asset_ref", type: "text" },
      { name: "user_file_id", type: "text" },
      { name: "user_id", type: "text" },
      { name: "storage_provider", type: "text" },
      { name: "storage_key", type: "text" },
      { name: "source", type: "text" },
      { name: "file_category", type: "text" },
      { name: "upload_session", type: "text" },
      { name: "state", type: "text" },
      { name: "attempts", type: "integer" },
      { name: "last_error_code", type: "text" },
      { name: "registered_at", type: "timestamp with time zone" },
      { name: "claimed_at", type: "timestamp with time zone" },
      { name: "object_deleted_at", type: "timestamp with time zone" },
      { name: "completed_at", type: "timestamp with time zone" },
      { name: "updated_at", type: "timestamp with time zone" },
    ],
    requiredConstraints: [],
  },
{
  "relation": "public.autodl_h3_jobs",
  "requiredColumns": [],
  "requiredConstraints": [
    {
      "name": "autodl_h3_jobs_success_asset_check",
      "validated": true,
      "definitionTokens": [
        "SUCCEEDED",
        "result_asset_url IS NOT NULL",
        "^object://tencent_cos/",
        "COALESCE",
        "autodl_h3_provider_delivery_url_valid(result_asset_url, upstream_task_id)"
      ]
    }
  ]
},
{
  "relation": "public.autodl_h3_settlements",
  "requiredColumns": [],
  "requiredConstraints": [
    {
      "name": "autodl_h3_settlement_asset_check",
      "validated": true,
      "definitionTokens": [
        "^object://tencent_cos/",
        "COALESCE",
        "autodl_h3_provider_delivery_url_valid(stable_asset_url, upstream_task_id)"
      ]
    }
  ]
},
  {
    relation: "public.video_tasks",
    requiredColumns: [{ name: "provider_asset_preparation", type: "jsonb" }],
    requiredConstraints: [{
      name: "video_tasks_provider_asset_preparation_object",
      validated: true,
      definitionTokens: ["provider_asset_preparation", "jsonb_typeof", "object"],
    }],
  },
  {
    relation: "public.gaorui_provider_asset_operations",
    requiredOwnerRelation: "public.user_files",
    rlsRequired: true,
    forbiddenPrivilegePrincipals: ["PUBLIC", "anon", "authenticated", "service_role"],
    requiredColumns: [
      { name: "scope_key", type: "text" },
      { name: "operation_id", type: "uuid" },
      { name: "scope", type: "jsonb" },
      { name: "claim_token", type: "uuid" },
      { name: "state", type: "text" },
      { name: "result", type: "jsonb" },
      { name: "error_code", type: "text" },
      { name: "budget_authorization_id", type: "text" },
      { name: "maximum_charge_cny", type: "numeric" },
      { name: "created_at", type: "timestamp with time zone" },
      { name: "updated_at", type: "timestamp with time zone" },
    ],
    requiredConstraints: [],
  },
]);
assert.deepEqual(liveCatalogChecks.triggerSemantics, [
  {
    relation: "public.video_tasks",
    name: "video_tasks_reference_asset_reservation_guard",
    function: "public.guard_video_reference_assets_during_reservation_v1()",
    enabled: true,
  },
]);
const purgeSignature = "public.purge_expired_video_history(integer,integer)";
assert.deepEqual(liveCatalogChecks.functionSecurityGroups.filter(group => !group.functions.includes(purgeSignature)), [
  {
    "id": "image-generation-request",
    "ownerRelation": "public.image_generation_requests",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [
      "service_role"
    ],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner",
      "service_role"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated"
    ],
    "functions": [
      "public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)",
      "public.reconcile_stale_image_generation_request_atomic(text,text,integer)",
      "public.record_image_provider_dispatch_receipt_atomic(text,text,text,text,jsonb)",
      "public.record_image_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)"
    ],
    "requiredDefinitionTokens": {
      "public.reconcile_stale_image_generation_request_atomic(text,text,integer)": [
        "provider_evidence_present"
      ],
      "public.record_image_provider_dispatch_receipt_atomic(text,text,text,text,jsonb)": [
        "IMAGE_PROVIDER_DISPATCH_RECEIPT_INVALID",
        "requestProjection.referenceCount="
      ],
      "public.record_image_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)": [
        "IMAGE_PROVIDER_SUBMISSION_RECEIPT_INVALID",
        "providerAcknowledgementField="
      ]
    }
  },
  {
    "id": "image-provider-reconciliation-owner-helper",
    "ownerRelation": "public.image_generation_requests",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated",
      "service_role"
    ],
    "functions": [
      "public.reconcile_stale_image_generation_request_without_provider_receipt(text,text,integer)"
    ]
  },
  {
    "id": "video-generation-request-snapshot",
    "ownerRelation": "public.video_tasks",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [
      "service_role"
    ],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner",
      "service_role"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated"
    ],
    "functions": [
      "public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text)",
      "public.reserve_video_generation_task_request_snapshot_v1_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)",
      "public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)"
    ]
  },
  {
    "id": "video-provider-request-projection",
    "ownerRelation": "public.video_tasks",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [
      "service_role"
    ],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner",
      "service_role"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated"
    ],
    "functions": [
      "public.record_video_provider_dispatch_receipt_atomic(text,text,text,jsonb)",
      "public.record_video_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)"
    ],
    "requiredDefinitionTokens": {
      "public.record_video_provider_dispatch_receipt_atomic(text,text,text,jsonb)": [
        "wireBodySha256",
        "endpointPath",
        "attemptOrdinal",
        "dispatchIdentitySha256",
        "VIDEO_PROVIDER_DISPATCH_ATTEMPT_ORDINAL_CONFLICT",
        "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT"
      ],
      "public.record_video_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)": [
        "dispatchReceiptSha256",
        "dispatchIdentitySha256s",
        "dispatchAttemptCount",
        "VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_V2_DISPATCH"
      ]
    }
  },
  {
    "id": "video-reference-asset-reservation-guard",
    "ownerRelation": "public.video_tasks",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated",
      "service_role"
    ],
    "functions": [
      "public.guard_video_reference_assets_during_reservation_v1()"
    ],
    "requiredDefinitionTokens": {
      "public.guard_video_reference_assets_during_reservation_v1()": [
        "VIDEO_REFERENCE_ASSET_CLEANUP_IN_PROGRESS"
      ]
    }
  },
  {
    "id": "video-reference-asset-cleanup",
    "ownerRelation": "public.video_tasks",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [
      "service_role"
    ],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner",
      "service_role"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated"
    ],
    "functions": [
      "public.register_video_reference_asset_guard_v1(text,text,text,text,text,text,text,text)",
      "public.claim_video_reference_asset_cleanup_v1(text,text,text,text,text,text,text,text)",
      "public.mark_video_reference_asset_object_deleted_v1(text,text)",
      "public.complete_video_reference_asset_cleanup_v1(text,text,text,text,text,text)",
      "public.record_video_reference_asset_cleanup_failure_v1(text,text,text)"
    ],
    "requiredDefinitionTokens": {
      "public.register_video_reference_asset_guard_v1(text,text,text,text,text,text,text,text)": [
        "VIDEO_REFERENCE_GUARD_IDENTITY_MISMATCH"
      ],
      "public.claim_video_reference_asset_cleanup_v1(text,text,text,text,text,text,text,text)": [
        "VIDEO_REFERENCE_DELETE_ACTIVE_TASK"
      ],
      "public.mark_video_reference_asset_object_deleted_v1(text,text)": [
        "VIDEO_REFERENCE_DELETE_STATE_INVALID"
      ],
      "public.complete_video_reference_asset_cleanup_v1(text,text,text,text,text,text)": [
        "delete from public.user_files"
      ],
      "public.record_video_reference_asset_cleanup_failure_v1(text,text,text)": [
        "VIDEO_REFERENCE_DELETE_RETRY_REQUIRED"
      ]
    }
  },
  {
    "id": "shared-agent-batch-cas",
    "ownerRelation": "public.agents",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [
      "service_role"
    ],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner",
      "service_role"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated"
    ],
    "functions": [
      "public.apply_agent_reorder_cas_v1(jsonb)",
      "public.apply_coze_agent_import_cas_v1(jsonb)"
    ],
    "requiredDefinitionTokens": {
      "public.apply_agent_reorder_cas_v1(jsonb)": [
        "AGENT_REORDER_CATEGORY_INCOMPLETE",
        "AGENT_CONFIG_REVISION_CONFLICT"
      ],
      "public.apply_coze_agent_import_cas_v1(jsonb)": [
        "pg_advisory_xact_lock",
        "COZE_IMPORT_INSERT_TARGET_EXISTS",
        "AGENT_CONFIG_REVISION_CONFLICT_AFTER_LOCK"
      ]
    }
  },
  {
    "id": "image-provider-delivery",
    "ownerRelation": "public.image_generation_requests",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [
      "service_role"
    ],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner",
      "service_role"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated"
    ],
    "functions": [
      "public.finalize_image_provider_delivery(text,text,text)",
      "public.mark_image_provider_source_expired(text,text,text)",
      "public.complete_image_ephemeral_delivery(text,text,text,text,text,text,text,jsonb)"
    ]
  },
  {
    "id": "h3-provider-delivery-finalizer",
    "ownerRelation": "public.video_tasks",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [
      "service_role"
    ],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner",
      "service_role"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated"
    ],
    "functions": [
      "public.autodl_h3_finalize_video_provider_url(uuid,text,text,text,text,text,text,bigint,text,numeric,numeric,bigint)"
    ]
  },
  {
    "id": "h3-provider-delivery-marker",
    "ownerRelation": "public.video_tasks",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": false,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [
      "service_role"
    ],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner",
      "service_role"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated"
    ],
    "functions": [
      "public.autodl_h3_provider_delivery_v1_ready()"
    ]
  },
  {
    "id": "image-model-receipt-publication",
    "ownerRelation": "public.cover_models",
    "ownerMustMatchRelationOwner": true,
    "securityDefinerRequired": true,
    "searchPath": [
      "public",
      "pg_temp"
    ],
    "requiredNonOwnerExecuteGrantees": [
      "service_role"
    ],
    "allowedEffectiveExecutePrincipals": [
      "relation_owner",
      "service_role"
    ],
    "superuserInherentPrivilegeExcluded": true,
    "forbiddenExecutePrincipals": [
      "PUBLIC",
      "anon",
      "authenticated"
    ],
    "functions": [
      "public.publish_image_model_validation_receipt(text,text,text,text,boolean,boolean,text,bigint,text,jsonb)"
    ]
  },
  {
    id: "gaorui-person-reference-assets",
    ownerRelation: "public.user_files",
    ownerMustMatchRelationOwner: true,
    securityDefinerRequired: true,
    searchPath: ["pg_catalog", "public"],
    requiredNonOwnerExecuteGrantees: ["service_role"],
    allowedEffectiveExecutePrincipals: ["relation_owner", "service_role"],
    superuserInherentPrivilegeExcluded: true,
    forbiddenExecutePrincipals: ["PUBLIC", "anon", "authenticated"],
    functions: [
      "public.claim_gaorui_provider_person_asset_v1(text,jsonb,uuid,text,numeric)",
      "public.settle_gaorui_provider_person_asset_v1(text,uuid,text,jsonb,text)",
    ],
    requiredSourceSha256: {
      "public.claim_gaorui_provider_person_asset_v1(text,jsonb,uuid,text,numeric)": "d5c4ac422afa02ed51862f633218487f48087836f57d4f1ad65825578d6d997b",
      "public.settle_gaorui_provider_person_asset_v1(text,uuid,text,jsonb,text)": "9a1cab4fbf54c9b5291d575ed92ae525be307b5be700fe586d3757d9cbd60c3a",
    },
  },
{
  "id": "digital-human-asset-preflight",
  "ownerRelation": "public.user_files",
  "ownerMustMatchRelationOwner": false,
  "requiredOwnerRole": "zimeiti_owner",
  "securityDefinerRequired": true,
  "searchPath": [
    "pg_catalog",
    "pg_temp"
  ],
  "requiredNonOwnerExecuteGrantees": [
    "service_role"
  ],
  "allowedEffectiveExecutePrincipals": [
    "function_owner",
    "service_role"
  ],
  "superuserInherentPrivilegeExcluded": true,
  "forbiddenExecutePrincipals": [
    "PUBLIC",
    "anon",
    "authenticated"
  ],
  "functions": [
    "public.read_gaorui_person_asset_preflight_v1(text,text,text,text,text)"
  ],
  "requiredSourceSha256": {
    "public.read_gaorui_person_asset_preflight_v1(text,text,text,text,text)": "3501638a81e522af349b44c053b9c859ac6626da40c9d365abdae4db48d6d411"
  },
  "requiredDefinitionTokens": {
    "public.read_gaorui_person_asset_preflight_v1(text,text,text,text,text)": [
      "STABLE",
      "SECURITY DEFINER",
      "operation.scope->>'user_id' = p_user_id",
      "operation.scope->>'owned_asset_id' = p_owned_asset_id",
      "operation.scope->>'model_id' = p_model_id",
      "operation.scope->>'provider_origin' = p_provider_origin",
      "operation.scope->>'credential_binding_fingerprint' = p_credential_binding_fingerprint",
      "EXISTS",
      "public.user_files",
      "asset.id::text = p_owned_asset_id",
      "asset.user_id::text = p_user_id",
      "asset.storage_key = operation.scope->>'storage_key'",
      "asset.file_category = 'image'",
      "asset.source = 'digital-human-input'",
      "asset.storage_provider = 'tencent_cos'",
      "nullif(to_jsonb(asset)->>'deleted_at', '') IS NULL",
      "coalesce(to_jsonb(asset)->>'is_deleted', 'false') <> 'true'",
      "nullif(asset.meta->>'deleted_at', '') IS NULL",
      "nullif(asset.meta->>'deletedAt', '') IS NULL",
      "coalesce(asset.meta->>'deleted', 'false') <> 'true'",
      "LIMIT 101"
    ]
  }
},
{
  "id": "agent-catalog-publication-invoker",
  "ownerRelation": "public.agents",
  "ownerMustMatchRelationOwner": false,
  "requiredOwnerRole": "postgres",
  "securityDefinerRequired": false,
  "searchPath": [
    "pg_catalog",
    "public"
  ],
  "requiredNonOwnerExecuteGrantees": [
    "service_role"
  ],
  "allowedEffectiveExecutePrincipals": [
    "function_owner",
    "service_role"
  ],
  "superuserInherentPrivilegeExcluded": true,
  "forbiddenExecutePrincipals": [
    "PUBLIC",
    "anon",
    "authenticated"
  ],
  "functions": [
    "public.agent_catalog_canonical_json_v1(jsonb)",
    "public.agent_catalog_projection_v1(public.agents)",
    "public.agent_catalog_utf16_v1(text)",
    "public.apply_agent_catalog_publication_v1(text,text,jsonb,jsonb,text,jsonb)",
    "public.read_agent_catalog_model_guard_v1(uuid)",
    "public.read_agent_catalog_publication_index_v1(text,text)",
    "public.read_agent_catalog_publication_v1(text)"
  ],
  "requiredSourceSha256": {
    "public.agent_catalog_canonical_json_v1(jsonb)": "d230b4e4ffe6d8204ee4ac3d2030dc30f8b26dedeab14b6ea8d00e3dc03f564e",
    "public.agent_catalog_projection_v1(public.agents)": "1d9fb6ba4019d6986a0758b6fc17476a577d5b65ed25f01aafb22b47f0cffe9a",
    "public.agent_catalog_utf16_v1(text)": "270e80afa92c2812d68b90fc1a70d55df9937faf5a01f9c3ca380197a95638ef",
    "public.apply_agent_catalog_publication_v1(text,text,jsonb,jsonb,text,jsonb)": "adce1c197ddc88308fa6a90592788be9900d79af38224447af8ced2a72a76a70",
    "public.read_agent_catalog_model_guard_v1(uuid)": "36020454bff4674a0c96a990386af6976afc0dcd7d1f9911d64187ff5160fbf6",
    "public.read_agent_catalog_publication_index_v1(text,text)": "dc85077a7303db4c48dcf1caf024e85fbdec7568fbc08f16a64ff2a213b78af8",
    "public.read_agent_catalog_publication_v1(text)": "a029625e856f9af4eade0ef45d2d6e1325f6b97af6ac6cda70a12776cf8b9434"
  }
},
{
  "id": "agent-catalog-owner-lock",
  "ownerRelation": "public.agents",
  "ownerMustMatchRelationOwner": false,
  "requiredOwnerRole": "postgres",
  "securityDefinerRequired": true,
  "searchPath": [
    "pg_catalog",
    "public"
  ],
  "requiredNonOwnerExecuteGrantees": [
    "service_role"
  ],
  "allowedEffectiveExecutePrincipals": [
    "function_owner",
    "service_role"
  ],
  "superuserInherentPrivilegeExcluded": true,
  "forbiddenExecutePrincipals": [
    "PUBLIC",
    "anon",
    "authenticated"
  ],
  "functions": [
    "public.lock_agent_catalog_publication_owner_v1(text,text,boolean)"
  ],
  "requiredSourceSha256": {
    "public.lock_agent_catalog_publication_owner_v1(text,text,boolean)": "9ab2909b4b876b3ac545058e5a5dcee368a2c49f1e0b8c9480850ce82214d97b"
  }
},
{
  "id": "agent-catalog-number-codec",
  "ownerRelation": "public.agents",
  "ownerMustMatchRelationOwner": false,
  "requiredOwnerRole": "postgres",
  "securityDefinerRequired": false,
  "searchPath": [
    "pg_catalog",
    "public"
  ],
  "requiredNonOwnerExecuteGrantees": [
    "service_role"
  ],
  "allowedEffectiveExecutePrincipals": [
    "function_owner",
    "service_role"
  ],
  "superuserInherentPrivilegeExcluded": true,
  "forbiddenExecutePrincipals": [
    "PUBLIC",
    "anon",
    "authenticated"
  ],
  "functions": [
    "public.agent_catalog_number_v1(numeric)"
  ],
  "requiredSourceSha256": {
    "public.agent_catalog_number_v1(numeric)": "69ab91b41449b47301b37edc70dc18ff0fc48d3687cdff4b2054045eed386b5d"
  },
  "additionalSettings": [
    "extra_float_digits=3"
  ]
},
{
  "id": "reviewed-text-activation",
  "ownerRelation": "public.agents",
  "ownerMustMatchRelationOwner": false,
  "requiredOwnerRole": "postgres",
  "securityDefinerRequired": false,
  "searchPath": [
    "pg_catalog",
    "public"
  ],
  "requiredNonOwnerExecuteGrantees": [
    "service_role"
  ],
  "allowedEffectiveExecutePrincipals": [
    "function_owner",
    "service_role"
  ],
  "superuserInherentPrivilegeExcluded": true,
  "forbiddenExecutePrincipals": [
    "PUBLIC",
    "anon",
    "authenticated"
  ],
  "functions": [
    "public.activate_reviewed_deepseek_history_v1(text,text,uuid,text,text,text)"
  ],
  "requiredSourceSha256": {
    "public.activate_reviewed_deepseek_history_v1(text,text,uuid,text,text,text)": "362e3149a9fc652ca08ccaba3011b0d0245d4d17c3d35903e917cee2a179f0aa"
  }
},
{
  "id": "reviewed-text-owner-locks",
  "ownerRelation": "public.agents",
  "ownerMustMatchRelationOwner": false,
  "requiredOwnerRole": "postgres",
  "securityDefinerRequired": true,
  "searchPath": [
    "pg_catalog",
    "public"
  ],
  "requiredNonOwnerExecuteGrantees": [
    "service_role"
  ],
  "allowedEffectiveExecutePrincipals": [
    "function_owner",
    "service_role"
  ],
  "superuserInherentPrivilegeExcluded": true,
  "forbiddenExecutePrincipals": [
    "PUBLIC",
    "anon",
    "authenticated"
  ],
  "functions": [
    "public.lock_reviewed_deepseek_history_v1(text,uuid,text,text,text)",
    "public.lock_reviewed_text_activation_owner_v1(text,text)"
  ],
  "requiredSourceSha256": {
    "public.lock_reviewed_deepseek_history_v1(text,uuid,text,text,text)": "3b44fd5bfcd0b7603207016c415952234e0618f22f09a04a6b6e5d6879b6f3a9",
    "public.lock_reviewed_text_activation_owner_v1(text,text)": "01138d5cee7c9a8d23babef02fd0288db35f04a3150e0db9d19c90919e9aae2d"
  }
}

]);
const purgeSecurityGroups = liveCatalogChecks.functionSecurityGroups.filter(group => group.functions.includes(purgeSignature));
assert.deepEqual(purgeSecurityGroups, [{
  id: "video-history-purge-billing-protection",
  ownerRelation: "public.video_tasks",
  ownerMustMatchRelationOwner: false,
  requiredOwnerRole: "postgres",
  securityDefinerRequired: true,
  searchPath: ["public", "pg_temp"],
  requiredNonOwnerExecuteGrantees: ["service_role"],
  allowedEffectiveExecutePrincipals: ["function_owner", "service_role"],
  superuserInherentPrivilegeExcluded: true,
  forbiddenExecutePrincipals: ["PUBLIC", "anon", "authenticated"],
  functions: [purgeSignature],
  requiredSourceSha256: { [purgeSignature]: "b9258ff96251b71b8f441a7cb8afb910c53f9422207d353269f18360ff0f7cec" },
}], "purge source, preserved function owner and ACL contract must be independently fixed");
assert.deepEqual(
  liveCatalogChecks.migrationLedger.requiredMigrations.map((entry) => entry.version),
  [
    "20261010023000", "20261010130000", "20261010131000", "20261010132000",
    "20261010133000", "20261010134000", "20261010135000", "20261010140000",
    "20261012010000", "20261012011000", "20261012012000", "20261012013000",
    "20261012014000", "20261030010000", "20261030020000", "20261030030000", "20261030040000", "20261030050000", "20261030060000", "20261030070000", "20261030080000", "20261031010000", "20261103010000", "20261104010000",
  ],
);
const pendingCredentialMigrations = [
  { version: "20261030010000", file: "supabase/migrations/20261030010000_platform_configuration_pending_credentials.sql", sha256: "2823d96c17df7126859ae1f2f626007a62838f8d8802fcadcbb3844d98e593c3" },
  { version: "20261030020000", file: "supabase/migrations/20261030020000_platform_pending_credentials_base_and_llm_removal.sql", sha256: "2b0de90f3a940d855f9be68232433bb7d67321e2ca87f9a1ad3ad1efbd1c8532" },
  { version: "20261030030000", file: "supabase/migrations/20261030030000_model_pool_credential_removal_combination_guard.sql", sha256: "8a54330daa13d671a3662d8ebfbb2c565ab3143f4129b6389ac55b9f97b0184e" },
] as const;
for (const expected of pendingCredentialMigrations) assert.deepEqual(liveCatalogChecks.migrationLedger.requiredMigrations.find(entry => entry.version === expected.version), expected, "pending credential migration identity must be independently fixed");
const videoHistoryBillingProtectionMigration = {
  version: "20261030040000",
  file: "supabase/migrations/20261030040000_video_history_unsettled_billing_protection.sql",
  sha256: "104beaa60970d24f3f776dde831d88da4ba49d28d7b161f7406e0b03ed390ec4",
} as const;
assert.deepEqual(liveCatalogChecks.migrationLedger.requiredMigrations.find(entry => entry.version === videoHistoryBillingProtectionMigration.version), videoHistoryBillingProtectionMigration, "unsettled video billing protection migration identity must be independently fixed");
assert.deepEqual(liveCatalogChecks.migrationLedger.requiredMigrations.find(entry => entry.version === "20261030050000"), {
  version: "20261030050000",
  file: "supabase/migrations/20261030050000_video_credential_only_publication.sql",
  sha256: "6ea6cea3b9b03ba1688e75ac344cda4425cb8cd967330ef3d666998a4accc069",
}, "video credential-only publication migration identity must be independently fixed");
assert.deepEqual(liveCatalogChecks.migrationLedger.requiredMigrations.find(entry => entry.version === "20261030060000"), {
  version: "20261030060000",
  file: "supabase/migrations/20261030060000_video_pricing_only_publication.sql",
  sha256: "53ae17629297d1dab7d8c049143774358c56bdd5082796ce331ab123f1fd11f1",
}, "video pricing-only publication migration identity must be independently fixed");
assert.deepEqual(liveCatalogChecks.migrationLedger.requiredMigrations.find(entry => entry.version === "20261030070000"), {
  version: "20261030070000",
  file: "supabase/migrations/20261030070000_video_upsert_publication.sql",
  sha256: "6bf7670160b5d7291da3a18d52561714c17964126dcb4edda232f57f262eb438",
}, "video upsert publication migration identity must be independently fixed");
// Independently matched to reviewed C9 intent, rollback fixtures and post-apply
// ledger readback; never obtain this expected hash from the current candidate.
const gaoruiAssetMigration = {
  version: "20261030080000",
  file: "supabase/migrations/20261030080000_gaorui_provider_asset_operations.sql",
  sha256: "0c0dc5115f083ee3d260f895307b7912b26789c3d64e5854391151874bd1a007",
};
assert.deepEqual(liveCatalogChecks.migrationLedger.requiredMigrations.find(entry => entry.version === gaoruiAssetMigration.version), gaoruiAssetMigration, "Gaorui asset migration identity must be independently fixed");
assert.ok(table("video_tasks")?.columns.includes("provider_asset_preparation"), "video task asset preparation column is mandatory");
assert.equal(table("gaorui_provider_asset_operations"), undefined, "internal asset operation table must not become a client table contract");
const digitalPreflightMigration = {"version": "20261031010000", "file": "supabase/migrations/20261031010000_digital_human_asset_preflight.sql", "sha256": "35d412828f7128797f01f6387ccd7281c474126159d4f069a38de6c4f40a6a1e"};
const digitalPreflightSignature = "public.read_gaorui_person_asset_preflight_v1(text,text,text,text,text)";
const digitalPreflightGroup = liveCatalogChecks.functionSecurityGroups.find(group => group.id === "digital-human-asset-preflight")!;
assert.deepEqual(liveCatalogChecks.migrationLedger.requiredMigrations.find(entry => entry.version === digitalPreflightMigration.version), digitalPreflightMigration);
assert.deepEqual(rpc("read_gaorui_person_asset_preflight_v1"), {"name": "read_gaorui_person_asset_preflight_v1", "feature": "digital-human-asset-preflight", "arguments": ["p_user_id", "p_owned_asset_id", "p_model_id", "p_provider_origin", "p_credential_binding_fingerprint"]});
const digitalPreflightSql = read(digitalPreflightMigration.file);
const digitalPreflightSource = digitalPreflightSql.match(/AS \$\$([\s\S]*?)\$\$;/u)?.[1];
assert.ok(digitalPreflightSource);
assert.equal(sha256(digitalPreflightSource), "3501638a81e522af349b44c053b9c859ac6626da40c9d365abdae4db48d6d411");
assert.ok(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE TABLE)\b/u.test(digitalPreflightSql), "preflight must remain read-only");
assert.match(digitalPreflightSql, /ALTER FUNCTION[^;]+OWNER TO zimeiti_owner;/u);
assert.match(digitalPreflightSql, /REVOKE ALL ON FUNCTION[^;]+FROM PUBLIC, anon, authenticated, service_role;/u);
assert.match(digitalPreflightSql, /GRANT EXECUTE ON FUNCTION[^;]+TO service_role;/u);
const gaoruiAssetRpcArguments = {
  claim_gaorui_provider_person_asset_v1: ["p_scope_key", "p_scope", "p_claim_token", "p_budget_authorization_id", "p_maximum_charge_cny"],
  settle_gaorui_provider_person_asset_v1: ["p_scope_key", "p_claim_token", "p_state", "p_result", "p_error_code"],
};
for (const [name, arguments_] of Object.entries(gaoruiAssetRpcArguments)) {
  assert.deepEqual(rpc(name), { name, feature: "gaorui-person-reference-assets", arguments: arguments_ }, `Gaorui asset RPC must match reviewed contract: ${name}`);
}
const pendingCredentialRpcArguments = {
  stage_model_pool_candidate_with_credentials_atomic: ["p_actor_id", "p_request_id", "p_request_payload", "p_snapshot", "p_snapshot_sha256", "p_validation_result", "p_status", "p_change_note", "p_parent_release_id", "p_credential_changes"],
  read_platform_model_pending_credential_metadata: ["p_release_id"],
  read_platform_model_mutation_receipt: ["p_actor_id", "p_request_id", "p_request_payload"],
};
for (const [name, args] of Object.entries(pendingCredentialRpcArguments)) assert.deepEqual(rpc(name)?.arguments, args, `pending credential RPC arguments must match approved contract: ${name}`);
for (const migration of liveCatalogChecks.migrationLedger.requiredMigrations) {
  assert.equal(sha256(read(migration.file)), migration.sha256, `migration source hash changed: ${migration.file}`);
}
assert.deepEqual(liveCatalogChecks.functionDependencyEdges, [
  {
    "caller": "public.reserve_video_generation_task_request_snapshot_v1_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)",
    "callee": "public.reserve_video_generation_task_routing_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)",
    "ownerRelation": "public.video_tasks"
  },
  {
    "caller": "public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)",
    "callee": "public.reserve_queued_digital_video_task_routing_atomic(jsonb,jsonb,jsonb)",
    "ownerRelation": "public.video_tasks"
  }
]);
const dependencyForward = "supabase/migrations/20261012014000_video_snapshot_dependency_execute.sql";
const dependencyRollback = "supabase/rollbacks/20261012014000_video_snapshot_dependency_execute.rollback.sql";
const dependencyRollbackContract = contract.rollbackArtifacts?.find((entry) => entry.forwardMigration === dependencyForward);
assert.ok(dependencyRollbackContract, "dependency rollback contract missing");
assert.deepEqual(dependencyRollbackContract, {
  forwardMigration: dependencyForward,
  rollback: dependencyRollback,
  rollbackSha256: "27ad969eda58ff8848ec444cada1e1a74472840a33eec9d80f5bf2790e9c9305",
  mode: "forward-repair-only",
  preserves: [
    "video_tasks",
    "reserve_video_generation_task_routing_atomic",
    "reserve_queued_digital_video_task_routing_atomic",
    "supabase_migrations.schema_migrations:20261012014000",
  ],
  blocksWhen: ["reviewed pre-migration ACL identity is unavailable"],
});
assert.equal(sha256(read(dependencyRollback)), dependencyRollbackContract.rollbackSha256);
assert.ok(read(dependencyRollback).includes("VIDEO_SNAPSHOT_DEPENDENCY_ROLLBACK_REQUIRES_REVIEWED_PRE_ACL"));
assert.doesNotMatch(read(dependencyRollback), /\b(?:revoke|drop|delete|update|grant)\b[^\n]*;/iu);
for (const edge of liveCatalogChecks.functionDependencyEdges) {
  assert.ok(liveCatalogChecks.functionSecurityGroups.some((group) =>
    group.ownerRelation === edge.ownerRelation && group.securityDefinerRequired
      && group.functions.includes(edge.caller)), "dependency caller must retain the existing owner/security contract");
  assert.ok(read(dependencyForward).includes(edge.caller) && read(dependencyForward).includes(edge.callee));
}
const referenceCheckIds = new Set(
  (JSON.parse(read("deploy/policies/database-contract.v1.json")) as {
    referenceDataChecks?: Array<{ id: string }>;
  }).referenceDataChecks?.map((entry) => entry.id) || [],
);
for (const name of [
  "service-role-runtime",
  "voice-active-price",
  "manju-production-active-release",
  "manju-native-storage-state",
  "active-video-model-current-protocol-health",
]) assert.ok(referenceCheckIds.has(name), `database contract missing reference check ${name}`);
for (const name of [
  "extraction_attempts",
  "extraction_attempt_reconciliation_audit",
  "image_generation_requests",
  "short_drama_script_requests",
  "digital_human_long_jobs",
  "llm_request_attempts",
  "llm_request_attempt_events",
  "text_chat_conversation_settings",
  "text_chat_memories",
  "voice_training_authorization_jobs",
  "video_models",
  "video_channel_health",
  "platform_settings",
  "manju_config_storage_state",
  "payment_refund_attempts",
  "user_login_identifiers",
  "revenue_records",
]) assert.ok(table(name), `database contract missing table ${name}`);

for (const name of [
  "white_label_profiles",
  "white_label_profile_events",
  "white_label_assets",
  "white_label_release_assets",
]) assert.equal(table(name), undefined, `internal-only white-label table leaked into the public OpenAPI contract: ${name}`);

for (const column of [
  "id", "user_id", "model_id", "task_id", "cost_price", "selling_price", "profit",
  "is_admin", "record_type", "credits_charged", "cash_charged", "created_at",
]) assert.ok(table("revenue_records")?.columns.includes(column), `revenue audit contract missing ${column}`);

assert.ok(
  table("extraction_attempts")?.columns.includes("request_snapshot"),
  "extraction failure history contract missing request_snapshot",
);
assert.ok(
  table("extraction_attempts")?.columns.includes("content_purged_at"),
  "extraction retention contract missing content_purged_at",
);
for (const column of ["history_hidden_at", "source_expired_at"]) {
  assert.ok(table("video_tasks")?.columns.includes(column), `video direct-delivery contract missing ${column}`);
}
for (const column of ["id", "user_id", "state", "billing_state", "history_hidden_at", "created_at"]) {
  assert.ok(table("digital_human_long_jobs")?.columns.includes(column), `digital-human long history contract missing ${column}`);
}
for (const column of [
  "id", "user_id", "client_request_id", "request_hash", "request_snapshot", "surface", "profile_id",
  "display_title", "episode_count", "state", "result_payload", "result_hash", "billing_snapshot",
  "error_code", "error_message", "submitted_at", "updated_at", "completed_at",
]) assert.ok(table("short_drama_script_requests")?.columns.includes(column), `general-script history contract missing ${column}`);

for (const column of [
  "request_snapshot",
  "provider_dispatch_receipt",
  "provider_submission_receipt",
  "failure_hidden_at",
]) assert.ok(table("image_generation_requests")?.columns.includes(column), `image failure history contract missing ${column}`);
assert.deepEqual(rpc("record_image_provider_dispatch_receipt_atomic")?.arguments, [
  "p_record_id", "p_user_id", "p_client_trace_id", "p_payload_fingerprint", "p_receipt",
]);
assert.deepEqual(rpc("record_image_provider_submission_receipt_atomic")?.arguments, [
  "p_record_id", "p_user_id", "p_client_trace_id", "p_payload_fingerprint",
  "p_dispatch_receipt_sha256", "p_receipt",
]);

for (const column of [
  "refund_attempt_id",
  "provider_refund_id",
  "provider_refund_amount",
  "provider_refund_status",
  "refunded_at",
]) assert.ok(table("payment_orders")?.columns.includes(column), `payment refund order contract missing ${column}`);

for (const column of [
  "attempt_id",
  "trade_order_id",
  "user_id",
  "admin_user_id",
  "idempotency_key",
  "request_fingerprint",
  "state",
  "wallet_operation_id",
  "lease_owner",
  "lease_token",
  "provider_call_started_at",
  "provider_refund_id",
  "provider_refund_amount",
  "provider_status",
]) assert.ok(table("payment_refund_attempts")?.columns.includes(column), `payment refund attempt contract missing ${column}`);

for (const column of [
  "health_protocol_version",
  "verification_state",
  "verified_at",
  "verification_evidence",
]) assert.ok(table("video_channel_health")?.columns.includes(column), `video health contract missing ${column}`);

for (const column of [
  "provider_call_started_at",
  "provider_last_checked_at",
  "provider_last_status",
  "reconciliation_reason",
]) assert.ok(table("voice_training_authorization_jobs")?.columns.includes(column), `voice lifecycle contract missing ${column}`);

for (const name of [
  "claim_extraction_attempt_atomic",
  "finalize_extraction_attempt_atomic",
  "list_extraction_attempts_for_reconciliation",
  "reconcile_extraction_attempt_atomic",
  "checkpoint_extraction_request_atomic",
  "read_extraction_account_history",
  "mark_video_upstream_source_expired",
  "purge_expired_user_content",
  "claim_image_generation_request_v2",
  "reconcile_stale_image_generation_request_atomic",
  "claim_short_drama_script_request_atomic",
  "finalize_short_drama_script_request_atomic",
  "hide_digital_human_long_history_item",
  "claim_llm_request_attempt_atomic",
  "mark_llm_request_provider_started_atomic",
  "finalize_llm_request_attempt_atomic",
  "reconcile_llm_request_attempt_atomic",
  "mark_voice_training_provider_attempt_atomic",
  "release_voice_training_terminal_atomic",
  "finalize_voice_training_ready_atomic",
  "commit_manju_config_compat_envelope",
  "reconcile_manju_config_storage_to_compat",
  "reconcile_manju_config_storage_to_native",
  "cutover_manju_config_storage",
  "claim_payment_refund_attempt_atomic",
  "mark_payment_refund_provider_started_atomic",
  "finalize_payment_refund_attempt_atomic",
  "autodl_h3_finalize_video",
  "save_white_label_draft_v2_atomic",
  "register_white_label_asset_atomic",
  "publish_white_label_draft_atomic",
  "read_published_white_label_brand",
  "read_published_white_label_asset",
]) assert.ok(rpc(name), `database contract missing RPC ${name}`);

assert.deepEqual(rpc("save_white_label_draft_v2_atomic")?.arguments, [
  "p_profile_id", "p_expected_revision", "p_brand_name", "p_brand_short_name",
  "p_contact_name", "p_contact_wechat", "p_contact_phone", "p_contact_email",
  "p_requested_hostname", "p_ascii_hostname", "p_unicode_hostname", "p_expected_txt_name",
  "p_verification_token_hash", "p_verification_token_hint", "p_brand_slogan",
  "p_brand_description", "p_asset_ids", "p_actor_id", "p_request_key",
]);
assert.deepEqual(rpc("register_white_label_asset_atomic")?.arguments, [
  "p_profile_id", "p_expected_revision", "p_purpose", "p_storage_provider", "p_storage_key",
  "p_sha256", "p_mime_type", "p_bytes", "p_width", "p_height", "p_actor_id", "p_request_key",
]);
assert.deepEqual(rpc("publish_white_label_draft_atomic")?.arguments, [
  "p_profile_id", "p_expected_revision", "p_actor_id", "p_request_key",
]);
assert.deepEqual(rpc("read_published_white_label_brand")?.arguments, ["p_hostname"]);
assert.deepEqual(rpc("read_published_white_label_asset")?.arguments, [
  "p_hostname", "p_release_id", "p_asset_id",
]);

assert.deepEqual(rpc("autodl_h3_finalize_video")?.arguments, [
  "p_job_id", "p_public_task_id", "p_video_task_internal_id", "p_user_id",
  "p_model_id", "p_upstream_task_id", "p_owner", "p_lease_token",
  "p_result_asset_url", "p_price_yuan", "p_cost_price", "p_response_ms",
]);

assert.deepEqual(rpc("claim_image_generation_request_v2")?.arguments, [
  "p_record_id", "p_user_id", "p_user_hash", "p_client_idempotency_key",
  "p_client_trace_id", "p_payload_fingerprint", "p_request_snapshot",
]);
assert.deepEqual(rpc("reconcile_stale_image_generation_request_atomic")?.arguments, [
  "p_record_id", "p_user_id", "p_stale_after_seconds",
]);
assert.deepEqual(rpc("checkpoint_extraction_request_atomic")?.arguments, [
  "p_record_id", "p_user_id", "p_payload_fingerprint", "p_request_snapshot",
]);
assert.deepEqual(rpc("read_extraction_account_history")?.arguments, [
  "p_user_id", "p_before", "p_before_id", "p_limit",
]);
assert.deepEqual(rpc("mark_video_upstream_source_expired")?.arguments, [
  "p_task_id", "p_user_id", "p_http_status",
]);
assert.deepEqual(rpc("purge_expired_user_content")?.arguments, [
  "p_conversation_days", "p_extraction_days", "p_limit",
]);
assert.deepEqual(rpc("hide_digital_human_long_history_item")?.arguments, [
  "p_user_id", "p_parent_id",
]);
assert.deepEqual(rpc("claim_short_drama_script_request_atomic")?.arguments, [
  "p_user_id", "p_client_request_id", "p_request_hash", "p_request_snapshot",
  "p_surface", "p_profile_id", "p_display_title",
]);
assert.deepEqual(rpc("finalize_short_drama_script_request_atomic")?.arguments, [
  "p_user_id", "p_client_request_id", "p_request_hash", "p_state", "p_result_payload",
  "p_result_hash", "p_billing_snapshot", "p_display_title", "p_episode_count",
  "p_error_code", "p_error_message",
]);

assert.deepEqual(rpc("claim_payment_refund_attempt_atomic")?.arguments, [
  "p_attempt_id", "p_trade_order_id", "p_admin_user_id", "p_idempotency_key",
  "p_request_fingerprint", "p_reason", "p_lease_owner", "p_lease_seconds",
]);
assert.deepEqual(rpc("mark_payment_refund_provider_started_atomic")?.arguments, [
  "p_attempt_id", "p_request_fingerprint", "p_lease_owner", "p_lease_token",
]);
assert.deepEqual(rpc("finalize_payment_refund_attempt_atomic")?.arguments, [
  "p_attempt_id", "p_request_fingerprint", "p_lease_owner", "p_lease_token",
  "p_terminal_state", "p_provider_status", "p_provider_trade_order_id",
  "p_provider_refund_id", "p_provider_refund_amount", "p_provider_response",
]);

// Prove these declarations against the real consumers and accepted semantic
// snapshot, rather than maintaining another copy of the authority field list.
const adminAuthorityTables = ["admin_access_profiles", "admin_permission_catalog"] as const;
const adminAccessConsumer = read("src/app/api/admin/access-control/route.ts");
const adminAuthorityConsumer = read("src/lib/server/admin-governance-authority.ts");
const semanticSections = (JSON.parse(read("deploy/policies/database-semantic-contract.v1.json")) as {
  snapshot: { sections: Record<string, { objects: Array<{ key: string }> }> };
}).snapshot.sections;
const semanticTableKeys = new Set(semanticSections.tables.objects.map((entry) => entry.key));
const semanticColumnKeys = new Set(semanticSections.columns.objects.map((entry) => entry.key));
const adminAuthorityColumns = new Map(adminAuthorityTables.map((name) => {
  const select = new RegExp(`\\.from\\("${name}"\\)\\s*\\.select\\("([^"]+)"\\)`, "u")
    .exec(adminAccessConsumer);
  assert.ok(select, `admin authority consumer select missing: ${name}`);
  const columns = select[1].split(",").map((column) => column.trim());
  assert.ok(columns.length > 0 && columns.every((column) => /^[a-z_][a-z0-9_]*$/u.test(column)));
  assert.ok(semanticTableKeys.has(`public|${name}`), `semantic authority table missing: ${name}`);
  for (const column of columns) {
    assert.ok(semanticColumnKeys.has(`public|${name}|${column}`), `semantic authority column missing: ${name}.${column}`);
  }
  return [name, columns] as const;
}));
const adminAuthorityRpcName = "read_admin_access_snapshot";
const adminAuthorityRpcCall = new RegExp(`\\.rpc\\("${adminAuthorityRpcName}",\\s*\\{([\\s\\S]*?)\\}\\)`, "u")
  .exec(adminAuthorityConsumer);
assert.ok(adminAuthorityRpcCall, "admin authority consumer RPC missing");
const adminAuthorityRpcArguments = [...adminAuthorityRpcCall[1].matchAll(/\b(p_[a-z0-9_]+)\s*:/gu)]
  .map((match) => match[1]);
assert.ok(adminAuthorityRpcArguments.length > 0);
const semanticAuthorityRpc = semanticSections.functions.objects
  .find((entry) => entry.key.startsWith(`public|${adminAuthorityRpcName}|`));
assert.ok(semanticAuthorityRpc, "semantic authority RPC missing");
assert.deepEqual(
  semanticAuthorityRpc.key.split("|")[2].split(",").map((argument) => argument.trim().split(/\s+/u)[0]),
  adminAuthorityRpcArguments,
  "admin authority consumer and semantic RPC arguments differ",
);
function assertAdminAuthorityContractCoverage(candidate: Pick<typeof contract, "tables" | "rpcs">) {
  for (const [name, columns] of adminAuthorityColumns) {
    const declared = candidate.tables.find((entry) => entry.name === name);
    assert.ok(declared, `REST contract missing authority table ${name}`);
    for (const column of columns) {
      assert.ok(declared.columns.includes(column), `REST contract missing authority column ${name}.${column}`);
    }
  }
  const declaredRpc = candidate.rpcs.find((entry) => entry.name === adminAuthorityRpcName);
  assert.ok(declaredRpc, `REST contract missing authority RPC ${adminAuthorityRpcName}`);
  assert.deepEqual(declaredRpc.arguments, adminAuthorityRpcArguments, "REST contract missing authority RPC argument");
}
assertAdminAuthorityContractCoverage(contract);
const legacyAuthorityOmission = structuredClone(contract);
legacyAuthorityOmission.tables = legacyAuthorityOmission.tables
  .filter((entry) => !adminAuthorityTables.some((name) => name === entry.name));
legacyAuthorityOmission.rpcs = legacyAuthorityOmission.rpcs.filter((entry) => entry.name !== adminAuthorityRpcName);
assert.throws(() => assertAdminAuthorityContractCoverage(legacyAuthorityOmission), /REST contract missing authority table/u);
for (const [name, columns] of adminAuthorityColumns) {
  const omittedTable = structuredClone(contract);
  omittedTable.tables = omittedTable.tables.filter((entry) => entry.name !== name);
  assert.throws(() => assertAdminAuthorityContractCoverage(omittedTable), /REST contract missing authority table/u);
  for (const column of columns) {
    const omittedColumn = structuredClone(contract);
    const declaration = omittedColumn.tables.find((entry) => entry.name === name)!;
    declaration.columns = declaration.columns.filter((entry) => entry !== column);
    assert.throws(() => assertAdminAuthorityContractCoverage(omittedColumn), /REST contract missing authority column/u);
  }
}
const omittedAuthorityRpc = structuredClone(contract);
omittedAuthorityRpc.rpcs = omittedAuthorityRpc.rpcs.filter((entry) => entry.name !== adminAuthorityRpcName);
assert.throws(() => assertAdminAuthorityContractCoverage(omittedAuthorityRpc), /REST contract missing authority RPC/u);
const omittedAuthorityArgument = structuredClone(contract);
omittedAuthorityArgument.rpcs.find((entry) => entry.name === adminAuthorityRpcName)!.arguments = [];
assert.throws(() => assertAdminAuthorityContractCoverage(omittedAuthorityArgument), /REST contract missing authority RPC argument/u);

const openApiFixture = {
  paths: Object.fromEntries([
    ...PRODUCTION_DATABASE_CONTRACT.tables.map((entry) => [`/${entry.name}`, { get: {} }]),
    ...PRODUCTION_DATABASE_CONTRACT.rpcs.map((entry) => [
      `/rpc/${entry.name}`,
      { post: { requestBody: { schema: { properties: Object.fromEntries(entry.arguments.map((argument) => [argument, {}])) } } } },
    ]),
  ]),
  definitions: Object.fromEntries(PRODUCTION_DATABASE_CONTRACT.tables.map((entry) => [
    entry.name,
    { properties: Object.fromEntries(entry.columns.map((column) => [column, {}])) },
  ])),
};
assert.equal(validateProductionDatabaseOpenApi(openApiFixture).ok, true);
for (const [name, args] of Object.entries(pendingCredentialRpcArguments)) {
  const missingRpc = structuredClone(openApiFixture); delete missingRpc.paths[`/rpc/${name}`];
  assert.ok(validateProductionDatabaseOpenApi(missingRpc).missingRpcs.includes(name));
  for (const argument of args) {
    const missingArgument = structuredClone(openApiFixture); delete missingArgument.paths[`/rpc/${name}`].post.requestBody.schema.properties[argument];
    assert.ok(validateProductionDatabaseOpenApi(missingArgument).missingRpcArguments.includes(`${name}.${argument}`));
  }
}
const exposedLegacyPublisher = structuredClone(openApiFixture);
exposedLegacyPublisher.paths["/rpc/publish_platform_configuration_release_before_pending_credentials"] = { post: { requestBody: { schema: { properties: {} } } } };
assert.ok(validateProductionDatabaseOpenApi(exposedLegacyPublisher).forbiddenRpcsPresent.includes("publish_platform_configuration_release_before_pending_credentials"), "legacy internal publisher must not be REST-executable");
// PostgreSQL truncates identifiers to 63 bytes. The actual catalog/RPC path is
// shorter than the historical spelling above; neither HTTP method may expose it.
const actualLegacyPublisherName = "publish_platform_configuration_release_before_pending_credentia";
assert.equal(Buffer.byteLength(actualLegacyPublisherName, "utf8"), 63);
for (const method of ["get", "post"] as const) {
  const exposedActualPublisher = structuredClone(openApiFixture);
  exposedActualPublisher.paths[`/rpc/${actualLegacyPublisherName}`] = { [method]: {} };
  const result = validateProductionDatabaseOpenApi(exposedActualPublisher);
  assert.equal(result.ok, false, `actual private publisher ${method.toUpperCase()} must fail readiness`);
  assert.ok(result.forbiddenRpcsPresent.includes(actualLegacyPublisherName), "actual PostgreSQL-truncated publisher name must be forbidden");
}

const preflightReferenceTables = new Map((JSON.parse(read("scripts/contracts/production-preflight-reference.v1.json")) as {
  tables: Array<{ name: string; select: string[] }>;
}).tables.map((entry) => [entry.name, entry]));
// Deployment preflight also validates the independent read-only reference
// projection, so the complete fixture includes that contract's fields too.
for (const [name, reference] of preflightReferenceTables) {
  const schema = openApiFixture.definitions[name];
  assert.ok(schema, `preflight reference table missing from fixture: ${name}`);
  for (const field of reference.select) schema.properties[field] = {};
}
assert.equal(validateProductionDatabaseOpenApi(openApiFixture).ok, true);
assert.doesNotThrow(() => validatePreflightOpenApi(openApiFixture, contract, preflightReferenceTables));
function assertAdminAuthorityOpenApiRejected(
  document: typeof openApiFixture,
  missingKind: "missingTables" | "missingColumns" | "missingRpcs" | "missingRpcArguments",
  missingName: string,
  preflightCode: string,
) {
  const runtime = validateProductionDatabaseOpenApi(document);
  assert.equal(runtime.ok, false, `runtime must reject ${missingName}`);
  assert.ok(runtime[missingKind].includes(missingName), `runtime must identify ${missingName}`);
  assert.throws(
    () => validatePreflightOpenApi(document, contract, preflightReferenceTables),
    { code: preflightCode },
    `deployment preflight must reject ${missingName}`,
  );
}
for (const [name, columns] of adminAuthorityColumns) {
  const missingTable = structuredClone(openApiFixture);
  delete missingTable.paths[`/${name}`];
  assertAdminAuthorityOpenApiRejected(missingTable, "missingTables", name, "OPENAPI_REQUIRED_TABLE_MISSING");
  const missingSchema = structuredClone(openApiFixture);
  delete missingSchema.definitions[name];
  assertAdminAuthorityOpenApiRejected(missingSchema, "missingColumns", `${name}.*`, "OPENAPI_TABLE_SCHEMA_MISSING");
  for (const column of columns) {
    const missingColumn = structuredClone(openApiFixture);
    delete missingColumn.definitions[name].properties[column];
    assertAdminAuthorityOpenApiRejected(missingColumn, "missingColumns", `${name}.${column}`, "OPENAPI_REQUIRED_COLUMN_MISSING");
  }
}
const missingAuthorityRpc = structuredClone(openApiFixture);
delete missingAuthorityRpc.paths[`/rpc/${adminAuthorityRpcName}`];
assertAdminAuthorityOpenApiRejected(missingAuthorityRpc, "missingRpcs", adminAuthorityRpcName, "OPENAPI_REQUIRED_RPC_MISSING");
for (const argument of adminAuthorityRpcArguments) {
  const missingArgument = structuredClone(openApiFixture);
  delete missingArgument.paths[`/rpc/${adminAuthorityRpcName}`].post.requestBody.schema.properties[argument];
  assertAdminAuthorityOpenApiRejected(
    missingArgument, "missingRpcArguments", `${adminAuthorityRpcName}.${argument}`, "OPENAPI_REQUIRED_RPC_ARGUMENT_MISSING",
  );
}

// Exercise the existing generator's real comparison with an in-memory stale
// mirror. No source resource, generated file or business data is written.
const embeddedVerifierSource = read("scripts/verify-embedded-runtime-resources.mjs")
  .replace(/^#![^\n]*\n/u, "")
  .replace(/^import [^\n]+;\r?\n/gmu, "");
const embeddedDatabasePath = path.resolve("src/lib/generated/database-contract.ts");
const embeddedDatabaseSource = read(embeddedDatabasePath);
const staleEmbeddedDatabaseSource = embeddedDatabaseSource
  .replace(`"contractVersion": "${contract.contractVersion}"`, '"contractVersion": "20261012014000"');
assert.notEqual(staleEmbeddedDatabaseSource, embeddedDatabaseSource, "stale mirror fixture must differ");
function verifyEmbeddedFixture(databaseSource: string) {
  runInNewContext(embeddedVerifierSource, {
    assert,
    fs: { readFileSync: (file: string) => path.resolve(file) === embeddedDatabasePath ? databaseSource : read(file) },
    path,
    process: { cwd: () => process.cwd(), argv: ["node", "verify-embedded-runtime-resources.mjs", "--database-only"] },
    console: { log: () => undefined },
  });
}
assert.doesNotThrow(() => verifyEmbeddedFixture(embeddedDatabaseSource));
assert.throws(() => verifyEmbeddedFixture(staleEmbeddedDatabaseSource), /is stale; regenerate/u);
for (const name of ["short_drama_script_requests", "digital_human_long_jobs"]) {
  const missing = structuredClone(openApiFixture);
  delete missing.paths[`/${name}`];
  assert.ok(
    validateProductionDatabaseOpenApi(missing).missingTables.includes(name),
    `missing non-Commerce table must block readiness: ${name}`,
  );
}
for (const [tableName, column] of [
  ["extraction_attempts", "request_snapshot"],
  ["extraction_attempts", "content_purged_at"],
  ["video_tasks", "source_expired_at"],
  ["digital_human_long_jobs", "history_hidden_at"],
  ["revenue_records", "profit"],
] as const) {
  const missing = structuredClone(openApiFixture);
  delete missing.definitions[tableName].properties[column];
  assert.ok(
    validateProductionDatabaseOpenApi(missing).missingColumns.includes(`${tableName}.${column}`),
    `missing non-Commerce column must block readiness: ${tableName}.${column}`,
  );
}
for (const name of [
  "checkpoint_extraction_request_atomic",
  "read_extraction_account_history",
  "mark_video_upstream_source_expired",
  "purge_expired_user_content",
  "hide_digital_human_long_history_item",
  "claim_short_drama_script_request_atomic",
  "finalize_short_drama_script_request_atomic",
  "autodl_h3_finalize_video",
  "save_white_label_draft_v2_atomic",
  "register_white_label_asset_atomic",
  "publish_white_label_draft_atomic",
  "read_published_white_label_brand",
  "read_published_white_label_asset",
]) {
  const missing = structuredClone(openApiFixture);
  delete missing.paths[`/rpc/${name}`];
  assert.ok(
    validateProductionDatabaseOpenApi(missing).missingRpcs.includes(name),
    `missing non-Commerce RPC must block readiness: ${name}`,
  );
}
for (const name of ["white_label_profiles", "white_label_profile_events", "white_label_assets", "white_label_release_assets"]) {
  assert.equal(openApiFixture.paths[`/${name}`], undefined, `internal-only white-label table exposed through PostgREST fixture: ${name}`);
}
const withoutH3CostPrice = structuredClone(openApiFixture);
delete withoutH3CostPrice.paths["/rpc/autodl_h3_finalize_video"]
  .post.requestBody.schema.properties.p_cost_price;
assert.ok(
  validateProductionDatabaseOpenApi(withoutH3CostPrice).missingRpcArguments
    .includes("autodl_h3_finalize_video.p_cost_price"),
  "missing H3 cost argument must block readiness",
);
const withoutGeneralScriptFinalizeState = structuredClone(openApiFixture);
delete withoutGeneralScriptFinalizeState.paths["/rpc/finalize_short_drama_script_request_atomic"]
  .post.requestBody.schema.properties.p_state;
assert.ok(
  validateProductionDatabaseOpenApi(withoutGeneralScriptFinalizeState).missingRpcArguments
    .includes("finalize_short_drama_script_request_atomic.p_state"),
  "missing general-script RPC argument must block readiness",
);
const withoutExtractionRpc = structuredClone(openApiFixture);
delete withoutExtractionRpc.paths["/rpc/claim_extraction_attempt_atomic"];
assert.deepEqual(
  validateProductionDatabaseOpenApi(withoutExtractionRpc).missingRpcs,
  ["claim_extraction_attempt_atomic"],
);
const withoutLlmLeaseColumn = structuredClone(openApiFixture);
delete withoutLlmLeaseColumn.definitions.llm_request_attempts.properties.lease_token;
assert.ok(
  validateProductionDatabaseOpenApi(withoutLlmLeaseColumn).missingColumns
    .includes("llm_request_attempts.lease_token"),
);
const withoutLlmClaimRpc = structuredClone(openApiFixture);
delete withoutLlmClaimRpc.paths["/rpc/claim_llm_request_attempt_atomic"];
assert.ok(
  validateProductionDatabaseOpenApi(withoutLlmClaimRpc).missingRpcs
    .includes("claim_llm_request_attempt_atomic"),
);
const withoutVideoProtocolColumn = structuredClone(openApiFixture);
delete withoutVideoProtocolColumn.definitions.video_channel_health.properties.health_protocol_version;
assert.ok(
  validateProductionDatabaseOpenApi(withoutVideoProtocolColumn).missingColumns
    .includes("video_channel_health.health_protocol_version"),
);
const withoutRefundTable = structuredClone(openApiFixture);
delete withoutRefundTable.paths["/payment_refund_attempts"];
assert.ok(
  validateProductionDatabaseOpenApi(withoutRefundTable).missingTables
    .includes("payment_refund_attempts"),
);
const withoutRefundColumn = structuredClone(openApiFixture);
delete withoutRefundColumn.definitions.payment_orders.properties.provider_refund_id;
assert.ok(
  validateProductionDatabaseOpenApi(withoutRefundColumn).missingColumns
    .includes("payment_orders.provider_refund_id"),
);
const withoutRefundRpc = structuredClone(openApiFixture);
delete withoutRefundRpc.paths["/rpc/claim_payment_refund_attempt_atomic"];
assert.ok(
  validateProductionDatabaseOpenApi(withoutRefundRpc).missingRpcs
    .includes("claim_payment_refund_attempt_atomic"),
);
const withoutRefundRpcArgument = structuredClone(openApiFixture);
delete withoutRefundRpcArgument.paths["/rpc/finalize_payment_refund_attempt_atomic"]
  .post.requestBody.schema.properties.p_provider_refund_amount;
assert.ok(
  validateProductionDatabaseOpenApi(withoutRefundRpcArgument).missingRpcArguments
    .includes("finalize_payment_refund_attempt_atomic.p_provider_refund_amount"),
);

const verified = {
  channel_id: "video-model-1",
  is_healthy: true,
  last_success_at: "2026-09-01T12:00:00.000Z",
  health_protocol_version: VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
  verification_state: "verified",
  verified_at: "2026-09-01T12:00:01.000Z",
  verification_evidence: { evidence_id: "evidence-123", task_id: "task-123456" },
};
assert.equal(isReleaseVerifiedVideoChannelHealth(verified), true);
assert.equal(isReleaseVerifiedVideoChannelHealth(null), false);
assert.equal(isReleaseVerifiedVideoChannelHealth({ ...verified, verification_state: "unverified" }), false);
assert.equal(isReleaseVerifiedVideoChannelHealth({ ...verified, health_protocol_version: "legacy" }), false);
assert.equal(isReleaseVerifiedVideoChannelHealth({ ...verified, verification_evidence: {} }), false);
assert.equal(isReleaseVerifiedVideoChannelHealth({ ...verified, verified_at: "2026-09-01T11:59:59.000Z" }), false);

const textChatMigration = read("supabase/migrations/20260825062000_text_chat_controls.sql");
assert.match(textChatMigration, /CREATE TABLE IF NOT EXISTS text_chat_conversation_settings/u);
assert.match(textChatMigration, /CREATE TABLE IF NOT EXISTS text_chat_memories/u);
const extractionMigration = read("supabase/migrations/20260901093000_extraction_attempts_exactly_once.sql");
for (const name of [
  "extraction_attempts",
  "extraction_attempt_reconciliation_audit",
  "claim_extraction_attempt_atomic",
  "finalize_extraction_attempt_atomic",
  "list_extraction_attempts_for_reconciliation",
  "reconcile_extraction_attempt_atomic",
]) assert.ok(extractionMigration.includes(name), `extraction migration missing ${name}`);
const nonCommerceRepairMigrations = [
  ["supabase/migrations/20260915231500_image_generation_failure_history.sql", [
    "request_snapshot", "failure_hidden_at", "claim_image_generation_request_v2",
  ]],
  ["supabase/migrations/20260915233000_digital_human_long_history_visibility.sql", [
    "history_hidden_at", "hide_digital_human_long_history_item",
  ]],
  ["supabase/migrations/20260915233500_extraction_request_snapshot.sql", [
    "request_snapshot", "checkpoint_extraction_request_atomic",
  ]],
  ["supabase/migrations/20260915234500_short_drama_script_history.sql", [
    "short_drama_script_requests", "claim_short_drama_script_request_atomic",
    "finalize_short_drama_script_request_atomic",
  ]],
  ["supabase/migrations/20261009033000_runtime_function_contract_reconcile.sql", [
    "autodl_h3_finalize_video", "profit", "matched_h3_revenue",
  ]],
] as const;
for (const [file, markers] of nonCommerceRepairMigrations) {
  const sql = read(file);
  assert.doesNotMatch(sql, /commerce|shopping|affiliate|带货/iu, `${file} must remain non-Commerce`);
  for (const marker of markers) assert.ok(sql.includes(marker), `${file} missing ${marker}`);
}
const runtimeFunctionSecurityMigration = read("supabase/migrations/20261009034000_runtime_function_security_reconcile.sql");
for (const marker of [
  "DROP FUNCTION IF EXISTS public.publish_commerce_config_release_atomic(uuid, uuid)",
  "publish_commerce_config_release_atomic(uuid, uuid, text, uuid, text)",
  "claim_payment_order_creation_atomic",
  "ingest_external_site_monitor_probe",
  "p.prorettype = 'trigger'::regtype",
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
]) assert.ok(runtimeFunctionSecurityMigration.includes(marker), `runtime function security migration missing ${marker}`);
const userContentRetentionMigration = read("supabase/migrations/20261009043000_user_content_retention_and_video_direct_delivery.sql");
for (const marker of [
  "source_expired_at",
  "content_purged_at",
  "scrub_transient_video_extraction_content",
  "read_extraction_account_history",
  "mark_video_upstream_source_expired",
  "purge_expired_user_content",
  "ARCHIVE_POLICY_RETIRED_DIRECT_DELIVERY",
]) assert.ok(userContentRetentionMigration.includes(marker), `user-content retention migration missing ${marker}`);
assert.doesNotMatch(userContentRetentionMigration, /GRANT EXECUTE ON FUNCTION public\.scrub_transient_video_extraction_content/u);
const imageSnapshotV2Migration = read("supabase/migrations/20261010130000_image_generation_request_snapshot_v2.sql");
for (const marker of [
  "image_generation_request_snapshot.v2",
  "claim_image_generation_request_v2",
  "reconcile_stale_image_generation_request_atomic",
  "payloadFingerprint",
  "set search_path = public, pg_temp",
  "grant execute on function public.claim_image_generation_request_v2",
  "grant execute on function public.reconcile_stale_image_generation_request_atomic",
  "to service_role",
]) assert.ok(imageSnapshotV2Migration.includes(marker), `image snapshot v2 migration missing ${marker}`);
const imageOwnerAlignmentMigration = read("supabase/migrations/20261010131000_image_security_definer_owner_alignment.sql");
for (const marker of [
  "image_generation_requests",
  "claim_image_generation_request_v2",
  "reconcile_stale_image_generation_request_atomic",
  "alter function %s owner to %I",
  "alter function %s security definer",
  "alter function %s set search_path = public, pg_temp",
  "revoke all on function %s from public, anon, authenticated, service_role",
  "grant execute on function %s to service_role",
]) assert.ok(imageOwnerAlignmentMigration.includes(marker), `image RPC owner alignment migration missing ${marker}`);
const videoOwnerAlignmentMigration = read("supabase/migrations/20261010132000_video_snapshot_function_owner_alignment.sql");
for (const marker of [
  "video_tasks",
  "persist_video_generation_request_snapshot_v1_atomic",
  "reserve_video_generation_task_request_snapshot_v1_atomic",
  "reserve_queued_digital_video_task_request_snapshot_v1_atomic",
  "alter function %s owner to %I",
  "alter function %s security definer",
  "alter function %s set search_path = public, pg_temp",
  "revoke all on function %s from public, anon, authenticated, service_role",
  "grant execute on function %s to service_role",
  "v_unexpected_effective_roles",
  "has_function_privilege",
]) assert.ok(videoOwnerAlignmentMigration.includes(marker), `video RPC owner alignment migration missing ${marker}`);
assert.doesNotMatch(videoOwnerAlignmentMigration, /\b(?:insert|update|delete|truncate)\s+(?:into\s+|from\s+)?public\.video_tasks\b/iu,
  "video owner alignment must not rewrite business rows");
const imageProviderReceiptMigration = read("supabase/migrations/20261010133000_image_provider_dispatch_receipts.sql");
for (const marker of [
  "provider_dispatch_receipt",
  "provider_submission_receipt",
  "image_generation_requests_provider_receipt_order",
  "record_image_provider_dispatch_receipt_atomic",
  "record_image_provider_submission_receipt_atomic",
  "reconcile_stale_image_generation_request_without_provider_receipt",
  "provider_evidence_present",
  "requestProjection.referenceCount=",
  "providerAcknowledgementField=",
  "alter function %s owner to %I",
  "set search_path = public, pg_temp",
  "IMAGE_PROVIDER_RECEIPT_EFFECTIVE_EXECUTE_ACL_INVALID",
]) assert.ok(imageProviderReceiptMigration.includes(marker), `image provider receipt migration missing ${marker}`);
assert.match(imageProviderReceiptMigration, /^begin;/u);
assert.match(imageProviderReceiptMigration, /commit;\s*$/u);
const videoProviderProjectionMigration = read("supabase/migrations/20261010134000_video_provider_request_projection.sql");
for (const marker of [
  "record_video_provider_dispatch_receipt_atomic",
  "record_video_provider_submission_receipt_atomic",
  "wireBodySha256",
  "endpointPath",
  "attemptOrdinal",
  "dispatchIdentitySha256",
  "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT",
  "dispatchIdentitySha256s",
  "dispatchAttemptCount",
  "VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_V2_DISPATCH",
  "alter function %s owner to %I",
  "set search_path = public, pg_temp",
  "VIDEO_PROVIDER_RECEIPT_UNEXPECTED_EFFECTIVE_EXECUTE",
]) assert.ok(videoProviderProjectionMigration.includes(marker), `video provider projection migration missing ${marker}`);
assert.match(videoProviderProjectionMigration, /^begin;/u);
assert.match(videoProviderProjectionMigration, /commit;\s*$/u);
const llmMigration = read("supabase/migrations/20260901170000_llm_request_attempts_exactly_once.sql");
for (const name of [
  "llm_request_attempts",
  "llm_request_attempt_events",
  "claim_llm_request_attempt_atomic",
  "mark_llm_request_provider_started_atomic",
  "finalize_llm_request_attempt_atomic",
  "reconcile_llm_request_attempt_atomic",
  "provider_call_started_at",
  "lease_token",
  "reconciliation_required",
]) assert.ok(llmMigration.includes(name), `LLM exactly-once migration missing ${name}`);
const voiceMigration = read("supabase/migrations/20260901153000_voice_training_provider_lifecycle.sql");
for (const name of [
  "provider_call_started_at",
  "provider_last_checked_at",
  "provider_last_status",
  "reconciliation_reason",
  "mark_voice_training_provider_attempt_atomic",
  "release_voice_training_terminal_atomic",
  "finalize_voice_training_ready_atomic",
]) assert.ok(voiceMigration.includes(name), `voice lifecycle migration missing ${name}`);
const manjuStorageMigration = read("supabase/migrations/20260829223000_manju_config_storage_state.sql");
for (const name of [
  "manju_config_storage_state",
  "commit_manju_config_compat_envelope",
  "reconcile_manju_config_storage_to_compat",
  "reconcile_manju_config_storage_to_native",
  "cutover_manju_config_storage",
]) assert.ok(manjuStorageMigration.includes(name), `Manju storage migration missing ${name}`);

const refundMigration = read("supabase/migrations/20260904193000_payment_refund_exactly_once.sql");
for (const name of [
  "payment_refund_attempts",
  "claim_payment_refund_attempt_atomic",
  "mark_payment_refund_provider_started_atomic",
  "finalize_payment_refund_attempt_atomic",
  "payment_refund_one_active_per_order",
  "reconciliation_required",
]) assert.ok(refundMigration.includes(name), `payment refund migration missing ${name}`);
const refundRollback = read("supabase/rollbacks/20260904193000_payment_refund_exactly_once.rollback.sql");
assert.ok(refundRollback.includes("ROLLBACK_BLOCKED_PAYMENT_REFUND_EVIDENCE_EXISTS"));

const platformBrandContactQrRollbackContract = contract.rollbackArtifacts?.find(
  (entry) => entry.forwardMigration === "supabase/migrations/20261009053000_platform_brand_contact_qr.sql",
);
assert.deepEqual(platformBrandContactQrRollbackContract, {
  forwardMigration: "supabase/migrations/20261009053000_platform_brand_contact_qr.sql",
  rollback: "supabase/rollbacks/20261009053000_platform_brand_contact_qr.rollback.sql",
  mode: "guarded-semantic-revert",
  preserves: [
    "platform_brand_profiles",
    "platform_brand_revisions",
    "platform_brand_assets",
    "platform_brand_revision_assets",
    "platform_brand_events",
  ],
  blocksWhen: [
    "platform_brand_revisions.snapshot.contact exists",
    "platform_brand_revisions.snapshot.assetIds references contact_wechat_qr_primary or contact_wechat_qr_secondary",
    "platform_brand_assets contains either contact WeChat QR purpose",
    "platform_brand_revision_assets contains either contact WeChat QR purpose",
  ],
});
const platformBrandContactQrRollback = read(platformBrandContactQrRollbackContract.rollback);
assert.match(platformBrandContactQrRollback, /^BEGIN;/u);
assert.match(platformBrandContactQrRollback, /COMMIT;\s*$/u);
for (const marker of [
  "ROLLBACK_BLOCKED_PLATFORM_BRAND_CONTACT_QR_DATA_EXISTS",
  "ERRCODE = '55000'",
  "snapshot ? 'contact'",
  "snapshot->'assetIds'",
  "contact_wechat_qr_primary",
  "contact_wechat_qr_secondary",
  "platform_brand_assets_purpose_check",
  "platform_brand_revision_assets_purpose_check",
  "save_platform_brand_draft_atomic(bigint,jsonb,text,uuid,text)",
  "register_platform_brand_asset_atomic(text,text,text,text,text,bigint,integer,integer,uuid,text)",
]) assert.ok(platformBrandContactQrRollback.includes(marker), `0530 rollback missing ${marker}`);
for (const preservedTable of platformBrandContactQrRollbackContract.preserves) {
  assert.doesNotMatch(
    platformBrandContactQrRollback,
    new RegExp(`DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+(?:public\\.)?${preservedTable}\\b`, "iu"),
    `0530 rollback must preserve ${preservedTable}`,
  );
}
assert.doesNotMatch(
  platformBrandContactQrRollback,
  /DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?\s+public\.(?:save_platform_brand_draft_atomic|register_platform_brand_asset_atomic)/iu,
  "0530 rollback must restore, not remove, the platform-brand RPCs",
);
const rollbackPurposeList = [
  "logo_square", "logo_horizontal_light", "logo_horizontal_dark",
  "favicon", "social_share", "login_background",
];
for (const purpose of rollbackPurposeList) {
  assert.ok(platformBrandContactQrRollback.includes(`'${purpose}'`), `0530 rollback missing legacy purpose ${purpose}`);
}
const restoredSaveFunction = platformBrandContactQrRollback.match(
  /CREATE OR REPLACE FUNCTION public\.save_platform_brand_draft_atomic[\s\S]*?\nEND;\n\$\$;/u,
)?.[0] || "";
const restoredRegisterFunction = platformBrandContactQrRollback.match(
  /CREATE OR REPLACE FUNCTION public\.register_platform_brand_asset_atomic[\s\S]*?\nEND;\n\$\$;/u,
)?.[0] || "";
assert.ok(restoredSaveFunction, "0530 rollback must restore save_platform_brand_draft_atomic");
assert.ok(restoredRegisterFunction, "0530 rollback must restore register_platform_brand_asset_atomic");
assert.doesNotMatch(restoredSaveFunction, /contact_wechat_qr_(?:primary|secondary)/u);
assert.doesNotMatch(restoredRegisterFunction, /contact_wechat_qr_(?:primary|secondary)/u);

const videoOwnerRollbackContract = contract.rollbackArtifacts?.find(
  (entry) => entry.forwardMigration === "supabase/migrations/20261010132000_video_snapshot_function_owner_alignment.sql",
);
assert.deepEqual(videoOwnerRollbackContract, {
  forwardMigration: "supabase/migrations/20261010132000_video_snapshot_function_owner_alignment.sql",
  rollback: "supabase/rollbacks/20261010132000_video_snapshot_function_owner_alignment.rollback.sql",
  mode: "forward-repair-only",
  preserves: [
    "video_tasks",
    "persist_video_generation_request_snapshot_v1_atomic",
    "reserve_video_generation_task_request_snapshot_v1_atomic",
    "reserve_queued_digital_video_task_request_snapshot_v1_atomic",
    "supabase_migrations.schema_migrations:20261010132000",
  ],
  blocksWhen: [
    "function owner differs from public.video_tasks owner",
    "SECURITY DEFINER or search_path differs from the release contract",
    "direct or effective EXECUTE is available to a non-owner role other than service_role",
  ],
});
const videoOwnerRollback = read(videoOwnerRollbackContract.rollback);
assert.match(videoOwnerRollback, /^begin;/u);
assert.match(videoOwnerRollback, /commit;\s*$/u);
for (const marker of [
  "Forward-repair-only rollback guard",
  "VIDEO_SNAPSHOT_SECURITY_DEFINER_OWNER_ALIGNMENT_REQUIRED",
  "VIDEO_SNAPSHOT_EXECUTE_ACL_REQUIRED",
  "VIDEO_SNAPSHOT_UNEXPECTED_EFFECTIVE_EXECUTE",
  "has_function_privilege",
]) assert.ok(videoOwnerRollback.includes(marker), `1320 rollback missing ${marker}`);
assert.doesNotMatch(videoOwnerRollback, /\b(?:alter|drop|create|grant|revoke|insert|update|delete|truncate)\b/iu,
  "1320 rollback must only verify and retain the forward security repair");
assert.doesNotMatch(videoOwnerRollback, /delete\s+from\s+supabase_migrations\.schema_migrations/iu,
  "1320 rollback must retain the migration ledger");

const imageProviderRollbackContract = contract.rollbackArtifacts?.find(
  (entry) => entry.forwardMigration === "supabase/migrations/20261010133000_image_provider_dispatch_receipts.sql",
);
assert.deepEqual(imageProviderRollbackContract, {
  forwardMigration: "supabase/migrations/20261010133000_image_provider_dispatch_receipts.sql",
  rollback: "supabase/rollbacks/20261010133000_image_provider_dispatch_receipts.rollback.sql",
  rollbackSha256: "14195658c6a43ac836a8617effb6eccb75fdca1cb0880e01fd61e6aaf45669ea",
  mode: "forward-repair-only",
  preserves: [
    "image_generation_requests.provider_dispatch_receipt",
    "image_generation_requests.provider_submission_receipt",
    "record_image_provider_dispatch_receipt_atomic",
    "record_image_provider_submission_receipt_atomic",
    "reconcile_stale_image_generation_request_atomic",
    "supabase_migrations.schema_migrations:20261010133000",
  ],
  blocksWhen: [
    "provider receipt columns or receipt-order constraint are absent",
    "receipt-aware stale reconciliation semantics are absent",
    "function owner, SECURITY DEFINER or search_path differs from the release contract",
    "direct or effective EXECUTE differs from the service-role-only and owner-only helper contract",
  ],
});
const imageProviderRollback = read(imageProviderRollbackContract.rollback);
assert.equal(sha256(imageProviderRollback), imageProviderRollbackContract.rollbackSha256,
  "1330 rollback source hash changed");
assert.match(imageProviderRollback, /^begin;/u);
assert.match(imageProviderRollback, /commit;\s*$/u);
for (const marker of [
  "IMAGE_PROVIDER_RECEIPT_FORWARD_REPAIR_REQUIRED",
  "IMAGE_PROVIDER_RECEIPT_SECURITY_ALIGNMENT_REQUIRED",
  "IMAGE_PROVIDER_RECEIPT_HELPER_ISOLATION_REQUIRED",
  "provider_evidence_present",
  "requestProjection.referenceCount=",
  "providerAcknowledgementField=",
  "has_function_privilege",
]) assert.ok(imageProviderRollback.includes(marker), `1330 rollback missing ${marker}`);
assert.doesNotMatch(imageProviderRollback, /\b(?:drop\s+(?:column|function|table)|delete\s+from|truncate\s+|insert\s+into|update\s+public\.)/iu,
  "1330 rollback must preserve provider receipt evidence and ledger history");
assert.doesNotMatch(imageProviderRollback, /delete\s+from\s+supabase_migrations\.schema_migrations/iu,
  "1330 rollback must retain the migration ledger");

const videoProviderRollbackContract = contract.rollbackArtifacts?.find(
  (entry) => entry.forwardMigration === "supabase/migrations/20261010134000_video_provider_request_projection.sql",
);
assert.deepEqual(videoProviderRollbackContract, {
  forwardMigration: "supabase/migrations/20261010134000_video_provider_request_projection.sql",
  rollback: "supabase/rollbacks/20261010134000_video_provider_request_projection.rollback.sql",
  rollbackSha256: "87cf610bc8d089f0f88ea7704d1ac90d6f6d00ca32a9a383ad672dde067ce3b0",
  mode: "forward-repair-only",
  preserves: [
    "video_tasks.provider_dispatch_receipt",
    "video_tasks.provider_submission_receipt",
    "record_video_provider_dispatch_receipt_atomic",
    "record_video_provider_submission_receipt_atomic",
    "supabase_migrations.schema_migrations:20261010134000",
  ],
  blocksWhen: [
    "ordered dispatch identity or duplicate wire-body conflict semantics are absent",
    "submission receipt is not bound to V2 dispatch hashes, identities and attempt count",
    "function owner, SECURITY DEFINER or search_path differs from the release contract",
    "direct or effective EXECUTE is available to a non-owner role other than service_role",
  ],
});
const videoProviderRollback = read(videoProviderRollbackContract.rollback);
assert.equal(sha256(videoProviderRollback), videoProviderRollbackContract.rollbackSha256,
  "1340 rollback source hash changed");
assert.match(videoProviderRollback, /^begin;/u);
assert.match(videoProviderRollback, /commit;\s*$/u);
for (const marker of [
  "VIDEO_PROVIDER_PROJECTION_FORWARD_REPAIR_REQUIRED",
  "VIDEO_PROVIDER_PROJECTION_SECURITY_REPAIR_REQUIRED",
  "VIDEO_PROVIDER_PROJECTION_ACL_REPAIR_REQUIRED",
  "VIDEO_PROVIDER_PROJECTION_SEMANTIC_REPAIR_REQUIRED",
  "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT",
  "dispatchIdentitySha256s",
  "dispatchAttemptCount",
  "has_function_privilege",
]) assert.ok(videoProviderRollback.includes(marker), `1340 rollback missing ${marker}`);
assert.doesNotMatch(videoProviderRollback, /\b(?:drop\s+(?:column|function|table)|delete\s+from|truncate\s+|insert\s+into|update\s+public\.)/iu,
  "1340 rollback must preserve provider request evidence and ledger history");
assert.doesNotMatch(videoProviderRollback, /delete\s+from\s+supabase_migrations\.schema_migrations/iu,
  "1340 rollback must retain the migration ledger");

const migration = read("supabase/migrations/20260901160000_video_channel_health_release_protocol.sql");
assert.match(migration, /verification_state = 'unverified'/u);
assert.match(migration, /'active_model_backfill_requires_canary'/u);
assert.match(migration, /false,\s*'video-channel-health\.v2',\s*'unverified'/u);
assert.doesNotMatch(migration, /SET\s+is_healthy\s*=\s*true/iu);
assert.doesNotMatch(migration, /verification_state\s*=\s*'verified'/iu);
assert.match(migration, /VIDEO_CHANNEL_HEALTH_DUPLICATE_CHANNEL_ID/u);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS video_channel_health_channel_unique/u);

const referenceGate = read("src/lib/production-reference-data-readiness.ts");
for (const marker of [
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
  ".from(\"video_models\")",
  ".from(\"video_channel_health\")",
  ".from(\"manju_config_storage_state\")",
  "isReleaseVerifiedVideoChannelHealth",
  "videoModelVerificationReady",
  "unverifiedVideoModelIds",
]) assert.ok(referenceGate.includes(marker), `reference-data gate missing ${marker}`);
assert.doesNotMatch(referenceGate, /const ok =[\s\S]{0,320}unverifiedVideoModelIds\.length === 0/u,
  "per-model paid acceptance must not block an unrelated whole-site release");
assert.doesNotMatch(referenceGate, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/u);
const schemaGate = read("src/lib/production-database-readiness.ts");
assert.match(schemaGate, /requiredProbeRole !== "service_role"/u);
assert.match(schemaGate, /COZE_SUPABASE_SERVICE_ROLE_KEY/u);

const releaseGate = read("src/app/api/release-readiness/route.ts");
for (const marker of [
  "serviceRoleConfigured",
  "missingManjuStorageDomainCount",
  "videoHealthProtocolVersion",
  "videoModelVerificationReady",
  "unverifiedVideoModelCount",
]) assert.ok(releaseGate.includes(marker), `release readiness output missing ${marker}`);

const runner = read("scripts/db-migration-release.mjs");
for (const marker of [
  "APPLIED_MIGRATION_HASH_DRIFT",
  "appliedMigrationHashDrifts",
  "ONLY_SELECTOR_NOT_FOUND",
  "dependencyClosureAdded",
  "already-applied-hash-verified",
]) assert.ok(runner.includes(marker), `migration runner gate missing ${marker}`);
const policy = JSON.parse(read("deploy/policies/release-policy.json")) as {
  database?: {
    excludedForwardMigrations?: string[];
    criticalMigrationOrder?: string[];
    migrationDatabaseUrlEnv?: string[];
    liveCatalogVerification?: {
      command?: string;
      mode?: string;
      requiredAfter?: string;
      requiredBefore?: string;
      requires?: string[];
    };
    releaseGateSequence?: string[];
    rollbackStrategies?: Record<string, { mode?: string; rollback?: string }>;
    nonCommerceRepairPack?: {
      planTool?: string;
      verification?: string;
      executionMode?: string;
      legacyOnlySelectorAllowed?: boolean;
      migrationCount?: number;
      objectCount?: number;
      migrations?: string[];
    };
  };
};
assert.ok(policy.database?.excludedForwardMigrations?.includes("20260822032000_aid_integration_bridge.sql"));
assert.deepEqual(policy.database?.criticalMigrationOrder?.slice(-18), [
  "20260915231500_image_generation_failure_history.sql",
  "20260915233000_digital_human_long_history_visibility.sql",
  "20260915233500_extraction_request_snapshot.sql",
  "20260915234500_short_drama_script_history.sql",
  "20261009033000_runtime_function_contract_reconcile.sql",
  "20261009034000_runtime_function_security_reconcile.sql",
  "20261009040000_video_history_archive_queue.sql",
  "20261009043000_user_content_retention_and_video_direct_delivery.sql",
  "20261010023000_video_generation_request_snapshot_v1.sql",
  "20261010130000_image_generation_request_snapshot_v2.sql",
  "20261010131000_image_security_definer_owner_alignment.sql",
  "20261010132000_video_snapshot_function_owner_alignment.sql",
  "20261010133000_image_provider_dispatch_receipts.sql",
  "20261010134000_video_provider_request_projection.sql",
  "20261012010000_image_provider_delivery.sql",
  "20261012011000_h3_provider_delivery.sql",
  "20261012012000_image_ephemeral_delivery.sql",
  "20261012013000_image_model_validation_receipt_publication.sql",
]);
assert.deepEqual(policy.database?.liveCatalogVerification, {
  command: "node scripts/run-node-maintenance-tsx.mjs ./scripts/verify-release-database-gates.ts --live --confirm-target-host=<database-host> --confirm-target-database=<database-name>",
  mode: "read-only-postgresql-catalog",
  requiredAfter: "migration-status-post-apply",
  requiredBefore: "candidate-activation",
  requires: [
    "exact target host confirmation",
    "exact target database name confirmation",
    "20261010023000, 20261010130000, 20261010131000, 20261010132000, 20261010133000 and 20261010134000 ledger rows with current source SHA-256",
    "image provider dispatch/submission receipt jsonb columns and validated receipt-order constraint",
    "image claim/reconcile/provider receipt RPC owners equal to image_generation_requests owner",
    "image legacy stale-reconciliation helper owner equal to image_generation_requests owner with owner-only EXECUTE",
    "video request snapshot and provider receipt RPC owners equal to video_tasks owner",
    "1330 receipt-aware reconciliation, receipt digest and acknowledgement binding semantics",
    "1340 ordered dispatch identity, duplicate wire-body conflict and V2 submission binding semantics",
    "SECURITY DEFINER with search_path=public, pg_temp",
    "service_role as the only non-owner direct EXECUTE grantee",
    "no ordinary role other than owner/service_role has effective EXECUTE",
    "20261012010000, 20261012011000 and 20261012012000 ledger rows with current source SHA-256",
    "provider delivery RPC owners and exact definer/invoker flags, service-only effective execution",
    "validated H3 provider URL constraints and immutable strict invoker predicate canonical body SHA-256",
  ],
});
assert.deepEqual(policy.database?.releaseGateSequence, [
  "migration-plan",
  "migration-status-pre-apply",
  "recoverable-backup-confirmed",
  "explicit-apply-authorization",
  "migration-apply",
  "migration-status-post-apply",
  "live-catalog-verification",
  "candidate-activation",
]);
for (const feature of [
  "image", "extraction", "digitalHuman", "generalScript", "h3Revenue", "videoHistoryArchive",
  "userContentRetention", "videoSnapshotSecurity", "imageProviderReceipts", "videoProviderRequestProjection",
]) {
  assert.equal(policy.database?.rollbackStrategies?.[feature]?.mode, "forward-repair-only-after-activation");
}
assert.equal(
  policy.database?.rollbackStrategies?.imageProviderReceipts?.rollback,
  "supabase/rollbacks/20261010133000_image_provider_dispatch_receipts.rollback.sql",
);
assert.equal(
  policy.database?.rollbackStrategies?.videoProviderRequestProjection?.rollback,
  "supabase/rollbacks/20261010134000_video_provider_request_projection.rollback.sql",
);
assert.deepEqual(policy.database?.nonCommerceRepairPack, {
  planTool: "scripts/prepare-noncommerce-migration-pack.mjs",
  verification: "scripts/verify-noncommerce-migration-pack.ts",
  executionMode: "isolated-migration-root-with-existing-runner",
  legacyOnlySelectorAllowed: false,
  migrationCount: 5,
  objectCount: 11,
  migrations: [
    "20260915231500_image_generation_failure_history.sql",
    "20260915233000_digital_human_long_history_visibility.sql",
    "20260915233500_extraction_request_snapshot.sql",
    "20260915234500_short_drama_script_history.sql",
    "20261009033000_runtime_function_contract_reconcile.sql",
  ],
  requires: [
    "exact target host",
    "runner plan manifest SHA-256",
    "recoverable pre-migration backup receipt",
    "explicit apply authorization",
  ],
});

type LiveMigrationLedgerRow = {
  version: string;
  name: string;
  hash: string;
};

type LiveFunctionSecurity = {
  signature: string;
  owner: string;
  securityDefiner: boolean;
  searchPath: string[];
  definition: string;
  sourceSha256?: string;
  argumentNames: string[];
  executeGrantees: string[];
  unexpectedEffectiveGrantees: string[];
  privileges: {
    anonExecute: boolean;
    authenticatedExecute: boolean;
    serviceExecute: boolean;
  };
};

type LiveFunctionSecurityGroup = {
  id: string;
  ownerRelation: string;
  tableOwner: string;
  functions: LiveFunctionSecurity[];
};

type LiveFunctionDependencyEdge = {
  caller: string;
  callee: string;
  ownerRelation: string;
  callerExists: boolean;
  calleeExists: boolean;
  callerOwner: string;
  calleeOwner: string;
  relationOwner: string;
  callerSecurityDefiner: boolean;
  calleeSecurityDefiner: boolean;
  calleeSearchPath: string[];
  callerExecute: boolean;
  callerSchemaUsage: boolean;
  serviceExecute: boolean;
};

type LiveRelationSemantics = {
  relation: string;
  owner: string;
  requiredOwner: string;
  rlsEnabled: boolean;
  forbiddenPrivilegePrincipals: string[];
  columns: Array<{ name: string; type: string }>;
  constraints: Array<{ name: string; validated: boolean; definition: string }>;
};

type LiveTriggerSemantics = {
  relation: string;
  name: string;
  function: string;
  enabled: boolean;
};

type H3PredicateProjection = { signature: string; owner: string; tableOwner: string; securityDefiner: boolean; volatility: string; strict: boolean; searchPath: string[]; publicExecute: boolean; source: string };
type LiveCatalogProjection = {
  h3ProviderUrlPredicate: H3PredicateProjection;
  identity: {
    database: string;
    currentUser: string;
    serverAddress: string | null;
    serverPort: number | null;
  };
  ledger: LiveMigrationLedgerRow[];
  relationSemantics: LiveRelationSemantics[];
  triggerSemantics: LiveTriggerSemantics[];
  functionSecurityGroups: LiveFunctionSecurityGroup[];
  functionDependencyEdges: LiveFunctionDependencyEdge[];
};

assert.deepEqual(liveCatalogChecks.h3ProviderUrlPredicate, {
  "signature": "public.autodl_h3_provider_delivery_url_valid(text,text)",
  "ownerRelation": "public.video_tasks",
  "securityDefinerRequired": false,
  "volatility": "i",
  "strict": true,
  "searchPath": [
    "public",
    "pg_temp"
  ],
  "requiredExecuteGrantee": "PUBLIC",
  "sourceSha256": "6a82bd7745258d692bd2cf560c811237e20b6ab52c54231281dd675d201d52ca",
  "sourceMigration": "supabase/migrations/20261012011000_h3_provider_delivery.sql"
});
const canonicalPredicateBody = read(liveCatalogChecks.h3ProviderUrlPredicate.sourceMigration).match(/AS \$valid\$([\s\S]*?)\$valid\$/u)?.[1].replace(/\r\n/gu,"\n").trim();
assert.ok(canonicalPredicateBody,"canonical predicate body missing");
assert.equal(sha256(canonicalPredicateBody),liveCatalogChecks.h3ProviderUrlPredicate.sourceSha256);
assert.equal(liveCatalogChecks.migrationLedger.requiredMigrations.find(e=>e.version==="20261012010000")?.sha256,"21396c606c383ffe74685d4970296b4fb00434c252745a7f3f22578fc6ace2d8");
assert.equal(liveCatalogChecks.migrationLedger.requiredMigrations.find(e=>e.version==="20261012011000")?.sha256,"f64ba0095efc497fa468998a48f3ea225a440aa1a2c547b214e596ab191a03bc");
assert.equal(liveCatalogChecks.migrationLedger.requiredMigrations.find(e=>e.version==="20261012012000")?.sha256,"85f1ded41a617e67d61741082938fdeeb0074b520724795d9cd8124ebbf09593");
for(const forwardMigration of [
  "supabase/migrations/20261012010000_image_provider_delivery.sql",
  "supabase/migrations/20261012011000_h3_provider_delivery.sql",
  "supabase/migrations/20261012012000_image_ephemeral_delivery.sql"
]) {
  const artifact=contract.rollbackArtifacts?.find(e=>e.forwardMigration===forwardMigration);
  assert.equal(artifact?.mode,"forward-repair-only-after-activation");
  assert.equal(artifact?.rollback,undefined,"forward repair policy must not invent inverse SQL");
  assert.ok(artifact?.preserves.includes("wallet_operations") && artifact.preserves.includes("video_tasks"));
}
for(const feature of [
  "imageProviderDelivery",
  "h3ProviderDelivery",
  "imageEphemeralDelivery", "imageReceiptPublication"
]) assert.equal(policy.database?.rollbackStrategies?.[feature]?.mode,"forward-repair-only-after-activation");
const sortedUnique = (values: string[]) => [...new Set(values)].sort();

function liveCatalogFailures(live: LiveCatalogProjection) {
  const failures: string[] = [];
  for (const expected of liveCatalogChecks.migrationLedger.requiredMigrations) {
    const actual = live.ledger.find((row) => row.version === expected.version);
    if (!actual) {
      failures.push(`MIGRATION_LEDGER_ROW_MISSING:${expected.version}`);
    } else if (actual.hash.toLowerCase() !== expected.sha256) {
      failures.push(`MIGRATION_LEDGER_HASH_MISMATCH:${expected.version}`);
    }
  }
  for (const expectedRelation of liveCatalogChecks.relationSemantics) {
    const actualRelation = live.relationSemantics.find((entry) => entry.relation === expectedRelation.relation);
    if (!actualRelation) {
      failures.push(`RELATION_SEMANTICS_MISSING:${expectedRelation.relation}`);
      continue;
    }
    for (const expectedColumn of expectedRelation.requiredColumns) {
      const actualColumn = actualRelation.columns.find((entry) => entry.name === expectedColumn.name);
      if (!actualColumn) failures.push(`RELATION_COLUMN_MISSING:${expectedRelation.relation}:${expectedColumn.name}`);
      else if (actualColumn.type !== expectedColumn.type) {
        failures.push(`RELATION_COLUMN_TYPE_MISMATCH:${expectedRelation.relation}:${expectedColumn.name}`);
      }
    }
    if (expectedRelation.requiredOwnerRelation && actualRelation.owner !== actualRelation.requiredOwner) {
      failures.push(`RELATION_OWNER_MISMATCH:${expectedRelation.relation}:${expectedRelation.requiredOwnerRelation}`);
    }
    if (expectedRelation.rlsRequired && !actualRelation.rlsEnabled) {
      failures.push(`RELATION_RLS_REQUIRED:${expectedRelation.relation}`);
    }
    if (actualRelation.forbiddenPrivilegePrincipals.length > 0) {
      failures.push(`RELATION_FORBIDDEN_PRIVILEGE:${expectedRelation.relation}:${actualRelation.forbiddenPrivilegePrincipals.join("|")}`);
    }
    for (const expectedConstraint of expectedRelation.requiredConstraints) {
      const actualConstraint = actualRelation.constraints.find((entry) => entry.name === expectedConstraint.name);
      if (!actualConstraint) {
        failures.push(`RELATION_CONSTRAINT_MISSING:${expectedRelation.relation}:${expectedConstraint.name}`);
        continue;
      }
      if (actualConstraint.validated !== expectedConstraint.validated) {
        failures.push(`RELATION_CONSTRAINT_VALIDATION_MISMATCH:${expectedRelation.relation}:${expectedConstraint.name}`);
      }
      for (const token of expectedConstraint.definitionTokens) {
        if (!actualConstraint.definition.toLowerCase().includes(token.toLowerCase())) {
          failures.push(`RELATION_CONSTRAINT_TOKEN_MISSING:${expectedRelation.relation}:${expectedConstraint.name}:${token}`);
        }
      }
    }
  }
  for (const expectedTrigger of liveCatalogChecks.triggerSemantics) {
    const actualTrigger = live.triggerSemantics.find((entry) =>
      entry.relation === expectedTrigger.relation && entry.name === expectedTrigger.name);
    if (!actualTrigger) {
      failures.push(`TRIGGER_MISSING:${expectedTrigger.relation}:${expectedTrigger.name}`);
    } else if (actualTrigger.function !== expectedTrigger.function) {
      failures.push(`TRIGGER_FUNCTION_MISMATCH:${expectedTrigger.relation}:${expectedTrigger.name}`);
    } else if (actualTrigger.enabled !== expectedTrigger.enabled) {
      failures.push(`TRIGGER_ENABLED_MISMATCH:${expectedTrigger.relation}:${expectedTrigger.name}`);
    }
  }
  for (const expectedGroup of liveCatalogChecks.functionSecurityGroups) {
    const actualGroup = live.functionSecurityGroups.find((entry) => entry.id === expectedGroup.id);
    if (!actualGroup?.tableOwner) {
      failures.push(`FUNCTION_OWNER_RELATION_MISSING:${expectedGroup.id}:${expectedGroup.ownerRelation}`);
      continue;
    }
    if (actualGroup.ownerRelation !== expectedGroup.ownerRelation) {
      failures.push(`FUNCTION_OWNER_RELATION_MISMATCH:${expectedGroup.id}`);
    }
    const expectedSearchPath = `search_path=${expectedGroup.searchPath.join(", ")}`;
    for (const signature of expectedGroup.functions) {
      const actual = actualGroup.functions.find((entry) => entry.signature === signature);
      if (!actual) {
        failures.push(`FUNCTION_MISSING:${signature}`);
        continue;
      }
      if (expectedGroup.ownerMustMatchRelationOwner) {
        if (actual.owner !== actualGroup.tableOwner) failures.push(`FUNCTION_OWNER_MISMATCH:${signature}`);
      } else if (!expectedGroup.requiredOwnerRole || actual.owner !== expectedGroup.requiredOwnerRole) {
        failures.push(`FUNCTION_OWNER_MISMATCH:${signature}`);
      }
      const requiredSourceHash = expectedGroup.requiredSourceSha256?.[signature];
      if (requiredSourceHash) {
        if (!actual.sourceSha256) failures.push(`FUNCTION_SOURCE_MISSING:${signature}`);
        else if (actual.sourceSha256 !== requiredSourceHash) failures.push(`FUNCTION_SOURCE_HASH_MISMATCH:${signature}`);
      }
      if (actual.securityDefiner !== expectedGroup.securityDefinerRequired) failures.push(`FUNCTION_SECURITY_DEFINER_REQUIRED:${signature}`);
      const expectedSettings = [expectedSearchPath, ...(expectedGroup.additionalSettings || [])];
      if (JSON.stringify(actual.searchPath) !== JSON.stringify(expectedSettings)) {
        failures.push(`FUNCTION_SEARCH_PATH_MISMATCH:${signature}`);
      }
      for (const token of expectedGroup.requiredDefinitionTokens?.[signature] || []) {
        if (!actual.definition.includes(token)) failures.push(`FUNCTION_SEMANTIC_TOKEN_MISSING:${signature}:${token}`);
      }
      const functionName = signature.match(/^public\.([^()]+)\(/u)?.[1] || "";
      const expectedArguments = rpc(functionName)?.arguments;
      if (expectedArguments && JSON.stringify(actual.argumentNames) !== JSON.stringify(expectedArguments)) {
        failures.push(`FUNCTION_ARGUMENT_NAMES_MISMATCH:${signature}`);
      }
      const nonOwnerGrantees = sortedUnique(actual.executeGrantees.filter((name) => name !== actual.owner));
      if (JSON.stringify(nonOwnerGrantees) !== JSON.stringify(expectedGroup.requiredNonOwnerExecuteGrantees)) {
        failures.push(`FUNCTION_EXECUTE_ACL_MISMATCH:${signature}`);
      }
      const serviceRoleRequired = expectedGroup.requiredNonOwnerExecuteGrantees.includes("service_role");
      if (actual.executeGrantees.includes("PUBLIC") || actual.privileges.anonExecute || actual.privileges.authenticatedExecute
        || (!serviceRoleRequired && actual.privileges.serviceExecute)) {
        failures.push(`FUNCTION_FORBIDDEN_EXECUTE_PRIVILEGE:${signature}`);
      }
      if (actual.unexpectedEffectiveGrantees.length > 0) {
        failures.push(`FUNCTION_UNEXPECTED_EFFECTIVE_EXECUTE:${signature}:${actual.unexpectedEffectiveGrantees.join("|")}`);
      }
      if (serviceRoleRequired && !actual.privileges.serviceExecute) {
        failures.push(`FUNCTION_SERVICE_ROLE_EXECUTE_REQUIRED:${signature}`);
      }
    }
  }
  for (const expected of liveCatalogChecks.functionDependencyEdges) {
    const key = `${expected.caller}->${expected.callee}`;
    const actual = (live.functionDependencyEdges || []).find((edge) =>
      edge.caller === expected.caller && edge.callee === expected.callee);
    if (!actual) {
      failures.push(`FUNCTION_DEPENDENCY_EDGE_MISSING:${key}`);
      continue;
    }
    if (!actual.callerExists || !actual.calleeExists) {
      failures.push(`FUNCTION_DEPENDENCY_FUNCTION_MISSING:${key}`);
    }
    if (actual.ownerRelation !== expected.ownerRelation) {
      failures.push(`FUNCTION_DEPENDENCY_OWNER_RELATION_MISMATCH:${key}`);
    }
    if (!actual.relationOwner || actual.callerOwner !== actual.relationOwner) {
      failures.push(`FUNCTION_DEPENDENCY_CALLER_OWNER_MISMATCH:${key}`);
    }
    if (!actual.callerSecurityDefiner || !actual.calleeSecurityDefiner) {
      failures.push(`FUNCTION_DEPENDENCY_SECURITY_DEFINER_REQUIRED:${key}`);
    }
    if (JSON.stringify(actual.calleeSearchPath) !== JSON.stringify(["search_path=public, pg_temp"])) {
      failures.push(`FUNCTION_DEPENDENCY_CALLEE_SEARCH_PATH_MISMATCH:${key}`);
    }
    // service_role EXECUTE does not survive entry into a SECURITY DEFINER
    // caller owned by another role. Check that caller's actual proowner.
    if (actual.callerExecute !== true) {
      failures.push(`FUNCTION_DEPENDENCY_CALLER_EXECUTE_REQUIRED:${key}`);
    }
    if (actual.callerSchemaUsage !== true) {
      failures.push(`FUNCTION_DEPENDENCY_CALLER_SCHEMA_USAGE_REQUIRED:${key}`);
    }
  }
  const predicate=live.h3ProviderUrlPredicate, expectedPredicate=liveCatalogChecks.h3ProviderUrlPredicate;
  if(predicate.signature!==expectedPredicate.signature || !predicate.tableOwner || predicate.owner!==predicate.tableOwner
    || predicate.securityDefiner!==false || predicate.volatility!=="i" || predicate.strict!==true
    || JSON.stringify(predicate.searchPath)!==JSON.stringify(["search_path=public, pg_temp"])
    || predicate.publicExecute!==true || sha256(predicate.source.replace(/\r\n/gu,"\n").trim())!==expectedPredicate.sourceSha256) {
    failures.push("H3_PROVIDER_URL_PREDICATE_SEMANTICS_MISMATCH");
  }
  return failures;
}

// pg_proc includes OUT/TABLE names in proargnames; RPC ABI includes only inputs.
function catalogInputArgumentNames(names: unknown, modes: unknown): string[] {
  if (!Array.isArray(names)) return [];
  if (modes == null) return names.map(String);
  assert.ok(Array.isArray(modes) && modes.length === names.length, "CATALOG_ARGUMENT_MODES_INVALID");
  assert.ok(modes.every(mode => ["i", "b", "v", "o", "t"].includes(String(mode))), "CATALOG_ARGUMENT_MODE_UNKNOWN");
  return names.filter((_, index) => ["i", "b", "v"].includes(String(modes[index]))).map(String);
}
assert.deepEqual(catalogInputArgumentNames(["a", "b"], null), ["a", "b"]);
assert.deepEqual(catalogInputArgumentNames(["a", "b", "c", "out", "row"], ["i", "b", "v", "o", "t"]), ["a", "b", "c"]);
assert.throws(() => catalogInputArgumentNames(["a"], []), /CATALOG_ARGUMENT_MODES_INVALID/u);
assert.throws(() => catalogInputArgumentNames(["a"], ["unknown"]), /CATALOG_ARGUMENT_MODE_UNKNOWN/u);
const fixtureOwner = "zimeiti_owner";
const canonicalPurgeSource = read(videoHistoryBillingProtectionMigration.file).match(/AS \$function\$([\s\S]*?)\$function\$;/u)?.[1];
assert.ok(canonicalPurgeSource, "approved purge function source must be present");
assert.equal(sha256(canonicalPurgeSource), purgeSecurityGroups[0].requiredSourceSha256?.[purgeSignature], "raw purge source hash must bind the approved 189 function body");
const gaoruiAssetSecurityGroup = liveCatalogChecks.functionSecurityGroups.find(group => group.id === "gaorui-person-reference-assets")!;
const canonicalGaoruiAssetSources: Record<string, string> = {};
for (const signature of gaoruiAssetSecurityGroup.functions) {
  const name = signature.match(/^public\.([a-z0-9_]+)\(/u)![1];
  const source = read(gaoruiAssetMigration.file).match(new RegExp(`CREATE OR REPLACE FUNCTION public[.]${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`, "u"))?.[1];
  assert.ok(source, `reviewed Gaorui asset function source missing: ${signature}`);
  assert.equal(sha256(source), gaoruiAssetSecurityGroup.requiredSourceSha256?.[signature], `reviewed Gaorui asset function raw body changed: ${signature}`);
  canonicalGaoruiAssetSources[signature] = source;
}
const agentCatalogMigration = {
  "version": "20261103010000",
  "file": "supabase/migrations/20261103010000_agent_catalog_publications.sql",
  "sha256": "d2a747d4d454ae609b9d5a55b4b3ad78fcc49f230cd77704362c453a0e397745"
} as const;
assert.equal(sha256(read(agentCatalogMigration.file)), agentCatalogMigration.sha256, "reviewed catalog migration source changed");
assert.deepEqual(liveCatalogChecks.migrationLedger.requiredMigrations.find(entry => entry.version === agentCatalogMigration.version), agentCatalogMigration);
const agentCatalogRpcArguments = {
  "agent_catalog_canonical_json_v1": [
    "p_value"
  ],
  "agent_catalog_number_v1": [
    "p_number"
  ],
  "agent_catalog_projection_v1": [
    "p_agent"
  ],
  "agent_catalog_utf16_v1": [
    "p_text"
  ],
  "apply_agent_catalog_publication_v1": [
    "p_actor",
    "p_step_hash",
    "p_plan",
    "p_fields",
    "p_expected_row_hash",
    "p_model_proof"
  ],
  "lock_agent_catalog_publication_owner_v1": [
    "p_actor",
    "p_step_hash",
    "p_self_use"
  ],
  "read_agent_catalog_model_guard_v1": [
    "p_model_id"
  ],
  "read_agent_catalog_publication_index_v1": [
    "p_actor",
    "p_step_hash"
  ],
  "read_agent_catalog_publication_v1": [
    "p_agent_id"
  ]
} as const;
const reviewedHistoryMigration = {
  "version": "20261104010000",
  "file": "supabase/migrations/20261104010000_reviewed_text_history.sql",
  "sha256": "33a61d1a6fe41b029945ee26bd290014b8767c0fa3271f4c564a7fb1bb8aca42"
} as const;
const reviewedHistorySql = read(reviewedHistoryMigration.file);
assert.equal(sha256(reviewedHistorySql), reviewedHistoryMigration.sha256, "reviewed text history migration source changed");
assert.deepEqual(liveCatalogChecks.migrationLedger.requiredMigrations.find(entry => entry.version === reviewedHistoryMigration.version), reviewedHistoryMigration);
const nativePublicationSignature = "public.apply_agent_catalog_publication_v1(text,text,jsonb,jsonb,text,jsonb)";
const oldPublicationSourceHash = "a38d4fa83bf02ed4729a7f179b4c8a0b77bf3f5bf0bb9e9d97282b019daaf00b";
const reviewedPublicationSourceHash = "adce1c197ddc88308fa6a90592788be9900d79af38224447af8ced2a72a76a70";
assert.ok(reviewedHistorySql.includes(oldPublicationSourceHash) && reviewedHistorySql.includes(reviewedPublicationSourceHash));
const canonicalAgentCatalogSources: Record<string, string> = {};
const catalogFunctionMatches = [...read(agentCatalogMigration.file).matchAll(/CREATE FUNCTION public[.]([a-z0-9_]+)\([^)]*\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu)];
assert.deepEqual(catalogFunctionMatches.map(match => match[1]).sort(), Object.keys(agentCatalogRpcArguments).sort());
for (const group of liveCatalogChecks.functionSecurityGroups.filter(entry => entry.id.startsWith("agent-catalog-"))) {
  for (const signature of group.functions) {
    const name = signature.match(/^public\.([^()]+)\(/u)![1];
    const source = catalogFunctionMatches.find(match => match[1] === name)![2];
    assert.equal(sha256(source), signature === nativePublicationSignature ? oldPublicationSourceHash : group.requiredSourceSha256?.[signature], `catalog raw body pin drift: ${signature}`);
    assert.deepEqual(rpc(name)?.arguments, agentCatalogRpcArguments[name as keyof typeof agentCatalogRpcArguments]);
    canonicalAgentCatalogSources[signature] = source;
  }
}
assert.equal(Object.keys(canonicalAgentCatalogSources).length, 9);
const reviewedRpcArguments = {
  "activate_reviewed_deepseek_history_v1": [
    "p_actor",
    "p_step_hash",
    "p_model_id",
    "p_agent_id",
    "p_configuration_hash",
    "p_expected_row_version"
  ],
  "lock_reviewed_deepseek_history_v1": [
    "p_actor",
    "p_model_id",
    "p_agent_id",
    "p_configuration_hash",
    "p_row_version"
  ],
  "lock_reviewed_text_activation_owner_v1": [
    "p_actor",
    "p_step_hash"
  ]
} as const;
const reviewedFunctions = [...reviewedHistorySql.matchAll(/CREATE FUNCTION public[.]([a-z0-9_]+)\([^)]*\)[\s\S]*?AS (\$[a-z_]*\$)([\s\S]*?)\2;/gu)];
assert.deepEqual(reviewedFunctions.map(match => match[1]).sort(), Object.keys(reviewedRpcArguments).sort());
for (const group of liveCatalogChecks.functionSecurityGroups.filter(entry => entry.id.startsWith("reviewed-text-"))) {
  for (const signature of group.functions) {
    const name = signature.match(/^public\.([^()]+)\(/u)![1];
    const match = reviewedFunctions.find(row => row[1] === name);
    assert.ok(match);
    assert.equal(sha256(match[3]), group.requiredSourceSha256?.[signature]);
    assert.deepEqual(rpc(name)?.arguments, reviewedRpcArguments[name as keyof typeof reviewedRpcArguments]);
    canonicalAgentCatalogSources[signature] = match[3];
  }
}
function fixtureSourceDigest(signature: string) {
  // The reviewed migration patches this native body inside PostgreSQL. The digest is
  // independently pinned by the transaction rehearsal and checked against the live catalog.
  if (signature === nativePublicationSignature) return reviewedPublicationSourceHash;
  const source = signature === purgeSignature ? canonicalPurgeSource : signature === digitalPreflightSignature ? digitalPreflightSource : canonicalGaoruiAssetSources[signature] || canonicalAgentCatalogSources[signature];
  return source ? sha256(source) : undefined;
}
const fixtureFunction = (
  signature: string,
  group: {
    securityDefinerRequired: boolean;
    ownerMustMatchRelationOwner: boolean;
    requiredOwnerRole?: string;
    requiredSourceSha256?: Record<string, string>;
    requiredDefinitionTokens?: Record<string, string[]>;
    requiredNonOwnerExecuteGrantees: string[];
    searchPath: string[];
    additionalSettings?: string[];
  },
): LiveFunctionSecurity => ({
  signature,
  owner: group.ownerMustMatchRelationOwner ? fixtureOwner : group.requiredOwnerRole || "",
  sourceSha256: fixtureSourceDigest(signature),
  securityDefiner: group.securityDefinerRequired,
  searchPath: [`search_path=${group.searchPath.join(", ")}`, ...(group.additionalSettings || [])],
  definition: (group.requiredDefinitionTokens?.[signature] || []).join("\n"),
  argumentNames: rpc(signature.match(/^public\.([^()]+)\(/u)?.[1] || "")?.arguments || [],
  executeGrantees: [...group.requiredNonOwnerExecuteGrantees, group.ownerMustMatchRelationOwner ? fixtureOwner : group.requiredOwnerRole || ""],
  unexpectedEffectiveGrantees: [],
  privileges: {
    anonExecute: false,
    authenticatedExecute: false,
    serviceExecute: group.requiredNonOwnerExecuteGrantees.includes("service_role"),
  },
});
const validLiveFixture: LiveCatalogProjection = {
  h3ProviderUrlPredicate:{signature:liveCatalogChecks.h3ProviderUrlPredicate.signature,owner:fixtureOwner,tableOwner:fixtureOwner,securityDefiner:false,volatility:"i",strict:true,searchPath:["search_path=public, pg_temp"],publicExecute:true,source:canonicalPredicateBody},
  identity: { database: "fixture", currentUser: "fixture_reader", serverAddress: null, serverPort: null },
  ledger: liveCatalogChecks.migrationLedger.requiredMigrations.map((entry) => ({
    version: entry.version,
    name: entry.file.split("/").at(-1) || entry.file,
    hash: entry.sha256,
  })),
  relationSemantics: liveCatalogChecks.relationSemantics.map((relation) => ({
    relation: relation.relation,
    owner: fixtureOwner,
    requiredOwner: fixtureOwner,
    rlsEnabled: relation.rlsRequired === true,
    forbiddenPrivilegePrincipals: [],
    columns: relation.requiredColumns.map((column) => ({ ...column })),
    constraints: relation.requiredConstraints.map((constraint) => ({
      name: constraint.name,
      validated: constraint.validated,
      definition: constraint.definitionTokens.join(" "),
    })),
  })),
  triggerSemantics: liveCatalogChecks.triggerSemantics.map((trigger) => ({ ...trigger })),
  functionDependencyEdges: liveCatalogChecks.functionDependencyEdges.map((edge) => ({
    ...edge,
    callerExists: true,
    calleeExists: true,
    callerOwner: fixtureOwner,
    calleeOwner: "postgres",
    relationOwner: fixtureOwner,
    callerSecurityDefiner: true,
    calleeSecurityDefiner: true,
    calleeSearchPath: ["search_path=public, pg_temp"],
    callerExecute: true,
    callerSchemaUsage: true,
    serviceExecute: true,
  })),
  functionSecurityGroups: liveCatalogChecks.functionSecurityGroups.map((group) => ({
    id: group.id,
    ownerRelation: group.ownerRelation,
    tableOwner: fixtureOwner,
    functions: group.functions.map((signature) => fixtureFunction(signature, group)),
  })),
};
assert.deepEqual(liveCatalogFailures(validLiveFixture), []);

const preflightCatalogNames = ["p_user_id", "p_owned_asset_id", "p_model_id", "p_provider_origin", "p_credential_binding_fingerprint", "scope", "state", "result"];
const preflightCatalogModes = ["i", "i", "i", "i", "i", "t", "t", "t"];
const catalogShapeFixture = structuredClone(validLiveFixture);
catalogShapeFixture.functionSecurityGroups.find(group => group.id === digitalPreflightGroup.id)!.functions[0].argumentNames = catalogInputArgumentNames(preflightCatalogNames, preflightCatalogModes);
assert.deepEqual(liveCatalogFailures(catalogShapeFixture), [], "five IN plus three TABLE columns must preserve five-input RPC ABI");
const wrongInputFixture = structuredClone(catalogShapeFixture);
wrongInputFixture.functionSecurityGroups.find(group => group.id === digitalPreflightGroup.id)!.functions[0].argumentNames = catalogInputArgumentNames(["p_wrong", ...preflightCatalogNames.slice(1)], preflightCatalogModes);
assert.ok(liveCatalogFailures(wrongInputFixture).some(failure => failure.startsWith("FUNCTION_ARGUMENT_NAMES_MISMATCH:")), "wrong input name must fail despite correct TABLE outputs");
let digitalPreflightBlockingCases = 0;
for (const missing of ["group", "function"]) {
  const bad = structuredClone(validLiveFixture);
  if (missing === "group") bad.functionSecurityGroups = bad.functionSecurityGroups.filter(group => group.id !== digitalPreflightGroup.id);
  else bad.functionSecurityGroups.find(group => group.id === digitalPreflightGroup.id)!.functions = [];
  assert.ok(liveCatalogFailures(bad).length > 0, "missing preflight group or function must block admission");
  digitalPreflightBlockingCases++;
}
for (const mutate of [
  (fn: LiveFunctionSecurity) => { fn.owner = "postgres"; },
  (fn: LiveFunctionSecurity) => { fn.securityDefiner = false; },
  (fn: LiveFunctionSecurity) => { fn.searchPath = ["search_path=pg_catalog, public"]; },
  (fn: LiveFunctionSecurity) => { fn.sourceSha256 = sha256("SELECT 1"); },
  (fn: LiveFunctionSecurity) => { fn.argumentNames = []; },
  (fn: LiveFunctionSecurity) => { fn.executeGrantees.push("anon"); },
  (fn: LiveFunctionSecurity) => { fn.privileges.anonExecute = true; },
  (fn: LiveFunctionSecurity) => { fn.privileges.authenticatedExecute = true; },
  (fn: LiveFunctionSecurity) => { fn.unexpectedEffectiveGrantees.push("authenticated"); },
  (fn: LiveFunctionSecurity) => { fn.privileges.serviceExecute = false; },
  ...digitalPreflightGroup.requiredDefinitionTokens![digitalPreflightSignature].map(token => (fn: LiveFunctionSecurity) => { fn.definition = fn.definition.replace(token, ""); }),
]) {
  const bad = structuredClone(validLiveFixture);
  mutate(bad.functionSecurityGroups.find(group => group.id === digitalPreflightGroup.id)!.functions[0]);
  assert.ok(liveCatalogFailures(bad).length > 0, "preflight owner, ACL, source and scoped semantics drift must block admission");
  digitalPreflightBlockingCases++;
}
for (const remove of [true, false]) {
  const bad = structuredClone(validLiveFixture);
  if (remove) bad.ledger = bad.ledger.filter(row => row.version !== digitalPreflightMigration.version);
  else bad.ledger.find(row => row.version === digitalPreflightMigration.version)!.hash = "0".repeat(64);
  assert.ok(liveCatalogFailures(bad).some(failure => failure.startsWith("MIGRATION_LEDGER_")), "migration 194 is independently mandatory");
  digitalPreflightBlockingCases++;
}
let gaoruiAssetBlockingCases = 0;
for (const relationName of ["public.video_tasks", "public.gaorui_provider_asset_operations"]) {
  const expected = liveCatalogChecks.relationSemantics.find(relation => relation.relation === relationName)!;
  const missing = structuredClone(validLiveFixture);
  missing.relationSemantics = missing.relationSemantics.filter(relation => relation.relation !== relationName);
  assert.ok(liveCatalogFailures(missing).length > 0, "missing Gaorui asset relation must block admission");
  gaoruiAssetBlockingCases++;
  for (const column of expected.requiredColumns) for (const remove of [true, false]) {
    const bad = structuredClone(validLiveFixture);
    const relation = bad.relationSemantics.find(entry => entry.relation === relationName)!;
    if (remove) relation.columns = relation.columns.filter(entry => entry.name !== column.name);
    else relation.columns.find(entry => entry.name === column.name)!.type = "wrong_type";
    assert.ok(liveCatalogFailures(bad).length > 0, `Gaorui asset column drift must block admission: ${column.name}`);
    gaoruiAssetBlockingCases++;
  }
}
for (const mutate of [
  (relation: LiveRelationSemantics) => { relation.owner = "wrong_owner"; },
  (relation: LiveRelationSemantics) => { relation.rlsEnabled = false; },
  ...["PUBLIC", "anon", "authenticated", "service_role"].map(principal => (relation: LiveRelationSemantics) => { relation.forbiddenPrivilegePrincipals.push(principal); }),
]) {
  const bad = structuredClone(validLiveFixture);
  mutate(bad.relationSemantics.find(relation => relation.relation === "public.gaorui_provider_asset_operations")!);
  assert.ok(liveCatalogFailures(bad).length > 0, "Gaorui operation owner/RLS/privilege drift must block admission");
  gaoruiAssetBlockingCases++;
}
for (const change of ["missing", "invalidated", "provider_asset_preparation", "jsonb_typeof", "object"]) {
  const bad = structuredClone(validLiveFixture);
  const relation = bad.relationSemantics.find(entry => entry.relation === "public.video_tasks")!;
  if (change === "missing") relation.constraints = [];
  else if (change === "invalidated") relation.constraints[0].validated = false;
  else relation.constraints[0].definition = relation.constraints[0].definition.replace(change, "");
  assert.ok(liveCatalogFailures(bad).length > 0, "video asset preparation object constraint drift must block admission");
  gaoruiAssetBlockingCases++;
}
for (const signature of gaoruiAssetSecurityGroup.functions) for (const mutate of [
  (entry: LiveFunctionSecurity) => { entry.owner = "wrong_owner"; },
  (entry: LiveFunctionSecurity) => { entry.securityDefiner = false; },
  (entry: LiveFunctionSecurity) => { entry.searchPath = ["search_path=public, pg_temp"]; },
  (entry: LiveFunctionSecurity) => { delete entry.sourceSha256; },
  (entry: LiveFunctionSecurity) => { entry.sourceSha256 = sha256("modified function"); },
  (entry: LiveFunctionSecurity) => { entry.argumentNames.pop(); },
  (entry: LiveFunctionSecurity) => { entry.privileges.serviceExecute = false; },
  (entry: LiveFunctionSecurity) => { entry.executeGrantees.push("PUBLIC"); },
  (entry: LiveFunctionSecurity) => { entry.unexpectedEffectiveGrantees.push("inherited_runtime_role"); },
]) {
  const bad = structuredClone(validLiveFixture);
  mutate(bad.functionSecurityGroups.find(group => group.id === gaoruiAssetSecurityGroup.id)!.functions.find(entry => entry.signature === signature)!);
  assert.ok(liveCatalogFailures(bad).length > 0, `Gaorui asset function drift must block admission: ${signature}`);
  gaoruiAssetBlockingCases++;
}
for (const remove of [true, false]) {
  const bad = structuredClone(validLiveFixture);
  if (remove) bad.ledger = bad.ledger.filter(entry => entry.version !== gaoruiAssetMigration.version);
  else bad.ledger.find(entry => entry.version === gaoruiAssetMigration.version)!.hash = "0".repeat(64);
  assert.ok(liveCatalogFailures(bad).some(failure => failure.startsWith("MIGRATION_LEDGER_")), "migration 193 must remain independently mandatory");
  gaoruiAssetBlockingCases++;
}

let purgeFunctionSemanticBlockingCases = 0;
for (const mutation of [
  (entry: LiveFunctionSecurity) => { entry.owner = "wrong_owner"; },
  (entry: LiveFunctionSecurity) => { delete entry.sourceSha256; },
  (entry: LiveFunctionSecurity) => { entry.sourceSha256 = sha256(canonicalPurgeSource + "\n-- changed"); },
  (entry: LiveFunctionSecurity) => { entry.sourceSha256 = sha256(canonicalPurgeSource + "\n-- provider_submitted"); },
  (entry: LiveFunctionSecurity) => { entry.executeGrantees.push("PUBLIC"); },
  (entry: LiveFunctionSecurity) => { entry.executeGrantees.push("extra_runtime_role"); },
  (entry: LiveFunctionSecurity) => { entry.unexpectedEffectiveGrantees.push("inherited_runtime_role"); },
]) {
  const invalid = structuredClone(validLiveFixture);
  const entry = invalid.functionSecurityGroups.find(group => group.id === "video-history-purge-billing-protection")!.functions[0];
  mutation(entry);
  assert.ok(liveCatalogFailures(invalid).length > 0, "purge owner/source/ACL mutation must fail");
  purgeFunctionSemanticBlockingCases += 1;
}
const missingPurgeSource = structuredClone(validLiveFixture);
delete missingPurgeSource.functionSecurityGroups.find(group => group.id === "video-history-purge-billing-protection")!.functions[0].sourceSha256;
assert.ok(liveCatalogFailures(missingPurgeSource).includes(`FUNCTION_SOURCE_MISSING:${purgeSignature}`));
const changedPurgeSource = structuredClone(validLiveFixture);
changedPurgeSource.functionSecurityGroups.find(group => group.id === "video-history-purge-billing-protection")!.functions[0].sourceSha256 = sha256(canonicalPurgeSource + "\n");
assert.ok(liveCatalogFailures(changedPurgeSource).includes(`FUNCTION_SOURCE_HASH_MISMATCH:${purgeSignature}`));
purgeFunctionSemanticBlockingCases += 2;

let functionDependencyFixtureCases = 1; // Valid catalog above includes both edges.
for (const expected of liveCatalogChecks.functionDependencyEdges) {
  const missing = structuredClone(validLiveFixture);
  missing.functionDependencyEdges = missing.functionDependencyEdges.filter((edge) => edge.caller !== expected.caller);
  assert.ok(liveCatalogFailures(missing).some((failure) => failure.startsWith("FUNCTION_DEPENDENCY_EDGE_MISSING:")));
  functionDependencyFixtureCases += 1;
  const mutations: Array<{ mutate: (edge: LiveFunctionDependencyEdge) => void; failure: string }> = [
    { mutate: (edge) => { edge.callerExists = false; }, failure: "FUNCTION_MISSING" },
    { mutate: (edge) => { edge.calleeExists = false; }, failure: "FUNCTION_MISSING" },
    { mutate: (edge) => { edge.ownerRelation = "public.users"; }, failure: "OWNER_RELATION_MISMATCH" },
    { mutate: (edge) => { edge.relationOwner = ""; }, failure: "CALLER_OWNER_MISMATCH" },
    { mutate: (edge) => { edge.callerOwner = "postgres"; }, failure: "CALLER_OWNER_MISMATCH" },
    { mutate: (edge) => { edge.callerSecurityDefiner = false; }, failure: "SECURITY_DEFINER_REQUIRED" },
    { mutate: (edge) => { edge.calleeSecurityDefiner = false; }, failure: "SECURITY_DEFINER_REQUIRED" },
    { mutate: (edge) => { edge.calleeSearchPath = []; }, failure: "CALLEE_SEARCH_PATH_MISMATCH" },
    { mutate: (edge) => { edge.callerExecute = false; }, failure: "CALLER_EXECUTE_REQUIRED" },
    { mutate: (edge) => { edge.callerSchemaUsage = false; }, failure: "CALLER_SCHEMA_USAGE_REQUIRED" },
  ];
  for (const { mutate, failure } of mutations) {
    const bad = structuredClone(validLiveFixture);
    const edge = bad.functionDependencyEdges.find((entry) => entry.caller === expected.caller)!;
    mutate(edge);
    // Reproduce the incident: service_role stays executable while the
    // SECURITY DEFINER caller owner loses its dependency privilege.
    assert.equal(edge.serviceExecute, true);
    assert.ok(liveCatalogFailures(bad).includes(`FUNCTION_DEPENDENCY_${failure}:${expected.caller}->${expected.callee}`));
    functionDependencyFixtureCases += 1;
  }
}
const missingDependencyLedgerFixture = structuredClone(validLiveFixture);
missingDependencyLedgerFixture.ledger = missingDependencyLedgerFixture.ledger.filter((entry) => entry.version !== "20261012014000");
assert.ok(liveCatalogFailures(missingDependencyLedgerFixture).includes("MIGRATION_LEDGER_ROW_MISSING:20261012014000"));
const changedDependencyLedgerFixture = structuredClone(validLiveFixture);
changedDependencyLedgerFixture.ledger.find((entry) => entry.version === "20261012014000")!.hash = "0".repeat(64);
assert.ok(liveCatalogFailures(changedDependencyLedgerFixture).includes("MIGRATION_LEDGER_HASH_MISMATCH:20261012014000"));
functionDependencyFixtureCases += 2;

for(const mutation of [
  (p:H3PredicateProjection)=>{p.owner="wrong_owner";}, (p:H3PredicateProjection)=>{p.securityDefiner=true;},
  (p:H3PredicateProjection)=>{p.volatility="v";},(p:H3PredicateProjection)=>{p.strict=false;},
  (p:H3PredicateProjection)=>{p.searchPath=[];},(p:H3PredicateProjection)=>{p.publicExecute=false;},
  (p:H3PredicateProjection)=>{p.source+=" SELECT true;";}
]) {const bad=structuredClone(validLiveFixture);mutation(bad.h3ProviderUrlPredicate);assert.ok(liveCatalogFailures(bad).includes("H3_PROVIDER_URL_PREDICATE_SEMANTICS_MISMATCH"));}
for(const id of ["image-provider-delivery","h3-provider-delivery-finalizer","h3-provider-delivery-marker","image-model-receipt-publication"]) {
 for(const mutation of [(f:LiveFunctionSecurity)=>{f.owner="wrong_owner";},(f:LiveFunctionSecurity)=>{f.securityDefiner=!f.securityDefiner;},(f:LiveFunctionSecurity)=>{f.executeGrantees.push("PUBLIC");},(f:LiveFunctionSecurity)=>{f.unexpectedEffectiveGrantees.push("inherited_service");}]) {
  const bad=structuredClone(validLiveFixture);mutation(bad.functionSecurityGroups.find(g=>g.id===id)!.functions[0]);assert.ok(liveCatalogFailures(bad).length>0);
 }
}
let agentCatalogBlockingCases = 0;
for (const group of liveCatalogChecks.functionSecurityGroups.filter(entry => entry.id.startsWith("agent-catalog-") || entry.id.startsWith("reviewed-text-"))) {
  for (const signature of group.functions) {
    for (const mutation of [
      (f: LiveFunctionSecurity) => { f.owner = "wrong_owner"; },
      (f: LiveFunctionSecurity) => { f.securityDefiner = !f.securityDefiner; },
      (f: LiveFunctionSecurity) => { f.searchPath = []; },
      (f: LiveFunctionSecurity) => { f.searchPath.push("unreviewed_setting=on"); },
      (f: LiveFunctionSecurity) => { f.sourceSha256 = sha256("modified catalog function"); },
      (f: LiveFunctionSecurity) => { f.argumentNames = ["wrong_argument"]; },
      (f: LiveFunctionSecurity) => { f.executeGrantees.push("PUBLIC"); f.privileges.anonExecute = true; },
      (f: LiveFunctionSecurity) => { f.privileges.authenticatedExecute = true; },
      (f: LiveFunctionSecurity) => { f.executeGrantees = [f.owner]; f.privileges.serviceExecute = false; },
      (f: LiveFunctionSecurity) => { f.unexpectedEffectiveGrantees.push("inherited_unreviewed_role"); },
    ]) {
      const bad = structuredClone(validLiveFixture);
      mutation(bad.functionSecurityGroups.find(entry => entry.id === group.id)!.functions.find(entry => entry.signature === signature)!);
      assert.ok(liveCatalogFailures(bad).some(message => message.includes(signature)), `catalog unsafe function accepted: ${signature}`);
      agentCatalogBlockingCases++;
    }
    const missing = structuredClone(validLiveFixture);
    missing.functionSecurityGroups.find(entry => entry.id === group.id)!.functions = missing.functionSecurityGroups.find(entry => entry.id === group.id)!.functions.filter(entry => entry.signature !== signature);
    assert.ok(liveCatalogFailures(missing).includes(`FUNCTION_MISSING:${signature}`));
    agentCatalogBlockingCases++;
  }
}
const missingCatalogLedger = structuredClone(validLiveFixture);
missingCatalogLedger.ledger = missingCatalogLedger.ledger.filter(entry => entry.version !== agentCatalogMigration.version);
assert.ok(liveCatalogFailures(missingCatalogLedger).includes(`MIGRATION_LEDGER_ROW_MISSING:${agentCatalogMigration.version}`));
const wrongCatalogLedger = structuredClone(validLiveFixture);
wrongCatalogLedger.ledger.find(entry => entry.version === agentCatalogMigration.version)!.hash = "0".repeat(64);
assert.ok(liveCatalogFailures(wrongCatalogLedger).includes(`MIGRATION_LEDGER_HASH_MISMATCH:${agentCatalogMigration.version}`));
agentCatalogBlockingCases += 2;
const unpatchedNative = structuredClone(validLiveFixture);
unpatchedNative.functionSecurityGroups.flatMap(group => group.functions).find(f => f.signature === nativePublicationSignature)!.sourceSha256 = oldPublicationSourceHash;
assert.ok(liveCatalogFailures(unpatchedNative).includes(`FUNCTION_SOURCE_HASH_MISMATCH:${nativePublicationSignature}`));
for (const reason of ["missing", "wrong hash"] as const) {
  const bad = structuredClone(validLiveFixture);
  if (reason === "missing") bad.ledger = bad.ledger.filter(row => row.version !== reviewedHistoryMigration.version);
  else bad.ledger.find(row => row.version === reviewedHistoryMigration.version)!.hash = "0".repeat(64);
  assert.ok(liveCatalogFailures(bad).includes(`${reason === "missing" ? "MIGRATION_LEDGER_ROW_MISSING" : "MIGRATION_LEDGER_HASH_MISMATCH"}:${reviewedHistoryMigration.version}`));
}
for(const entry of [
{"version":"20261012013000","file":"supabase/migrations/20261012013000_image_model_validation_receipt_publication.sql","sha256":"75053bdad5e5d668f8dd3cf824e26ebbef72b4eb8f07515cfd3a4ff695ceb8f9"},
  {
    "version": "20261012010000",
    "file": "supabase/migrations/20261012010000_image_provider_delivery.sql",
    "sha256": "21396c606c383ffe74685d4970296b4fb00434c252745a7f3f22578fc6ace2d8"
  },
  {
    "version": "20261012011000",
    "file": "supabase/migrations/20261012011000_h3_provider_delivery.sql",
    "sha256": "f64ba0095efc497fa468998a48f3ea225a440aa1a2c547b214e596ab191a03bc"
  },
  {
    "version": "20261012012000",
    "file": "supabase/migrations/20261012012000_image_ephemeral_delivery.sql",
    "sha256": "85f1ded41a617e67d61741082938fdeeb0074b520724795d9cd8124ebbf09593"
  }
]) {for(const missing of [true,false]) {const bad=structuredClone(validLiveFixture);if(missing)bad.ledger=bad.ledger.filter(e=>e.version!==entry.version);else bad.ledger.find(e=>e.version===entry.version)!.hash="0".repeat(64);assert.ok(liveCatalogFailures(bad).some(f=>f.startsWith("MIGRATION_LEDGER_")));}}
for(const relation of ["public.autodl_h3_jobs","public.autodl_h3_settlements"]) {for(const invalidated of [true,false]) {const bad=structuredClone(validLiveFixture);const constraint=bad.relationSemantics.find(r=>r.relation===relation)!.constraints[0];if(invalidated)constraint.validated=false;else constraint.definition="CHECK (stable_asset_url ~ '^object://tencent_cos/')";assert.ok(liveCatalogFailures(bad).some(f=>f.startsWith("RELATION_CONSTRAINT_")));}}

// Do not accept a pre-186 database or a database missing only the 187 behavior fix.
const missingBothPendingMigrations = structuredClone(validLiveFixture);
missingBothPendingMigrations.ledger = missingBothPendingMigrations.ledger.filter(entry => !["20261030010000", "20261030020000"].includes(entry.version));
const missingBothFailures = liveCatalogFailures(missingBothPendingMigrations);
for (const version of ["20261030010000", "20261030020000"]) assert.ok(missingBothFailures.includes(`MIGRATION_LEDGER_ROW_MISSING:${version}`));
const missingOnlyPendingForward = structuredClone(validLiveFixture);
missingOnlyPendingForward.ledger = missingOnlyPendingForward.ledger.filter(entry => entry.version !== "20261030020000");
assert.ok(liveCatalogFailures(missingOnlyPendingForward).includes("MIGRATION_LEDGER_ROW_MISSING:20261030020000"));
const driftedPendingForward = structuredClone(validLiveFixture);
driftedPendingForward.ledger.find(entry => entry.version === "20261030020000")!.hash = "0".repeat(64);
assert.ok(liveCatalogFailures(driftedPendingForward).includes("MIGRATION_LEDGER_HASH_MISMATCH:20261030020000"));
// Migration 188 is independently mandatory even when 186 and 187 are present.
const missingCredentialRemovalGuard = structuredClone(validLiveFixture);
missingCredentialRemovalGuard.ledger = missingCredentialRemovalGuard.ledger.filter(entry => entry.version !== "20261030030000");
assert.ok(liveCatalogFailures(missingCredentialRemovalGuard).includes("MIGRATION_LEDGER_ROW_MISSING:20261030030000"));
const driftedCredentialRemovalGuard = structuredClone(validLiveFixture);
driftedCredentialRemovalGuard.ledger.find(entry => entry.version === "20261030030000")!.hash = "0".repeat(64);
assert.ok(liveCatalogFailures(driftedCredentialRemovalGuard).includes("MIGRATION_LEDGER_HASH_MISMATCH:20261030030000"));
// Migration 189 must remain present and exact after all pending-credential fixes.
const missingUnsettledVideoBillingProtection = structuredClone(validLiveFixture);
missingUnsettledVideoBillingProtection.ledger = missingUnsettledVideoBillingProtection.ledger.filter(entry => entry.version !== "20261030040000");
assert.ok(liveCatalogFailures(missingUnsettledVideoBillingProtection).includes("MIGRATION_LEDGER_ROW_MISSING:20261030040000"));
const driftedUnsettledVideoBillingProtection = structuredClone(validLiveFixture);
driftedUnsettledVideoBillingProtection.ledger.find(entry => entry.version === "20261030040000")!.hash = "0".repeat(64);
assert.ok(liveCatalogFailures(driftedUnsettledVideoBillingProtection).includes("MIGRATION_LEDGER_HASH_MISMATCH:20261030040000"));
const missingLedgerFixture = structuredClone(validLiveFixture);
missingLedgerFixture.ledger.pop();
assert.match(liveCatalogFailures(missingLedgerFixture).join("\n"), /MIGRATION_LEDGER_ROW_MISSING/u);
const driftedLedgerFixture = structuredClone(validLiveFixture);
driftedLedgerFixture.ledger[0].hash = "0".repeat(64);
assert.match(liveCatalogFailures(driftedLedgerFixture).join("\n"), /MIGRATION_LEDGER_HASH_MISMATCH/u);
const missingProviderReceiptColumnFixture = structuredClone(validLiveFixture);
missingProviderReceiptColumnFixture.relationSemantics[0].columns.pop();
assert.match(liveCatalogFailures(missingProviderReceiptColumnFixture).join("\n"), /RELATION_COLUMN_MISSING/u);
const invalidProviderReceiptConstraintFixture = structuredClone(validLiveFixture);
invalidProviderReceiptConstraintFixture.relationSemantics[0].constraints[0].validated = false;
assert.match(liveCatalogFailures(invalidProviderReceiptConstraintFixture).join("\n"), /RELATION_CONSTRAINT_VALIDATION_MISMATCH/u);
const wrongRelationOwnerFixture = structuredClone(validLiveFixture);
wrongRelationOwnerFixture.relationSemantics[1].owner = "postgres";
assert.match(liveCatalogFailures(wrongRelationOwnerFixture).join("\n"), /RELATION_OWNER_MISMATCH/u);
const missingRelationRlsFixture = structuredClone(validLiveFixture);
missingRelationRlsFixture.relationSemantics[1].rlsEnabled = false;
assert.match(liveCatalogFailures(missingRelationRlsFixture).join("\n"), /RELATION_RLS_REQUIRED/u);
const leakedRelationPrivilegeFixture = structuredClone(validLiveFixture);
leakedRelationPrivilegeFixture.relationSemantics[1].forbiddenPrivilegePrincipals = ["service_role"];
assert.match(liveCatalogFailures(leakedRelationPrivilegeFixture).join("\n"), /RELATION_FORBIDDEN_PRIVILEGE/u);
const missingTriggerFixture = structuredClone(validLiveFixture);
missingTriggerFixture.triggerSemantics.pop();
assert.match(liveCatalogFailures(missingTriggerFixture).join("\n"), /TRIGGER_MISSING/u);
const wrongTriggerFunctionFixture = structuredClone(validLiveFixture);
wrongTriggerFunctionFixture.triggerSemantics[0].function = "public.unexpected_trigger_function()";
assert.match(liveCatalogFailures(wrongTriggerFunctionFixture).join("\n"), /TRIGGER_FUNCTION_MISMATCH/u);
const disabledTriggerFixture = structuredClone(validLiveFixture);
disabledTriggerFixture.triggerSemantics[0].enabled = false;
assert.match(liveCatalogFailures(disabledTriggerFixture).join("\n"), /TRIGGER_ENABLED_MISMATCH/u);
const wrongOwnerFixture = structuredClone(validLiveFixture);
wrongOwnerFixture.functionSecurityGroups[0].functions[0].owner = "postgres";
assert.match(liveCatalogFailures(wrongOwnerFixture).join("\n"), /FUNCTION_OWNER_MISMATCH/u);
const invokerFixture = structuredClone(validLiveFixture);
invokerFixture.functionSecurityGroups[0].functions[0].securityDefiner = false;
assert.match(liveCatalogFailures(invokerFixture).join("\n"), /FUNCTION_SECURITY_DEFINER_REQUIRED/u);
const unsafeSearchPathFixture = structuredClone(validLiveFixture);
unsafeSearchPathFixture.functionSecurityGroups[0].functions[0].searchPath = [];
assert.match(liveCatalogFailures(unsafeSearchPathFixture).join("\n"), /FUNCTION_SEARCH_PATH_MISMATCH/u);
const publicAclFixture = structuredClone(validLiveFixture);
publicAclFixture.functionSecurityGroups[0].functions[0].executeGrantees.push("PUBLIC");
assert.match(liveCatalogFailures(publicAclFixture).join("\n"), /FUNCTION_EXECUTE_ACL_MISMATCH/u);
assert.match(liveCatalogFailures(publicAclFixture).join("\n"), /FUNCTION_FORBIDDEN_EXECUTE_PRIVILEGE/u);
const missingServiceFixture = structuredClone(validLiveFixture);
missingServiceFixture.functionSecurityGroups[0].functions[0].executeGrantees = [fixtureOwner];
missingServiceFixture.functionSecurityGroups[0].functions[0].privileges.serviceExecute = false;
assert.match(liveCatalogFailures(missingServiceFixture).join("\n"), /FUNCTION_SERVICE_ROLE_EXECUTE_REQUIRED/u);
const inheritedAclFixture = structuredClone(validLiveFixture);
inheritedAclFixture.functionSecurityGroups[1].functions[0].unexpectedEffectiveGrantees = ["extra_runtime_role"];
assert.match(liveCatalogFailures(inheritedAclFixture).join("\n"), /FUNCTION_UNEXPECTED_EFFECTIVE_EXECUTE/u);
const helperServiceRoleFixture = structuredClone(validLiveFixture);
helperServiceRoleFixture.functionSecurityGroups[1].functions[0].executeGrantees.push("service_role");
helperServiceRoleFixture.functionSecurityGroups[1].functions[0].privileges.serviceExecute = true;
helperServiceRoleFixture.functionSecurityGroups[1].functions[0].unexpectedEffectiveGrantees.push("service_role");
assert.match(liveCatalogFailures(helperServiceRoleFixture).join("\n"), /FUNCTION_FORBIDDEN_EXECUTE_PRIVILEGE/u);
const semanticDriftFixture = structuredClone(validLiveFixture);
semanticDriftFixture.functionSecurityGroups[3].functions[0].definition = "";
assert.match(liveCatalogFailures(semanticDriftFixture).join("\n"), /FUNCTION_SEMANTIC_TOKEN_MISSING/u);
const argumentDriftFixture = structuredClone(validLiveFixture);
argumentDriftFixture.functionSecurityGroups[0].functions[2].argumentNames = ["p_wrong"];
assert.match(liveCatalogFailures(argumentDriftFixture).join("\n"), /FUNCTION_ARGUMENT_NAMES_MISMATCH/u);

const argumentValue = (name: string) => {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length).trim() || "";
};

async function verifyLiveCatalog(): Promise<LiveCatalogProjection> {
  const confirmedHost = argumentValue("--confirm-target-host").toLowerCase();
  const confirmedDatabase = argumentValue("--confirm-target-database");
  assert.ok(confirmedHost && !confirmedHost.includes("<"), "CONFIRM_TARGET_HOST_REQUIRED");
  assert.ok(confirmedDatabase && !confirmedDatabase.includes("<"), "CONFIRM_TARGET_DATABASE_REQUIRED");
  const configured = (policy.database?.migrationDatabaseUrlEnv || [])
    .map((envName) => ({ envName, value: String(process.env[envName] || "").trim() }))
    .find((entry) => entry.value);
  assert.ok(configured, "MIGRATION_DATABASE_URL_REQUIRED");
  const parsed = new URL(configured.value);
  assert.equal(parsed.hostname.toLowerCase(), confirmedHost, "CONFIRMED_TARGET_HOST_MISMATCH");
  const configuredDatabase = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  assert.equal(configuredDatabase, confirmedDatabase, "CONFIRMED_TARGET_DATABASE_MISMATCH");
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.toLowerCase());
  const client = new Client({
    connectionString: configured.value,
    ssl: localHost ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    application_name: "zimeiti-release-database-live-gate",
  });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("begin read only");
    transactionOpen = true;
    const identityRow = (await client.query(
      "select current_database() as database_name,current_user,inet_server_addr()::text as server_address,inet_server_port() as server_port",
    )).rows[0];
    assert.equal(String(identityRow?.database_name || ""), confirmedDatabase, "LIVE_TARGET_DATABASE_MISMATCH");
    const versions = liveCatalogChecks.migrationLedger.requiredMigrations.map((entry) => entry.version);
    const ledgerRows = (await client.query(
      `select version::text as version,coalesce(name::text,'') as name,coalesce(hash::text,'') as hash
         from supabase_migrations.schema_migrations
        where version::text = any($1::text[])
        order by version::text`,
      [versions],
    )).rows.map((row) => ({
      version: String(row.version || ""),
      name: String(row.name || ""),
      hash: String(row.hash || "").toLowerCase(),
    }));
    const relationSemantics: LiveRelationSemantics[] = [];
    for (const expectedRelation of liveCatalogChecks.relationSemantics) {
      const relationExists = Boolean((await client.query(
        "select to_regclass($1)::text as relation_name",
        [expectedRelation.relation],
      )).rows[0]?.relation_name);
      if (!relationExists) continue;
      const relationMetadata = (await client.query(
        `select pg_get_userbyid(relation_entry.relowner) as owner,
                relation_entry.relrowsecurity as rls_enabled,
                coalesce(pg_get_userbyid(required_owner_relation.relowner),'') as required_owner
           from pg_class relation_entry
           left join pg_class required_owner_relation on required_owner_relation.oid=to_regclass($2)
          where relation_entry.oid=to_regclass($1)`,
        [expectedRelation.relation, expectedRelation.requiredOwnerRelation || null],
      )).rows[0];
      const forbiddenPrivilegePrincipals: string[] = [];
      for (const principal of expectedRelation.forbiddenPrivilegePrincipals || []) {
        const hasPrivilege = principal === "PUBLIC"
          ? (await client.query(
            `select exists(
               select 1
                 from pg_class relation_entry
                 cross join lateral aclexplode(coalesce(relation_entry.relacl,acldefault('r',relation_entry.relowner))) acl
                where relation_entry.oid=to_regclass($1)
                  and acl.grantee=0
                  and acl.privilege_type in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
             ) as present`,
            [expectedRelation.relation],
          )).rows[0]?.present === true
          : (await client.query(
            `select coalesce(
               has_table_privilege(to_regrole($1),to_regclass($2),'SELECT')
               or has_table_privilege(to_regrole($1),to_regclass($2),'INSERT')
               or has_table_privilege(to_regrole($1),to_regclass($2),'UPDATE')
               or has_table_privilege(to_regrole($1),to_regclass($2),'DELETE')
               or has_table_privilege(to_regrole($1),to_regclass($2),'TRUNCATE')
               or has_table_privilege(to_regrole($1),to_regclass($2),'REFERENCES')
               or has_table_privilege(to_regrole($1),to_regclass($2),'TRIGGER'), false
             ) as present`,
            [principal, expectedRelation.relation],
          )).rows[0]?.present === true;
        if (hasPrivilege) forbiddenPrivilegePrincipals.push(principal);
      }
      const columns = (await client.query(
        `select attribute.attname as name,format_type(attribute.atttypid,attribute.atttypmod) as type
           from pg_attribute attribute
          where attribute.attrelid=to_regclass($1)
            and attribute.attnum > 0 and not attribute.attisdropped
            and attribute.attname = any($2::text[])
          order by attribute.attname`,
        [expectedRelation.relation, expectedRelation.requiredColumns.map((entry) => entry.name)],
      )).rows.map((row) => ({ name: String(row.name || ""), type: String(row.type || "") }));
      const constraints = (await client.query(
        `select constraint_entry.conname as name,constraint_entry.convalidated as validated,
                pg_get_constraintdef(constraint_entry.oid,true) as definition
           from pg_constraint constraint_entry
          where constraint_entry.conrelid=to_regclass($1)
            and constraint_entry.conname = any($2::text[])
          order by constraint_entry.conname`,
        [expectedRelation.relation, expectedRelation.requiredConstraints.map((entry) => entry.name)],
      )).rows.map((row) => ({
        name: String(row.name || ""),
        validated: row.validated === true,
        definition: String(row.definition || ""),
      }));
      relationSemantics.push({
        relation: expectedRelation.relation,
        owner: String(relationMetadata?.owner || ""),
        requiredOwner: String(relationMetadata?.required_owner || ""),
        rlsEnabled: relationMetadata?.rls_enabled === true,
        forbiddenPrivilegePrincipals,
        columns,
        constraints,
      });
    }
    const triggerSemantics: LiveTriggerSemantics[] = [];
    for (const expectedTrigger of liveCatalogChecks.triggerSemantics) {
      const row = (await client.query(
        `select format('%I.%I', relation_namespace.nspname, relation_entry.relname) as relation,
                trigger_entry.tgname as name,
                format('%I.%I(%s)', function_namespace.nspname, function_entry.proname,
                  pg_get_function_identity_arguments(function_entry.oid)) as function,
                trigger_entry.tgenabled <> 'D' as enabled
           from pg_trigger trigger_entry
           join pg_class relation_entry on relation_entry.oid=trigger_entry.tgrelid
           join pg_namespace relation_namespace on relation_namespace.oid=relation_entry.relnamespace
           join pg_proc function_entry on function_entry.oid=trigger_entry.tgfoid
           join pg_namespace function_namespace on function_namespace.oid=function_entry.pronamespace
          where trigger_entry.tgrelid=to_regclass($1)
            and trigger_entry.tgname=$2
            and not trigger_entry.tgisinternal`,
        [expectedTrigger.relation, expectedTrigger.name],
      )).rows[0];
      if (row) {
        triggerSemantics.push({
          relation: String(row.relation || ""),
          name: String(row.name || ""),
          function: String(row.function || ""),
          enabled: row.enabled === true,
        });
      }
    }
    const functionSecurityGroups: LiveFunctionSecurityGroup[] = [];
    for (const expectedGroup of liveCatalogChecks.functionSecurityGroups) {
      const tableOwner = String((await client.query(
        "select pg_get_userbyid(relowner) as owner from pg_class where oid=to_regclass($1)",
        [expectedGroup.ownerRelation],
      )).rows[0]?.owner || "");
      const functions: LiveFunctionSecurity[] = [];
      for (const signature of expectedGroup.functions) {
        const row = (await client.query(
          `select pg_get_userbyid(p.proowner) as owner,p.prosecdef as security_definer,p.proconfig,p.proargnames,p.proargmodes::text[] as proargmodes,
                  pg_get_functiondef(p.oid) as definition,encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') as source_sha256,
                  to_jsonb(array(
                    select distinct coalesce(pg_get_userbyid(acl.grantee),'PUBLIC')
                      from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
                     where acl.privilege_type='EXECUTE'
                     order by 1
                  )) as execute_grantees,
                  to_jsonb(array(
                    select role_entry.rolname
                      from pg_roles role_entry
                     where role_entry.oid <> p.proowner
                       and ($2::boolean or role_entry.oid <> to_regrole('service_role'))
                        and not role_entry.rolsuper
                       and has_function_privilege(role_entry.oid, p.oid, 'EXECUTE')
                     order by role_entry.rolname
                  )) as unexpected_effective_grantees
             from pg_proc p where p.oid=to_regprocedure($1)`,
          [signature, !expectedGroup.allowedEffectiveExecutePrincipals.includes("service_role")],
        )).rows[0];
        const privileges = (await client.query(
          `select has_function_privilege('anon',$1,'execute') as anon_execute,
                  has_function_privilege('authenticated',$1,'execute') as authenticated_execute,
                  has_function_privilege('service_role',$1,'execute') as service_execute`,
          [signature],
        )).rows[0];
        functions.push({
          signature,
          owner: String(row?.owner || ""),
          securityDefiner: row?.security_definer === true,
          searchPath: Array.isArray(row?.proconfig) ? row.proconfig.map(String) : [],
          definition: String(row?.definition || ""),
          sourceSha256: typeof row?.source_sha256 === "string" ? row.source_sha256 : undefined,
          argumentNames: catalogInputArgumentNames(row?.proargnames, row?.proargmodes),
          executeGrantees: Array.isArray(row?.execute_grantees) ? row.execute_grantees.map(String) : [],
          unexpectedEffectiveGrantees: Array.isArray(row?.unexpected_effective_grantees)
            ? row.unexpected_effective_grantees.map(String) : [],
          privileges: {
            anonExecute: privileges?.anon_execute === true,
            authenticatedExecute: privileges?.authenticated_execute === true,
            serviceExecute: privileges?.service_execute === true,
          },
        });
      }
      functionSecurityGroups.push({
        id: expectedGroup.id,
        ownerRelation: expectedGroup.ownerRelation,
        tableOwner,
        functions,
      });
    }
    const functionDependencyEdges: LiveFunctionDependencyEdge[] = [];
    for (const expected of liveCatalogChecks.functionDependencyEdges) {
      const row = (await client.query(
        `select caller.oid is not null as caller_exists, callee.oid is not null as callee_exists,
                pg_get_userbyid(caller.proowner) as caller_owner,
                pg_get_userbyid(callee.proowner) as callee_owner,
                pg_get_userbyid(relation.relowner) as relation_owner,
                caller.prosecdef as caller_security_definer, callee.prosecdef as callee_security_definer,
                callee.proconfig as callee_search_path,
                coalesce(has_function_privilege(caller.proowner, callee.oid, 'EXECUTE'), false) as caller_execute,
                coalesce(has_schema_privilege(caller.proowner, callee.pronamespace, 'USAGE'), false) as caller_schema_usage,
                coalesce(has_function_privilege(to_regrole('service_role'), callee.oid, 'EXECUTE'), false) as service_execute
           from (values (1)) as anchor(value)
           left join pg_proc caller on caller.oid = to_regprocedure($1)
           left join pg_proc callee on callee.oid = to_regprocedure($2)
           left join pg_class relation on relation.oid = to_regclass($3)`,
        [expected.caller, expected.callee, expected.ownerRelation],
      )).rows[0];
      functionDependencyEdges.push({
        ...expected,
        callerExists: row?.caller_exists === true,
        calleeExists: row?.callee_exists === true,
        callerOwner: String(row?.caller_owner || ""),
        calleeOwner: String(row?.callee_owner || ""),
        relationOwner: String(row?.relation_owner || ""),
        callerSecurityDefiner: row?.caller_security_definer === true,
        calleeSecurityDefiner: row?.callee_security_definer === true,
        calleeSearchPath: Array.isArray(row?.callee_search_path) ? row.callee_search_path.map(String) : [],
        callerExecute: row?.caller_execute === true,
        callerSchemaUsage: row?.caller_schema_usage === true,
        serviceExecute: row?.service_execute === true,
      });
    }
    const predicateSignature=liveCatalogChecks.h3ProviderUrlPredicate.signature;
    const predicateRow=(await client.query(`select pg_get_userbyid(p.proowner) as owner,p.prosecdef,p.provolatile,p.proisstrict,p.proconfig,p.prosrc,
      pg_get_userbyid(c.relowner) as table_owner,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE') as public_execute
      from pg_proc p cross join pg_class c where p.oid=to_regprocedure($1) and c.oid=to_regclass($2)`,[predicateSignature,liveCatalogChecks.h3ProviderUrlPredicate.ownerRelation])).rows[0];
    const h3ProviderUrlPredicate:H3PredicateProjection={signature:predicateSignature,owner:String(predicateRow?.owner||""),tableOwner:String(predicateRow?.table_owner||""),securityDefiner:predicateRow?.prosecdef===true,volatility:String(predicateRow?.provolatile||""),strict:predicateRow?.proisstrict===true,searchPath:Array.isArray(predicateRow?.proconfig)?predicateRow.proconfig.map(String):[],publicExecute:predicateRow?.public_execute===true,source:String(predicateRow?.prosrc||"")};
    const live: LiveCatalogProjection = {
      h3ProviderUrlPredicate,
      identity: {
        database: String(identityRow?.database_name || ""),
        currentUser: String(identityRow?.current_user || ""),
        serverAddress: identityRow?.server_address ? String(identityRow.server_address) : null,
        serverPort: Number.isFinite(Number(identityRow?.server_port)) ? Number(identityRow.server_port) : null,
      },
      ledger: ledgerRows,
      relationSemantics,
      triggerSemantics,
      functionSecurityGroups,
      functionDependencyEdges,
    };
    const failures = liveCatalogFailures(live);
    assert.deepEqual(failures, [], `LIVE_DATABASE_GATE_FAILED:${failures.join(",")}`);
    await client.query("rollback");
    transactionOpen = false;
    return live;
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const liveMode = process.argv.includes("--live");
  const live = liveMode ? await verifyLiveCatalog() : null;
  console.log(JSON.stringify({
    ok: true,
    contractVersion: contract.contractVersion,
    contractTableCount: contract.tables.length,
    contractRpcCount: contract.rpcs.length,
    requiredTablesChecked: 17,
    requiredRpcsChecked: 36,
    internalOnlyTablesChecked: 4,
    nonCommerceRepairObjectsChecked: 11,
    nonCommerceMissingObjectBlockingCases: 22,
    adminAuthorityTablesChecked: adminAuthorityTables.length,
    adminAuthorityColumnsChecked: [...adminAuthorityColumns.values()].reduce((sum, columns) => sum + columns.length, 0),
    adminAuthorityRpcArgumentsChecked: adminAuthorityRpcArguments.length,
    adminAuthorityDeclarationBlockingCases: 1 + adminAuthorityTables.length
      + [...adminAuthorityColumns.values()].reduce((sum, columns) => sum + columns.length, 0) + 2,
    adminAuthorityOpenApiBlockingCases: adminAuthorityTables.length * 2
      + [...adminAuthorityColumns.values()].reduce((sum, columns) => sum + columns.length, 0) + 1 + adminAuthorityRpcArguments.length,
    staleEmbeddedContractBlockingCases: 1,
    videoHealthProtocolVersion: VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
    liveCatalogFixtureCases: 62,
    agentCatalogFunctionsChecked: catalogFunctionMatches.length,
    reviewedTextFunctionsChecked: reviewedFunctions.length,
    reviewedMigrationSha256: reviewedHistoryMigration.sha256,
    agentCatalogBlockingCases,
    agentCatalogMigrationSha256: agentCatalogMigration.sha256,
    pendingCredentialLedgerBlockingCases: 5,
    unsettledVideoBillingLedgerBlockingCases: 2,
    purgeFunctionSemanticBlockingCases,
    gaoruiAssetBlockingCases,
    digitalPreflightBlockingCases,
    digitalPreflightMigrationSha256: digitalPreflightMigration.sha256,
    gaoruiAssetRpcArgumentsChecked: Object.values(gaoruiAssetRpcArguments).reduce((sum, args) => sum + args.length, 0),
    gaoruiAssetMigrationSha256: gaoruiAssetMigration.sha256,
    pendingCredentialRpcArgumentsChecked: Object.values(pendingCredentialRpcArguments).reduce((sum, args) => sum + args.length, 0),
    legacyInternalPublisherBlockingCases: 3,
    functionDependencyFixtureCases,
    deliveryCatalogFixtureCases: 35,
    liveCatalogChecked: liveMode,
    liveCatalog: live,
    forwardMigrationCount: forwardMigrationRoot.entries.length,
    forwardMigrationGitIndexChecked: forwardMigrationRoot.gitIndex.checked,
    forwardMigrationLegacyTombstoneCount: forwardMigrationRoot.gitIndex.legacyTombstonePaths.length,
    forwardMigrationInvalidIndexPathCount: forwardMigrationRoot.gitIndex.invalidPaths.length,
    forwardMigrationStagedChangeCount: forwardMigrationRoot.gitIndex.stagedChangePaths.length,
    forwardMigrationWorktreeDriftCount: forwardMigrationRoot.gitIndex.worktreeDriftPaths.length,
    forwardMigrationTrackedCount: forwardMigrationRoot.gitIndex.trackedForwardPaths.length,
    forwardMigrationStagedNewCount: forwardMigrationRoot.gitIndex.stagedNewForwardPaths.length,
    forwardMigrationUntrackedNewCount: forwardMigrationRoot.gitIndex.untrackedNewForwardPaths.length,
    forwardMigrationCoveredCount: forwardMigrationCoverage.length,
    forwardMigrationCoverageSha256,
    forwardMigrationUntrackedNewPaths: forwardMigrationRoot.gitIndex.untrackedNewForwardPaths,
    networkRequests: liveMode ? 1 : 0,
    databaseWrites: 0,
    paidModelCalls: 0,
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

assert.deepEqual(rpc("publish_image_model_validation_receipt")?.arguments,["p_validation_id","p_user_id","p_configuration_hash","p_model_snapshot_hash","p_expected_active","p_expected_hidden","p_verified_key","p_verified_size","p_verified_type","p_evidence"]);
