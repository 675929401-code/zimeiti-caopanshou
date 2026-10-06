-- Commerce configuration is private to the main-site service role.
-- PostgREST omits relations from its API cache when the active role has no
-- table privileges, so these grants are part of the configuration contract.

GRANT USAGE ON SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.commerce_cards,
  public.commerce_card_versions,
  public.commerce_prompt_versions,
  public.commerce_knowledge_documents,
  public.commerce_operation_routes,
  public.commerce_config_releases,
  public.commerce_model_acceptance_evidence
TO service_role;

GRANT EXECUTE ON FUNCTION public.publish_commerce_config_release_atomic(uuid, uuid)
TO service_role;

-- The isolated Windows validation stack connects PostgREST through a
-- non-inheriting local owner role. Keep this conditional so hosted/production
-- databases without the local role preserve their existing role topology.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zimeiti_owner') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      public.commerce_cards,
      public.commerce_card_versions,
      public.commerce_prompt_versions,
      public.commerce_knowledge_documents,
      public.commerce_operation_routes,
      public.commerce_config_releases,
      public.commerce_model_acceptance_evidence
    TO zimeiti_owner;
  END IF;
END;
$$;
