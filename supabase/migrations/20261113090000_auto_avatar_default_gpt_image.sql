BEGIN;

-- 2026-11-13：智能体头像默认模型切到 GPT-Image-2.5。
-- 头像生成器优先使用该设置；如果后台从未选择过模型，也优先挑 GPT-Image-2.5。
-- 模型 ID 是各环境 cover_models 的动态主键，不能写死本地/生产 ID。
WITH preferred AS (
  SELECT id
  FROM public.cover_models
  WHERE is_active IS TRUE
    AND is_hidden IS FALSE
    AND provider IS DISTINCT FROM 'retired_configuration'
    AND (model_name ILIKE 'gpt-image-2.5%' OR name ILIKE '%GPT-Image-2.5%')
  ORDER BY sort_order ASC NULLS LAST, created_at ASC
  LIMIT 1
)
INSERT INTO public.platform_settings (setting_key, setting_value, updated_at)
SELECT 'auto_avatar_model_id', id, now()
FROM preferred
ON CONFLICT (setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value,
    updated_at = EXCLUDED.updated_at;

-- 自动补齐开关默认开启；如果管理员已显式关闭，不覆盖。
INSERT INTO public.platform_settings (setting_key, setting_value, updated_at)
VALUES ('auto_avatar_enabled', 'true', now())
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;
