-- Views indicate live attendance. Assignments remain the persistent editing
-- role; attendance does not edit a roadmap or advance any roadmap cursor.
create table private.dw_roadmap_view_presence (
  session_id uuid not null references public.dw_sessions(id) on delete cascade,
  user_id uuid not null references public.dw_profiles(user_id) on delete cascade,
  view_id uuid not null,
  roadmap_id uuid,
  revision bigint not null check(revision between 1 and 9007199254740991),
  expires_at timestamptz not null,
  primary key(session_id,user_id,view_id),
  foreign key(session_id,roadmap_id) references private.dw_roadmaps(session_id,id) on delete cascade
);
create index dw_roadmap_view_presence_expiry on private.dw_roadmap_view_presence(session_id,expires_at);
alter table private.dw_roadmap_view_presence enable row level security;
revoke all on private.dw_roadmap_view_presence from public,anon,authenticated;

create function private.dw_roadmap_presence(p_session_id uuid,p_view_id uuid,p_roadmap_id uuid,p_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user_id uuid:=private.dw_verified_uid(); v_now timestamptz; result jsonb;
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if p_revision is null or p_revision not between 1 and 9007199254740991
    or (p_view_id is null and p_roadmap_id is not null) then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_roadmap_id is not null and not exists (
    select 1 from private.dw_roadmaps where session_id=p_session_id and id=p_roadmap_id
  ) then perform private.dw_fail('NOT_FOUND'); end if;

  v_now:=clock_timestamp();
  if p_view_id is not null then
    -- A leave keeps its revision as a short-lived tombstone, so delayed
    -- heartbeats cannot restore a view after navigation or a room switch.
    delete from private.dw_roadmap_view_presence p
      where p.session_id=p_session_id and (p.user_id,p.view_id) in (
        select old.user_id,old.view_id from private.dw_roadmap_view_presence old
        where old.session_id=p_session_id and old.expires_at<v_now-interval '1 day'
        order by old.expires_at limit 64 for update skip locked
      );
    insert into private.dw_roadmap_view_presence as current_view(session_id,user_id,view_id,roadmap_id,revision,expires_at)
      values(p_session_id,v_user_id,p_view_id,p_roadmap_id,p_revision,
        case when p_roadmap_id is null then v_now else v_now+interval '25 seconds' end)
      on conflict(session_id,user_id,view_id) do update set
        roadmap_id=excluded.roadmap_id,revision=excluded.revision,expires_at=excluded.expires_at
      where current_view.revision<excluded.revision;
  end if;

  select jsonb_build_object('sessionId',p_session_id,'counts',
    coalesce(jsonb_agg(jsonb_build_object('roadmapId',c.roadmap_id,'count',c.people) order by c.roadmap_id),'[]'::jsonb))
    into result
    from (
      select p.roadmap_id,count(distinct p.user_id) as people
      from private.dw_roadmap_view_presence p
      join public.dw_memberships m on m.session_id=p.session_id and m.user_id=p.user_id and m.revoked_at is null
      where p.session_id=p_session_id and p.roadmap_id is not null and p.expires_at>v_now
      group by p.roadmap_id
    ) c;
  return result;
end $$;

create function public.dw_roadmap_presence(p_session_id uuid,p_view_id uuid,p_roadmap_id uuid,p_revision bigint)
returns jsonb language sql security invoker set search_path='' as $$
  select private.dw_roadmap_presence(p_session_id,p_view_id,p_roadmap_id,p_revision)
$$;
revoke all on function private.dw_roadmap_presence(uuid,uuid,uuid,bigint),public.dw_roadmap_presence(uuid,uuid,uuid,bigint)
  from public,anon,authenticated;
grant execute on function private.dw_roadmap_presence(uuid,uuid,uuid,bigint),public.dw_roadmap_presence(uuid,uuid,uuid,bigint)
  to authenticated;

-- The shared workshop opens any catalogue territory at its configured team level.
create or replace function private.dw_join_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); receipt jsonb; st private.dw_roadmap_state%rowtype;
  t private.dw_roadmap_territories%rowtype; room_id uuid; previous_room uuid; current_revision bigint; session_region text; k text; d jsonb;
begin
  perform private.dw_roadmap_write_guard(p_session_id);
  receipt:=private.dw_begin_operation(p_operation_id,'roadmap.join',v_payload);
  if receipt is not null then return private.dw_roadmap_snapshot(p_session_id,(receipt->>'id')::uuid); end if;
  if not private.dw_s4_required(p_input,array['territoryKey','dataEditionId','expectedAssignmentRevision'])
    or not private.dw_text(p_input->'territoryKey',1,500) or not private.dw_text(p_input->'dataEditionId',1,500)
    or not private.dw_s4_integer(p_input->'expectedAssignmentRevision') then perform private.dw_fail('INVALID_INPUT'); end if;
  select * into st from private.dw_roadmap_state where session_id=p_session_id;
  if st.dataset_id is not null and st.dataset_id<>p_input->>'dataEditionId' then perform private.dw_fail('DATASET_MISMATCH'); end if;
  if not exists(select 1 from private.dw_roadmap_datasets where id=p_input->>'dataEditionId' and sealed) then perform private.dw_fail('DATASET_NOT_READY'); end if;
  select * into t from private.dw_roadmap_territories where dataset_id=p_input->>'dataEditionId' and territory_key=p_input->>'territoryKey';
  if not found or not t.room_eligible or t.level<>st.room_level then perform private.dw_fail('TERRITORY_NOT_ELIGIBLE'); end if;
  select region_id into session_region from public.dw_sessions where id=p_session_id;
  if not private.dw_is_current_workspace(p_session_id) and st.room_level<>'federal'
    and session_region is not null and t.region_id is distinct from session_region then perform private.dw_fail('TERRITORY_OUT_OF_SCOPE'); end if;
  select roadmap_id,revision into previous_room,current_revision from private.dw_roadmap_assignments where session_id=p_session_id and user_id=auth.uid();
  if coalesce(current_revision,0)<>(p_input->>'expectedAssignmentRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
  select id into room_id from private.dw_roadmaps where session_id=p_session_id and territory_key=t.territory_key;
  if room_id is null then
    if (select count(*) from private.dw_roadmaps where session_id=p_session_id)>=1000 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
    room_id:=gen_random_uuid();
    insert into private.dw_roadmaps(id,session_id,dataset_id,territory_key,territory) values(room_id,p_session_id,t.dataset_id,t.territory_key,t.material);
    foreach k in array array['passport','diagnosis','monitoring'] loop
      d:=case k when 'passport' then jsonb_build_object('title','','targetGroup','','partners','','goal','','objectives','[]'::jsonb,'startDate',null,'endDate',null,
        'expectedResult','','defenseDate',null,'humanResources','','materialResources','','informationResources','')
        when 'diagnosis' then jsonb_build_object('problem','','causeHypothesis','','conclusion','')
        else jsonb_build_object('frequency','','method','','responsible','','interimReportDate',null,'finalReportDate',null,'qualitativeResults','','sustainability','') end;
      insert into private.dw_roadmap_items(session_id,roadmap_id,kind,data,created_by,updated_by) values(p_session_id,room_id,k,d,auth.uid(),auth.uid());
    end loop;
  end if;
  if st.dataset_id is null then update private.dw_roadmap_state set dataset_id=t.dataset_id,revision=revision+1 where session_id=p_session_id; end if;
  insert into private.dw_roadmap_assignments(session_id,user_id,roadmap_id) values(p_session_id,auth.uid(),room_id)
    on conflict(session_id,user_id) do update set roadmap_id=excluded.roadmap_id,revision=private.dw_roadmap_assignments.revision+1;
  if previous_room is not null and previous_room<>room_id then perform private.dw_roadmap_touch(p_session_id,previous_room,'roadmap.member_left'); end if;
  perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.joined');
  perform private.dw_finish_operation(p_operation_id,'roadmap.join',v_payload,jsonb_build_object('id',room_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

-- Add the presence endpoint to the declared-email gateway allowlist.
create or replace function private.dw_entry_rpc(p_token text,p_method text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_session private.dw_entry_sessions:=private.dw_entry_token(p_token); v_def record; v_key text; v_index integer;
 v_type text; v_value jsonb; v_sql text:=''; v_expr text; v_result jsonb; v_required integer;
 v_old_sub text:=current_setting('request.jwt.claim.sub',true); v_old_claims text:=current_setting('request.jwt.claims',true);
 v_old_id text:=current_setting('demography.entry_id',true); v_old_hash text:=current_setting('demography.entry_hash',true);
begin
 if p_method is null or not(p_method=any(array['dw_flipchart_updates','dw_flipchart_add','dw_flipchart_vote','dw_flipchart_status','dw_enter_workspace','dw_configure_workspace','dw_workspace_votes','dw_workspace_votes_projection','dw_workspace_vote','dw_workshop_survey','dw_workspace_read','dw_workspace_commit','dw_bootstrap','dw_join_session','dw_save_profile','dw_create_session','dw_available_sessions','dw_join_open_session','dw_session_snapshot','dw_session_cursor','dw_projector_snapshot','dw_update_session','dw_publish_submission','dw_moderate_submission','dw_invitation','dw_rotate_invitation','dw_set_member_role','dw_revoke_member','dw_workshop_snapshot','dw_workshop_cursor','dw_workshop_projector_snapshot','dw_workshop_round_snapshot','dw_region_work','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_cast_vote','dw_workshop_updates','dw_workshop_projector_updates','dw_cast_vote_updates','dw_barriers_snapshot','dw_barriers_cursor','dw_barriers_projector_snapshot','dw_save_barrier','dw_barrier_vote','dw_save_barrier_link','dw_save_solution','dw_barrier_evidence','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_roadmaps_index','dw_roadmaps_cursor','dw_roadmap_presence','dw_roadmap_snapshot','dw_roadmap_version','dw_roadmaps_projector_snapshot','dw_configure_roadmaps','dw_join_roadmap','dw_save_roadmap_item','dw_capture_roadmap_fact','dw_capture_roadmap_basis','dw_freeze_roadmap','dw_review_roadmap','dw_roadmap_statistics_save','dw_roadmap_statistics_restore','dw_roadmap_statistics_history','dw_roadmap_statistics_series']::text[])) then perform private.dw_fail('FORBIDDEN'); end if;
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
