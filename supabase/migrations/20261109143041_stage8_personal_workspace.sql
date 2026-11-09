-- Stage 8.2: one server-owned personal notebook per application actor.
-- Private drafts are separate from shared, source-validated workshop submissions.
-- No account profile is copied into a notebook and no caller can choose its owner.

create table private.dw_workspaces (
 user_id uuid primary key references private.dw_actors(id) on delete cascade,
 state jsonb not null check(jsonb_typeof(state)='object'),
 revision bigint not null check(revision between 1 and 9007199254740991),
 updated_at timestamptz not null default clock_timestamp()
);
create table private.dw_workspace_receipts (
 user_id uuid not null references private.dw_workspaces(user_id) on delete cascade,
 operation_id uuid not null,
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 revision bigint not null check(revision between 1 and 9007199254740991),
 created_at timestamptz not null default clock_timestamp(),
 primary key(user_id,operation_id)
);
alter table private.dw_workspaces enable row level security;
alter table private.dw_workspace_receipts enable row level security;
revoke all on private.dw_workspaces,private.dw_workspace_receipts from public,anon,authenticated;

-- The API validates the bounded storage envelope. The client also validates each
-- domain field before writes and reads; publication retains canonical-source SQL
-- validation and never treats a personal notebook as verified shared evidence.
create function private.dw_workspace_validate(p_state jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare v_keys text[]:=array['schemaVersion','id','title','profile','sourceReferences','annotations',
 'practiceProposals','linkDecisions','customCards','readingTasks','preferences'];
 v_arrays text[]:=array['sourceReferences','annotations','practiceProposals','linkDecisions','customCards','readingTasks'];
 v_pref_keys text[]:=array['selectedRegionId','selectedSourceEditionId','selectedPracticeId','activePanel','readerFontScale'];
 v_key text; v_limit integer; v_value jsonb; v_prefs jsonb;
begin
 if p_state is null or not private.dw_keys(p_state,v_keys) or not(p_state ?& v_keys)
   or p_state->'schemaVersion' is distinct from '1'::jsonb
   or p_state->'id' is distinct from '"personal-workspace"'::jsonb
   or p_state->'profile' is distinct from 'null'::jsonb
   or not private.dw_text(p_state->'title',1,300) then perform private.dw_fail('INVALID_INPUT'); end if;
 if octet_length(p_state::text)>5242880 then perform private.dw_fail('LIMIT_EXCEEDED'); end if;
 foreach v_key in array v_arrays loop
   if jsonb_typeof(p_state->v_key) is distinct from 'array' then perform private.dw_fail('INVALID_INPUT'); end if;
   v_limit:=case when v_key in ('practiceProposals','customCards') then 2000 else 5000 end;
   if jsonb_array_length(p_state->v_key)>v_limit then perform private.dw_fail('LIMIT_EXCEEDED'); end if;
   if v_key='sourceReferences' then
     for v_value in select value from jsonb_array_elements(p_state->v_key) loop
       if not private.dw_keys(v_value,array['sourceId','editionId','title','normalizationVersion','sha256','sourceUrl','regionId'])
         or not(v_value ?& array['sourceId','editionId','title','normalizationVersion'])
         or not private.dw_id(v_value->'sourceId') or not private.dw_id(v_value->'editionId')
         or not private.dw_text(v_value->'title',1,1000)
         or not private.dw_text(v_value->'normalizationVersion',1,100)
         or (v_value?'sha256' and (not private.dw_text(v_value->'sha256',64,64) or (v_value->>'sha256') !~ '^[a-f0-9]{64}$'))
         or (v_value?'regionId' and not private.dw_id(v_value->'regionId'))
         or (v_value?'sourceUrl' and (not private.dw_text(v_value->'sourceUrl',1,2000) or (v_value->>'sourceUrl') !~ '^https?://'))
         then perform private.dw_fail('INVALID_INPUT'); end if;
     end loop;
     if (select count(distinct value->>'editionId') from jsonb_array_elements(p_state->v_key))<>jsonb_array_length(p_state->v_key)
       then perform private.dw_fail('INVALID_INPUT'); end if;
   else
     if exists(select 1 from jsonb_array_elements(p_state->v_key) where jsonb_typeof(value)<>'object' or not private.dw_id(value->'id'))
       or (select count(distinct value->>'id') from jsonb_array_elements(p_state->v_key))<>jsonb_array_length(p_state->v_key)
       then perform private.dw_fail('INVALID_INPUT'); end if;
   end if;
 end loop;
 v_prefs:=p_state->'preferences';
 if not private.dw_keys(v_prefs,v_pref_keys) or not(v_prefs ?& v_pref_keys)
   or (v_prefs->>'activePanel') is null or (v_prefs->>'activePanel') not in ('documents','practice-catalog','my-work')
   or jsonb_typeof(v_prefs->'readerFontScale') is distinct from 'number' then perform private.dw_fail('INVALID_INPUT'); end if;
 foreach v_key in array array['selectedRegionId','selectedSourceEditionId','selectedPracticeId'] loop
   if v_prefs->v_key is distinct from 'null'::jsonb and not private.dw_id(v_prefs->v_key) then perform private.dw_fail('INVALID_INPUT'); end if;
 end loop;
 if (v_prefs->>'readerFontScale')::numeric<0.75 or (v_prefs->>'readerFontScale')::numeric>2 then perform private.dw_fail('INVALID_INPUT'); end if;
end $$;

create function private.dw_workspace_json(p_workspace private.dw_workspaces) returns jsonb
language sql stable set search_path='' as $$
 select case when p_workspace.user_id is null then null else jsonb_build_object(
   'state',p_workspace.state,'revision',p_workspace.revision,
   'updatedAt',to_char(p_workspace.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end
$$;

create function private.dw_workspace_read(p_known_revision bigint default -1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_current private.dw_workspaces;
begin
 if p_known_revision is null or p_known_revision not between -1 and 9007199254740991 then perform private.dw_fail('INVALID_INPUT'); end if;
 select * into v_current from private.dw_workspaces where user_id=v_uid;
 if found and v_current.revision=p_known_revision then
   return jsonb_build_object('unchanged',true,'revision',v_current.revision);
 end if;
 return jsonb_build_object('snapshot',private.dw_workspace_json(v_current));
end $$;

create function private.dw_workspace_commit(p_operation_id uuid,p_expected_revision bigint,p_state jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_current private.dw_workspaces;
 v_receipt private.dw_workspace_receipts; v_hash text; v_actual bigint;
begin
 if p_operation_id is null or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740990
   then perform private.dw_fail('INVALID_INPUT'); end if;
 perform private.dw_workspace_validate(p_state);
 v_hash:=encode(sha256(convert_to(jsonb_build_object('expectedRevision',p_expected_revision,'state',p_state)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('personal-workspace:'||v_uid::text,0));
 select * into v_current from private.dw_workspaces where user_id=v_uid for update;
 select * into v_receipt from private.dw_workspace_receipts where user_id=v_uid and operation_id=p_operation_id;
 if found then
   if v_receipt.request_hash<>v_hash then perform private.dw_fail('IDEMPOTENCY_CONFLICT'); end if;
   return jsonb_build_object('kind','committed','revision',v_receipt.revision,'replayed',true,
     'snapshot',private.dw_workspace_json(v_current));
 end if;
 v_actual:=coalesce(v_current.revision,0);
 if p_expected_revision<>v_actual then
   return jsonb_build_object('kind','conflict','expectedRevision',p_expected_revision,
     'actualRevision',v_actual,'snapshot',private.dw_workspace_json(v_current));
 end if;
 insert into private.dw_workspaces(user_id,state,revision,updated_at)
   values(v_uid,p_state,v_actual+1,clock_timestamp())
   on conflict(user_id) do update set state=excluded.state,revision=excluded.revision,updated_at=excluded.updated_at
   returning * into v_current;
 insert into private.dw_workspace_receipts(user_id,operation_id,request_hash,revision)
   values(v_uid,p_operation_id,v_hash,v_current.revision);
 return jsonb_build_object('kind','committed','revision',v_current.revision,'replayed',false,
   'snapshot',private.dw_workspace_json(v_current));
end $$;

create function public.dw_workspace_read(p_known_revision bigint default -1) returns jsonb
language sql security invoker set search_path='' as $$ select private.dw_workspace_read($1) $$;
create function public.dw_workspace_commit(p_operation_id uuid,p_expected_revision bigint,p_state jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.dw_workspace_commit($1,$2,$3) $$;
revoke all on function private.dw_workspace_validate(jsonb),private.dw_workspace_json(private.dw_workspaces),
 private.dw_workspace_read(bigint),private.dw_workspace_commit(uuid,bigint,jsonb),
 public.dw_workspace_read(bigint),public.dw_workspace_commit(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.dw_workspace_read(bigint),public.dw_workspace_commit(uuid,bigint,jsonb),
 private.dw_workspace_read(bigint),private.dw_workspace_commit(uuid,bigint,jsonb) to authenticated;

-- Extend only the explicitly listed personal RPCs in the existing declared-entry gateway.
create or replace function private.dw_entry_rpc(p_token text,p_method text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_session private.dw_entry_sessions:=private.dw_entry_token(p_token); v_def record; v_key text; v_index integer;
 v_type text; v_value jsonb; v_sql text:=''; v_expr text; v_result jsonb; v_required integer;
 v_old_sub text:=current_setting('request.jwt.claim.sub',true); v_old_claims text:=current_setting('request.jwt.claims',true);
 v_old_id text:=current_setting('demography.entry_id',true); v_old_hash text:=current_setting('demography.entry_hash',true);
begin
 if p_method is null or not(p_method=any(array['dw_workspace_read','dw_workspace_commit','dw_bootstrap','dw_join_session','dw_save_profile','dw_create_session','dw_available_sessions','dw_join_open_session','dw_session_snapshot','dw_session_cursor','dw_projector_snapshot','dw_update_session','dw_publish_submission','dw_moderate_submission','dw_invitation','dw_rotate_invitation','dw_set_member_role','dw_revoke_member','dw_workshop_snapshot','dw_workshop_cursor','dw_workshop_projector_snapshot','dw_workshop_round_snapshot','dw_region_work','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_cast_vote','dw_workshop_updates','dw_workshop_projector_updates','dw_cast_vote_updates','dw_barriers_snapshot','dw_barriers_cursor','dw_barriers_projector_snapshot','dw_save_barrier','dw_barrier_vote','dw_save_barrier_link','dw_save_solution','dw_barrier_evidence','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_roadmaps_index','dw_roadmaps_cursor','dw_roadmap_snapshot','dw_roadmap_version','dw_roadmaps_projector_snapshot','dw_configure_roadmaps','dw_join_roadmap','dw_save_roadmap_item','dw_capture_roadmap_fact','dw_capture_roadmap_basis','dw_freeze_roadmap','dw_review_roadmap','dw_roadmap_statistics_save','dw_roadmap_statistics_restore','dw_roadmap_statistics_history','dw_roadmap_statistics_series']::text[])) then perform private.dw_fail('FORBIDDEN'); end if;
 if not v_session.operator and p_method=any(array['dw_create_session','dw_invitation','dw_rotate_invitation','dw_update_session','dw_moderate_submission','dw_set_member_role','dw_revoke_member','dw_projector_snapshot','dw_workshop_projector_snapshot','dw_workshop_projector_updates','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_barriers_projector_snapshot','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_configure_roadmaps','dw_roadmaps_projector_snapshot']::text[]) then perform private.dw_fail('FORBIDDEN'); end if;
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

revoke all on function private.dw_entry_rpc(text,text,jsonb) from public,anon,authenticated;
grant execute on function private.dw_entry_rpc(text,text,jsonb) to anon,authenticated;
