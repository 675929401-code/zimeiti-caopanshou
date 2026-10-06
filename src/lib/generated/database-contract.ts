// Generated from deploy/policies/database-contract.v1.json.
// Verify with scripts/verify-embedded-runtime-resources.mjs before production builds.
const DATABASE_CONTRACT_SOURCE = {
  "schemaVersion": 1,
  "contractId": "zimeiti-caopanshou-production-database-v1",
  "contractVersion": "20261001070000",
  "openApiProfile": "public",
  "probeMode": "read-only-postgrest-openapi",
  "requiredProbeRole": "service_role",
  "tables": [
    {
      "name": "users",
      "feature": "account-wallet-voice",
      "columns": [
        "id",
        "credits",
        "cash_balance",
        "total_credits_recharged",
        "total_credits_consumed",
        "total_cash_recharged",
        "total_cash_consumed",
        "voice_clone_authorized",
        "updated_at"
      ]
    },
    {
      "name": "user_appearance_preferences",
      "feature": "account-appearance-preference",
      "columns": [
        "user_id",
        "theme_key",
        "mode_preference",
        "ip_hash",
        "expires_at",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "user_auth_sessions",
      "feature": "account-auth-sessions",
      "columns": [
        "id",
        "user_id",
        "session_id",
        "ip_hash",
        "user_agent_hash",
        "created_at",
        "expires_at",
        "revoked_at",
        "revoke_reason"
      ]
    },
    {
      "name": "agent_favorites",
      "feature": "account-agent-favorites",
      "columns": [
        "id",
        "user_id",
        "agent_id",
        "created_at"
      ]
    },
    {
      "name": "revenue_records",
      "feature": "revenue-audit",
      "columns": [
        "id",
        "user_id",
        "model_id",
        "task_id",
        "cost_price",
        "selling_price",
        "profit",
        "is_admin",
        "record_type",
        "credits_charged",
        "cash_charged",
        "created_at"
      ]
    },
    {
      "name": "credit_transactions",
      "feature": "wallet",
      "columns": [
        "id",
        "user_id",
        "amount",
        "type",
        "transaction_type",
        "balance_after",
        "description",
        "metadata"
      ]
    },
    {
      "name": "cash_transactions",
      "feature": "wallet",
      "columns": [
        "id",
        "user_id",
        "amount",
        "balance_after",
        "type",
        "description",
        "reference_id",
        "metadata"
      ]
    },
    {
      "name": "wallet_operations",
      "feature": "wallet",
      "columns": [
        "id",
        "user_id",
        "wallet",
        "operation_kind",
        "idempotency_key",
        "amount",
        "delta",
        "status",
        "balance_before",
        "balance_after",
        "description",
        "metadata",
        "legacy_transaction_id",
        "created_at",
        "completed_at"
      ]
    },
    {
      "name": "wallet_ledger_entries",
      "feature": "wallet",
      "columns": [
        "id",
        "operation_id",
        "user_id",
        "wallet",
        "delta",
        "balance_before",
        "balance_after",
        "operation_kind",
        "idempotency_key",
        "description",
        "metadata",
        "created_at"
      ]
    },
    {
      "name": "user_files",
      "feature": "owned-assets",
      "columns": [
        "id",
        "user_id",
        "storage_key",
        "storage_provider",
        "created_at",
        "file_name",
        "file_category",
        "file_size",
        "content_type",
        "source",
        "meta",
        "is_public"
      ]
    },
    {
      "name": "image_generation_requests",
      "feature": "image-exactly-once",
      "columns": [
        "record_id",
        "user_id",
        "user_hash",
        "client_idempotency_key",
        "client_trace_id",
        "payload_fingerprint",
        "request_snapshot",
        "state",
        "response",
        "delivery_state",
        "delivery_asset_id",
        "failure_hidden_at",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "cash_debt_records",
      "feature": "debt-ledger",
      "columns": [
        "id",
        "user_id",
        "amount",
        "description",
        "reference_id",
        "status",
        "created_at",
        "paid_at"
      ]
    },
    {
      "name": "password_audit_log",
      "feature": "security-audit",
      "columns": [
        "id",
        "user_id",
        "action",
        "performed_by",
        "performed_by_role",
        "performed_by_name",
        "old_hash_prefix",
        "new_hash_prefix",
        "ip_address",
        "user_agent",
        "details",
        "created_at"
      ]
    },
    {
      "name": "conversations",
      "feature": "conversation-history",
      "columns": [
        "id",
        "user_id",
        "agent_id",
        "title",
        "source",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "conversation_messages",
      "feature": "conversation-history",
      "columns": [
        "id",
        "user_id",
        "conversation_id",
        "role",
        "content",
        "reasoning_content",
        "agent_id",
        "created_at"
      ]
    },
    {
      "name": "conversation_message_attachments",
      "feature": "conversation-history",
      "columns": [
        "id",
        "user_id",
        "conversation_id",
        "message_id",
        "asset_id",
        "created_at"
      ]
    },
    {
      "name": "text_chat_conversation_settings",
      "feature": "text-chat-controls",
      "columns": [
        "id",
        "user_id",
        "conversation_id",
        "paid_tool_authorization_enabled",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "text_chat_memories",
      "feature": "text-chat-controls",
      "columns": [
        "id",
        "user_id",
        "content",
        "source_conversation_id",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "extraction_attempts",
      "feature": "extraction-exactly-once",
      "columns": [
        "record_id",
        "user_id",
        "client_request_id",
        "request_kind",
        "payload_fingerprint",
        "request_snapshot",
        "state",
        "http_status",
        "response",
        "provider_task_id",
        "provider_evidence",
        "billing_evidence",
        "error_code",
        "error_message",
        "reconciled_by",
        "reconciled_at",
        "reconciliation_reason",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "extraction_attempt_reconciliation_audit",
      "feature": "extraction-exactly-once",
      "columns": [
        "id",
        "record_id",
        "actor_user_id",
        "from_state",
        "to_state",
        "reason",
        "response_fingerprint",
        "provider_task_id",
        "provider_evidence",
        "billing_evidence",
        "created_at"
      ]
    },
    {
      "name": "llm_request_attempts",
      "feature": "llm-exactly-once",
      "columns": [
        "record_id",
        "user_id",
        "client_request_id",
        "payload_fingerprint",
        "state",
        "attempt_no",
        "lease_owner",
        "lease_token",
        "lease_expires_at",
        "provider_call_started_at",
        "http_status",
        "response_headers",
        "response_body",
        "response_fingerprint",
        "result_reference",
        "error_code",
        "error_message",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "llm_request_attempt_events",
      "feature": "llm-exactly-once",
      "columns": [
        "id",
        "record_id",
        "attempt_no",
        "event_type",
        "from_state",
        "to_state",
        "lease_owner",
        "lease_token",
        "actor_user_id",
        "reason",
        "evidence",
        "created_at"
      ]
    },
    {
      "name": "short_drama_script_requests",
      "feature": "general-script-history",
      "columns": [
        "id",
        "user_id",
        "client_request_id",
        "request_hash",
        "request_snapshot",
        "surface",
        "profile_id",
        "display_title",
        "episode_count",
        "state",
        "result_payload",
        "result_hash",
        "billing_snapshot",
        "error_code",
        "error_message",
        "submitted_at",
        "updated_at",
        "completed_at"
      ]
    },
    {
      "name": "short_drama_projects",
      "feature": "short-drama",
      "columns": [
        "id",
        "user_id",
        "client_request_id",
        "request_hash",
        "title",
        "description",
        "project_type",
        "status",
        "source_payload",
        "settings",
        "revision",
        "created_at",
        "updated_at",
        "deleted_at"
      ]
    },
    {
      "name": "short_drama_project_versions",
      "feature": "short-drama",
      "columns": [
        "id",
        "project_id",
        "user_id",
        "version",
        "change_kind",
        "snapshot",
        "created_at"
      ]
    },
    {
      "name": "short_drama_entities",
      "feature": "short-drama",
      "columns": [
        "id",
        "project_id",
        "user_id",
        "entity_type",
        "entity_key",
        "name",
        "description",
        "attributes",
        "reference_asset_uri",
        "revision",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "short_drama_shots",
      "feature": "short-drama",
      "columns": [
        "id",
        "project_id",
        "user_id",
        "sequence",
        "scene_key",
        "title",
        "narration",
        "visual_description",
        "image_prompt",
        "video_prompt",
        "negative_prompt",
        "duration_seconds",
        "aspect_ratio",
        "status",
        "metadata",
        "revision",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "short_drama_prompt_snapshots",
      "feature": "short-drama",
      "columns": [
        "id",
        "project_id",
        "user_id",
        "stage",
        "agent_id",
        "prompt_version",
        "prompt_hash",
        "template_text",
        "variables",
        "model_public_id",
        "created_at"
      ]
    },
    {
      "name": "short_drama_jobs",
      "feature": "short-drama",
      "columns": [
        "id",
        "public_job_id",
        "project_id",
        "user_id",
        "shot_id",
        "prompt_snapshot_id",
        "client_request_id",
        "input_hash",
        "stage",
        "state",
        "provider",
        "upstream_task_id",
        "model_public_id",
        "model_id_snapshot",
        "request_payload",
        "result_payload",
        "billing_snapshot",
        "attempt_count",
        "max_attempts",
        "not_before",
        "lease_owner",
        "lease_token",
        "lease_expires_at",
        "progress",
        "error_code",
        "error_message",
        "created_at",
        "updated_at",
        "started_at",
        "completed_at"
      ]
    },
    {
      "name": "short_drama_assets",
      "feature": "short-drama",
      "columns": [
        "id",
        "project_id",
        "user_id",
        "shot_id",
        "job_id",
        "asset_role",
        "provider",
        "object_key",
        "stable_uri",
        "mime_type",
        "byte_size",
        "checksum_sha256",
        "metadata",
        "created_at",
        "updated_at",
        "deleted_at"
      ]
    },
    {
      "name": "short_drama_settlements",
      "feature": "short-drama",
      "columns": [
        "job_id",
        "project_id",
        "user_id",
        "public_job_id",
        "billing_mode",
        "credits_charged",
        "cash_charged",
        "cost_amount",
        "ledger_reference",
        "pricing_snapshot",
        "created_at"
      ]
    },
    {
      "name": "voice_nest_slots",
      "feature": "voice",
      "columns": [
        "id",
        "user_id",
        "slot_type",
        "status",
        "voice_id",
        "price",
        "purchased_at",
        "used_at",
        "created_at",
        "purchase_request_id"
      ]
    },
    {
      "name": "voice_clone_licenses",
      "feature": "voice",
      "columns": [
        "id",
        "license_key",
        "status",
        "user_id",
        "speaker_id",
        "voice_type",
        "voice_name",
        "max_trainings",
        "used_trainings",
        "created_at",
        "activated_at",
        "used_at",
        "updated_at"
      ]
    },
    {
      "name": "user_voices",
      "feature": "voice",
      "columns": [
        "id",
        "user_id",
        "voice_type",
        "voice_name",
        "speaker_id",
        "language",
        "source_info",
        "is_active",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "voice_nest_price_versions",
      "feature": "voice",
      "columns": [
        "id",
        "version",
        "unit_price_cash",
        "currency",
        "status",
        "effective_at",
        "metadata",
        "created_by",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "voice_nest_purchase_requests",
      "feature": "voice",
      "columns": [
        "id",
        "user_id",
        "idempotency_key",
        "request_payload",
        "price_version_id",
        "price_version",
        "unit_price_cash",
        "quantity",
        "total_price_cash",
        "wallet_operation_id",
        "wallet_result",
        "slot_ids",
        "status",
        "created_at",
        "completed_at"
      ]
    },
    {
      "name": "voice_training_authorization_jobs",
      "feature": "voice",
      "columns": [
        "id",
        "user_id",
        "job_key",
        "operation_kind",
        "request_fingerprint",
        "license_id",
        "reserved_used_before",
        "reserved_used_after",
        "max_trainings",
        "status",
        "provider_speaker_id",
        "voice_id",
        "result_payload",
        "release_reason",
        "provider_call_started_at",
        "provider_last_checked_at",
        "provider_last_status",
        "reconciliation_reason",
        "created_at",
        "reserved_at",
        "completed_at",
        "released_at",
        "updated_at"
      ]
    },
    {
      "name": "voice_generation_requests",
      "feature": "voice",
      "columns": [
        "id",
        "request_id",
        "user_id",
        "client_request_id",
        "phase",
        "payload_fingerprint",
        "model_id",
        "billing_idempotency_key",
        "quoted_credits",
        "charge_credits",
        "refunded_credits",
        "billing_exempt",
        "state",
        "wallet_operation_id",
        "refund_scopes",
        "asset_id",
        "generation_id",
        "provider_task_id",
        "response",
        "error",
        "price_snapshot",
        "metadata",
        "started_at",
        "updated_at",
        "completed_at",
        "refunded_at"
      ]
    },
    {
      "name": "video_models",
      "feature": "video-channel-health",
      "columns": [
        "id",
        "name",
        "protocol_type",
        "is_active",
        "is_hidden"
      ]
    },
    {
      "name": "video_channel_health",
      "feature": "video-channel-health",
      "columns": [
        "channel_id",
        "is_healthy",
        "consecutive_failures",
        "last_success_at",
        "last_fail_at",
        "updated_at",
        "health_protocol_version",
        "verification_state",
        "verified_at",
        "verification_evidence"
      ]
    },
    {
      "name": "video_tasks",
      "feature": "video-terminal",
      "columns": [
        "id",
        "user_id",
        "model_id",
        "task_label",
        "batch_id",
        "batch_topic",
        "card_index",
        "prompt",
        "first_frame_url",
        "last_frame_url",
        "reference_image_url",
        "aspect_ratio",
        "resolution",
        "duration_seconds",
        "status",
        "task_id_external",
        "content_url",
        "error_message",
        "price_charged",
        "completed_at",
        "storage_url",
        "video_url",
        "needs_proxy",
        "client_request_id",
        "request_fingerprint",
        "billing_price_yuan",
        "billing_cost_price_yuan",
        "billing_unit",
        "billing_quantity",
        "billing_state",
        "billing_operation_id",
        "billing_idempotency_key",
        "provider_result_url",
        "explicitly_free",
        "billing_exempt",
        "submission_error_code",
        "routing_snapshot",
        "routing_snapshot_hash",
        "routing_snapshot_version",
        "provider_dispatch_receipt",
        "provider_submission_receipt",
        "provider_dispatch_started_at",
        "provider_acknowledged_at",
        "provider_reconciliation_state"
      ]
    },
    {
      "name": "digital_human_long_jobs",
      "feature": "digital-human-long-history",
      "columns": [
        "id",
        "user_id",
        "state",
        "billing_state",
        "history_hidden_at",
        "created_at"
      ]
    },
    {
      "name": "payment_orders",
      "feature": "payment",
      "columns": [
        "id",
        "user_id",
        "trade_order_id",
        "amount",
        "payment_provider",
        "status",
        "type",
        "credits_amount",
        "paid_at",
        "provider_trade_order_id",
        "provider_transaction_id",
        "provider_paid_amount",
        "provider_confirmed_at",
        "refund_attempt_id",
        "provider_refund_id",
        "provider_refund_amount",
        "provider_refund_status",
        "refunded_at"
      ]
    },
    {
      "name": "payment_refund_attempts",
      "feature": "payment-refund-exactly-once",
      "columns": [
        "attempt_id",
        "trade_order_id",
        "user_id",
        "admin_user_id",
        "idempotency_key",
        "request_fingerprint",
        "reason",
        "state",
        "order_type",
        "payment_provider",
        "paid_amount",
        "wallet_amount",
        "wallet_operation_id",
        "release_operation_id",
        "lease_owner",
        "lease_token",
        "lease_until",
        "provider_call_started_at",
        "provider_refund_id",
        "provider_trade_order_id",
        "provider_refund_amount",
        "provider_status",
        "provider_response",
        "created_at",
        "updated_at",
        "completed_at",
        "released_at"
      ]
    },
    {
      "name": "canvas_documents",
      "feature": "canvas",
      "columns": [
        "id",
        "owner_id",
        "name",
        "revision",
        "document",
        "deleted",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "canvas_document_requests",
      "feature": "canvas",
      "columns": [
        "owner_id",
        "idempotency_key",
        "operation",
        "request_hash",
        "canvas_id",
        "response_revision",
        "created_at"
      ]
    },
    {
      "name": "platform_settings",
      "feature": "manju-config-storage",
      "columns": [
        "setting_key",
        "setting_value",
        "updated_at"
      ]
    },
    {
      "name": "manju_config_revisions",
      "feature": "manju-config",
      "columns": [
        "id",
        "environment",
        "domain",
        "version",
        "status",
        "payload",
        "payload_hash",
        "schema_version",
        "parent_revision_id",
        "created_by",
        "created_at",
        "updated_at",
        "published_at"
      ]
    },
    {
      "name": "manju_config_releases",
      "feature": "manju-config",
      "columns": [
        "id",
        "environment",
        "domain",
        "release_number",
        "revision_id",
        "previous_release_id",
        "release_kind",
        "rollback_of_release_id",
        "etag",
        "released_by",
        "created_at"
      ]
    },
    {
      "name": "manju_config_active",
      "feature": "manju-config",
      "columns": [
        "environment",
        "domain",
        "active_release_id",
        "active_revision_id",
        "etag",
        "updated_by",
        "updated_at"
      ]
    },
    {
      "name": "manju_config_audit",
      "feature": "manju-config",
      "columns": [
        "id",
        "action",
        "environment",
        "domain",
        "revision_id",
        "release_id",
        "previous_release_id",
        "actor_id",
        "detail",
        "created_at"
      ]
    },
    {
      "name": "manju_config_storage_state",
      "feature": "manju-config-storage",
      "columns": [
        "environment",
        "domain",
        "state",
        "generation",
        "compat_setting_key",
        "compat_storage_revision",
        "compat_active_release_id",
        "compat_active_revision_id",
        "compat_payload_hash",
        "native_active_release_id",
        "native_active_revision_id",
        "native_payload_hash",
        "cutover_at",
        "cutover_by",
        "last_verified_at",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "skill_packages",
      "feature": "skill-runtime",
      "columns": [
        "id",
        "slug",
        "display_name",
        "summary",
        "origin",
        "visibility",
        "runtime_kind",
        "lifecycle",
        "active_version_id",
        "latest_version_number",
        "metadata",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "skill_versions",
      "feature": "skill-runtime",
      "columns": [
        "id",
        "package_id",
        "version_number",
        "semver",
        "status",
        "payload",
        "payload_hash",
        "schema_version",
        "parent_version_id",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
        "published_at"
      ]
    },
    {
      "name": "skill_secret_bindings",
      "feature": "skill-runtime",
      "columns": [
        "id",
        "package_id",
        "environment",
        "secret_name",
        "secret_ref",
        "binding_status",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "agent_skill_installations",
      "feature": "skill-runtime",
      "columns": [
        "agent_id",
        "package_id",
        "version_id",
        "enabled",
        "priority",
        "install_config",
        "installed_by",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "user_skill_installations",
      "feature": "skill-runtime",
      "columns": [
        "user_id",
        "package_id",
        "version_id",
        "enabled",
        "priority",
        "install_config",
        "installed_by",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "skill_invocations",
      "feature": "skill-runtime",
      "columns": [
        "id",
        "user_id",
        "agent_id",
        "package_id",
        "version_id",
        "client_idempotency_key",
        "payload_fingerprint",
        "input",
        "state",
        "output",
        "error_code",
        "error_detail",
        "model_id",
        "billing_operation_id",
        "task_id",
        "provider_task_id",
        "asset_ids",
        "charged_credits",
        "charged_cash",
        "cost_snapshot",
        "created_at",
        "updated_at",
        "completed_at"
      ]
    },
    {
      "name": "skill_release_audit",
      "feature": "skill-runtime",
      "columns": [
        "id",
        "package_id",
        "version_id",
        "previous_version_id",
        "sequence",
        "action",
        "actor_id",
        "detail",
        "created_at"
      ]
    },
    {
      "name": "user_login_identifiers",
      "feature": "account-login-identity",
      "columns": [
        "identifier",
        "user_id"
      ]
    },
    {
      "name": "operation_flight_events",
      "feature": "platform-flight-recorder",
      "columns": [
        "id",
        "capture_sequence",
        "trace_id",
        "user_id",
        "username",
        "source",
        "domain",
        "operation",
        "phase",
        "outcome",
        "duration_ms",
        "http_status",
        "route",
        "error_code",
        "error_fingerprint",
        "summary",
        "metadata",
        "source_version",
        "build_id",
        "occurred_at",
        "created_at"
      ]
    },
    {
      "name": "member_activation_events",
      "feature": "member-lifecycle",
      "columns": [
        "id",
        "admin_id",
        "user_id",
        "member_status",
        "activation_method",
        "activation_reference",
        "activation_fee",
        "activation_note",
        "idempotency_key",
        "created_at"
      ]
    },
    {
      "name": "invitation_reward_grants",
      "feature": "invitation-reward-recipients",
      "columns": [
        "id",
        "invitation_record_id",
        "reward_stage",
        "status",
        "recipient_user_id",
        "eligibility_at",
        "credits",
        "cash_amount",
        "note",
        "drafted_at",
        "drafted_by",
        "sent_at",
        "sent_by",
        "send_request_key",
        "credit_operation_id",
        "cash_operation_id",
        "notification_id",
        "created_at",
        "updated_at",
        "package_assignment_id"
      ]
    },
    {
      "name": "offline_payment_receipts",
      "feature": "offline-payment-reconciliation",
      "columns": [
        "id",
        "user_id",
        "payment_channel",
        "business_type",
        "amount",
        "currency",
        "paid_at",
        "merchant_reference",
        "payer_reference_masked",
        "note",
        "status",
        "activation_event_id",
        "created_by",
        "idempotency_key",
        "created_at",
        "voided_at",
        "voided_by",
        "void_reason",
        "void_request_key"
      ]
    },
    {
      "name": "member_permission_profiles",
      "feature": "member-package-templates",
      "columns": [
        "profile_key",
        "version",
        "name",
        "description",
        "feature_navigation_keys",
        "agent_navigation_keys",
        "is_active",
        "created_at",
        "created_by",
        "membership_status",
        "duration_days",
        "credits",
        "cash_amount",
        "sort_order",
        "is_selectable",
        "change_request_key",
        "updated_at"
      ]
    },
    {
      "name": "member_permission_assignments",
      "feature": "member-permission-snapshots",
      "columns": [
        "user_id",
        "feature_navigation_keys",
        "agent_navigation_keys",
        "source_profile_key",
        "source_profile_version",
        "revision",
        "checksum",
        "source",
        "reason",
        "updated_by",
        "created_at",
        "updated_at"
      ]
    },
    {
      "name": "member_permission_events",
      "feature": "member-permission-audit",
      "columns": [
        "id",
        "user_id",
        "actor_id",
        "revision",
        "source",
        "request_key",
        "reason",
        "before_snapshot",
        "after_snapshot",
        "created_at"
      ]
    },
    {
      "name": "member_permission_resources",
      "feature": "member-permission-resource-catalog",
      "columns": [
        "resource_type",
        "resource_key",
        "label",
        "route",
        "description",
        "sort_order",
        "first_seen_at",
        "last_seen_at"
      ]
    },
    {
      "name": "member_package_assignments",
      "feature": "member-package-assignment",
      "columns": [
        "id",
        "user_id",
        "invitation_record_id",
        "profile_key",
        "profile_version",
        "package_name",
        "membership_status",
        "duration_days",
        "member_expires_at",
        "credits",
        "cash_amount",
        "feature_navigation_keys",
        "agent_navigation_keys",
        "permission_revision",
        "note",
        "assigned_by",
        "request_key",
        "credit_operation_id",
        "cash_operation_id",
        "notification_id",
        "created_at"
      ]
    },
    {
      "name": "member_package_automation_settings",
      "feature": "invited-registration-package-toggle",
      "columns": [
        "automation_key",
        "enabled",
        "profile_key",
        "revision",
        "configured_by",
        "last_request_key",
        "updated_at"
      ]
    },
    {
      "name": "member_package_automation_events",
      "feature": "invited-registration-package-toggle-audit",
      "columns": [
        "id",
        "automation_key",
        "revision",
        "enabled",
        "profile_key",
        "profile_version",
        "configured_by",
        "request_key",
        "created_at"
      ]
    },
    {
      "name": "member_package_automation_runs",
      "feature": "invited-registration-package-delivery-receipts",
      "columns": [
        "id",
        "invitation_record_id",
        "user_id",
        "profile_key",
        "profile_version",
        "status",
        "package_assignment_id",
        "result",
        "created_at"
      ]
    }
  ],
  "rpcs": [
    {
      "name": "register_invited_user_atomic",
      "feature": "registration",
      "arguments": [
        "p_email",
        "p_phone",
        "p_username",
        "p_password_hash",
        "p_display_name",
        "p_invitation_code",
        "p_session_id"
      ]
    },
    {
      "name": "issue_user_auth_session",
      "feature": "account-auth-sessions",
      "arguments": [
        "p_user_id",
        "p_session_id",
        "p_ip_hash",
        "p_user_agent_hash",
        "p_expires_at"
      ]
    },
    {
      "name": "revoke_user_auth_session",
      "feature": "account-auth-sessions",
      "arguments": [
        "p_user_id",
        "p_session_id",
        "p_reason"
      ]
    },
    {
      "name": "create_one_time_invitation_code",
      "feature": "single-use-invitation-registration",
      "arguments": [
        "p_user_id"
      ]
    },
    {
      "name": "set_member_activation_state_atomic",
      "feature": "member-lifecycle",
      "arguments": [
        "p_admin_id",
        "p_user_id",
        "p_member_status",
        "p_activation_method",
        "p_activation_reference",
        "p_activation_fee",
        "p_activation_note",
        "p_idempotency_key"
      ]
    },
    {
      "name": "assign_cami_to_user_atomic",
      "feature": "member-cami-assignment",
      "arguments": [
        "p_admin_id",
        "p_cami_id",
        "p_user_id",
        "p_idempotency_key"
      ]
    },
    {
      "name": "redeem_cami_membership_atomic",
      "feature": "member-cami-redemption",
      "arguments": [
        "p_user_id",
        "p_code",
        "p_idempotency_key"
      ]
    },
    {
      "name": "save_invitation_reward_decision_atomic",
      "feature": "invitation-reward-decision",
      "arguments": [
        "p_admin_id",
        "p_invitation_record_id",
        "p_reward_stage",
        "p_credits",
        "p_cash_amount",
        "p_note",
        "p_decision"
      ]
    },
    {
      "name": "send_invitation_reward_atomic",
      "feature": "invitation-reward-delivery",
      "arguments": [
        "p_admin_id",
        "p_invitation_record_id",
        "p_reward_stage",
        "p_idempotency_key"
      ]
    },
    {
      "name": "record_offline_payment_and_activate_member_atomic",
      "feature": "offline-payment-reconciliation",
      "arguments": [
        "p_admin_id",
        "p_user_id",
        "p_payment_channel",
        "p_business_type",
        "p_amount",
        "p_paid_at",
        "p_merchant_reference",
        "p_payer_reference_masked",
        "p_note",
        "p_idempotency_key"
      ]
    },
    {
      "name": "void_offline_payment_receipt_atomic",
      "feature": "offline-payment-reconciliation",
      "arguments": [
        "p_admin_id",
        "p_receipt_id",
        "p_void_reason",
        "p_idempotency_key"
      ]
    },
    {
      "name": "read_member_permission_snapshot",
      "feature": "member-permission-snapshots",
      "arguments": [
        "p_user_id"
      ]
    },
    {
      "name": "set_member_permissions_atomic",
      "feature": "member-permission-snapshots",
      "arguments": [
        "p_admin_id",
        "p_user_id",
        "p_feature_navigation_keys",
        "p_agent_navigation_keys",
        "p_expected_revision",
        "p_request_key",
        "p_reason",
        "p_source_profile_key",
        "p_source_profile_version"
      ]
    },
    {
      "name": "create_member_package_profile_version_atomic",
      "feature": "member-package-templates",
      "arguments": [
        "p_admin_id",
        "p_profile_key",
        "p_name",
        "p_description",
        "p_membership_status",
        "p_duration_days",
        "p_credits",
        "p_cash_amount",
        "p_feature_navigation_keys",
        "p_agent_navigation_keys",
        "p_request_key"
      ]
    },
    {
      "name": "assign_member_package_atomic",
      "feature": "member-package-assignment",
      "arguments": [
        "p_admin_id",
        "p_user_id",
        "p_invitation_record_id",
        "p_profile_key",
        "p_profile_version",
        "p_package_name",
        "p_membership_status",
        "p_duration_days",
        "p_credits",
        "p_cash_amount",
        "p_feature_navigation_keys",
        "p_agent_navigation_keys",
        "p_expected_permission_revision",
        "p_request_key",
        "p_note"
      ]
    },
    {
      "name": "set_invited_registration_package_automation_atomic",
      "feature": "invited-registration-package-toggle",
      "arguments": [
        "p_admin_id",
        "p_enabled",
        "p_request_key"
      ]
    },
    {
      "name": "enqueue_user_notification_once",
      "feature": "account-notification-delivery",
      "arguments": [
        "p_user_id",
        "p_type",
        "p_title",
        "p_content",
        "p_cami_code",
        "p_metadata"
      ]
    },
    {
      "name": "apply_wallet_operation_atomic",
      "feature": "wallet",
      "arguments": [
        "p_user_id",
        "p_operation_kind",
        "p_idempotency_key",
        "p_amount",
        "p_description",
        "p_metadata"
      ]
    },
    {
      "name": "claim_image_generation_request",
      "feature": "image-exactly-once",
      "arguments": [
        "p_record_id",
        "p_user_id",
        "p_user_hash",
        "p_client_idempotency_key",
        "p_client_trace_id",
        "p_payload_fingerprint"
      ]
    },
    {
      "name": "claim_image_generation_request_v2",
      "feature": "image-failure-history",
      "arguments": [
        "p_record_id",
        "p_user_id",
        "p_user_hash",
        "p_client_idempotency_key",
        "p_client_trace_id",
        "p_payload_fingerprint",
        "p_request_snapshot"
      ]
    },
    {
      "name": "save_image_generation_request",
      "feature": "image-exactly-once",
      "arguments": [
        "p_record_id",
        "p_payload_fingerprint",
        "p_state",
        "p_response"
      ]
    },
    {
      "name": "finalize_image_generation_delivery",
      "feature": "image-exactly-once",
      "arguments": [
        "p_record_id",
        "p_user_id",
        "p_storage_key",
        "p_storage_provider",
        "p_file_name",
        "p_file_size",
        "p_content_type",
        "p_source",
        "p_meta"
      ]
    },
    {
      "name": "claim_short_drama_script_request_atomic",
      "feature": "general-script-history",
      "arguments": [
        "p_user_id",
        "p_client_request_id",
        "p_request_hash",
        "p_request_snapshot",
        "p_surface",
        "p_profile_id",
        "p_display_title"
      ]
    },
    {
      "name": "finalize_short_drama_script_request_atomic",
      "feature": "general-script-history",
      "arguments": [
        "p_user_id",
        "p_client_request_id",
        "p_request_hash",
        "p_state",
        "p_result_payload",
        "p_result_hash",
        "p_billing_snapshot",
        "p_display_title",
        "p_episode_count",
        "p_error_code",
        "p_error_message"
      ]
    },
    {
      "name": "short_drama_create_project",
      "feature": "short-drama",
      "arguments": [
        "p_user_id",
        "p_client_request_id",
        "p_request_hash",
        "p_title",
        "p_description",
        "p_project_type",
        "p_source_payload",
        "p_settings"
      ]
    },
    {
      "name": "short_drama_update_project",
      "feature": "short-drama",
      "arguments": [
        "p_user_id",
        "p_project_id",
        "p_expected_revision",
        "p_patch"
      ]
    },
    {
      "name": "short_drama_delete_project",
      "feature": "short-drama",
      "arguments": [
        "p_user_id",
        "p_project_id",
        "p_expected_revision"
      ]
    },
    {
      "name": "purchase_voice_nest_slots_atomic",
      "feature": "voice",
      "arguments": [
        "p_user_id",
        "p_quantity",
        "p_idempotency_key"
      ]
    },
    {
      "name": "reserve_voice_training_authorization_atomic",
      "feature": "voice",
      "arguments": [
        "p_user_id",
        "p_job_key",
        "p_operation_kind",
        "p_request_fingerprint"
      ]
    },
    {
      "name": "release_voice_training_authorization_atomic",
      "feature": "voice",
      "arguments": [
        "p_user_id",
        "p_job_key",
        "p_operation_kind",
        "p_request_fingerprint",
        "p_reason"
      ]
    },
    {
      "name": "finalize_voice_training_authorization_atomic",
      "feature": "voice",
      "arguments": [
        "p_user_id",
        "p_job_key",
        "p_operation_kind",
        "p_request_fingerprint",
        "p_speaker_id",
        "p_voice_name",
        "p_language",
        "p_source_info",
        "p_result_payload"
      ]
    },
    {
      "name": "mark_voice_training_provider_attempt_atomic",
      "feature": "voice",
      "arguments": [
        "p_user_id",
        "p_job_key",
        "p_operation_kind",
        "p_request_fingerprint",
        "p_provider_speaker_id",
        "p_lifecycle_status",
        "p_provider_status",
        "p_result_payload",
        "p_provider_call_started",
        "p_reconciliation_reason"
      ]
    },
    {
      "name": "release_voice_training_terminal_atomic",
      "feature": "voice",
      "arguments": [
        "p_user_id",
        "p_job_key",
        "p_operation_kind",
        "p_request_fingerprint",
        "p_terminal_kind",
        "p_reason"
      ]
    },
    {
      "name": "finalize_voice_training_ready_atomic",
      "feature": "voice",
      "arguments": [
        "p_user_id",
        "p_job_key",
        "p_operation_kind",
        "p_request_fingerprint",
        "p_speaker_id",
        "p_voice_name",
        "p_language",
        "p_source_info",
        "p_result_payload"
      ]
    },
    {
      "name": "begin_voice_generation_atomic",
      "feature": "voice",
      "arguments": [
        "p_request_id",
        "p_user_id",
        "p_client_request_id",
        "p_phase",
        "p_payload_fingerprint",
        "p_model_id",
        "p_billing_idempotency_key",
        "p_quoted_credits",
        "p_charge_credits",
        "p_billing_exempt",
        "p_price_snapshot",
        "p_metadata"
      ]
    },
    {
      "name": "finalize_voice_generation_atomic",
      "feature": "voice",
      "arguments": [
        "p_request_id",
        "p_user_id",
        "p_payload_fingerprint",
        "p_asset_id",
        "p_generation_id",
        "p_provider_task_id",
        "p_response",
        "p_metadata"
      ]
    },
    {
      "name": "refund_voice_generation_atomic",
      "feature": "voice",
      "arguments": [
        "p_request_id",
        "p_user_id",
        "p_payload_fingerprint",
        "p_refund_credits",
        "p_refund_scope",
        "p_refund_idempotency_key",
        "p_reason",
        "p_error",
        "p_terminal"
      ]
    },
    {
      "name": "reserve_video_generation_task_atomic",
      "feature": "video-terminal",
      "arguments": [
        "p_task_id",
        "p_user_id",
        "p_model_id",
        "p_client_request_id",
        "p_request_fingerprint",
        "p_billing_price_yuan",
        "p_billing_cost_price_yuan",
        "p_billing_unit",
        "p_billing_quantity",
        "p_explicitly_free",
        "p_billing_exempt",
        "p_provider_task_id",
        "p_task_label",
        "p_batch_id",
        "p_batch_topic",
        "p_card_index",
        "p_prompt",
        "p_first_frame_url",
        "p_last_frame_url",
        "p_reference_image_url",
        "p_aspect_ratio",
        "p_resolution",
        "p_duration_seconds",
        "p_content_url"
      ]
    },
    {
      "name": "reserve_video_generation_task_budget_atomic",
      "feature": "video-budget-reservation",
      "arguments": [
        "p_task_id",
        "p_user_id",
        "p_model_id",
        "p_client_request_id",
        "p_request_fingerprint",
        "p_billing_price_yuan",
        "p_billing_cost_price_yuan",
        "p_billing_unit",
        "p_billing_quantity",
        "p_explicitly_free",
        "p_billing_exempt",
        "p_provider_task_id",
        "p_task_label",
        "p_batch_id",
        "p_batch_topic",
        "p_card_index",
        "p_prompt",
        "p_first_frame_url",
        "p_last_frame_url",
        "p_reference_image_url",
        "p_aspect_ratio",
        "p_resolution",
        "p_duration_seconds",
        "p_content_url"
      ]
    },
    {
      "name": "reserve_queued_digital_video_task_budget_atomic",
      "feature": "video-budget-reservation",
      "arguments": [
        "p_task",
        "p_dispatch"
      ]
    },
    {
      "name": "persist_video_routing_snapshot_atomic",
      "feature": "video-routing-snapshot",
      "arguments": [
        "p_task_id",
        "p_user_id",
        "p_request_fingerprint",
        "p_routing_snapshot"
      ]
    },
    {
      "name": "reserve_video_generation_task_routing_atomic",
      "feature": "video-routing-snapshot",
      "arguments": [
        "p_task_id",
        "p_user_id",
        "p_model_id",
        "p_client_request_id",
        "p_request_fingerprint",
        "p_billing_price_yuan",
        "p_billing_cost_price_yuan",
        "p_billing_unit",
        "p_billing_quantity",
        "p_explicitly_free",
        "p_billing_exempt",
        "p_routing_snapshot",
        "p_provider_task_id",
        "p_task_label",
        "p_batch_id",
        "p_batch_topic",
        "p_card_index",
        "p_prompt",
        "p_first_frame_url",
        "p_last_frame_url",
        "p_reference_image_url",
        "p_aspect_ratio",
        "p_resolution",
        "p_duration_seconds",
        "p_content_url"
      ]
    },
    {
      "name": "reserve_queued_digital_video_task_routing_atomic",
      "feature": "video-routing-snapshot",
      "arguments": [
        "p_task",
        "p_dispatch",
        "p_routing_snapshot"
      ]
    },
    {
      "name": "record_video_provider_dispatch_receipt_atomic",
      "feature": "video-provider-receipt",
      "arguments": [
        "p_task_id",
        "p_user_id",
        "p_request_fingerprint",
        "p_receipt"
      ]
    },
    {
      "name": "record_video_provider_submission_receipt_atomic",
      "feature": "video-provider-receipt",
      "arguments": [
        "p_task_id",
        "p_user_id",
        "p_request_fingerprint",
        "p_outcome",
        "p_provider_task_id",
        "p_receipt"
      ]
    },
    {
      "name": "expire_video_submission_confirmations_atomic",
      "feature": "video-provider-reconciliation",
      "arguments": [
        "p_user_id",
        "p_timeout_seconds"
      ]
    },
    {
      "name": "bind_video_provider_task_atomic",
      "feature": "video-terminal",
      "arguments": [
        "p_task_id",
        "p_user_id",
        "p_request_fingerprint",
        "p_provider_task_id",
        "p_content_url"
      ]
    },
    {
      "name": "fail_video_generation_submission_atomic",
      "feature": "video-terminal",
      "arguments": [
        "p_task_id",
        "p_user_id",
        "p_request_fingerprint",
        "p_error_code",
        "p_error_message"
      ]
    },
    {
      "name": "finalize_video_generation_task_atomic",
      "feature": "video-terminal",
      "arguments": [
        "p_task_id",
        "p_user_id",
        "p_provider_task_id",
        "p_stable_storage_url",
        "p_billing_operation_id",
        "p_legacy_h3_settled"
      ]
    },
    {
      "name": "autodl_h3_finalize_video",
      "feature": "autodl-h3-revenue-audit",
      "arguments": [
        "p_job_id",
        "p_public_task_id",
        "p_video_task_internal_id",
        "p_user_id",
        "p_model_id",
        "p_upstream_task_id",
        "p_owner",
        "p_lease_token",
        "p_result_asset_url",
        "p_price_yuan",
        "p_cost_price",
        "p_response_ms"
      ]
    },
    {
      "name": "fulfill_payment_order_with_evidence_atomic",
      "feature": "payment",
      "arguments": [
        "p_trade_order_id",
        "p_provider",
        "p_provider_trade_order_id",
        "p_provider_transaction_id",
        "p_paid_amount"
      ]
    },
    {
      "name": "claim_payment_refund_attempt_atomic",
      "feature": "payment-refund-exactly-once",
      "arguments": [
        "p_attempt_id",
        "p_trade_order_id",
        "p_admin_user_id",
        "p_idempotency_key",
        "p_request_fingerprint",
        "p_reason",
        "p_lease_owner",
        "p_lease_seconds"
      ]
    },
    {
      "name": "mark_payment_refund_provider_started_atomic",
      "feature": "payment-refund-exactly-once",
      "arguments": [
        "p_attempt_id",
        "p_request_fingerprint",
        "p_lease_owner",
        "p_lease_token"
      ]
    },
    {
      "name": "finalize_payment_refund_attempt_atomic",
      "feature": "payment-refund-exactly-once",
      "arguments": [
        "p_attempt_id",
        "p_request_fingerprint",
        "p_lease_owner",
        "p_lease_token",
        "p_terminal_state",
        "p_provider_status",
        "p_provider_trade_order_id",
        "p_provider_refund_id",
        "p_provider_refund_amount",
        "p_provider_response"
      ]
    },
    {
      "name": "save_canvas_document_atomic",
      "feature": "canvas",
      "arguments": [
        "p_owner_id",
        "p_canvas_id",
        "p_expected_revision",
        "p_idempotency_key",
        "p_operation",
        "p_request_hash",
        "p_name",
        "p_document"
      ]
    },
    {
      "name": "delete_canvas_document_atomic",
      "feature": "canvas",
      "arguments": [
        "p_owner_id",
        "p_canvas_id",
        "p_expected_revision",
        "p_idempotency_key",
        "p_request_hash"
      ]
    },
    {
      "name": "claim_extraction_attempt_atomic",
      "feature": "extraction-exactly-once",
      "arguments": [
        "p_record_id",
        "p_user_id",
        "p_client_request_id",
        "p_request_kind",
        "p_payload_fingerprint"
      ]
    },
    {
      "name": "checkpoint_extraction_request_atomic",
      "feature": "extraction-failure-history",
      "arguments": [
        "p_record_id",
        "p_user_id",
        "p_payload_fingerprint",
        "p_request_snapshot"
      ]
    },
    {
      "name": "finalize_extraction_attempt_atomic",
      "feature": "extraction-exactly-once",
      "arguments": [
        "p_record_id",
        "p_payload_fingerprint",
        "p_state",
        "p_http_status",
        "p_response",
        "p_provider_task_id",
        "p_provider_evidence",
        "p_billing_evidence",
        "p_error_code",
        "p_error_message"
      ]
    },
    {
      "name": "list_extraction_attempts_for_reconciliation",
      "feature": "extraction-exactly-once",
      "arguments": [
        "p_limit"
      ]
    },
    {
      "name": "reconcile_extraction_attempt_atomic",
      "feature": "extraction-exactly-once",
      "arguments": [
        "p_record_id",
        "p_expected_updated_at",
        "p_actor_user_id",
        "p_target_state",
        "p_http_status",
        "p_response",
        "p_response_fingerprint",
        "p_provider_task_id",
        "p_provider_evidence",
        "p_billing_evidence",
        "p_error_code",
        "p_error_message",
        "p_reason"
      ]
    },
    {
      "name": "claim_llm_request_attempt_atomic",
      "feature": "llm-exactly-once",
      "arguments": [
        "p_record_id",
        "p_user_id",
        "p_client_request_id",
        "p_payload_fingerprint",
        "p_lease_owner",
        "p_lease_seconds"
      ]
    },
    {
      "name": "mark_llm_request_provider_started_atomic",
      "feature": "llm-exactly-once",
      "arguments": [
        "p_record_id",
        "p_payload_fingerprint",
        "p_lease_owner",
        "p_lease_token"
      ]
    },
    {
      "name": "finalize_llm_request_attempt_atomic",
      "feature": "llm-exactly-once",
      "arguments": [
        "p_record_id",
        "p_payload_fingerprint",
        "p_lease_owner",
        "p_lease_token",
        "p_state",
        "p_http_status",
        "p_response_headers",
        "p_response_body",
        "p_response_fingerprint",
        "p_result_reference",
        "p_error_code",
        "p_error_message"
      ]
    },
    {
      "name": "reconcile_llm_request_attempt_atomic",
      "feature": "llm-exactly-once",
      "arguments": [
        "p_record_id",
        "p_expected_attempt_no",
        "p_actor_user_id",
        "p_target_state",
        "p_reason",
        "p_http_status",
        "p_response_headers",
        "p_response_body",
        "p_response_fingerprint",
        "p_result_reference"
      ]
    },
    {
      "name": "hide_digital_human_long_history_item",
      "feature": "digital-human-long-history",
      "arguments": [
        "p_user_id",
        "p_parent_id"
      ]
    },
    {
      "name": "save_manju_config_draft",
      "feature": "manju-config",
      "arguments": [
        "p_environment",
        "p_domain",
        "p_payload",
        "p_payload_hash",
        "p_schema_version",
        "p_revision_id",
        "p_expected_updated_at",
        "p_actor_id"
      ]
    },
    {
      "name": "publish_manju_config_revision",
      "feature": "manju-config",
      "arguments": [
        "p_revision_id",
        "p_expected_active_release_id",
        "p_actor_id"
      ]
    },
    {
      "name": "rollback_manju_config_release",
      "feature": "manju-config",
      "arguments": [
        "p_environment",
        "p_domain",
        "p_target_release_id",
        "p_expected_active_release_id",
        "p_actor_id"
      ]
    },
    {
      "name": "commit_manju_config_compat_envelope",
      "feature": "manju-config-storage",
      "arguments": [
        "p_environment",
        "p_domain",
        "p_expected_generation",
        "p_expected_storage_revision",
        "p_envelope"
      ]
    },
    {
      "name": "reconcile_manju_config_storage_to_compat",
      "feature": "manju-config-storage",
      "arguments": [
        "p_environment",
        "p_domain",
        "p_expected_generation",
        "p_expected_compat_storage_revision",
        "p_expected_compat_active_release_id",
        "p_expected_compat_active_revision_id",
        "p_expected_compat_payload_hash",
        "p_expected_native_active_release_id",
        "p_expected_native_active_revision_id",
        "p_expected_native_payload_hash",
        "p_allow_payload_divergence",
        "p_actor_id"
      ]
    },
    {
      "name": "reconcile_manju_config_storage_to_native",
      "feature": "manju-config-storage",
      "arguments": [
        "p_environment",
        "p_domain",
        "p_expected_generation",
        "p_expected_native_active_release_id",
        "p_expected_native_active_revision_id",
        "p_expected_native_payload_hash",
        "p_actor_id"
      ]
    },
    {
      "name": "cutover_manju_config_storage",
      "feature": "manju-config-storage",
      "arguments": [
        "p_environment",
        "p_domain",
        "p_expected_generation",
        "p_expected_compat_storage_revision",
        "p_expected_compat_active_release_id",
        "p_expected_compat_active_revision_id",
        "p_expected_compat_payload_hash",
        "p_expected_native_active_release_id",
        "p_expected_native_active_revision_id",
        "p_expected_native_payload_hash",
        "p_actor_id"
      ]
    },
    {
      "name": "save_skill_package_draft",
      "feature": "skill-runtime",
      "arguments": [
        "p_slug",
        "p_display_name",
        "p_summary",
        "p_origin",
        "p_visibility",
        "p_runtime_kind",
        "p_payload",
        "p_payload_hash",
        "p_semver",
        "p_schema_version",
        "p_metadata",
        "p_package_id",
        "p_version_id",
        "p_expected_updated_at",
        "p_actor_id"
      ]
    },
    {
      "name": "publish_skill_version",
      "feature": "skill-runtime",
      "arguments": [
        "p_version_id",
        "p_expected_active_version_id",
        "p_actor_id"
      ]
    },
    {
      "name": "rollback_skill_package_version",
      "feature": "skill-runtime",
      "arguments": [
        "p_package_id",
        "p_target_version_id",
        "p_expected_active_version_id",
        "p_actor_id"
      ]
    },
    {
      "name": "replace_agent_skill_installations",
      "feature": "skill-runtime",
      "arguments": [
        "p_agent_id",
        "p_installations",
        "p_actor_id"
      ]
    },
    {
      "name": "replace_user_skill_installations",
      "feature": "skill-runtime",
      "arguments": [
        "p_user_id",
        "p_installations",
        "p_actor_id"
      ]
    },
    {
      "name": "claim_skill_invocation",
      "feature": "skill-runtime",
      "arguments": [
        "p_invocation_id",
        "p_user_id",
        "p_agent_id",
        "p_package_id",
        "p_version_id",
        "p_client_idempotency_key",
        "p_payload_fingerprint",
        "p_input",
        "p_model_id",
        "p_billing_operation_id",
        "p_task_id"
      ]
    },
    {
      "name": "complete_skill_invocation",
      "feature": "skill-runtime",
      "arguments": [
        "p_invocation_id",
        "p_payload_fingerprint",
        "p_output",
        "p_model_id",
        "p_billing_operation_id",
        "p_task_id",
        "p_provider_task_id",
        "p_asset_ids",
        "p_charged_credits",
        "p_charged_cash",
        "p_cost_snapshot"
      ]
    },
    {
      "name": "fail_skill_invocation",
      "feature": "skill-runtime",
      "arguments": [
        "p_invocation_id",
        "p_payload_fingerprint",
        "p_failure_kind",
        "p_error_code",
        "p_error_detail",
        "p_billing_operation_id",
        "p_task_id"
      ]
    },
    {
      "name": "update_video_model_configuration_atomic",
      "feature": "video-model-configuration",
      "arguments": [
        "p_model_id",
        "p_expected",
        "p_updates"
      ]
    }
  ],
  "forbiddenRpcs": [
    {
      "name": "fulfill_payment_order_atomic",
      "reason": "legacy payment fulfillment does not require provider transaction evidence"
    }
  ],
  "referenceDataChecks": [
    {
      "id": "service-role-runtime",
      "mode": "protected-env-presence-and-service-role-openapi-probe",
      "requiredBeforeActivation": true
    },
    {
      "id": "voice-active-price",
      "mode": "separate-read-only-row-probe",
      "requiredBeforeActivation": true
    },
    {
      "id": "manju-production-active-release",
      "mode": "separate-read-only-row-probe",
      "requiredBeforeActivation": true
    },
    {
      "id": "manju-native-storage-state",
      "mode": "separate-read-only-row-probe",
      "requiredBeforeActivation": true
    },
    {
      "id": "active-video-model-current-protocol-health",
      "mode": "separate-read-only-row-probe",
      "protocolVersion": "video-channel-health.v2",
      "requiredBeforeActivation": true
    }
  ],
  "conditionalTables": [
    {
      "name": "autodl_h3_settlements",
      "condition": "legacy-h3-settlement-compatibility-enabled"
    }
  ]
} as const;

export default DATABASE_CONTRACT_SOURCE;
