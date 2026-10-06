begin;

drop function if exists public.hide_autodl_h3_selfhost_models_v1(text);
drop function if exists public.activate_autodl_h3_selfhost_models_v1(text, integer, integer, text, jsonb, text, text);

commit;
