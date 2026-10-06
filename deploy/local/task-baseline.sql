-- NEW LOCAL DATABASE ONLY. No imported users, balances, chats or generation history.

-- Source column/default/PK/FK metadata SHA256: 3574061c7bea69b734dbac351f53f471e40e5146e5e7ee32c9fc452a52cdd5ab

-- Application-required unique constraints are explicit below; this is not a production backup.

BEGIN;

DO $$ BEGIN IF current_database() <> 'zimeiti_local' OR inet_server_addr() <> '127.0.0.1'::inet THEN RAISE EXCEPTION 'LOCAL_DATABASE_ONLY'; END IF; END $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') THEN RAISE EXCEPTION 'LOCAL_BASELINE_REQUIRES_EMPTY_DATABASE'; END IF; END $$;

GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

CREATE TABLE public."llm_models" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" character varying(200) NOT NULL,
  "model_name" character varying(200) NOT NULL,
  "description" text DEFAULT '',
  "category" character varying(50) DEFAULT '通用',
  "api_endpoint" character varying(500) DEFAULT '',
  "api_key" text DEFAULT '',
  "proxy_url" character varying(500) DEFAULT '',
  "billing_mode" character varying(20) DEFAULT 'credit',
  "cost_per_use" numeric DEFAULT 10,
  "cost_price" numeric DEFAULT 0,
  "token_billing_enabled" boolean DEFAULT false,
  "input_cost_per_million" numeric,
  "output_cost_per_million" numeric,
  "cached_cost_per_million" numeric,
  "profit_margin" numeric,
  "token_rounding_unit" integer DEFAULT 0,
  "deep_thinking_type" integer DEFAULT 0,
  "deduct_deep_think" numeric DEFAULT 1,
  "max_context_rounds" integer DEFAULT 12,
  "max_context_tokens" integer DEFAULT 64000,
  "max_reply_tokens" integer DEFAULT 4096,
  "timeout" integer DEFAULT 300,
  "enable_web_search" boolean DEFAULT false,
  "temperature" numeric,
  "response_format" character varying(20) DEFAULT NULL,
  "is_active" boolean DEFAULT true,
  "is_hidden" boolean DEFAULT false,
  "sort_order" integer DEFAULT 0,
  "user_access" character varying(32) DEFAULT 'available',
  "admin_notes" text DEFAULT '',
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "frequency_limit" integer DEFAULT 50,
  "image_parsing" character varying(20) DEFAULT 'none',
  "file_parsing" character varying(20) DEFAULT 'none',
  "icon_url" text DEFAULT '',
  "api_protocol_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."popup_pushes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "title" character varying(200) DEFAULT '' NOT NULL,
  "content" text DEFAULT '' NOT NULL,
  "wechat_id" character varying(100) DEFAULT '',
  "wechat_label" character varying(200) DEFAULT '添加微信获取卡密',
  "wechat_note" character varying(200) DEFAULT '',
  "show_cami_entry" boolean DEFAULT true,
  "show_trial_plans" boolean DEFAULT false,
  "target_audience" character varying(30) DEFAULT 'inactive_members' NOT NULL,
  "is_enabled" boolean DEFAULT true,
  "priority" integer DEFAULT 0,
  "dismiss_behavior" character varying(20) DEFAULT 'session',
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."voice_billing_records" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "model_id" text NOT NULL,
  "model_name" text NOT NULL,
  "voice_type" text DEFAULT 'tts' NOT NULL,
  "total_char" integer DEFAULT 0 NOT NULL,
  "text_char" integer DEFAULT 0 NOT NULL,
  "instruction_char" integer DEFAULT 0 NOT NULL,
  "cost_per_10k" numeric DEFAULT 0 NOT NULL,
  "profit_rate" numeric DEFAULT 0 NOT NULL,
  "real_cost" numeric DEFAULT 0 NOT NULL,
  "charge_amount" numeric DEFAULT 0 NOT NULL,
  "profit" numeric DEFAULT 0 NOT NULL,
  "balance_before" numeric DEFAULT 0,
  "balance_after" numeric DEFAULT 0,
  "status" text DEFAULT 'pending' NOT NULL,
  "voice_id" text,
  "audio_url" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."security_events" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "event_type" character varying(50) NOT NULL,
  "risk_level" character varying(20) DEFAULT 'medium' NOT NULL,
  "ip_address" character varying(100),
  "ip_hash" character varying(32),
  "user_id" character varying(100),
  "username" character varying(100),
  "display_name" character varying(200),
  "user_agent" text,
  "path" character varying(500),
  "method" character varying(10),
  "details" text,
  "raw_data" text,
  "blocked" boolean DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now(),
  "source" character varying(20) DEFAULT 'user_client',
  "phone" character varying(20),
  PRIMARY KEY ("id")
);

CREATE TABLE public."trial_plans" (
  "id" character varying(64) DEFAULT gen_random_uuid()::text NOT NULL,
  "name" character varying(100) NOT NULL,
  "description" text DEFAULT '',
  "credits" integer DEFAULT 0 NOT NULL,
  "duration_days" integer DEFAULT 7 NOT NULL,
  "is_active" boolean DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."cover_templates" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" character varying(100) NOT NULL,
  "description" text,
  "category" character varying(50) DEFAULT 'general',
  "preview_url" text,
  "source_url" text,
  "canvas_width" integer DEFAULT 1080 NOT NULL,
  "canvas_height" integer DEFAULT 1440 NOT NULL,
  "regions" jsonb,
  "background" jsonb,
  "decorations" jsonb,
  "style_tags" text[],
  "use_count" integer DEFAULT 0,
  "is_active" boolean DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."cash_transactions" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "amount" numeric NOT NULL,
  "balance_after" numeric NOT NULL,
  "type" character varying(20) NOT NULL,
  "description" text,
  "reference_id" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "metadata" jsonb,
  PRIMARY KEY ("id")
);

CREATE TABLE public."agent_memories" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "content" text NOT NULL,
  "source_conversation_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."plugins" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "subtype" text DEFAULT '' NOT NULL,
  "description" text DEFAULT '',
  "icon" text DEFAULT '',
  "is_active" boolean DEFAULT true,
  "config" jsonb NOT NULL,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "price_per_use" numeric DEFAULT 0,
  "cost_price" numeric DEFAULT 0,
  "price_unit" text DEFAULT '次',
  "role" text DEFAULT '',
  PRIMARY KEY ("id")
);

CREATE TABLE public."prompt_versions" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" text NOT NULL,
  "prompt" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."payment_methods" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" character varying(50) NOT NULL,
  "code" character varying(30) NOT NULL,
  "icon" character varying(20) DEFAULT 'wallet' NOT NULL,
  "provider" character varying(50) DEFAULT 'xunhupay' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "config" jsonb,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."trial_plan_agents" (
  "id" character varying(64) DEFAULT gen_random_uuid()::text NOT NULL,
  "plan_id" character varying(64) NOT NULL,
  "agent_id" character varying(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."invitation_benefits" (
  "id" character varying(36) DEFAULT gen_random_uuid()::text NOT NULL,
  "title" character varying(255) DEFAULT '邀请福利' NOT NULL,
  "content" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."invitation_codes" (
  "id" character varying(36) DEFAULT gen_random_uuid()::text NOT NULL,
  "user_id" uuid NOT NULL,
  "code" character varying(8) NOT NULL,
  "is_used" boolean DEFAULT false NOT NULL,
  "used_by" uuid,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_permanent" boolean DEFAULT false NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."voice_clone_licenses" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "license_key" character varying(20) NOT NULL,
  "status" character varying(20) DEFAULT 'active' NOT NULL,
  "user_id" uuid,
  "speaker_id" character varying(100),
  "voice_type" character varying(20),
  "voice_name" character varying(100),
  "max_trainings" integer DEFAULT 15 NOT NULL,
  "used_trainings" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  "used_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."user_files" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "storage_key" text NOT NULL,
  "storage_provider" character varying(20) DEFAULT 'coze_s3' NOT NULL,
  "file_name" character varying(512) NOT NULL,
  "file_category" character varying(20) DEFAULT 'other' NOT NULL,
  "file_size" bigint DEFAULT 0 NOT NULL,
  "content_type" character varying(128) DEFAULT 'application/octet-stream' NOT NULL,
  "source" character varying(128),
  "meta" jsonb,
  "is_public" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."conversation_messages" (
  "id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "user_id" text,
  "agent_id" text NOT NULL,
  "role" text NOT NULL,
  "content" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "reasoning_content" text DEFAULT '',
  PRIMARY KEY ("id")
);

CREATE TABLE public."diagnostic_logs" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "username" character varying(100),
  "display_name" character varying(100),
  "problem_type" character varying(50) NOT NULL,
  "severity" character varying(20) DEFAULT 'medium' NOT NULL,
  "description" text,
  "context" jsonb,
  "status" character varying(20) DEFAULT 'pending',
  "admin_notes" text,
  "conversation_id" character varying(100),
  "agent_id" character varying(100),
  "agent_name" character varying(200),
  "user_agent" text,
  "page_url" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."operation_flight_events" (
  "capture_sequence" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "trace_id" text NOT NULL,
  "user_id" text,
  "username" text,
  "source" text NOT NULL,
  "domain" text NOT NULL,
  "operation" text NOT NULL,
  "phase" text NOT NULL,
  "outcome" text NOT NULL,
  "duration_ms" bigint,
  "http_status" integer,
  "route" text,
  "error_code" text,
  "error_fingerprint" text,
  "summary" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source_version" text,
  "build_id" text,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operation_flight_source_check" CHECK ("source" IN ('browser', 'database', 'server', 'worker', 'system', 'admin')),
  CONSTRAINT "operation_flight_domain_check" CHECK ("domain" IN ('chat', 'image', 'video', 'voice', 'extract', 'payment', 'auth', 'storage', 'admin', 'system', 'other')),
  CONSTRAINT "operation_flight_outcome_check" CHECK ("outcome" IN ('in_progress', 'success', 'warning', 'error', 'cancelled', 'unknown')),
  CONSTRAINT "operation_flight_trace_format" CHECK ("trace_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'),
  CONSTRAINT "operation_flight_metadata_object" CHECK (jsonb_typeof("metadata") = 'object'),
  PRIMARY KEY ("id")
);

CREATE INDEX operation_flight_events_occurred_idx ON public."operation_flight_events" ("occurred_at" DESC);
CREATE INDEX operation_flight_events_trace_idx ON public."operation_flight_events" ("trace_id", "occurred_at" ASC);
CREATE INDEX operation_flight_events_trace_sequence_idx ON public."operation_flight_events" ("trace_id", "occurred_at" ASC, "capture_sequence" ASC);
CREATE INDEX operation_flight_events_user_idx ON public."operation_flight_events" ("user_id", "occurred_at" DESC) WHERE "user_id" IS NOT NULL;
CREATE INDEX operation_flight_events_domain_outcome_idx ON public."operation_flight_events" ("domain", "outcome", "occurred_at" DESC);

CREATE TABLE public."health_checks" (
  "id" character varying DEFAULT gen_random_uuid()::text NOT NULL,
  "status" character varying(10) DEFAULT 'healthy' NOT NULL,
  "checks" jsonb NOT NULL,
  "error_count" integer DEFAULT 0,
  "warning_count" integer DEFAULT 0,
  "auto_fixed_count" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."autodl_h3_instance_state" (
  "instance_uuid" text NOT NULL,
  "lifecycle_state" text DEFAULT 'UNKNOWN' NOT NULL,
  "last_activity_at" timestamp with time zone,
  "idle_since" timestamp with time zone,
  "lease_owner" text,
  "lease_token" bigint DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "activity_epoch" bigint DEFAULT 0 NOT NULL,
  "shutdown_epoch" bigint,
  "last_error_code" text,
  "last_error_message" text,
  "state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("instance_uuid")
);

CREATE TABLE public."nav_items" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "icon" text DEFAULT '🛠️' NOT NULL,
  "description" text DEFAULT '',
  "status" text DEFAULT 'active' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "icon_type" text DEFAULT 'emoji' NOT NULL,
  "icon_image" text DEFAULT '',
  PRIMARY KEY ("id")
);

CREATE TABLE public."revenue_records" (
  "id" text DEFAULT gen_random_uuid()::text NOT NULL,
  "user_id" uuid NOT NULL,
  "model_id" text NOT NULL,
  "task_id" text,
  "cost_price" numeric DEFAULT 0 NOT NULL,
  "selling_price" numeric DEFAULT 0 NOT NULL,
  "profit" numeric,
  "is_admin" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "record_type" text DEFAULT 'video' NOT NULL,
  "credits_charged" numeric DEFAULT 0,
  "cash_charged" numeric DEFAULT 0,
  PRIMARY KEY ("id")
);

CREATE TABLE public."voice_models" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "model_name" text DEFAULT '' NOT NULL,
  "voice_type" text DEFAULT 'tts' NOT NULL,
  "provider" text DEFAULT 'aliyun' NOT NULL,
  "api_endpoint" text DEFAULT '',
  "api_key" text DEFAULT '',
  "billing_mode" text DEFAULT 'per_use',
  "cost_per_use" numeric DEFAULT 0,
  "cost_price" numeric DEFAULT 0,
  "is_active" boolean DEFAULT true,
  "is_hidden" boolean DEFAULT false,
  "sort_order" integer DEFAULT 0,
  "admin_notes" text DEFAULT '',
  "description" text DEFAULT '',
  "language" text DEFAULT '中文',
  "sample_rate" integer DEFAULT 22050,
  "output_format" text DEFAULT 'mp3',
  "max_duration" integer DEFAULT 300,
  "supports_streaming" boolean DEFAULT true,
  "supports_emotion" boolean DEFAULT false,
  "supports_clone" boolean DEFAULT false,
  "total_requests" integer DEFAULT 0,
  "success_count" integer DEFAULT 0,
  "fail_count" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "cost_per_10k" numeric DEFAULT 0,
  "profit_rate" numeric DEFAULT 0.1,
  PRIMARY KEY ("id")
);

CREATE TABLE public."payment_orders" (
  "id" text DEFAULT gen_random_uuid()::text NOT NULL,
  "user_id" uuid NOT NULL,
  "trade_order_id" text NOT NULL,
  "platform_order_id" text,
  "type" text DEFAULT 'credits' NOT NULL,
  "amount" numeric NOT NULL,
  "credits_amount" integer,
  "status" text DEFAULT 'pending' NOT NULL,
  "payment_method" text,
  "payment_url" text,
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expire_at" timestamp with time zone,
  "payment_provider" character varying(20) DEFAULT 'xunhupay',
  PRIMARY KEY ("id")
);

CREATE TABLE public."autodl_h3_jobs" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "public_task_id" text NOT NULL,
  "client_request_id" text NOT NULL,
  "video_task_internal_id" text,
  "user_id" character varying NOT NULL,
  "model_id" text NOT NULL,
  "instance_uuid" text NOT NULL,
  "request_payload" jsonb NOT NULL,
  "state" text DEFAULT 'ACCEPTED' NOT NULL,
  "upstream_task_id" text,
  "content_url" text,
  "result_asset_url" text,
  "progress" integer DEFAULT 0 NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "not_before" timestamp with time zone,
  "lease_owner" text,
  "lease_token" bigint DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  PRIMARY KEY ("id")
);

CREATE TABLE public."prompt_guard_logs" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "agent_name" text NOT NULL,
  "agent_source" text NOT NULL,
  "message_preview" text NOT NULL,
  "risk_level" text NOT NULL,
  "reason" text NOT NULL,
  "matched_patterns" jsonb,
  "blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "user_display_name" character varying,
  "full_message" text,
  PRIMARY KEY ("id")
);

CREATE TABLE public."video_channel_health" (
  "channel_id" text NOT NULL,
  "total_requests" integer DEFAULT 0,
  "success_count" integer DEFAULT 0,
  "fail_count" integer DEFAULT 0,
  "timeout_count" integer DEFAULT 0,
  "avg_response_ms" integer DEFAULT 0,
  "last_success_at" timestamp with time zone,
  "last_fail_at" timestamp with time zone,
  "last_error" text,
  "consecutive_failures" integer DEFAULT 0,
  "is_healthy" boolean DEFAULT true,
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("channel_id")
);

CREATE TABLE public."video_models" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "provider" text DEFAULT '' NOT NULL,
  "api_endpoint" text DEFAULT '' NOT NULL,
  "api_key" text DEFAULT '' NOT NULL,
  "protocol_type" text DEFAULT 'openai' NOT NULL,
  "request_template" jsonb,
  "response_mapping" jsonb,
  "price_per_use" numeric DEFAULT 0.2 NOT NULL,
  "currency" text DEFAULT 'CNY' NOT NULL,
  "duration_seconds" integer DEFAULT 10,
  "max_duration" integer DEFAULT 10,
  "supports_image_input" boolean DEFAULT true,
  "is_active" boolean DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "admin_notes" text DEFAULT '',
  "model_name" text,
  "cost_price" numeric DEFAULT 0,
  "is_hidden" boolean DEFAULT false,
  "total_requests" integer DEFAULT 0,
  "success_count" integer DEFAULT 0,
  "fail_count" integer DEFAULT 0,
  "last_tested_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "billing_mode" character varying(20) DEFAULT 'per_use',
  "token_billing_enabled" boolean DEFAULT false,
  "input_cost_per_million" numeric,
  "output_cost_per_million" numeric,
  "profit_margin" numeric,
  "token_rounding_unit" integer DEFAULT 0,
  "cost_per_use" numeric,
  "api_protocol_config" jsonb,
  "requires_image" boolean DEFAULT false,
  PRIMARY KEY ("id")
);

CREATE TABLE public."registration_codes" (
  "email" character varying(255) NOT NULL,
  "code" character varying(10) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0,
  PRIMARY KEY ("email")
);

CREATE TABLE public."announcements" (
  "id" character varying(36) DEFAULT gen_random_uuid()::text NOT NULL,
  "title" character varying(255) NOT NULL,
  "content" text NOT NULL,
  "is_pinned" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now(),
  "image_url" text DEFAULT '',
  "link_url" text DEFAULT '',
  "link_text" text DEFAULT '',
  PRIMARY KEY ("id")
);

CREATE TABLE public."credit_transactions" (
  "id" character varying(36) DEFAULT gen_random_uuid()::text NOT NULL,
  "user_id" uuid NOT NULL,
  "type" character varying(20) NOT NULL,
  "amount" numeric NOT NULL,
  "description" character varying(255),
  "balance_after" numeric NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb,
  "transaction_type" character varying,
  PRIMARY KEY ("id")
);

CREATE TABLE public."skills" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" character varying(100) NOT NULL,
  "display_name" character varying(200) NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "icon" character varying(20) DEFAULT '🔧',
  "category" character varying(50) DEFAULT 'general',
  "skill_type" character varying(30) DEFAULT 'coze_workflow' NOT NULL,
  "config" jsonb NOT NULL,
  "tool_definition" jsonb NOT NULL,
  "trigger_signals" text DEFAULT '' NOT NULL,
  "is_active" boolean DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."formatter_history" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "title" text,
  "original_text" text NOT NULL,
  "result_text" text NOT NULL,
  "rules" jsonb,
  "char_count" integer DEFAULT 0,
  "line_count" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "expires_at" timestamp with time zone DEFAULT (now() + interval '7 days'),
  PRIMARY KEY ("id")
);

CREATE TABLE public."invitation_records" (
  "id" character varying(36) DEFAULT gen_random_uuid()::text NOT NULL,
  "inviter_id" uuid NOT NULL,
  "invitee_id" uuid NOT NULL,
  "invitee_activated" boolean DEFAULT false NOT NULL,
  "invited_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  "reward_sent" boolean DEFAULT false,
  PRIMARY KEY ("id")
);

CREATE TABLE public."system_logs" (
  "id" character varying DEFAULT gen_random_uuid()::text NOT NULL,
  "level" character varying(10) DEFAULT 'info' NOT NULL,
  "source" character varying(50) DEFAULT 'system' NOT NULL,
  "message" text NOT NULL,
  "details" jsonb,
  "stack_trace" text,
  "resolved" boolean DEFAULT false,
  "auto_fixed" boolean DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."auto_fixes" (
  "id" character varying DEFAULT gen_random_uuid()::text NOT NULL,
  "issue_type" character varying(100) NOT NULL,
  "description" text NOT NULL,
  "fix_action" text NOT NULL,
  "fix_result" jsonb,
  "success" boolean DEFAULT false,
  "health_check_id" character varying,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."cami_codes" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "code" character varying(50) NOT NULL,
  "credits" numeric DEFAULT 0,
  "cash_balance" numeric DEFAULT 0,
  "duration_days" integer DEFAULT 0,
  "plan_name" character varying(100),
  "is_used" boolean DEFAULT false,
  "used_by" uuid,
  "used_at" timestamp with time zone,
  "batch_id" character varying(50),
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "allowed_categories" jsonb,
  PRIMARY KEY ("id")
);

CREATE TABLE public."user_trial_activations" (
  "id" character varying(64) DEFAULT gen_random_uuid()::text NOT NULL,
  "user_id" uuid NOT NULL,
  "plan_id" character varying(64) NOT NULL,
  "activated_at" timestamp with time zone DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "credits_granted" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."platform_settings" (
  "id" character varying(36) DEFAULT gen_random_uuid()::text NOT NULL,
  "setting_key" character varying(128) NOT NULL,
  "setting_value" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."agent_skills" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" character varying(100) NOT NULL,
  "skill_id" uuid NOT NULL,
  "is_enabled" boolean DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."balance_audit_log" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "user_id" uuid NOT NULL,
  "field" character varying(50) NOT NULL,
  "old_value" numeric NOT NULL,
  "new_value" numeric NOT NULL,
  "delta" numeric NOT NULL,
  "source" character varying(100) NOT NULL,
  "source_id" character varying(200),
  "operator_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."agents" (
  "id" character varying(36) DEFAULT gen_random_uuid()::text NOT NULL,
  "name" character varying(128) NOT NULL,
  "description" text,
  "avatar" character varying(512),
  "category" character varying(64) DEFAULT '通用' NOT NULL,
  "source" character varying(20) DEFAULT 'llm' NOT NULL,
  "bot_id" character varying(128),
  "model" character varying(64) DEFAULT 'glm-5.1',
  "system_prompt" text,
  "cost_per_message" integer DEFAULT 10 NOT NULL,
  "sort_order" integer DEFAULT 0,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now(),
  "coze_coding_api_url" text,
  "coze_coding_project_id" text,
  "coze_coding_api_token" text,
  "preset_fields" jsonb,
  "deleted_at" timestamp with time zone,
  "base_fee" numeric DEFAULT 0,
  "output_style" jsonb,
  "enable_think_tags" boolean DEFAULT false,
  "proxy_url" text DEFAULT '',
  "deep_thinking_type" smallint DEFAULT 0,
  "deduct_deep_think" numeric DEFAULT 1,
  "max_context_rounds" integer DEFAULT 12,
  "max_context_tokens" integer DEFAULT 64000,
  "max_reply_tokens" integer DEFAULT 4096,
  "timeout" integer DEFAULT 300,
  "enable_web_search" boolean DEFAULT false,
  "temperature" numeric,
  "response_format" character varying(20) DEFAULT NULL,
  "token_billing_enabled" boolean DEFAULT false,
  "input_cost_per_million" numeric,
  "output_cost_per_million" numeric,
  "cached_cost_per_million" numeric,
  "profit_margin" numeric,
  "token_rounding_unit" integer DEFAULT 0,
  "user_access" character varying(20) DEFAULT 'available',
  "admin_notes" text DEFAULT '',
  "model_id" uuid,
  "cover_url" text DEFAULT '',
  "frequency_limit" integer DEFAULT 50,
  "image_parsing" character varying(20) DEFAULT 'none',
  "file_parsing" character varying(20) DEFAULT 'none',
  "guide_message" text DEFAULT '',
  "enable_knowledge_base" boolean DEFAULT false,
  "knowledge_base_id" text DEFAULT '',
  "enable_memory" boolean DEFAULT false,
  PRIMARY KEY ("id")
);

CREATE TABLE public."segmenter_history" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "title" text,
  "original_text" text NOT NULL,
  "result_text" text NOT NULL,
  "mode" text DEFAULT 'paragraph',
  "rules" jsonb,
  "char_count" integer DEFAULT 0,
  "segment_count" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "expires_at" timestamp with time zone DEFAULT (now() + interval '7 days'),
  PRIMARY KEY ("id")
);

CREATE TABLE public."user_voices" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "voice_type" text NOT NULL,
  "voice_name" text NOT NULL,
  "speaker_id" text NOT NULL,
  "language" text DEFAULT 'zh',
  "demo_audio_url" text,
  "source_info" jsonb,
  "is_active" boolean DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."login_logs" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" character varying NOT NULL,
  "username" character varying,
  "display_name" character varying,
  "ip_address" character varying,
  "user_agent" text,
  "login_method" character varying DEFAULT 'password',
  "status" character varying DEFAULT 'success',
  "fail_reason" character varying,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."voice_favorites" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "voice_id" text NOT NULL,
  "voice_name" text NOT NULL,
  "engine" text NOT NULL,
  "gender" text,
  "language" text,
  "style_tags" text[],
  "is_cloned" boolean DEFAULT false,
  "clone_id" text,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."chat_models" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "model_name" character varying(255) NOT NULL,
  "display_name" character varying(255) NOT NULL,
  "icon_url" text DEFAULT '',
  "description" text DEFAULT '',
  "proxy_url" text DEFAULT '',
  "api_key" text DEFAULT '',
  "is_active" boolean DEFAULT true,
  "sort_order" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."cover_models" (
  "id" text NOT NULL,
  "name" text NOT NULL,
  "model_name" text NOT NULL,
  "provider" text DEFAULT 'vectorengine',
  "api_endpoint" text NOT NULL,
  "api_key" text NOT NULL,
  "cost_price" numeric DEFAULT 0,
  "selling_price" numeric DEFAULT 0,
  "is_active" boolean DEFAULT true,
  "is_hidden" boolean DEFAULT false,
  "supports_image_input" boolean DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "billing_mode" character varying(20) DEFAULT 'per_use',
  "token_billing_enabled" boolean DEFAULT false,
  "input_cost_per_million" numeric,
  "output_cost_per_million" numeric,
  "profit_margin" numeric,
  "token_rounding_unit" integer DEFAULT 0,
  "cost_per_use" numeric,
  "sort_order" integer DEFAULT 0,
  PRIMARY KEY ("id")
);

CREATE TABLE public."shortcut_icons" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "title" character varying(50) NOT NULL,
  "icon_svg" text NOT NULL,
  "icon_color" character varying(20) DEFAULT '#7C5CFF',
  "link_type" character varying(20) DEFAULT 'internal',
  "link_value" character varying(500) NOT NULL,
  "sort_order" integer DEFAULT 0,
  "is_active" boolean DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."video_tasks" (
  "id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "model_id" text NOT NULL,
  "prompt" text DEFAULT '' NOT NULL,
  "first_frame_url" text DEFAULT '',
  "last_frame_url" text DEFAULT '',
  "reference_image_url" text DEFAULT '',
  "aspect_ratio" text DEFAULT '16:9',
  "resolution" text DEFAULT '1280x720',
  "duration_seconds" integer DEFAULT 10,
  "status" text DEFAULT 'pending',
  "task_id_external" text DEFAULT '',
  "video_url" text DEFAULT '',
  "thumbnail_url" text DEFAULT '',
  "error_message" text DEFAULT '',
  "price_charged" numeric DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "completed_at" timestamp with time zone,
  "task_label" text DEFAULT '',
  "content_url" text,
  "batch_id" text DEFAULT '',
  "batch_topic" text DEFAULT '',
  "card_index" integer DEFAULT 0,
  "storage_url" text,
  "needs_proxy" boolean DEFAULT false,
  PRIMARY KEY ("id")
);

CREATE TABLE public."users" (
  "id" character varying(36) DEFAULT gen_random_uuid()::text NOT NULL,
  "username" character varying(64) NOT NULL,
  "password_hash" character varying(255) NOT NULL,
  "display_name" character varying(128) NOT NULL,
  "role" character varying(20) DEFAULT 'student' NOT NULL,
  "credits" numeric DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now(),
  "phone" text,
  "email" text,
  "session_id" character varying(64),
  "cash_balance" numeric DEFAULT 0,
  "status" character varying DEFAULT 'active',
  "allowed_categories" jsonb,
  "total_credits_recharged" numeric DEFAULT 0 NOT NULL,
  "total_credits_consumed" numeric DEFAULT 0 NOT NULL,
  "total_cash_recharged" numeric DEFAULT 0 NOT NULL,
  "total_cash_consumed" numeric DEFAULT 0 NOT NULL,
  "last_sign_in_at" timestamp with time zone,
  "member_status" character varying(20) DEFAULT 'inactive',
  "member_expires_at" timestamp with time zone,
  "theme_preference" character varying(20) DEFAULT NULL,
  "invited_by" uuid,
  "voice_clone_authorized" boolean DEFAULT false NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE public."user_appearance_preferences" (
  "user_id" character varying(36) NOT NULL,
  "theme_key" character varying(32) NOT NULL,
  "mode_preference" character varying(16) NOT NULL,
  "ip_hash" character varying(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_appearance_preferences_theme_check" CHECK ("theme_key" IN ('lattice', 'soft-white', 'crystal-aurora', 'stellar-blue')),
  CONSTRAINT "user_appearance_preferences_mode_check" CHECK ("mode_preference" IN ('system', 'light', 'dark')),
  PRIMARY KEY ("user_id")
);

CREATE TABLE public."dead_letter_billing" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  "user_id" character varying,
  "billing_type" character varying(20) DEFAULT 'credits' NOT NULL,
  "amount" numeric NOT NULL,
  "agent_id" character varying,
  "agent_name" character varying,
  "model" character varying,
  "error_message" text,
  "retry_count" integer DEFAULT 0,
  "last_retry_at" timestamp with time zone,
  "resolved" boolean DEFAULT false,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."autodl_h3_settlements" (
  "job_id" uuid NOT NULL,
  "public_task_id" text NOT NULL,
  "video_task_internal_id" text NOT NULL,
  "user_id" character varying NOT NULL,
  "model_id" text NOT NULL,
  "upstream_task_id" text NOT NULL,
  "stable_asset_url" text NOT NULL,
  "price_yuan" numeric DEFAULT 0 NOT NULL,
  "cost_price" numeric DEFAULT 0 NOT NULL,
  "charged_yuan" numeric DEFAULT 0 NOT NULL,
  "response_ms" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("job_id")
);

CREATE TABLE public."prompt_guard_rules" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "keyword" text NOT NULL,
  "risk_level" text DEFAULT 'high' NOT NULL,
  "is_enabled" boolean DEFAULT true,
  "category" text DEFAULT 'custom',
  "description" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  PRIMARY KEY ("id")
);

CREATE TABLE public."user_notifications" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "type" character varying(30) DEFAULT 'system' NOT NULL,
  "title" character varying(200) NOT NULL,
  "content" text DEFAULT '' NOT NULL,
  "cami_code" character varying(50),
  "is_read" boolean DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now(),
  "read_at" timestamp with time zone,
  "metadata" jsonb,
  PRIMARY KEY ("id")
);

CREATE TABLE public."categories" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" character varying(50) NOT NULL,
  "icon" character varying(10) DEFAULT '',
  "sort_order" integer DEFAULT 0,
  "is_active" boolean DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "visibility" character varying(20) DEFAULT 'normal',
  "description" text DEFAULT '',
  PRIMARY KEY ("id")
);

CREATE TABLE public."conversations" (
  "id" text NOT NULL,
  "user_id" uuid,
  "agent_id" text NOT NULL,
  "title" text DEFAULT '',
  "source" text DEFAULT 'coze_coding',
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "messages_key" text,
  PRIMARY KEY ("id")
);

ALTER TABLE public."trial_plan_agents" ADD FOREIGN KEY ("plan_id") REFERENCES public."trial_plans" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."autodl_h3_jobs" ADD FOREIGN KEY ("user_id") REFERENCES public."users" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."auto_fixes" ADD FOREIGN KEY ("health_check_id") REFERENCES public."health_checks" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."user_trial_activations" ADD FOREIGN KEY ("plan_id") REFERENCES public."trial_plans" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."agent_skills" ADD FOREIGN KEY ("agent_id") REFERENCES public."agents" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."agent_skills" ADD FOREIGN KEY ("skill_id") REFERENCES public."skills" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."agents" ADD FOREIGN KEY ("model_id") REFERENCES public."llm_models" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."video_tasks" ADD FOREIGN KEY ("model_id") REFERENCES public."video_models" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."autodl_h3_settlements" ADD FOREIGN KEY ("job_id") REFERENCES public."autodl_h3_jobs" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."autodl_h3_settlements" ADD FOREIGN KEY ("user_id") REFERENCES public."users" ("id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public."user_appearance_preferences" ADD FOREIGN KEY ("user_id") REFERENCES public."users" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX "local_users_username_unique" ON public."users" ("username");

CREATE INDEX "local_user_appearance_preferences_expires_at_idx" ON public."user_appearance_preferences" ("expires_at");

CREATE UNIQUE INDEX "local_platform_settings_setting_key_unique" ON public."platform_settings" ("setting_key");

CREATE UNIQUE INDEX "local_agent_skills_agent_id_skill_id_unique" ON public."agent_skills" ("agent_id", "skill_id");

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;

ALTER TABLE public."llm_models" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."llm_models" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."popup_pushes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."popup_pushes" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."voice_billing_records" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."voice_billing_records" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."security_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."security_events" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."trial_plans" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."trial_plans" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."cover_templates" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."cover_templates" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."cash_transactions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."cash_transactions" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."agent_memories" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."agent_memories" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."plugins" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."plugins" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."prompt_versions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."prompt_versions" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."payment_methods" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."payment_methods" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."trial_plan_agents" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."trial_plan_agents" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."invitation_benefits" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."invitation_benefits" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."invitation_codes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."invitation_codes" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."voice_clone_licenses" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."voice_clone_licenses" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."user_files" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."user_files" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."conversation_messages" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."conversation_messages" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."diagnostic_logs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."diagnostic_logs" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."operation_flight_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."operation_flight_events" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."health_checks" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."health_checks" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."autodl_h3_instance_state" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."autodl_h3_instance_state" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."nav_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."nav_items" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."revenue_records" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."revenue_records" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."voice_models" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."voice_models" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."payment_orders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."payment_orders" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."autodl_h3_jobs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."autodl_h3_jobs" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."prompt_guard_logs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."prompt_guard_logs" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."video_channel_health" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."video_channel_health" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."video_models" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."video_models" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."registration_codes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."registration_codes" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."announcements" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."announcements" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."credit_transactions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."credit_transactions" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."skills" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."skills" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."formatter_history" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."formatter_history" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."invitation_records" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."invitation_records" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."system_logs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."system_logs" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."auto_fixes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."auto_fixes" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."cami_codes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."cami_codes" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."user_trial_activations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."user_trial_activations" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."platform_settings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."platform_settings" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."agent_skills" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."agent_skills" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."balance_audit_log" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."balance_audit_log" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."agents" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."agents" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."segmenter_history" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."segmenter_history" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."user_voices" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."user_voices" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."login_logs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."login_logs" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."voice_favorites" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."voice_favorites" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."chat_models" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."chat_models" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."cover_models" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."cover_models" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."shortcut_icons" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."shortcut_icons" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."video_tasks" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."video_tasks" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."users" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."users" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."user_appearance_preferences" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."user_appearance_preferences" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."dead_letter_billing" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."dead_letter_billing" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."autodl_h3_settlements" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."autodl_h3_settlements" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."prompt_guard_rules" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."prompt_guard_rules" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."user_notifications" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."user_notifications" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."categories" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."categories" FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public."conversations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY local_service_access ON public."conversations" FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
