BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.incident_slo_audit_events)
     OR EXISTS (SELECT 1 FROM public.incident_slo_incident_events)
     OR EXISTS (SELECT 1 FROM public.incident_slo_action_requests)
     OR EXISTS (SELECT 1 FROM public.incident_slo_postmortems)
     OR EXISTS (SELECT 1 FROM public.incident_slo_recovery_probes)
     OR EXISTS (SELECT 1 FROM public.incident_slo_alerts)
     OR EXISTS (SELECT 1 FROM public.incident_slo_incidents)
     OR EXISTS (SELECT 1 FROM public.incident_slo_measurements)
     OR EXISTS (SELECT 1 FROM public.incident_slo_maintenance_windows)
     OR EXISTS (SELECT 1 FROM public.incident_slo_definitions)
     OR EXISTS (SELECT 1 FROM public.incident_slo_services) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_INCIDENT_SLO_EVIDENCE_EXISTS' USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.get_incident_slo_status();
DROP FUNCTION IF EXISTS public.link_incident_slo_postmortem_cas(uuid,text,integer,text,text,text,jsonb,jsonb,text);
DROP FUNCTION IF EXISTS public.register_incident_slo_action_request(uuid,text,uuid,integer,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.transition_incident_slo_incident_cas(uuid,text,uuid,integer,text,text,text);
DROP FUNCTION IF EXISTS public.record_incident_slo_recovery_probe_result_cas(uuid,uuid,text,uuid,integer,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.request_incident_slo_recovery_probe(uuid,text,uuid,integer,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.claim_incident_slo_incident_cas(uuid,text,integer,integer,text);
DROP FUNCTION IF EXISTS public.record_incident_slo_observation_atomic(jsonb);

DROP TABLE IF EXISTS public.incident_slo_audit_events;
DROP TABLE IF EXISTS public.incident_slo_action_requests;
DROP TABLE IF EXISTS public.incident_slo_postmortems;
DROP TABLE IF EXISTS public.incident_slo_recovery_probes;
DROP TABLE IF EXISTS public.incident_slo_incident_events;
DROP TABLE IF EXISTS public.incident_slo_alerts;
DROP TABLE IF EXISTS public.incident_slo_incidents;
DROP TABLE IF EXISTS public.incident_slo_measurements;
DROP TABLE IF EXISTS public.incident_slo_maintenance_windows;
DROP TABLE IF EXISTS public.incident_slo_definitions;
DROP TABLE IF EXISTS public.incident_slo_services;

DROP FUNCTION IF EXISTS public.reject_incident_slo_immutable_mutation();

COMMIT;
