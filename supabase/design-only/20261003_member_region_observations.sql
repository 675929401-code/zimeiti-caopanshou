-- DESIGN ONLY — DO NOT APPLY FROM THE NORMAL MIGRATION RUNNER.
-- MEMBER-REGION-DISTRIBUTION phase 1 persistence proposal.
-- This file documents the future durable source. It has not been applied to
-- local, staging, or production databases by this task.
--
-- Privacy boundary:
--   * no raw IP and no precise street address are stored here;
--   * profile residence, recent access region, and business service city are
--     separate dimensions and must never be inferred from one another;
--   * the read function publishes only cohorts with k >= 5;
--   * direct user identifiers never leave the aggregation function.

BEGIN;

CREATE TABLE IF NOT EXISTS public.member_region_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  dimension text NOT NULL CHECK (dimension IN (
    'profile_residence',
    'recent_access_region',
    'business_service_city'
  )),
  source_type text NOT NULL CHECK (source_type IN (
    'member_self_reported',
    'admin_verified',
    'versioned_business_profile',
    'trusted_offline_geoip'
  )),
  source_record_id text,
  purpose_code text NOT NULL CHECK (length(trim(purpose_code)) BETWEEN 3 AND 80),
  legal_basis text NOT NULL CHECK (legal_basis IN (
    'consent',
    'contract',
    'legitimate_interest',
    'legal_obligation'
  )),
  consent_status text NOT NULL CHECK (consent_status IN (
    'granted',
    'notice_acknowledged',
    'not_required_with_basis'
  )),
  consent_recorded_at timestamptz,
  consent_reference text,
  country_code varchar(2) NOT NULL,
  province_code varchar(24),
  province_name varchar(80),
  city_code varchar(24),
  city_name varchar(80),
  district_code varchar(24),
  district_name varchar(80),
  precision text NOT NULL CHECK (precision IN ('country', 'province', 'city', 'district')),
  confidence numeric(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  resolver_name text,
  resolver_version text,
  source_address_hmac varchar(128),
  network_anonymity_signal text CHECK (network_anonymity_signal IN (
    'none_detected',
    'vpn_suspected',
    'proxy_suspected',
    'shared_exit_suspected',
    'unknown'
  )),
  observed_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  valid_until timestamptz,
  retained_until timestamptz NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_by varchar(36),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (retained_until > collected_at),
  CHECK (
    dimension <> 'recent_access_region'
    OR (
      source_type = 'trusted_offline_geoip'
      AND resolver_name IS NOT NULL
      AND resolver_version IS NOT NULL
      AND source_address_hmac IS NOT NULL
    )
  ),
  CHECK (
    dimension = 'recent_access_region'
    OR consent_status = 'granted'
  )
);

COMMENT ON TABLE public.member_region_observations IS
  'DESIGN-ONLY member region facts. Stores coarse administrative areas, provenance, purpose/legal basis, confidence and collection time; never raw IP or a precise address.';
COMMENT ON COLUMN public.member_region_observations.source_address_hmac IS
  'Keyed, non-reversible correlation value for access observations. It is not returned by the aggregate read function.';

CREATE UNIQUE INDEX IF NOT EXISTS member_region_observations_one_current_per_dimension
  ON public.member_region_observations(user_id, dimension)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS member_region_observations_distribution_lookup
  ON public.member_region_observations(
    dimension,
    is_current,
    province_code,
    city_code,
    district_code,
    collected_at DESC
  );

CREATE INDEX IF NOT EXISTS member_region_observations_retention
  ON public.member_region_observations(retained_until);

ALTER TABLE public.member_region_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.member_region_observations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.read_admin_member_region_distribution(
  p_min_cohort_size integer DEFAULT 5
)
RETURNS TABLE (
  row_kind text,
  dimension text,
  region_level text,
  country_code text,
  province_code text,
  province_name text,
  city_code text,
  city_name text,
  district_code text,
  district_name text,
  member_count bigint,
  observed_member_count bigint,
  observation_count bigint,
  suppressed_bucket_count bigint,
  privacy_suppressed boolean,
  average_confidence numeric,
  latest_collected_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH dimension_catalog(dimension) AS (
    VALUES
      ('profile_residence'::text),
      ('recent_access_region'::text),
      ('business_service_city'::text)
  ),
  latest_member_region AS (
    SELECT DISTINCT ON (observation.dimension, observation.user_id)
      observation.dimension,
      observation.user_id,
      observation.country_code,
      observation.province_code,
      observation.province_name,
      observation.city_code,
      observation.city_name,
      observation.district_code,
      observation.district_name,
      observation.precision,
      observation.confidence,
      observation.collected_at
    FROM public.member_region_observations observation
    INNER JOIN public.users member
      ON member.id = observation.user_id
     AND member.role = 'student'
    WHERE observation.is_current = true
      AND observation.retained_until > now()
      AND observation.purpose_code <> ''
      AND observation.consent_status IN ('granted', 'notice_acknowledged', 'not_required_with_basis')
    ORDER BY observation.dimension, observation.user_id, observation.collected_at DESC, observation.id DESC
  ),
  grouped_regions AS (
    SELECT
      source.dimension,
      source.precision AS region_level,
      source.country_code,
      source.province_code,
      source.province_name,
      source.city_code,
      source.city_name,
      source.district_code,
      source.district_name,
      count(*)::bigint AS member_count,
      avg(source.confidence)::numeric AS average_confidence,
      max(source.collected_at) AS latest_collected_at
    FROM latest_member_region source
    GROUP BY
      source.dimension,
      source.precision,
      source.country_code,
      source.province_code,
      source.province_name,
      source.city_code,
      source.city_name,
      source.district_code,
      source.district_name
  ),
  dimension_summary AS (
    SELECT
      catalog.dimension,
      count(source.user_id)::bigint AS observed_member_count,
      count(source.user_id)::bigint AS observation_count,
      max(source.collected_at) AS latest_collected_at
    FROM dimension_catalog catalog
    LEFT JOIN latest_member_region source ON source.dimension = catalog.dimension
    GROUP BY catalog.dimension
  ),
  suppressed_summary AS (
    SELECT
      catalog.dimension,
      count(grouped.dimension) FILTER (
        WHERE grouped.member_count < greatest(5, p_min_cohort_size)
      )::bigint AS suppressed_bucket_count
    FROM dimension_catalog catalog
    LEFT JOIN grouped_regions grouped ON grouped.dimension = catalog.dimension
    GROUP BY catalog.dimension
  )
  SELECT
    'summary'::text AS row_kind,
    summary.dimension,
    NULL::text AS region_level,
    NULL::text AS country_code,
    NULL::text AS province_code,
    NULL::text AS province_name,
    NULL::text AS city_code,
    NULL::text AS city_name,
    NULL::text AS district_code,
    NULL::text AS district_name,
    NULL::bigint AS member_count,
    CASE
      WHEN summary.observed_member_count >= greatest(5, p_min_cohort_size)
      THEN summary.observed_member_count
      ELSE NULL::bigint
    END AS observed_member_count,
    CASE
      WHEN summary.observed_member_count >= greatest(5, p_min_cohort_size)
      THEN summary.observation_count
      ELSE NULL::bigint
    END AS observation_count,
    coalesce(suppressed.suppressed_bucket_count, 0)::bigint AS suppressed_bucket_count,
    (
      summary.observed_member_count > 0
      AND summary.observed_member_count < greatest(5, p_min_cohort_size)
    ) AS privacy_suppressed,
    NULL::numeric AS average_confidence,
    summary.latest_collected_at
  FROM dimension_summary summary
  LEFT JOIN suppressed_summary suppressed ON suppressed.dimension = summary.dimension

  UNION ALL

  SELECT
    'region'::text AS row_kind,
    grouped.dimension,
    grouped.region_level,
    grouped.country_code,
    grouped.province_code,
    grouped.province_name,
    grouped.city_code,
    grouped.city_name,
    grouped.district_code,
    grouped.district_name,
    grouped.member_count,
    NULL::bigint AS observed_member_count,
    NULL::bigint AS observation_count,
    NULL::bigint AS suppressed_bucket_count,
    false AS privacy_suppressed,
    grouped.average_confidence,
    grouped.latest_collected_at
  FROM grouped_regions grouped
  WHERE grouped.member_count >= greatest(5, p_min_cohort_size)

  ORDER BY dimension, row_kind DESC, member_count DESC NULLS LAST;
$$;

COMMENT ON FUNCTION public.read_admin_member_region_distribution(integer) IS
  'DESIGN-ONLY service-role aggregate. Returns no user_id, IP/HMAC, direct identifier or regional cohort smaller than k=5.';

REVOKE ALL ON FUNCTION public.read_admin_member_region_distribution(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_admin_member_region_distribution(integer) TO service_role;

COMMIT;

-- DESIGN-ONLY rollback order after an explicitly authorized deployment:
-- DROP FUNCTION IF EXISTS public.read_admin_member_region_distribution(integer);
-- DROP TABLE IF EXISTS public.member_region_observations;
