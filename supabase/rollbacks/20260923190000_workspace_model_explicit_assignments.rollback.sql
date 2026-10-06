DO $$
DECLARE
  v_backup jsonb;
BEGIN
  SELECT setting_value::jsonb INTO v_backup
    FROM public.platform_settings
   WHERE setting_key = 'workspace_model_assignment_overrides_v1_backup_20260923';

  IF v_backup IS NULL THEN
    RAISE EXCEPTION 'workspace assignment migration backup is missing';
  ELSIF coalesce((v_backup->>'existed')::boolean, false) THEN
    INSERT INTO public.platform_settings (setting_key, setting_value, updated_at)
    VALUES (
      'workspace_model_assignment_overrides_v1',
      v_backup->>'setting_value',
      now()
    )
    ON CONFLICT (setting_key) DO UPDATE
      SET setting_value = excluded.setting_value,
          updated_at = excluded.updated_at;
  ELSE
    DELETE FROM public.platform_settings
     WHERE setting_key = 'workspace_model_assignment_overrides_v1';
  END IF;

  DELETE FROM public.platform_settings
   WHERE setting_key = 'workspace_model_assignment_overrides_v1_backup_20260923';
END $$;
