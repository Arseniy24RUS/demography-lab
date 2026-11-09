-- Stage 10: short, public-in-the-workshop anonymous stickers. Historical
-- research responses stay in their independent schema and are never copied.
create table private.dw_flipchart_state (
  session_id uuid primary key references public.dw_sessions(id),
  cursor bigint not null default 0 check(cursor between 0 and 9007199254740991)
);
create table private.dw_flipchart_notes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references private.dw_flipchart_state(session_id),
  author_id uuid not null references public.dw_profiles(user_id),
  kind text not null check(kind in ('barrier','condition')),
  text text not null check(char_length(text) between 1 and 180),
  status text not null default 'active' check(status in ('active','withdrawn')),
  created_at timestamptz not null default clock_timestamp(),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  support bigint not null default 0 check(support between 0 and 9007199254740991),
  oppose bigint not null default 0 check(oppose between 0 and 9007199254740991),
  updated_cursor bigint not null check(updated_cursor between 1 and 9007199254740991),
  unique(session_id,id)
);
create index dw_flipchart_notes_delta on private.dw_flipchart_notes(session_id,updated_cursor);
create index dw_flipchart_notes_author on private.dw_flipchart_notes(author_id,session_id);
create table private.dw_flipchart_votes (
  session_id uuid not null,
  note_id uuid not null,
  actor_id uuid not null references public.dw_profiles(user_id),
  value integer check(value in (-1,1)),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  primary key(session_id,note_id,actor_id),
  foreign key(session_id,note_id) references private.dw_flipchart_notes(session_id,id)
);
create index dw_flipchart_votes_actor on private.dw_flipchart_votes(actor_id,session_id);
alter table private.dw_flipchart_state enable row level security;
alter table private.dw_flipchart_notes enable row level security;
alter table private.dw_flipchart_votes enable row level security;
revoke all on private.dw_flipchart_state,private.dw_flipchart_notes,private.dw_flipchart_votes from public,anon,authenticated;

-- Internal serializers deliberately contain no author fields. Projector mode
-- has a smaller shape, not null placeholders for individual voting metadata.
create function private.dw_flipchart_note_json(p_session_id uuid,p_note_id uuid,p_viewer uuid,p_projector boolean)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',n.id,'kind',n.kind,'text',n.text,'status',n.status,
    'createdAt',n.created_at,'revision',n.revision,'support',n.support,'oppose',n.oppose,'score',n.support-n.oppose)
    || case when p_projector then '{}'::jsonb else jsonb_build_object(
      'myVote',v.value,'myVoteRevision',coalesce(v.revision,0),
      'canWithdraw',n.author_id=p_viewer or private.dw_member_role(p_session_id)='host') end
  from private.dw_flipchart_notes n
  left join private.dw_flipchart_votes v on not p_projector and v.session_id=n.session_id
    and v.note_id=n.id and v.actor_id=p_viewer
  where n.session_id=p_session_id and n.id=p_note_id
$$;
create function private.dw_flipchart_result_json(p_session_id uuid,p_note_id uuid,p_viewer uuid)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('sessionId',p_session_id,'cursor',s.cursor,
    'note',private.dw_flipchart_note_json(p_session_id,p_note_id,p_viewer,false))
  from private.dw_flipchart_state s where s.session_id=p_session_id
$$;
create function private.dw_flipchart_lock(p_session_id uuid) returns bigint
language plpgsql set search_path='' as $$
declare v_cursor bigint;
begin
  insert into private.dw_flipchart_state(session_id) values(p_session_id) on conflict do nothing;
  select cursor into v_cursor from private.dw_flipchart_state where session_id=p_session_id for update;
  return v_cursor;
end $$;
revoke all on function private.dw_flipchart_note_json(uuid,uuid,uuid,boolean),
  private.dw_flipchart_result_json(uuid,uuid,uuid),private.dw_flipchart_lock(uuid) from public,anon,authenticated;

create function private.dw_flipchart_updates(p_session_id uuid,p_after_cursor bigint default null,p_projector boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  if p_projector is null or p_after_cursor<0 or p_after_cursor>9007199254740991 then perform private.dw_fail('INVALID_INPUT'); end if;
  -- One SELECT snapshot binds the cursor, active notes, vote counters, viewer's
  -- votes and withdrawal tombstones. Empty polling does not scan all notes.
  with state as materialized (
    select coalesce((select cursor from private.dw_flipchart_state where session_id=p_session_id),0) as cursor
  ), mode as materialized (
    select cursor,(p_after_cursor is null or p_after_cursor>cursor) as reset from state
  ), changed as materialized (
    select n.id,n.status,n.created_at from private.dw_flipchart_notes n cross join mode m
    where n.session_id=p_session_id and (m.reset and n.status='active'
      or not m.reset and n.updated_cursor>p_after_cursor and n.updated_cursor<=m.cursor)
  )
  select jsonb_build_object('sessionId',p_session_id,'cursor',m.cursor,'reset',m.reset,
    'notes',case when not m.reset and m.cursor=p_after_cursor then '[]'::jsonb else
      coalesce((select jsonb_agg(private.dw_flipchart_note_json(p_session_id,n.id,v_uid,p_projector)
        order by n.created_at,n.id) from changed n where n.status='active'),'[]'::jsonb) end,
    'removedIds',case when m.reset or m.cursor=p_after_cursor then '[]'::jsonb else coalesce((select jsonb_agg(n.id order by n.id)
      from changed n where n.status='withdrawn'),'[]'::jsonb) end)
    into v_result from mode m;
  return v_result;
end $$;

create function private.dw_flipchart_add(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_text text; v_cursor bigint; v_id uuid; v_replay jsonb;
  v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  v_replay:=private.dw_begin_operation(p_operation_id,'flipchart_add',v_payload);
  perform private.dw_flipchart_lock(p_session_id);
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  if v_replay is not null then return private.dw_flipchart_result_json(p_session_id,(v_replay->>'noteId')::uuid,v_uid); end if;
  if p_input is null or not private.dw_keys(p_input,array['kind','text']) or not(p_input ?& array['kind','text'])
    or coalesce(p_input->>'kind','') not in ('barrier','condition')
    or jsonb_typeof(p_input->'text') is distinct from 'string' then perform private.dw_fail('INVALID_INPUT'); end if;
  v_text:=p_input->>'text';
  if char_length(v_text)>4096 or v_text ~ '[\x01-\x08\x0E-\x1F\x7F]' then perform private.dw_fail('INVALID_INPUT'); end if;
  v_text:=btrim(regexp_replace(normalize(v_text,NFC),
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g'));
  if char_length(v_text) not between 1 and 180 then perform private.dw_fail('INVALID_INPUT'); end if;
  if (select count(*) from private.dw_flipchart_notes where session_id=p_session_id)>=20000 then
    perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
  insert into private.dw_flipchart_notes(session_id,author_id,kind,text,updated_cursor)
    values(p_session_id,v_uid,p_input->>'kind',v_text,v_cursor) returning id into v_id;
  perform private.dw_finish_operation(p_operation_id,'flipchart_add',v_payload,jsonb_build_object('noteId',v_id));
  return private.dw_flipchart_result_json(p_session_id,v_id,v_uid);
end $$;

create function private.dw_flipchart_vote(p_operation_id uuid,p_session_id uuid,p_note_id uuid,
  p_expected_revision bigint,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_note private.dw_flipchart_notes; v_vote private.dw_flipchart_votes;
  v_value integer; v_revision bigint; v_cursor bigint; v_replay jsonb;
  v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'noteId',p_note_id,'revision',p_expected_revision,'input',p_input);
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  v_replay:=private.dw_begin_operation(p_operation_id,'flipchart_vote',v_payload);
  perform private.dw_flipchart_lock(p_session_id);
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_note from private.dw_flipchart_notes where session_id=p_session_id and id=p_note_id;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_replay is not null then return private.dw_flipchart_result_json(p_session_id,p_note_id,v_uid); end if;
  if p_expected_revision is null or p_expected_revision<0 or p_expected_revision>9007199254740991
    or p_input is null or not private.dw_keys(p_input,array['value']) or not(p_input ? 'value')
    or not(p_input->'value'=any(array['1'::jsonb,'-1'::jsonb,'null'::jsonb])) then perform private.dw_fail('INVALID_INPUT'); end if;
  if v_note.status<>'active' then perform private.dw_fail('NOTE_WITHDRAWN'); end if;
  select * into v_vote from private.dw_flipchart_votes where session_id=p_session_id and note_id=p_note_id and actor_id=v_uid;
  v_revision:=coalesce(v_vote.revision,0);
  if v_revision<>p_expected_revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  v_value:=(p_input->>'value')::integer;
  if v_vote.value is distinct from v_value then
    insert into private.dw_flipchart_votes(session_id,note_id,actor_id,value,revision)
      values(p_session_id,p_note_id,v_uid,v_value,v_revision+1)
      on conflict(session_id,note_id,actor_id) do update set value=excluded.value,revision=excluded.revision;
    update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
    update private.dw_flipchart_notes set
      support=support-(case when v_vote.value=1 then 1 else 0 end)+(case when v_value=1 then 1 else 0 end),
      oppose=oppose-(case when v_vote.value=-1 then 1 else 0 end)+(case when v_value=-1 then 1 else 0 end),
      updated_cursor=v_cursor where session_id=p_session_id and id=p_note_id;
  end if;
  perform private.dw_finish_operation(p_operation_id,'flipchart_vote',v_payload,jsonb_build_object('noteId',p_note_id));
  return private.dw_flipchart_result_json(p_session_id,p_note_id,v_uid);
end $$;

create function private.dw_flipchart_status(p_operation_id uuid,p_session_id uuid,p_note_id uuid,
  p_expected_revision bigint,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_note private.dw_flipchart_notes; v_cursor bigint; v_replay jsonb;
  v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'noteId',p_note_id,'revision',p_expected_revision,'input',p_input);
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  v_replay:=private.dw_begin_operation(p_operation_id,'flipchart_status',v_payload);
  perform private.dw_flipchart_lock(p_session_id);
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_note from private.dw_flipchart_notes where session_id=p_session_id and id=p_note_id;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_note.author_id<>v_uid and private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_replay is not null then return private.dw_flipchart_result_json(p_session_id,p_note_id,v_uid); end if;
  if p_input is null or not private.dw_keys(p_input,array['status']) or not(p_input ? 'status')
    or coalesce(p_input->>'status','') not in ('active','withdrawn') then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_expected_revision is null or p_expected_revision<>v_note.revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  if v_note.status is distinct from p_input->>'status' then
    update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
    update private.dw_flipchart_notes set status=p_input->>'status',revision=revision+1,updated_cursor=v_cursor
      where session_id=p_session_id and id=p_note_id;
  end if;
  perform private.dw_finish_operation(p_operation_id,'flipchart_status',v_payload,jsonb_build_object('noteId',p_note_id));
  return private.dw_flipchart_result_json(p_session_id,p_note_id,v_uid);
end $$;

create function public.dw_flipchart_updates(p_session_id uuid,p_after_cursor bigint default null,p_projector boolean default false)
returns jsonb language sql stable security invoker set search_path='' as $$ select private.dw_flipchart_updates($1,$2,$3) $$;
create function public.dw_flipchart_add(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.dw_flipchart_add($1,$2,$3) $$;
create function public.dw_flipchart_vote(p_operation_id uuid,p_session_id uuid,p_note_id uuid,p_expected_revision bigint,p_input jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.dw_flipchart_vote($1,$2,$3,$4,$5) $$;
create function public.dw_flipchart_status(p_operation_id uuid,p_session_id uuid,p_note_id uuid,p_expected_revision bigint,p_input jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.dw_flipchart_status($1,$2,$3,$4,$5) $$;
revoke all on function private.dw_flipchart_updates(uuid,bigint,boolean),public.dw_flipchart_updates(uuid,bigint,boolean),
  private.dw_flipchart_add(uuid,uuid,jsonb),public.dw_flipchart_add(uuid,uuid,jsonb),
  private.dw_flipchart_vote(uuid,uuid,uuid,bigint,jsonb),public.dw_flipchart_vote(uuid,uuid,uuid,bigint,jsonb),
  private.dw_flipchart_status(uuid,uuid,uuid,bigint,jsonb),public.dw_flipchart_status(uuid,uuid,uuid,bigint,jsonb)
  from public,anon,authenticated;
grant execute on function private.dw_flipchart_updates(uuid,bigint,boolean),public.dw_flipchart_updates(uuid,bigint,boolean),
  private.dw_flipchart_add(uuid,uuid,jsonb),public.dw_flipchart_add(uuid,uuid,jsonb),
  private.dw_flipchart_vote(uuid,uuid,uuid,bigint,jsonb),public.dw_flipchart_vote(uuid,uuid,uuid,bigint,jsonb),
  private.dw_flipchart_status(uuid,uuid,uuid,bigint,jsonb),public.dw_flipchart_status(uuid,uuid,uuid,bigint,jsonb)
  to authenticated;

-- Preserve the complete declared-email dispatcher and extend its exact method allowlist.
create or replace function private.dw_entry_rpc(p_token text,p_method text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_session private.dw_entry_sessions:=private.dw_entry_token(p_token); v_def record; v_key text; v_index integer;
 v_type text; v_value jsonb; v_sql text:=''; v_expr text; v_result jsonb; v_required integer;
 v_old_sub text:=current_setting('request.jwt.claim.sub',true); v_old_claims text:=current_setting('request.jwt.claims',true);
 v_old_id text:=current_setting('demography.entry_id',true); v_old_hash text:=current_setting('demography.entry_hash',true);
begin
 if p_method is null or not(p_method=any(array['dw_flipchart_updates','dw_flipchart_add','dw_flipchart_vote','dw_flipchart_status','dw_enter_workspace','dw_configure_workspace','dw_workspace_votes','dw_workspace_votes_projection','dw_workspace_vote','dw_workshop_survey','dw_workspace_read','dw_workspace_commit','dw_bootstrap','dw_join_session','dw_save_profile','dw_create_session','dw_available_sessions','dw_join_open_session','dw_session_snapshot','dw_session_cursor','dw_projector_snapshot','dw_update_session','dw_publish_submission','dw_moderate_submission','dw_invitation','dw_rotate_invitation','dw_set_member_role','dw_revoke_member','dw_workshop_snapshot','dw_workshop_cursor','dw_workshop_projector_snapshot','dw_workshop_round_snapshot','dw_region_work','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_cast_vote','dw_workshop_updates','dw_workshop_projector_updates','dw_cast_vote_updates','dw_barriers_snapshot','dw_barriers_cursor','dw_barriers_projector_snapshot','dw_save_barrier','dw_barrier_vote','dw_save_barrier_link','dw_save_solution','dw_barrier_evidence','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_roadmaps_index','dw_roadmaps_cursor','dw_roadmap_snapshot','dw_roadmap_version','dw_roadmaps_projector_snapshot','dw_configure_roadmaps','dw_join_roadmap','dw_save_roadmap_item','dw_capture_roadmap_fact','dw_capture_roadmap_basis','dw_freeze_roadmap','dw_review_roadmap','dw_roadmap_statistics_save','dw_roadmap_statistics_restore','dw_roadmap_statistics_history','dw_roadmap_statistics_series']::text[])) then perform private.dw_fail('FORBIDDEN'); end if;
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
