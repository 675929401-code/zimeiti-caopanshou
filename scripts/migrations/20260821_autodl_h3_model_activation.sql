begin;

create or replace function public.activate_autodl_h3_selfhost_models_v1(
  p_video_name text,
  p_video_duration_seconds integer,
  p_video_max_duration integer,
  p_video_admin_notes text,
  p_video_protocol_config jsonb,
  p_image_name text,
  p_profile_evidence_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.video_models%rowtype;
  v_image public.cover_models%rowtype;
  v_resolution text;
  v_combination text;
  v_duration integer;
  v_options_count integer := 0;
  v_supported_count integer := 0;
  v_selfhost_video_count integer := 0;
  v_selfhost_image_count integer := 0;
  v_video_updated integer := 0;
  v_image_updated integer := 0;
begin
  if p_profile_evidence_id !~ '^[A-Za-z0-9._:-]{8,160}$' then
    raise exception 'AUTODL_H3_PROFILE_EVIDENCE_INVALID';
  end if;
  if coalesce(length(trim(p_video_name)), 0) = 0
    or coalesce(length(trim(p_image_name)), 0) = 0
    or coalesce(length(trim(p_video_admin_notes)), 0) = 0 then
    raise exception 'AUTODL_H3_PROFILE_TEXT_INVALID';
  end if;
  if p_video_duration_seconds not in (5, 10, 15)
    or p_video_max_duration not in (5, 10, 15)
    or p_video_duration_seconds > p_video_max_duration then
    raise exception 'AUTODL_H3_PROFILE_DURATION_INVALID';
  end if;
  if jsonb_typeof(p_video_protocol_config) <> 'object'
    or jsonb_typeof(p_video_protocol_config->'resolution_options') <> 'array'
    or jsonb_typeof(p_video_protocol_config->'aspect_ratios') <> 'array'
    or jsonb_typeof(p_video_protocol_config->'input_pixel_size_by_resolution') <> 'object'
    or jsonb_typeof(p_video_protocol_config->'output_pixel_size_by_resolution') <> 'object'
    or jsonb_typeof(p_video_protocol_config->'gateway_output_tier_by_resolution') <> 'object'
    or jsonb_typeof(p_video_protocol_config->'resolution_status') <> 'object'
    or jsonb_typeof(p_video_protocol_config->'resolution_verification_mode') <> 'object'
    or jsonb_typeof(p_video_protocol_config->'duration_options') <> 'array'
    or jsonb_typeof(p_video_protocol_config->'direct_verified_combinations') <> 'array'
    or jsonb_typeof(p_video_protocol_config->'supported_combinations') <> 'array'
    or jsonb_typeof(p_video_protocol_config->'combination_verification_mode') <> 'object' then
    raise exception 'AUTODL_H3_PROFILE_SHAPE_INVALID';
  end if;
  if p_video_protocol_config#>>'{live_verification,evidence_id}' <> p_profile_evidence_id then
    raise exception 'AUTODL_H3_PROFILE_EVIDENCE_MISMATCH';
  end if;
  if p_video_protocol_config->>'default_resolution' is null then
    raise exception 'AUTODL_H3_PROFILE_DEFAULT_RESOLUTION_MISSING';
  end if;

  for v_resolution in
    select value from jsonb_array_elements_text(p_video_protocol_config->'resolution_options')
  loop
    v_options_count := v_options_count + 1;
    if v_resolution not in ('480p', '1080p', '2K') then
      raise exception 'AUTODL_H3_PROFILE_RESOLUTION_INVALID';
    end if;
    if not (
      (
        coalesce(p_video_protocol_config#>>array['resolution_status', v_resolution], '') = 'verified'
        and coalesce(p_video_protocol_config#>>array['resolution_verification_mode', v_resolution], '') = 'direct'
      )
      or (
        v_resolution = '1080p'
        and coalesce(p_video_protocol_config#>>array['resolution_status', v_resolution], '') = 'derived'
        and coalesce(p_video_protocol_config#>>array['resolution_verification_mode', v_resolution], '') = 'derived_from_higher_tier'
        and (p_video_protocol_config->'resolution_options' ? '2K')
        and coalesce(p_video_protocol_config#>>'{resolution_status,2K}', '') = 'verified'
        and coalesce(p_video_protocol_config#>>'{resolution_verification_mode,2K}', '') = 'direct'
      )
    ) then
      raise exception 'AUTODL_H3_PROFILE_RESOLUTION_UNVERIFIED';
    end if;
    if jsonb_typeof(p_video_protocol_config#>array['input_pixel_size_by_resolution', v_resolution]) <> 'object'
      or jsonb_typeof(p_video_protocol_config#>array['output_pixel_size_by_resolution', v_resolution]) <> 'object' then
      raise exception 'AUTODL_H3_PROFILE_PIXEL_MAP_MISSING';
    end if;
    if v_resolution = '480p'
      and p_video_protocol_config#>>array['gateway_output_tier_by_resolution', v_resolution] <> 'base' then
      raise exception 'AUTODL_H3_PROFILE_BASE_TIER_INVALID';
    end if;
    if v_resolution in ('1080p', '2K')
      and p_video_protocol_config#>>array['gateway_output_tier_by_resolution', v_resolution] <> v_resolution then
      raise exception 'AUTODL_H3_PROFILE_ENHANCED_TIER_INVALID';
    end if;
    if p_video_protocol_config#>>array['resolution_verification_mode', v_resolution] = 'direct'
      and not exists (
      select 1
      from jsonb_array_elements_text(p_video_protocol_config->'direct_verified_combinations') as combinations(value)
      where split_part(combinations.value, '|', 1) = v_resolution
    ) then
      raise exception 'AUTODL_H3_PROFILE_RESOLUTION_DIRECT_EVIDENCE_MISSING';
    end if;
  end loop;
  if v_options_count = 0 then
    raise exception 'AUTODL_H3_PROFILE_RESOLUTION_EMPTY';
  end if;
  for v_combination in
    select value from jsonb_array_elements_text(p_video_protocol_config->'direct_verified_combinations')
  loop
    if v_combination !~ '^(480p|1080p|2K)\|(5|10|15)\|(16:9|9:16|1:1)$'
      or not (p_video_protocol_config->'resolution_options' ? split_part(v_combination, '|', 1))
      or p_video_protocol_config#>>array['resolution_status', split_part(v_combination, '|', 1)] <> 'verified' then
      raise exception 'AUTODL_H3_PROFILE_DIRECT_COMBINATION_INVALID';
    end if;
  end loop;
  if jsonb_array_length(p_video_protocol_config->'direct_verified_combinations') = 0
    or coalesce(length(trim(p_video_protocol_config->>'verification_notice')), 0) = 0 then
    raise exception 'AUTODL_H3_PROFILE_VERIFICATION_DISCLOSURE_MISSING';
  end if;
  for v_combination in
    select value from jsonb_array_elements_text(p_video_protocol_config->'supported_combinations')
  loop
    v_supported_count := v_supported_count + 1;
    if v_combination !~ '^(480p|1080p|2K)\|(5|10|15)\|(16:9|9:16|1:1)$'
      or not (p_video_protocol_config->'resolution_options' ? split_part(v_combination, '|', 1))
      or not exists (
        select 1 from jsonb_array_elements_text(p_video_protocol_config->'duration_options') as supported_duration(value)
        where supported_duration.value = split_part(v_combination, '|', 2)
      )
      or not (p_video_protocol_config->'aspect_ratios' ? split_part(v_combination, '|', 3))
      or p_video_protocol_config#>>array['combination_verification_mode', v_combination]
        is distinct from (case
          when (p_video_protocol_config->'direct_verified_combinations' ? v_combination) then 'direct'
          else 'derived'
        end) then
      raise exception 'AUTODL_H3_PROFILE_SUPPORTED_COMBINATION_INVALID';
    end if;
  end loop;
  if v_supported_count <> jsonb_array_length(p_video_protocol_config->'resolution_options')
      * jsonb_array_length(p_video_protocol_config->'duration_options')
      * jsonb_array_length(p_video_protocol_config->'aspect_ratios') then
    raise exception 'AUTODL_H3_PROFILE_SUPPORTED_COMBINATION_INCOMPLETE';
  end if;
  for v_duration in
    select value::integer from jsonb_array_elements_text(p_video_protocol_config->'duration_options')
  loop
    if v_duration not in (5, 10, 15)
      or not exists (
        select 1
        from jsonb_array_elements_text(p_video_protocol_config->'direct_verified_combinations') as combinations(value)
        where split_part(combinations.value, '|', 2) = v_duration::text
      ) then
      raise exception 'AUTODL_H3_PROFILE_DURATION_UNVERIFIED';
    end if;
  end loop;
  if jsonb_array_length(p_video_protocol_config->'duration_options') = 0
    or not exists (
      select 1 from jsonb_array_elements_text(p_video_protocol_config->'duration_options') as durations(value)
      where durations.value::integer = p_video_duration_seconds
    )
    or not exists (
      select 1 from jsonb_array_elements_text(p_video_protocol_config->'duration_options') as durations(value)
      where durations.value::integer = p_video_max_duration
    )
    or p_video_max_duration <> (
      select max(durations.value::integer)
      from jsonb_array_elements_text(p_video_protocol_config->'duration_options') as durations(value)
    )
    or not exists (
      select 1
      from jsonb_array_elements_text(p_video_protocol_config->'direct_verified_combinations') as combinations(value)
      where split_part(combinations.value, '|', 1) = p_video_protocol_config->>'default_resolution'
        and split_part(combinations.value, '|', 2) = p_video_duration_seconds::text
    ) then
    raise exception 'AUTODL_H3_PROFILE_DEFAULT_COMBINATION_UNVERIFIED';
  end if;
  if not (p_video_protocol_config->'resolution_options' ? (p_video_protocol_config->>'default_resolution')) then
    raise exception 'AUTODL_H3_PROFILE_DEFAULT_RESOLUTION_DISABLED';
  end if;
  if p_video_protocol_config->>'billing_unit' <> 'per_use'
    or p_video_protocol_config->>'persist_result_immediately' <> 'true'
    or p_video_protocol_config->>'supports_remote_cancel' <> 'false'
    or p_video_protocol_config->>'auto_generate_reference' <> 'false' then
    raise exception 'AUTODL_H3_PROFILE_SAFETY_FLAGS_INVALID';
  end if;

  select count(*) into v_selfhost_video_count
  from public.video_models
  where provider = 'autodl_h3_selfhost' or protocol_type = 'autodl_h3_selfhost';
  select count(*) into v_selfhost_image_count
  from public.cover_models
  where provider = 'autodl_h3_selfhost';
  if v_selfhost_video_count <> 1 or v_selfhost_image_count <> 1 then
    raise exception 'AUTODL_H3_TARGET_CARDINALITY_INVALID';
  end if;

  select * into v_video
  from public.video_models
  where id = 'minimax-h3-turbo-selfhost-pro6000'
  for update;
  select * into v_image
  from public.cover_models
  where id = 'qwen-image-2512-hq-selfhost-pro6000'
  for update;

  if not found or v_video.id is null or v_image.id is null then
    raise exception 'AUTODL_H3_TARGETS_MISSING';
  end if;
  if v_video.is_hidden is distinct from true or v_image.is_hidden is distinct from true then
    raise exception 'AUTODL_H3_TARGETS_NOT_BOTH_HIDDEN';
  end if;
  if v_video.provider <> 'autodl_h3_selfhost'
    or v_video.protocol_type <> 'autodl_h3_selfhost'
    or v_video.model_name <> 'minimax-h3-turbo'
    or v_video.api_endpoint <> 'http://127.0.0.1:16011/v1/video/generations'
    or v_video.api_key <> 'secret://autodl-h3-selfhost'
    or v_video.is_active is distinct from true then
    raise exception 'AUTODL_H3_VIDEO_BINDING_INVALID';
  end if;
  if v_image.provider <> 'autodl_h3_selfhost'
    or v_image.model_name <> 'qwen-image-2512-hq'
    or v_image.api_endpoint <> 'http://127.0.0.1:16011/v1'
    or v_image.api_key <> 'secret://autodl-h3-selfhost'
    or v_image.is_active is distinct from true then
    raise exception 'AUTODL_H3_IMAGE_BINDING_INVALID';
  end if;

  update public.video_models
  set name = p_video_name,
      duration_seconds = p_video_duration_seconds,
      max_duration = p_video_max_duration,
      admin_notes = p_video_admin_notes,
      api_protocol_config = p_video_protocol_config,
      is_hidden = false
  where id = 'minimax-h3-turbo-selfhost-pro6000'
    and is_hidden = true;
  get diagnostics v_video_updated = row_count;

  update public.cover_models
  set name = p_image_name,
      is_hidden = false,
      updated_at = now()
  where id = 'qwen-image-2512-hq-selfhost-pro6000'
    and is_hidden = true;
  get diagnostics v_image_updated = row_count;

  if v_video_updated <> 1 or v_image_updated <> 1 then
    raise exception 'AUTODL_H3_ATOMIC_ACTIVATION_ROWCOUNT_INVALID';
  end if;

  return jsonb_build_object(
    'activated', true,
    'video_id', 'minimax-h3-turbo-selfhost-pro6000',
    'image_id', 'qwen-image-2512-hq-selfhost-pro6000',
    'profile_evidence_id', p_profile_evidence_id
  );
end;
$$;

create or replace function public.hide_autodl_h3_selfhost_models_v1(
  p_reason_evidence_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.video_models%rowtype;
  v_image public.cover_models%rowtype;
  v_selfhost_video_count integer := 0;
  v_selfhost_image_count integer := 0;
  v_video_updated integer := 0;
  v_image_updated integer := 0;
begin
  if p_reason_evidence_id !~ '^[A-Za-z0-9._:-]{8,160}$' then
    raise exception 'AUTODL_H3_HIDE_EVIDENCE_INVALID';
  end if;

  select count(*) into v_selfhost_video_count
  from public.video_models
  where provider = 'autodl_h3_selfhost' or protocol_type = 'autodl_h3_selfhost';
  select count(*) into v_selfhost_image_count
  from public.cover_models
  where provider = 'autodl_h3_selfhost';
  if v_selfhost_video_count <> 1 or v_selfhost_image_count <> 1 then
    raise exception 'AUTODL_H3_TARGET_CARDINALITY_INVALID';
  end if;

  select * into v_video
  from public.video_models
  where id = 'minimax-h3-turbo-selfhost-pro6000'
  for update;
  select * into v_image
  from public.cover_models
  where id = 'qwen-image-2512-hq-selfhost-pro6000'
  for update;

  if v_video.id is null or v_image.id is null then
    raise exception 'AUTODL_H3_TARGETS_MISSING';
  end if;
  if v_video.is_hidden is distinct from false or v_image.is_hidden is distinct from false then
    raise exception 'AUTODL_H3_TARGETS_NOT_BOTH_VISIBLE';
  end if;
  if v_video.provider <> 'autodl_h3_selfhost'
    or v_video.protocol_type <> 'autodl_h3_selfhost'
    or v_video.model_name <> 'minimax-h3-turbo'
    or v_video.api_endpoint <> 'http://127.0.0.1:16011/v1/video/generations'
    or v_video.api_key <> 'secret://autodl-h3-selfhost'
    or v_image.provider <> 'autodl_h3_selfhost'
    or v_image.model_name <> 'qwen-image-2512-hq'
    or v_image.api_endpoint <> 'http://127.0.0.1:16011/v1'
    or v_image.api_key <> 'secret://autodl-h3-selfhost' then
    raise exception 'AUTODL_H3_HIDE_BINDING_INVALID';
  end if;

  update public.video_models
  set is_hidden = true
  where id = 'minimax-h3-turbo-selfhost-pro6000'
    and is_hidden = false;
  get diagnostics v_video_updated = row_count;

  update public.cover_models
  set is_hidden = true,
      updated_at = now()
  where id = 'qwen-image-2512-hq-selfhost-pro6000'
    and is_hidden = false;
  get diagnostics v_image_updated = row_count;

  if v_video_updated <> 1 or v_image_updated <> 1 then
    raise exception 'AUTODL_H3_ATOMIC_HIDE_ROWCOUNT_INVALID';
  end if;

  return jsonb_build_object(
    'hidden', true,
    'video_id', 'minimax-h3-turbo-selfhost-pro6000',
    'image_id', 'qwen-image-2512-hq-selfhost-pro6000',
    'reason_evidence_id', p_reason_evidence_id
  );
end;
$$;

revoke all on function public.activate_autodl_h3_selfhost_models_v1(text, integer, integer, text, jsonb, text, text) from public;
revoke all on function public.activate_autodl_h3_selfhost_models_v1(text, integer, integer, text, jsonb, text, text) from anon;
revoke all on function public.activate_autodl_h3_selfhost_models_v1(text, integer, integer, text, jsonb, text, text) from authenticated;
grant execute on function public.activate_autodl_h3_selfhost_models_v1(text, integer, integer, text, jsonb, text, text) to service_role;

revoke all on function public.hide_autodl_h3_selfhost_models_v1(text) from public;
revoke all on function public.hide_autodl_h3_selfhost_models_v1(text) from anon;
revoke all on function public.hide_autodl_h3_selfhost_models_v1(text) from authenticated;
grant execute on function public.hide_autodl_h3_selfhost_models_v1(text) to service_role;

notify pgrst, 'reload schema';

commit;
