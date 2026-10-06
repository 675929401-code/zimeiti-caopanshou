-- Reserve every login identifier in one namespace. The primary key provides
-- concurrency safety across username, phone and email, including case variants.
BEGIN;
LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.user_login_identifiers (
  identifier text PRIMARY KEY CHECK (identifier = lower(btrim(identifier)) AND identifier <> ''),
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS user_login_identifiers_owner_idx ON public.user_login_identifiers(user_id);
ALTER TABLE public.user_login_identifiers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_login_identifiers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_login_identifiers TO service_role;

-- Existing collisions stop this transaction; never choose an account or alter
-- a member's identity automatically during deployment.
INSERT INTO public.user_login_identifiers(identifier, user_id)
SELECT DISTINCT lower(btrim(value)), u.id
FROM public.users u
CROSS JOIN LATERAL unnest(ARRAY[u.username::text, u.phone, u.email]) value
WHERE nullif(btrim(value), '') IS NOT NULL
ON CONFLICT (identifier) DO UPDATE SET user_id = CASE
  WHEN public.user_login_identifiers.user_id = EXCLUDED.user_id THEN EXCLUDED.user_id
  ELSE NULL END;

CREATE OR REPLACE FUNCTION public.sync_user_login_identifiers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.user_login_identifiers WHERE user_id = NEW.id;
  INSERT INTO public.user_login_identifiers(identifier, user_id)
  SELECT DISTINCT lower(btrim(value)), NEW.id
  FROM unnest(ARRAY[NEW.username::text, NEW.phone, NEW.email]) value
  WHERE nullif(btrim(value), '') IS NOT NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_user_login_identifiers() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS users_sync_login_identifiers ON public.users;
CREATE TRIGGER users_sync_login_identifiers
AFTER INSERT OR UPDATE OF username, phone, email ON public.users
FOR EACH ROW EXECUTE FUNCTION public.sync_user_login_identifiers();
NOTIFY pgrst, 'reload schema';
COMMIT;
