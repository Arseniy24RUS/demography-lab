-- Deployment repair for the audited, partially installed 0.6 schema.
-- This is the one historical grant omitted after automatic approval review.
-- Read-only HTTP checks proved that private/research are not exposed by PostgREST
-- (PGRST106), while public.dw_survey_public_manifest fails with 42501 solely on
-- schema USAGE. Its SECURITY INVOKER wrapper needs namespace lookup permission.
-- This migration never grants table access, schema CREATE, or extra function access.
-- Refuse to proceed if the previously audited narrow privilege state has changed.
do $$
declare v_allowed text[];
begin
  select array_agg(p.proname::text order by p.proname::text) into v_allowed
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and has_function_privilege('anon',p.oid,'execute');
  if v_allowed is distinct from array[
    'dw_survey_own_response','dw_survey_public_manifest',
    'dw_survey_save_response','dw_survey_withdraw_response'
  ]::text[] then
    raise exception 'Anonymous function allowlist changed; re-audit before granting namespace usage';
  end if;
  if has_schema_privilege('anon','private','create') then
    raise exception 'Anonymous schema creation must be disabled';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('private','research') and c.relkind='r'
      and (not c.relrowsecurity or has_table_privilege('anon',c.oid,'select,insert,update,delete'))
  ) then
    raise exception 'Private/research tables must have RLS and no anonymous table privileges';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and p.proname::text=any(v_allowed)
      and (not p.prosecdef or p.prosrc not like '%private.dw_survey_anon_guard()%')
  ) then
    raise exception 'Survey procedures must retain their anonymous request guards';
  end if;
end $$;
grant usage on schema private to anon;
