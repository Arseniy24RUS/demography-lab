-- Remaining Stage 3 deployment, reviewed against the unchanged v0.6 sources.
-- This script DEFINES guarded functions; it does not invoke them or delete any rows.
-- Supabase connector requested native confirmation because DELETE occurs in function bodies.
-- Run only after reviewing this complete transaction. No secrets or personal data are included.
-- Historical migration sources remain unchanged. Current cloud parts 01-04,06-07 are already applied.
-- Expected current state: private.dw_save_family and private.dw_delete_family are absent.
-- If this transaction was already applied, inspect state instead of running it again.

begin;

create function private.dw_save_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint,
  p_title text,p_mechanism text,p_rationale text,p_submission_ids uuid[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb;
  v_session public.dw_sessions; v_state private.dw_workshop_state; v_family uuid; v_revision bigint;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id,'boardRevision',p_expected_board_revision,
    'title',p_title,'mechanism',p_mechanism,'rationale',p_rationale,'submissionIds',to_jsonb(p_submission_ids));
  v_replay:=private.dw_begin_operation(p_operation_id,'save_family',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if exists(select 1 from private.dw_voting_rounds where session_id=p_session_id and status='open') then
    perform private.dw_fail('ROUND_OPEN'); end if;
  if v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
  select * into v_state from private.dw_workshop_state where session_id=p_session_id for update;
  if p_expected_board_revision is null or p_expected_board_revision<>v_state.board_revision then
    perform private.dw_fail('REVISION_CONFLICT'); end if;
  if not private.dw_text(to_jsonb(p_title),1,300) or btrim(p_title)=''
    or not private.dw_text(to_jsonb(p_mechanism),1,4000) or btrim(p_mechanism)=''
    or not private.dw_text(to_jsonb(p_rationale),1,4000) or btrim(p_rationale)=''
    or p_submission_ids is null or coalesce(array_ndims(p_submission_ids),1)<>1 or cardinality(p_submission_ids)>5000
    or exists(select 1 from unnest(p_submission_ids) x where x is null)
    or (select count(distinct x) from unnest(p_submission_ids) x)<>cardinality(p_submission_ids) then
    perform private.dw_fail('INVALID_INPUT'); end if;
  if (select count(*) from public.dw_submissions where session_id=p_session_id and id=any(p_submission_ids) and status='shared')
    <>cardinality(p_submission_ids) then perform private.dw_fail('FORBIDDEN'); end if;
  if p_family_id is not null and not exists(select 1 from private.dw_practice_families where session_id=p_session_id and id=p_family_id) then
    perform private.dw_fail('NOT_FOUND'); end if;
  if p_family_id is null and (select count(*) from private.dw_practice_families where session_id=p_session_id)>=200 then
    perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  perform private.dw_record_family_history(p_session_id,p_operation_id);
  v_family:=coalesce(p_family_id,gen_random_uuid());
  if p_family_id is null then
    insert into private.dw_practice_families(id,session_id,title,mechanism,rationale)
      values(v_family,p_session_id,btrim(p_title),btrim(p_mechanism),btrim(p_rationale)) returning revision into v_revision;
  else
    update private.dw_practice_families set title=btrim(p_title),mechanism=btrim(p_mechanism),rationale=btrim(p_rationale),
      revision=revision+1,updated_at=clock_timestamp() where id=v_family returning revision into v_revision;
  end if;
  update private.dw_practice_families set revision=revision+1,updated_at=clock_timestamp()
    where session_id=p_session_id and id<>v_family and id in
      (select family_id from private.dw_family_members where session_id=p_session_id and submission_id=any(p_submission_ids));
  delete from private.dw_family_members where session_id=p_session_id and (family_id=v_family or submission_id=any(p_submission_ids));
  insert into private.dw_family_members(session_id,family_id,submission_id)
    select p_session_id,v_family,x from unnest(p_submission_ids) x;
  perform private.dw_workshop_touch(p_session_id,'family.saved',true);
  perform private.dw_record_family_history(p_session_id,p_operation_id);
  insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
    values(p_session_id,v_uid,p_operation_id,'workshop.family.saved',v_family,v_revision);
  perform private.dw_finish_operation(p_operation_id,'save_family',v_payload,jsonb_build_object('sessionId',p_session_id,'familyId',v_family));
  return private.dw_workshop_snapshot(p_session_id);
end $$;
revoke all on function private.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[]) from public,anon,authenticated;

create function private.dw_delete_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb;
  v_session public.dw_sessions; v_state private.dw_workshop_state; v_revision bigint;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id,'boardRevision',p_expected_board_revision);
  v_replay:=private.dw_begin_operation(p_operation_id,'delete_family',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if exists(select 1 from private.dw_voting_rounds where session_id=p_session_id and status='open') then
    perform private.dw_fail('ROUND_OPEN'); end if;
  if v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
  select * into v_state from private.dw_workshop_state where session_id=p_session_id for update;
  if p_expected_board_revision is null or p_expected_board_revision<>v_state.board_revision then
    perform private.dw_fail('REVISION_CONFLICT'); end if;
  select revision into v_revision from private.dw_practice_families where id=p_family_id and session_id=p_session_id;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  perform private.dw_record_family_history(p_session_id,p_operation_id);
  delete from private.dw_practice_families where id=p_family_id and session_id=p_session_id;
  perform private.dw_workshop_touch(p_session_id,'family.deleted',true);
  perform private.dw_record_family_history(p_session_id,p_operation_id);
  insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
    values(p_session_id,v_uid,p_operation_id,'workshop.family.deleted',p_family_id,v_revision);
  perform private.dw_finish_operation(p_operation_id,'delete_family',v_payload,jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id));
  return private.dw_workshop_snapshot(p_session_id);
end $$;
revoke all on function private.dw_delete_family(uuid,uuid,uuid,bigint) from public,anon,authenticated;

create function public.dw_region_work(p_operation_id uuid,p_session_id uuid,p_region_id text,p_action text,p_expected_revision bigint,p_note text)
  returns jsonb language sql security invoker set search_path='' as $$ select private.dw_region_work($1,$2,$3,$4,$5,$6) $$;
create function public.dw_save_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint,
  p_title text,p_mechanism text,p_rationale text,p_submission_ids uuid[]) returns jsonb language sql security invoker set search_path=''
  as $$ select private.dw_save_family($1,$2,$3,$4,$5,$6,$7,$8) $$;
create function public.dw_delete_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint)
  returns jsonb language sql security invoker set search_path='' as $$ select private.dw_delete_family($1,$2,$3,$4) $$;
create function public.dw_open_voting_round(p_operation_id uuid,p_session_id uuid,p_title text,p_results_visibility text,
  p_expected_board_revision bigint,p_settings jsonb default '{}') returns jsonb language sql security invoker set search_path=''
  as $$ select private.dw_open_voting_round($1,$2,$3,$4,$5,$6) $$;
create function public.dw_close_voting_round(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_expected_revision bigint)
  returns jsonb language sql security invoker set search_path='' as $$ select private.dw_close_voting_round($1,$2,$3,$4) $$;
create function public.dw_cast_vote(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_family_id uuid,p_value integer,p_expected_revision bigint)
  returns jsonb language sql security invoker set search_path='' as $$ select private.dw_cast_vote($1,$2,$3,$4,$5,$6) $$;
create function public.dw_workshop_updates(p_session_id uuid,p_known_round_id uuid default null) returns jsonb
  language sql security invoker set search_path='' as $$ select private.dw_workshop_updates($1,$2) $$;
create function public.dw_workshop_projector_updates(p_session_id uuid,p_known_round_id uuid default null) returns jsonb
  language sql security invoker set search_path='' as $$ select private.dw_workshop_projector_updates($1,$2) $$;
create function public.dw_cast_vote_updates(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_family_id uuid,
  p_value integer,p_expected_revision bigint,p_known_round_id uuid default null) returns jsonb
  language sql security invoker set search_path='' as $$ select private.dw_cast_vote_updates($1,$2,$3,$4,$5,$6,$7) $$;

-- Do not revoke the existing Stage 2 authenticated grants when locking down new helpers.
revoke all on all functions in schema private from public,anon;
revoke all on function public.dw_workshop_snapshot(uuid),public.dw_workshop_cursor(uuid),public.dw_workshop_projector_snapshot(uuid),
  public.dw_workshop_round_snapshot(uuid,uuid),public.dw_region_work(uuid,uuid,text,text,bigint,text),
  public.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[]),public.dw_delete_family(uuid,uuid,uuid,bigint),
  public.dw_open_voting_round(uuid,uuid,text,text,bigint,jsonb),public.dw_close_voting_round(uuid,uuid,uuid,bigint),
  public.dw_cast_vote(uuid,uuid,uuid,uuid,integer,bigint),public.dw_workshop_updates(uuid,uuid),
  public.dw_workshop_projector_updates(uuid,uuid),public.dw_cast_vote_updates(uuid,uuid,uuid,uuid,integer,bigint,uuid)
  from public,anon,authenticated;
grant execute on function public.dw_workshop_snapshot(uuid),private.dw_workshop_snapshot(uuid),
  public.dw_workshop_cursor(uuid),private.dw_workshop_cursor(uuid),
  public.dw_workshop_projector_snapshot(uuid),private.dw_workshop_projector_snapshot(uuid),
  public.dw_workshop_round_snapshot(uuid,uuid),private.dw_workshop_round_snapshot(uuid,uuid),
  public.dw_region_work(uuid,uuid,text,text,bigint,text),private.dw_region_work(uuid,uuid,text,text,bigint,text),
  public.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[]),private.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[]),
  public.dw_delete_family(uuid,uuid,uuid,bigint),private.dw_delete_family(uuid,uuid,uuid,bigint),
  public.dw_open_voting_round(uuid,uuid,text,text,bigint,jsonb),private.dw_open_voting_round(uuid,uuid,text,text,bigint,jsonb),
  public.dw_close_voting_round(uuid,uuid,uuid,bigint),private.dw_close_voting_round(uuid,uuid,uuid,bigint),
  public.dw_cast_vote(uuid,uuid,uuid,uuid,integer,bigint),private.dw_cast_vote(uuid,uuid,uuid,uuid,integer,bigint),
  public.dw_workshop_updates(uuid,uuid),private.dw_workshop_updates(uuid,uuid),
  public.dw_workshop_projector_updates(uuid,uuid),private.dw_workshop_projector_updates(uuid,uuid),
  public.dw_cast_vote_updates(uuid,uuid,uuid,uuid,integer,bigint,uuid),private.dw_cast_vote_updates(uuid,uuid,uuid,uuid,integer,bigint,uuid) to authenticated;

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='dw_workshop_events') then
    alter publication supabase_realtime add table public.dw_workshop_events;
  end if;
end $$;

-- The Stage 3 historical blanket revocation above predates Stage 4.
-- Restore only the four already-reviewed Stage 4 anonymous survey entry points.
grant execute on function public.dw_survey_public_manifest(uuid,text),private.dw_survey_public_manifest(uuid,text) to anon,authenticated;
grant execute on function public.dw_survey_own_response(uuid,text),private.dw_survey_own_response(uuid,text) to anon,authenticated;
grant execute on function public.dw_survey_save_response(uuid,uuid,text,text,jsonb),private.dw_survey_save_response(uuid,uuid,text,text,jsonb) to anon,authenticated;
grant execute on function public.dw_survey_withdraw_response(uuid,uuid,text,bigint),private.dw_survey_withdraw_response(uuid,uuid,text,bigint) to anon,authenticated;

-- Stage 8 can be installed independently while this transaction awaits confirmation.
-- Preserve exactly its four guarded entry RPCs if the complete entry surface exists.
-- A partially installed surface is an error; never grant access to additional helpers.
do $$
declare v_entry_count integer;
begin
  select count(*) into v_entry_count from unnest(array[
    'public.dw_identify(text,text)','private.dw_identify(text,text)',
    'public.dw_entry_session(text)','private.dw_entry_session(text)',
    'public.dw_entry_logout(text)','private.dw_entry_logout(text)',
    'public.dw_entry_rpc(text,text,jsonb)','private.dw_entry_rpc(text,text,jsonb)'
  ]::text[]) signature where to_regprocedure(signature) is not null;
  if v_entry_count not in (0,8) then raise exception 'Incomplete Stage 8 entry surface'; end if;
  if v_entry_count=8 then
    grant execute on function public.dw_identify(text,text),private.dw_identify(text,text),
      public.dw_entry_session(text),private.dw_entry_session(text),
      public.dw_entry_logout(text),private.dw_entry_logout(text),
      public.dw_entry_rpc(text,text,jsonb),private.dw_entry_rpc(text,text,jsonb) to anon,authenticated;
  end if;
end $$;

-- Fail closed if a privilege invariant is unexpectedly violated.
do $$
declare v_allowed text[]; v_expected text[];
begin
  v_expected:=array['dw_survey_own_response','dw_survey_public_manifest','dw_survey_save_response','dw_survey_withdraw_response']::text[];
  if to_regprocedure('private.dw_identify(text,text)') is not null then
    v_expected:=array['dw_entry_logout','dw_entry_rpc','dw_entry_session','dw_identify',
      'dw_survey_own_response','dw_survey_public_manifest','dw_survey_save_response','dw_survey_withdraw_response']::text[];
  end if;
  select array_agg(p.proname::text order by p.proname::text) into v_allowed
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and has_function_privilege('anon',p.oid,'execute');
  if v_allowed is distinct from v_expected then
    raise exception 'Unexpected anonymous private function privileges';
  end if;
  select array_agg(p.proname::text order by p.proname::text) into v_allowed
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'dw_%' and has_function_privilege('anon',p.oid,'execute');
  if v_allowed is distinct from v_expected then
    raise exception 'Unexpected anonymous public function privileges';
  end if;
  if not has_function_privilege('authenticated','public.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[])','execute')
     or not has_function_privilege('authenticated','public.dw_delete_family(uuid,uuid,uuid,bigint)','execute')
     or has_function_privilege('anon','public.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[])','execute')
     or has_function_privilege('anon','public.dw_delete_family(uuid,uuid,uuid,bigint)','execute') then
    raise exception 'Family RPC privileges do not match the shipped contract';
  end if;
end $$;
commit;
