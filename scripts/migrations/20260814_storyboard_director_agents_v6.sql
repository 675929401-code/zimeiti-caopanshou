-- OBSOLETE AND INTENTIONALLY BLOCKED.
-- This draft replaced the full storyboard prompts and could reduce visual quality.
-- Use 20260814_storyboard_director_agents_v6_1.sql after review instead.
BEGIN;
DO $blocked$
BEGIN
  RAISE EXCEPTION 'Blocked obsolete migration: use storyboard_director_agents_v6_1';
END
$blocked$;
ROLLBACK;
