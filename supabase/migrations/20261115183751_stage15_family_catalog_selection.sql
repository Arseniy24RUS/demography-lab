create table private.dw_family_catalog_releases (
  commit_sha text primary key check(commit_sha ~ '^[0-9a-f]{40}$'),
  material_sha text not null check(material_sha ~ '^[0-9a-f]{64}$'),
  card_count integer not null check(card_count between 1 and 5000),
  sealed boolean not null default false
);
create unique index dw_family_catalog_one_release
  on private.dw_family_catalog_releases(sealed) where sealed;

create table private.dw_family_catalog (
  commit_sha text not null references private.dw_family_catalog_releases(commit_sha),
  catalog_id text not null check(char_length(catalog_id) between 1 and 160),
  group_key text not null,
  group_title text not null check(char_length(btrim(group_title)) between 1 and 300),
  group_kind text check(group_kind in ('mechanism','same-title')),
  bundle jsonb not null check(jsonb_typeof(bundle)='object'),
  primary key(commit_sha,catalog_id),
  check((bundle#>>'{catalogSource,id}') is not distinct from catalog_id),
  check((bundle#>>'{catalogSource,commit}') is not distinct from commit_sha)
);
create index dw_family_catalog_group on private.dw_family_catalog(commit_sha,group_key);
alter table private.dw_family_catalog_releases enable row level security;
alter table private.dw_family_catalog enable row level security;
revoke all on private.dw_family_catalog_releases,private.dw_family_catalog from public,anon,authenticated,service_role;

-- Owner-side imports can resume after interrupted upload. The release becomes
-- selectable only after the owner has verified every batch and sealed it.
create function private.dw_import_family_catalog_batch(p_commit text,p_cards jsonb)
returns void language plpgsql set search_path='' as $$
declare
  v_sealed boolean;
begin
  select sealed into strict v_sealed from private.dw_family_catalog_releases where commit_sha=p_commit for update;
  if not v_sealed then
    insert into private.dw_family_catalog(commit_sha,catalog_id,group_key,group_title,group_kind,bundle)
      select p_commit,c.catalog_id,c.group_key,c.group_title,c.group_kind,c.bundle
        from jsonb_to_recordset(p_cards) c(catalog_id text,group_key text,group_title text,group_kind text,bundle jsonb)
      on conflict(commit_sha,catalog_id) do nothing;
  end if;
  if exists(
    select 1 from jsonb_to_recordset(p_cards) c(catalog_id text,group_key text,group_title text,group_kind text,bundle jsonb)
    left join private.dw_family_catalog t on t.commit_sha=p_commit and t.catalog_id=c.catalog_id
    where (t.group_key,t.group_title,t.group_kind,t.bundle) is distinct from (c.group_key,c.group_title,c.group_kind,c.bundle)
  ) then raise exception 'FAMILY_CATALOG_REIMPORT_MISMATCH'; end if;
end $$;
revoke all on function private.dw_import_family_catalog_batch(text,jsonb) from public,anon,authenticated,service_role;

create unique index dw_catalog_submission_once
  on public.dw_submissions(session_id,(bundle#>>'{catalogSource,id}')) where bundle?'catalogSource';

create function private.dw_protect_catalog_submission() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.bundle is distinct from old.bundle then perform private.dw_fail('FORBIDDEN'); end if;
  if new.status is distinct from old.status and private.dw_member_role(old.session_id) is distinct from 'host' then
    perform private.dw_fail('FORBIDDEN');
  end if;
  return new;
end $$;
create trigger dw_protect_catalog_submission before update of bundle,status on public.dw_submissions
  for each row when (old.bundle?'catalogSource') execute function private.dw_protect_catalog_submission();
revoke all on function private.dw_protect_catalog_submission() from public,anon,authenticated,service_role;

create function private.dw_select_catalog_practice(p_operation_id uuid,p_session_id uuid,p_catalog_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=private.dw_verified_uid();
  v_role text;
  v_status text;
  v_card private.dw_family_catalog;
  v_submission public.dw_submissions;
  v_family uuid;
  v_matching_families uuid[];
  v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'catalogId',p_catalog_id);
begin
  v_role:=private.dw_member_role(p_session_id);
  if not private.dw_is_current_workspace(p_session_id) or v_role is null or v_role='observer' then
    perform private.dw_fail('FORBIDDEN');
  end if;
  if not private.dw_id(to_jsonb(p_catalog_id)) then perform private.dw_fail('INVALID_INPUT'); end if;
  if private.dw_begin_operation(p_operation_id,'select_catalog_practice',v_payload) is not null then
    return private.dw_snapshot(p_session_id);
  end if;
  select status into v_status from public.dw_sessions where id=p_session_id for update;
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_status is distinct from 'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;

  select * into v_card from private.dw_family_catalog c
    where c.catalog_id=p_catalog_id and exists(select 1 from private.dw_family_catalog_releases r
      where r.commit_sha=c.commit_sha and r.sealed);
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  select * into v_submission from public.dw_submissions s
    where s.session_id=p_session_id and s.bundle?'catalogSource' and s.bundle#>>'{catalogSource,id}'=p_catalog_id;
  if found then
    if v_submission.status='withdrawn' then perform private.dw_fail('FORBIDDEN'); end if;
  else
    if (select count(*) from public.dw_submissions where session_id=p_session_id)>=5000
      or coalesce((select sum(octet_length(bundle::text)) from public.dw_submissions where session_id=p_session_id),0)
        + octet_length(v_card.bundle::text)>4194304 then perform private.dw_fail('LIMIT_EXCEEDED'); end if;
    insert into public.dw_submissions(session_id,author_id,local_key,bundle)
      values(p_session_id,v_uid,'family-support:'||p_catalog_id,v_card.bundle) returning * into v_submission;

    -- Respect edits to existing families. If participants split a proposed
    -- group, the next variant can be evaluated on its own until they place it.
    if v_card.group_kind is not null then
      select array_agg(distinct m.family_id) into v_matching_families
      from private.dw_family_catalog c
      join public.dw_submissions s on s.session_id=p_session_id and s.status='shared'
        and s.bundle?'catalogSource' and s.bundle#>>'{catalogSource,id}'=c.catalog_id
      join private.dw_family_members m on m.session_id=s.session_id and m.submission_id=s.id
      where c.commit_sha=v_card.commit_sha and c.group_key=v_card.group_key;
    end if;
    if cardinality(v_matching_families)=1 then
      v_family:=v_matching_families[1];
      update private.dw_practice_families set revision=revision+1,updated_at=clock_timestamp() where id=v_family;
    else
      if (select count(*) from private.dw_practice_families where session_id=p_session_id)>=5000 then
        perform private.dw_fail('LIMIT_EXCEEDED');
      end if;
      insert into private.dw_practice_families(session_id,title,mechanism,rationale)
        values(p_session_id,
          case when v_card.group_kind is not null and v_matching_families is null
            then v_card.group_title else v_card.bundle#>>'{practice,title}' end,
          case when v_card.group_kind is not null and v_matching_families is null
            then v_card.group_title else v_card.bundle#>>'{practice,mechanism}' end,
          case when v_card.group_kind is not null and v_matching_families is null
            then 'Предложенная группировка похожих карточек family-support. Условия каждого варианта сохранены.'
            else 'Карточка из каталога family-support, выбранная участником.' end)
        returning id into v_family;
    end if;
    insert into private.dw_family_members(session_id,family_id,submission_id)
      values(p_session_id,v_family,v_submission.id);
    perform private.dw_event(p_session_id,p_operation_id,'submission.published',v_submission.id,v_submission.revision);
  end if;
  perform private.dw_finish_operation(p_operation_id,'select_catalog_practice',v_payload,
    jsonb_build_object('sessionId',p_session_id,'entityId',v_submission.id,'revision',v_submission.revision));
  return private.dw_snapshot(p_session_id);
end $$;

create function public.dw_select_catalog_practice(p_operation_id uuid,p_session_id uuid,p_catalog_id text)
returns jsonb language sql security invoker set search_path='' as $$
  select private.dw_select_catalog_practice(p_operation_id,p_session_id,p_catalog_id)
$$;
revoke all on function public.dw_select_catalog_practice(uuid,uuid,text),private.dw_select_catalog_practice(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.dw_select_catalog_practice(uuid,uuid,text),private.dw_select_catalog_practice(uuid,uuid,text)
  to authenticated;

-- Allow the current board to group the full catalogue. Historical rounds retain their limits.
create or replace function private.dw_save_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint,
  p_title text,p_mechanism text,p_rationale text,p_submission_ids uuid[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb;
  v_session public.dw_sessions; v_state private.dw_workshop_state; v_family uuid; v_revision bigint;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' and not private.dw_can_project_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id,'boardRevision',p_expected_board_revision,
    'title',p_title,'mechanism',p_mechanism,'rationale',p_rationale,'submissionIds',to_jsonb(p_submission_ids));
  v_replay:=private.dw_begin_operation(p_operation_id,'save_family',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' and not private.dw_can_project_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if exists(select 1 from private.dw_voting_rounds where session_id=p_session_id and status='open') then
    perform private.dw_fail('ROUND_OPEN'); end if;
  if not private.dw_is_current_workspace(p_session_id) and v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
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
  if p_family_id is null and (select count(*) from private.dw_practice_families where session_id=p_session_id)
      >=(case when private.dw_is_current_workspace(p_session_id) then 5000 else 200 end) then
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

-- Preserve the declared-identity gateway while allowing catalogue selections.
create or replace function private.dw_entry_rpc(p_token text,p_method text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_session private.dw_entry_sessions:=private.dw_entry_token(p_token); v_def record; v_key text; v_index integer;
 v_type text; v_value jsonb; v_sql text:=''; v_expr text; v_result jsonb; v_required integer;
 v_old_sub text:=current_setting('request.jwt.claim.sub',true); v_old_claims text:=current_setting('request.jwt.claims',true);
 v_old_id text:=current_setting('demography.entry_id',true); v_old_hash text:=current_setting('demography.entry_hash',true);
begin
 if p_method is null or not(p_method=any(array['dw_flipchart_updates','dw_flipchart_add','dw_flipchart_vote','dw_flipchart_status','dw_enter_workspace','dw_configure_workspace','dw_workspace_votes','dw_workspace_votes_projection','dw_workspace_vote','dw_workshop_survey','dw_workspace_read','dw_workspace_commit','dw_bootstrap','dw_join_session','dw_save_profile','dw_create_session','dw_available_sessions','dw_join_open_session','dw_session_snapshot','dw_session_cursor','dw_projector_snapshot','dw_update_session','dw_publish_submission','dw_select_catalog_practice','dw_moderate_submission','dw_invitation','dw_rotate_invitation','dw_set_member_role','dw_revoke_member','dw_workshop_snapshot','dw_workshop_cursor','dw_workshop_projector_snapshot','dw_workshop_round_snapshot','dw_region_work','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_cast_vote','dw_workshop_updates','dw_workshop_projector_updates','dw_cast_vote_updates','dw_barriers_snapshot','dw_barriers_cursor','dw_barriers_projector_snapshot','dw_save_barrier','dw_barrier_vote','dw_save_barrier_link','dw_save_solution','dw_barrier_evidence','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_roadmaps_index','dw_roadmaps_cursor','dw_roadmap_presence','dw_roadmap_snapshot','dw_roadmap_version','dw_roadmaps_projector_snapshot','dw_configure_roadmaps','dw_join_roadmap','dw_save_roadmap_item','dw_capture_roadmap_fact','dw_capture_roadmap_basis','dw_freeze_roadmap','dw_review_roadmap','dw_roadmap_statistics_save','dw_roadmap_statistics_restore','dw_roadmap_statistics_history','dw_roadmap_statistics_series']::text[])) then perform private.dw_fail('FORBIDDEN'); end if;
 if not v_session.operator and p_method=any(array['dw_configure_workspace','dw_create_session','dw_invitation','dw_rotate_invitation','dw_update_session','dw_moderate_submission','dw_set_member_role','dw_revoke_member','dw_projector_snapshot','dw_workshop_projector_snapshot','dw_workshop_projector_updates','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_barriers_projector_snapshot','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_configure_roadmaps','dw_roadmaps_projector_snapshot']::text[]) and not (p_method=any(array['dw_save_family','dw_delete_family','dw_projector_snapshot','dw_workshop_projector_snapshot','dw_workshop_projector_updates','dw_barriers_projector_snapshot','dw_roadmaps_projector_snapshot']::text[]) and exists(select 1 from private.dw_current_workspace where session_id::text=p_args->>'p_session_id')) then perform private.dw_fail('FORBIDDEN'); end if;
 if p_args is null or jsonb_typeof(p_args)<>'object' or octet_length(p_args::text)>8388608 then perform private.dw_fail('INVALID_INPUT'); end if;
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=p_method)<>1 then perform private.dw_fail('SCHEMA_MISSING'); end if;
 select p.proargnames as names,p.pronargdefaults as defaults,
   array(select format_type(t,null) from unnest(p.proargtypes) t) as types into v_def
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=p_method;
 if not found then perform private.dw_fail('SCHEMA_MISSING'); end if;
 if cardinality(v_def.names) is distinct from cardinality(v_def.types) and cardinality(v_def.types)>0 then perform private.dw_fail('SCHEMA_MISSING'); end if;
 if exists(select 1 from jsonb_object_keys(p_args) k where not(k=any(coalesce(v_def.names,array[]::text[])))) then perform private.dw_fail('INVALID_INPUT'); end if;
 v_required:=cardinality(v_def.types)-v_def.defaults;
 if exists(select 1 from generate_series(1,v_required) i where not(p_args ? v_def.names[i])) then perform private.dw_fail('INVALID_INPUT'); end if;
 for v_index in 1..coalesce(cardinality(v_def.types),0) loop
   v_key:=v_def.names[v_index]; v_type:=v_def.types[v_index];
   if v_key !~ '^p_[a-z0-9_]+$' or v_type<>all(array['uuid','text','jsonb','integer','bigint','boolean','uuid[]','text[]']) then
     perform private.dw_fail('SCHEMA_MISSING');
   end if;
   if not(p_args ? v_key) then continue; end if;
   v_value:=p_args->v_key;
   if v_value='null'::jsonb then v_expr:='null::'||v_type;
   elsif v_type='jsonb' then v_expr:=format('%L::jsonb',v_value::text);
   elsif v_type in ('uuid[]','text[]') then
     if jsonb_typeof(v_value)<>'array' or exists(select 1 from jsonb_array_elements(v_value) x where jsonb_typeof(x)<>'string') then
       perform private.dw_fail('INVALID_INPUT');
     end if;
     v_expr:=format('array(select jsonb_array_elements_text(%L::jsonb))::%s',v_value::text,v_type);
   else
     if jsonb_typeof(v_value) in ('array','object') then perform private.dw_fail('INVALID_INPUT'); end if;
     v_expr:=format('%L::%s',p_args->>v_key,v_type);
   end if;
   v_sql:=v_sql||case when v_sql='' then '' else ',' end||format('%I => %s',v_key,v_expr);
 end loop;
 begin
   perform set_config('request.jwt.claim.sub',v_session.actor_id::text,true);
   perform set_config('request.jwt.claims',jsonb_build_object('sub',v_session.actor_id,'role','authenticated',
     'app_metadata',jsonb_build_object('provider','declared-email','email_verified',false))::text,true);
   perform set_config('demography.entry_id',v_session.id::text,true);
   perform set_config('demography.entry_hash',v_session.token_hash,true);
   execute format('select public.%I(%s)',p_method,v_sql) into v_result;
 exception when others then
   perform set_config('request.jwt.claim.sub',coalesce(v_old_sub,''),true);
   perform set_config('request.jwt.claims',coalesce(v_old_claims,''),true);
   perform set_config('demography.entry_id',coalesce(v_old_id,''),true);
   perform set_config('demography.entry_hash',coalesce(v_old_hash,''),true);
   if sqlstate in ('22P02','22003','22023') then perform private.dw_fail('INVALID_INPUT'); end if;
   raise;
 end;
 perform set_config('request.jwt.claim.sub',coalesce(v_old_sub,''),true);
 perform set_config('request.jwt.claims',coalesce(v_old_claims,''),true);
 perform set_config('demography.entry_id',coalesce(v_old_id,''),true);
 perform set_config('demography.entry_hash',coalesce(v_old_hash,''),true);
 return v_result;
end $$;
