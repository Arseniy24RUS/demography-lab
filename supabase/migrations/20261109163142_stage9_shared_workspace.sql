-- Stage 9: one installation-wide collaborative workspace. Historical sessions,
-- source editions, immutable voting rounds and roadmap versions remain intact.
create table private.dw_current_workspace (
  singleton boolean primary key default true check(singleton),
  session_id uuid not null unique references public.dw_sessions(id),
  created_at timestamptz not null default now()
);
alter table private.dw_current_workspace enable row level security;
revoke all on private.dw_current_workspace from public,anon,authenticated;

create function private.dw_is_current_workspace(p_session_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.dw_current_workspace where singleton and session_id=p_session_id)
$$;
create function private.dw_can_project_workspace(p_session_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select private.dw_is_current_workspace(p_session_id)
    and private.dw_member_role(p_session_id) in ('host','participant')
$$;
revoke all on function private.dw_is_current_workspace(uuid),private.dw_can_project_workspace(uuid) from public,anon,authenticated;

-- An old tab cannot reintroduce a classroom admission gate for this workspace.
create function private.dw_workspace_always_open() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if private.dw_is_current_workspace(new.id) then new.status:='open'; new.join_open:=true; end if;
  return new;
end $$;
create trigger dw_workspace_always_open before update of status,join_open on public.dw_sessions
for each row execute function private.dw_workspace_always_open();
revoke all on function private.dw_workspace_always_open() from public,anon,authenticated;

-- Identity disable/revocation remains an administrator operation. Membership of
-- the live board cannot be changed to observer/revoked by an obsolete client.
create function private.dw_workspace_member_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if private.dw_is_current_workspace(new.session_id)
    and (new.revoked_at is not null or new.role='observer'
      or (new.role='host' and not exists(select 1 from private.facilitators where user_id=new.user_id and revoked_at is null)))
    then perform private.dw_fail('FORBIDDEN'); end if;
  return new;
end $$;
create trigger dw_workspace_member_guard before insert or update of role,revoked_at on public.dw_memberships
for each row execute function private.dw_workspace_member_guard();
revoke all on function private.dw_workspace_member_guard() from public,anon,authenticated;

create function private.dw_enter_workspace(p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_id uuid; v_session public.dw_sessions;
 v_member public.dw_memberships; v_host boolean; v_role text; v_old jsonb; v_revision bigint;
begin
 if not exists(select 1 from public.dw_profiles where user_id=v_uid) then perform private.dw_fail('PROFILE_REQUIRED'); end if;
 v_old:=private.dw_begin_operation(p_operation_id,'enter_workspace','{}'::jsonb);
 -- Every entry takes the same lock before selecting or creating a board.
 perform pg_advisory_xact_lock(hashtextextended('demography:current-workspace',0));
 select session_id into v_id from private.dw_current_workspace where singleton for update;
 if v_id is null then
   -- Adopt only an existing active session. A closed rehearsal is never revived.
   select s.id into v_id from public.dw_sessions s where s.status='open'
     and not exists(select 1 from private.dw_voting_rounds r where r.session_id=s.id and r.status='open')
     order by s.created_at desc,s.id limit 1 for update;
   if v_id is null then
     insert into public.dw_sessions(owner_id,title,scope,region_id,status,phase,join_open)
       values(v_uid,'Демографическая мастерская','municipality','respublika-mordoviia','open','reading',true)
       returning id into v_id;
   end if;
   insert into private.dw_current_workspace(singleton,session_id) values(true,v_id);
 end if;
 select * into v_session from public.dw_sessions where id=v_id for update;
 if v_session.status<>'open' or not v_session.join_open then
   update public.dw_sessions set status='open',join_open=true,revision=revision+1,updated_at=now() where id=v_id;
 end if;
 v_host:=exists(select 1 from private.facilitators where user_id=v_uid and revoked_at is null);
 v_role:=case when v_host then 'host' else 'participant' end;
 select * into v_member from public.dw_memberships where session_id=v_id and user_id=v_uid for update;
 if not found then
   if (select count(*) from public.dw_memberships where session_id=v_id and revoked_at is null)>=1000 then
     perform private.dw_fail('LIMIT_EXCEEDED'); end if;
   insert into public.dw_memberships(session_id,user_id,role) values(v_id,v_uid,v_role) returning revision into v_revision;
   perform private.dw_event(v_id,p_operation_id,'member.joined',v_uid,v_revision);
 elsif v_member.revoked_at is not null or v_member.role is distinct from v_role then
   update public.dw_memberships set revoked_at=null,role=v_role,revision=revision+1 where session_id=v_id and user_id=v_uid
     returning revision into v_revision;
   perform private.dw_event(v_id,p_operation_id,'member.joined',v_uid,v_revision);
 end if;
 if v_old is null then
   perform private.dw_finish_operation(p_operation_id,'enter_workspace','{}'::jsonb,jsonb_build_object('sessionId',v_id));
 end if;
 return private.dw_snapshot(v_id);
end $$;
create function public.dw_enter_workspace(p_operation_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select private.dw_enter_workspace($1) $$;
revoke all on function private.dw_enter_workspace(uuid),public.dw_enter_workspace(uuid) from public,anon,authenticated;
grant execute on function private.dw_enter_workspace(uuid),public.dw_enter_workspace(uuid) to authenticated;

create function private.dw_configure_workspace(p_operation_id uuid,p_session_id uuid,p_expected_revision bigint,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_session public.dw_sessions; v_old jsonb;
 v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'revision',p_expected_revision,'input',p_input);
 v_scope text; v_region text; v_context_changed boolean;
begin
 if not private.dw_is_current_workspace(p_session_id) or private.dw_member_role(p_session_id) is distinct from 'host' then
   perform private.dw_fail('FORBIDDEN'); end if;
 v_old:=private.dw_begin_operation(p_operation_id,'configure_workspace',v_payload);
 if v_old is not null then return private.dw_snapshot(p_session_id); end if;
 select * into v_session from public.dw_sessions where id=p_session_id for update;
 if p_expected_revision is null or v_session.revision<>p_expected_revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
 if p_input is null or not private.dw_keys(p_input,array['title','scope','regionId'])
   or not (p_input ?& array['title','scope','regionId'])
   or not private.dw_text(p_input->'title',1,200) or btrim(p_input->>'title')=''
   or coalesce(p_input->>'scope','') not in ('municipality','region','federal')
   then perform private.dw_fail('INVALID_INPUT'); end if;
 v_scope:=p_input->>'scope'; v_region:=p_input->>'regionId';
 if (v_scope='federal' and p_input->'regionId'<>'null'::jsonb)
   or (v_scope<>'federal' and (not private.dw_id(p_input->'regionId') or v_region is null)) then perform private.dw_fail('INVALID_INPUT'); end if;
 if v_scope<>'federal' and not exists(select 1 from private.source_versions where region_id=v_region and sealed)
   and not exists(select 1 from private.dw_roadmap_territories t join private.dw_roadmap_datasets d on d.id=t.dataset_id
     where t.region_id=v_region and d.sealed) then perform private.dw_fail('REGION_UNAVAILABLE'); end if;
 v_context_changed:=v_session.scope<>v_scope or v_session.region_id is distinct from v_region;
 if v_context_changed
   and exists(select 1 from private.dw_roadmaps where session_id=p_session_id) then perform private.dw_fail('CONTEXT_IN_USE'); end if;
 update public.dw_sessions set title=btrim(p_input->>'title'),scope=v_scope,region_id=v_region,
   revision=revision+1,updated_at=now() where id=p_session_id returning * into v_session;
 update private.dw_roadmap_state set room_level=v_scope,revision=revision+1
   where session_id=p_session_id and room_level<>v_scope and v_context_changed;
 perform private.dw_event(p_session_id,p_operation_id,'session.updated',p_session_id,v_session.revision);
 perform private.dw_finish_operation(p_operation_id,'configure_workspace',v_payload,jsonb_build_object('sessionId',p_session_id));
 return private.dw_snapshot(p_session_id);
end $$;
create function public.dw_configure_workspace(p_operation_id uuid,p_session_id uuid,p_expected_revision bigint,p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.dw_configure_workspace($1,$2,$3,$4) $$;
revoke all on function private.dw_configure_workspace(uuid,uuid,bigint,jsonb),public.dw_configure_workspace(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function private.dw_configure_workspace(uuid,uuid,bigint,jsonb),public.dw_configure_workspace(uuid,uuid,bigint,jsonb) to authenticated;

-- Live discussion votes are separate from the immutable research-round ledger.
-- Each vote names the exact family material; edited material requires a new vote.
create table private.dw_workspace_votes (
 session_id uuid not null references public.dw_sessions(id),
 family_id uuid not null,
 actor_id uuid not null references public.dw_profiles(user_id),
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 value integer check(value in (-1,1)),
 revision bigint not null default 1 check(revision between 1 and 9007199254740991),
 primary key(session_id,family_id,actor_id),
 foreign key(session_id,family_id) references private.dw_practice_families(session_id,id) on delete cascade
);
alter table private.dw_workspace_votes enable row level security;
revoke all on private.dw_workspace_votes from public,anon,authenticated;
create index dw_workspace_votes_actor on private.dw_workspace_votes(actor_id,session_id);

create function private.dw_workspace_votes_json(p_session_id uuid,p_projector boolean default false) returns jsonb
language sql stable set search_path='' as $$
 with eligible as (
   select user_id from public.dw_memberships where session_id=p_session_id and revoked_at is null and role in ('host','participant')
 ), families as (
   select f.id,f.title,encode(sha256(convert_to(m.material::text,'UTF8')),'hex') as fingerprint
   from private.dw_practice_families f cross join lateral (select private.dw_barrier_family_material(p_session_id,f.id) material) m
   where f.session_id=p_session_id and m.material is not null
 ), counted as (
   select f.id,f.title,f.fingerprint,
    (select count(*) from private.dw_workspace_votes v join eligible e on e.user_id=v.actor_id
      where v.session_id=p_session_id and v.family_id=f.id and v.fingerprint=f.fingerprint and v.value=1) as support,
    (select count(*) from private.dw_workspace_votes v join eligible e on e.user_id=v.actor_id
      where v.session_id=p_session_id and v.family_id=f.id and v.fingerprint=f.fingerprint and v.value=-1) as oppose,
    mine.value as my_value,mine.fingerprint as my_fingerprint,mine.revision as my_revision
   from families f left join private.dw_workspace_votes mine on mine.session_id=p_session_id and mine.family_id=f.id and mine.actor_id=auth.uid()
 )
 select jsonb_build_object('sessionId',p_session_id,
   'cursor',(select event_cursor from private.dw_workshop_state where session_id=p_session_id),
   'participantCount',(select count(*) from eligible),
   'families',coalesce((select jsonb_agg(jsonb_build_object('familyId',c.id,'title',c.title,'fingerprint',c.fingerprint,
     'support',c.support,'oppose',c.oppose,'unanswered',(select count(*) from eligible)-c.support-c.oppose,'score',c.support-c.oppose)
     ||case when p_projector then '{}'::jsonb else jsonb_build_object(
       'myVote',case when c.my_fingerprint=c.fingerprint then c.my_value else null end,
       'myVoteRevision',coalesce(c.my_revision,0),'needsReview',coalesce(c.my_value is not null and c.my_fingerprint<>c.fingerprint,false)) end
     order by c.id) from counted c),'[]'::jsonb))
$$;
revoke all on function private.dw_workspace_votes_json(uuid,boolean) from public,anon,authenticated;

create function private.dw_workspace_votes(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid();
begin
 if not private.dw_is_current_workspace(p_session_id) or private.dw_member_role(p_session_id) is null then perform private.dw_fail('FORBIDDEN'); end if;
 return private.dw_workspace_votes_json(p_session_id,false);
end $$;
create function private.dw_workspace_votes_projection(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid();
begin
 if not private.dw_can_project_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
 return private.dw_workspace_votes_json(p_session_id,true);
end $$;
create function private.dw_workspace_vote(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_value integer,p_expected_revision bigint,p_expected_fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_old jsonb; v_role text; v_material jsonb; v_fingerprint text;
 v_vote private.dw_workspace_votes; v_revision bigint;
 v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id,'value',p_value,'revision',p_expected_revision,'fingerprint',p_expected_fingerprint);
begin
 if not private.dw_is_current_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
 v_role:=private.dw_member_role(p_session_id); if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
 v_old:=private.dw_begin_operation(p_operation_id,'workspace_vote',v_payload);
 if v_old is not null then return private.dw_workspace_votes_json(p_session_id,false); end if;
 perform 1 from public.dw_sessions where id=p_session_id for update;
 v_role:=private.dw_member_role(p_session_id); if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
 if p_expected_revision is null or p_expected_revision<0 or p_value is not null and p_value not in (-1,1)
   or p_expected_fingerprint is null or p_expected_fingerprint !~ '^[a-f0-9]{64}$' then perform private.dw_fail('INVALID_INPUT'); end if;
 v_material:=private.dw_barrier_family_material(p_session_id,p_family_id);
 if v_material is null then perform private.dw_fail('NOT_FOUND'); end if;
 v_fingerprint:=encode(sha256(convert_to(v_material::text,'UTF8')),'hex');
 if v_fingerprint<>p_expected_fingerprint then perform private.dw_fail('FAMILY_CHANGED'); end if;
 select * into v_vote from private.dw_workspace_votes where session_id=p_session_id and family_id=p_family_id and actor_id=v_uid for update;
 if coalesce(v_vote.revision,0)<>p_expected_revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
 insert into private.dw_workspace_votes(session_id,family_id,actor_id,fingerprint,value)
   values(p_session_id,p_family_id,v_uid,v_fingerprint,p_value)
   on conflict(session_id,family_id,actor_id) do update set fingerprint=excluded.fingerprint,value=excluded.value,revision=private.dw_workspace_votes.revision+1
   returning revision into v_revision;
 perform private.dw_workshop_touch(p_session_id,'workspace.vote',false);
 perform private.dw_finish_operation(p_operation_id,'workspace_vote',v_payload,jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id,'revision',v_revision));
 return private.dw_workspace_votes_json(p_session_id,false);
end $$;
create function public.dw_workspace_votes(p_session_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_workspace_votes($1) $$;
create function public.dw_workspace_votes_projection(p_session_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_workspace_votes_projection($1) $$;
create function public.dw_workspace_vote(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_value integer,p_expected_revision bigint,p_expected_fingerprint text) returns jsonb
language sql security invoker set search_path='' as $$ select private.dw_workspace_vote($1,$2,$3,$4,$5,$6) $$;
revoke all on function public.dw_workspace_votes(uuid),private.dw_workspace_votes(uuid),public.dw_workspace_votes_projection(uuid),private.dw_workspace_votes_projection(uuid),
 public.dw_workspace_vote(uuid,uuid,uuid,integer,bigint,text),private.dw_workspace_vote(uuid,uuid,uuid,integer,bigint,text) from public,anon,authenticated;
grant execute on function public.dw_workspace_votes(uuid),private.dw_workspace_votes(uuid),public.dw_workspace_votes_projection(uuid),private.dw_workspace_votes_projection(uuid),
 public.dw_workspace_vote(uuid,uuid,uuid,integer,bigint,text),private.dw_workspace_vote(uuid,uuid,uuid,integer,bigint,text) to authenticated;

-- Current-board phase and projection compatibility; historical permissions remain.

create or replace function private.dw_publish_submission(p_operation_id uuid,p_session_id uuid,p_local_key text,p_expected_revision bigint,p_bundle jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_old jsonb; v_role text; v_bundle jsonb;
  v_session public.dw_sessions; v_submission public.dw_submissions; v_existing boolean;
begin
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'localKey',p_local_key,'revision',p_expected_revision,'bundle',p_bundle);
  v_old:=private.dw_begin_operation(p_operation_id,'publish_submission',v_payload);
  if v_old is not null then return private.dw_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  -- Re-check current membership after the lock: a concurrent revocation cannot race the write.
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if not private.dw_is_current_workspace(p_session_id) and v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
  if p_local_key is null or not private.dw_id(to_jsonb(p_local_key)) then perform private.dw_fail('INVALID_INPUT'); end if;
  select * into v_submission from public.dw_submissions where session_id=p_session_id and author_id=v_uid and local_key=p_local_key for update;
  v_existing:=found;
  if v_existing then
    if p_expected_revision is null or p_expected_revision<>v_submission.revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if v_submission.status='withdrawn' then perform private.dw_fail('FORBIDDEN'); end if;
    if p_bundle#>>'{practice,id}' is distinct from v_submission.bundle#>>'{practice,id}' then perform private.dw_fail('INVALID_INPUT'); end if;
  elsif p_expected_revision is not null then perform private.dw_fail('REVISION_CONFLICT'); end if;
  v_bundle:=private.dw_validate_bundle(p_bundle);
  if exists(select 1 from public.dw_submissions where session_id=p_session_id and author_id=v_uid
    and local_key<>p_local_key and bundle#>>'{practice,id}'=v_bundle#>>'{practice,id}') then perform private.dw_fail('INVALID_INPUT'); end if;
  if not v_existing and (select count(*) from public.dw_submissions where session_id=p_session_id)>=5000 then perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  if coalesce((select sum(octet_length(bundle::text)) from public.dw_submissions
      where session_id=p_session_id and (not v_existing or id<>v_submission.id)),0)+octet_length(v_bundle::text)>4194304 then
    perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  if v_existing then
    update public.dw_submissions set bundle=v_bundle,revision=revision+1,updated_at=now()
      where id=v_submission.id returning * into v_submission;
  else
    insert into public.dw_submissions(session_id,author_id,local_key,bundle) values(p_session_id,v_uid,p_local_key,v_bundle)
      returning * into v_submission;
  end if;
  perform private.dw_event(p_session_id,p_operation_id,'submission.published',v_submission.id,v_submission.revision);
  perform private.dw_finish_operation(p_operation_id,'publish_submission',v_payload,
    jsonb_build_object('sessionId',p_session_id,'entityId',v_submission.id,'revision',v_submission.revision));
  return private.dw_snapshot(p_session_id);
end $$;

create or replace function private.dw_moderate_submission(p_operation_id uuid,p_session_id uuid,p_submission_id uuid,p_expected_revision bigint,p_status text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_old jsonb; v_role text;
  v_session public.dw_sessions; v_submission public.dw_submissions;
begin
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'submissionId',p_submission_id,'revision',p_expected_revision,'status',p_status);
  v_old:=private.dw_begin_operation(p_operation_id,'moderate_submission',v_payload);
  if v_old is not null then return private.dw_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_submission from public.dw_submissions where id=p_submission_id and session_id=p_session_id for update;
  if not found then perform private.dw_fail('FORBIDDEN'); end if;
  if p_status is null or p_status not in ('shared','withdrawn') then perform private.dw_fail('INVALID_INPUT'); end if;
  if v_role<>'host' then
    if v_submission.author_id<>v_uid or p_status<>'withdrawn' then perform private.dw_fail('FORBIDDEN'); end if;
    if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
    if not private.dw_is_current_workspace(p_session_id) and v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
  end if;
  if p_expected_revision is null or p_expected_revision<>v_submission.revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  update public.dw_submissions set status=p_status,revision=revision+1,updated_at=now() where id=p_submission_id returning * into v_submission;
  if p_status='withdrawn' and v_session.focus_submission_id=p_submission_id then
    update public.dw_sessions set focus_submission_id=null,revision=revision+1,updated_at=now() where id=p_session_id;
  end if;
  perform private.dw_event(p_session_id,p_operation_id,'submission.moderated',p_submission_id,v_submission.revision);
  perform private.dw_finish_operation(p_operation_id,'moderate_submission',v_payload,
    jsonb_build_object('sessionId',p_session_id,'entityId',p_submission_id,'revision',v_submission.revision));
  return private.dw_snapshot(p_session_id);
end $$;

create or replace function private.dw_region_work(p_operation_id uuid,p_session_id uuid,p_region_id text,p_action text,
  p_expected_revision bigint,p_note text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_role text; v_payload jsonb; v_replay jsonb;
  v_session public.dw_sessions; v_work private.dw_region_work; v_exists boolean; v_now timestamptz;
begin
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'regionId',p_region_id,'action',p_action,
    'revision',p_expected_revision,'note',p_note);
  v_replay:=private.dw_begin_operation(p_operation_id,'region_work',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if not private.dw_is_current_workspace(p_session_id) and v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
  if not private.dw_id(to_jsonb(p_region_id)) or coalesce(p_action,'') not in ('claim','release','complete','reopen','renew')
    or p_expected_revision is null or p_expected_revision<0 or not private.dw_text(to_jsonb(p_note),0,4000) then
    perform private.dw_fail('INVALID_INPUT');
  end if;
  if not exists(select 1 from private.source_versions where region_id=p_region_id and sealed) then
    perform private.dw_fail('REGION_UNAVAILABLE');
  end if;
  select * into v_work from private.dw_region_work where session_id=p_session_id and region_id=p_region_id for update;
  v_exists:=found; v_now:=clock_timestamp();
  if p_expected_revision<>(case when v_exists then v_work.revision else 0 end) then
    perform private.dw_fail('REVISION_CONFLICT');
  end if;
  if p_action='claim' then
    if v_exists and (v_work.status='completed'
      or (v_work.status='in_progress' and v_work.lease_expires_at>v_now and v_work.owner_id<>v_uid and v_role<>'host')) then
      perform private.dw_fail('REGION_TAKEN');
    end if;
    insert into private.dw_region_work(session_id,region_id,owner_id,status,lease_expires_at,revision)
      values(p_session_id,p_region_id,v_uid,'in_progress',v_now+interval '30 minutes',1)
      on conflict(session_id,region_id) do update set owner_id=v_uid,status='in_progress',
        lease_expires_at=v_now+interval '30 minutes',completion_note='',revision=private.dw_region_work.revision+1,updated_at=v_now
      returning * into v_work;
  else
    if not v_exists then perform private.dw_fail('NOT_FOUND'); end if;
    if v_work.owner_id is distinct from v_uid and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    if p_action='release' then
      update private.dw_region_work set status='available',owner_id=null,lease_expires_at=null,completion_note='',
        revision=revision+1,updated_at=v_now where session_id=p_session_id and region_id=p_region_id returning * into v_work;
    elsif p_action='reopen' then
      if v_work.status<>'completed' then perform private.dw_fail('INVALID_INPUT'); end if;
      update private.dw_region_work set status='in_progress',owner_id=v_uid,lease_expires_at=v_now+interval '30 minutes',
        completion_note='',revision=revision+1,updated_at=v_now
        where session_id=p_session_id and region_id=p_region_id returning * into v_work;
    else
      if v_work.status<>'in_progress' then perform private.dw_fail('INVALID_INPUT'); end if;
      if v_work.lease_expires_at<=v_now then perform private.dw_fail('LEASE_EXPIRED'); end if;
      if p_action='renew' then
        update private.dw_region_work set lease_expires_at=v_now+interval '30 minutes',revision=revision+1,updated_at=v_now
          where session_id=p_session_id and region_id=p_region_id returning * into v_work;
      else
        if not exists(select 1 from public.dw_submissions where session_id=p_session_id and status='shared'
          and bundle#>>'{practice,regionId}'=p_region_id) and char_length(btrim(p_note))<10 then
          perform private.dw_fail('COMPLETION_NOTE_REQUIRED');
        end if;
        update private.dw_region_work set status='completed',lease_expires_at=null,completion_note=btrim(p_note),
          revision=revision+1,updated_at=v_now where session_id=p_session_id and region_id=p_region_id returning * into v_work;
      end if;
    end if;
  end if;
  perform private.dw_workshop_touch(p_session_id,'region.'||p_action);
  perform private.dw_finish_operation(p_operation_id,'region_work',v_payload,jsonb_build_object('sessionId',p_session_id,'revision',v_work.revision));
  return private.dw_workshop_snapshot(p_session_id);
end $$;

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

create or replace function private.dw_delete_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb;
  v_session public.dw_sessions; v_state private.dw_workshop_state; v_revision bigint;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' and not private.dw_can_project_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id,'boardRevision',p_expected_board_revision);
  v_replay:=private.dw_begin_operation(p_operation_id,'delete_family',v_payload);
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

create or replace function private.dw_open_voting_round(p_operation_id uuid,p_session_id uuid,p_title text,p_results_visibility text,
  p_expected_board_revision bigint,p_settings jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb; v_session public.dw_sessions;
  v_state private.dw_workshop_state; v_round uuid:=gen_random_uuid(); v_eligible integer; v_families integer;
  v_settings jsonb:=coalesce(p_settings,'{}'::jsonb); v_prompt text; v_min_coverage numeric:=0.7; v_min_votes numeric;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if private.dw_is_current_workspace(p_session_id) then perform private.dw_fail('WORKSPACE_LIVE_VOTING'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'title',p_title,'visibility',p_results_visibility,
    'boardRevision',p_expected_board_revision,'settings',v_settings);
  v_replay:=private.dw_begin_operation(p_operation_id,'open_voting_round',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if not private.dw_is_current_workspace(p_session_id) and v_session.phase<>'discussion' then perform private.dw_fail('PHASE_CLOSED'); end if;
  if exists(select 1 from private.dw_voting_rounds where session_id=p_session_id and status='open') then
    perform private.dw_fail('ROUND_OPEN'); end if;
  select * into v_state from private.dw_workshop_state where session_id=p_session_id for update;
  if p_expected_board_revision is null or p_expected_board_revision<>v_state.board_revision then
    perform private.dw_fail('REVISION_CONFLICT'); end if;
  if not private.dw_text(to_jsonb(p_title),1,200) or btrim(p_title)=''
    or coalesce(p_results_visibility,'') not in ('live','after_close')
    or not private.dw_keys(v_settings,array['promptText','minCoverage','minSubstantiveVotes'])
    or octet_length(v_settings::text)>4096 then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_results_visibility='live' and not exists(select 1 from private.dw_voting_rounds where session_id=p_session_id) then
    perform private.dw_fail('FIRST_ROUND_BLIND'); end if;
  if (select count(*) from private.dw_voting_rounds where session_id=p_session_id)>=100 then perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  select count(*) into v_eligible from public.dw_memberships m
    where m.session_id=p_session_id and m.revoked_at is null and m.role in ('host','participant')
      and private.dw_actor_eligible(m.user_id);
  select count(*) into v_families from private.dw_practice_families f where f.session_id=p_session_id
    and exists(select 1 from private.dw_family_members m join public.dw_submissions s on s.id=m.submission_id
      where m.family_id=f.id and s.status='shared');
  if v_eligible<1 or v_families<1 then perform private.dw_fail('ROUND_NOT_READY'); end if;
  if v_eligible>1000 or v_families>200 then perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  v_prompt:='Считаете ли Вы эту практику приоритетной для адаптации в выбранном контексте?';
  if v_settings?'promptText' then
    if not private.dw_text(v_settings->'promptText',1,1000) or btrim(v_settings->>'promptText')='' then
      perform private.dw_fail('INVALID_INPUT'); end if;
    v_prompt:=btrim(v_settings->>'promptText');
  end if;
  if v_settings?'minCoverage' then
    if jsonb_typeof(v_settings->'minCoverage') is distinct from 'number' then perform private.dw_fail('INVALID_INPUT'); end if;
    v_min_coverage:=(v_settings->>'minCoverage')::numeric;
    if v_min_coverage<0 or v_min_coverage>1 then perform private.dw_fail('INVALID_INPUT'); end if;
  end if;
  v_min_votes:=least(3,v_eligible);
  if v_settings?'minSubstantiveVotes' then
    if jsonb_typeof(v_settings->'minSubstantiveVotes') is distinct from 'number' then perform private.dw_fail('INVALID_INPUT'); end if;
    v_min_votes:=(v_settings->>'minSubstantiveVotes')::numeric;
    if v_min_votes<1 or v_min_votes>v_eligible or trunc(v_min_votes)<>v_min_votes then perform private.dw_fail('INVALID_INPUT'); end if;
  end if;
  insert into private.dw_voting_rounds(id,session_id,title,results_visibility,prompt_text,context_scope,context_region_id,
    min_coverage,min_substantive_votes,eligible_count,family_count,opened_at)
    values(v_round,p_session_id,btrim(p_title),p_results_visibility,v_prompt,v_session.scope,v_session.region_id,
      v_min_coverage,v_min_votes::integer,v_eligible,v_families,clock_timestamp());
  insert into private.dw_round_families(round_id,family_id,source_family_revision,title,mechanism,rationale,ordinal)
    select v_round,f.id,f.revision,f.title,f.mechanism,f.rationale,(row_number() over(order by f.created_at,f.id))::integer
    from private.dw_practice_families f where f.session_id=p_session_id
      and exists(select 1 from private.dw_family_members m join public.dw_submissions s on s.id=m.submission_id
        where m.family_id=f.id and s.status='shared');
  insert into private.dw_round_variants(round_id,family_id,submission_id,submission_revision,bundle)
    select v_round,f.family_id,s.id,s.revision,s.bundle from private.dw_round_families f
      join private.dw_family_members m on m.family_id=f.family_id and m.session_id=p_session_id
      join public.dw_submissions s on s.id=m.submission_id where f.round_id=v_round and s.status='shared';
  insert into private.dw_round_roster(round_id,user_id)
    select v_round,m.user_id from public.dw_memberships m
    where m.session_id=p_session_id and m.revoked_at is null and m.role in ('host','participant')
      and private.dw_actor_eligible(m.user_id);
  if (select coalesce(sum(octet_length(bundle::text)),0) from private.dw_round_variants where round_id=v_round)>8388608
    or (select coalesce(sum(octet_length(v.bundle::text)),0) from private.dw_round_variants v
      join private.dw_voting_rounds r on r.id=v.round_id where r.session_id=p_session_id)>67108864 then
    perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  update private.dw_voting_rounds set sealed=true where id=v_round;
  perform private.dw_workshop_touch(p_session_id,'round.opened');
  insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
    values(p_session_id,v_uid,p_operation_id,'workshop.round.opened',v_round,1);
  perform private.dw_finish_operation(p_operation_id,'open_voting_round',v_payload,jsonb_build_object('sessionId',p_session_id,'roundId',v_round));
  return private.dw_workshop_snapshot(p_session_id);
end $$;

create or replace function private.dw_cast_vote(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_family_id uuid,p_value integer,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb; v_role text;
  v_session public.dw_sessions; v_round private.dw_voting_rounds; v_ballot private.dw_ballots; v_exists boolean;
begin
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'roundId',p_round_id,'familyId',p_family_id,'value',p_value,'revision',p_expected_revision);
  v_replay:=private.dw_begin_operation(p_operation_id,'cast_vote',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if not private.dw_is_current_workspace(p_session_id) and v_session.phase<>'discussion' then perform private.dw_fail('PHASE_CLOSED'); end if;
  select * into v_round from private.dw_voting_rounds where id=p_round_id and session_id=p_session_id for update;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_round.status<>'open' then perform private.dw_fail('ROUND_CLOSED'); end if;
  if not exists(select 1 from private.dw_round_roster where round_id=p_round_id and user_id=v_uid) then
    perform private.dw_fail('NOT_ELIGIBLE'); end if;
  if not exists(select 1 from private.dw_round_families where round_id=p_round_id and family_id=p_family_id) then
    perform private.dw_fail('NOT_FOUND'); end if;
  if p_value is not null and p_value not in (-1,0,1) then perform private.dw_fail('INVALID_INPUT'); end if;
  select * into v_ballot from private.dw_ballots where round_id=p_round_id and family_id=p_family_id and user_id=v_uid for update;
  v_exists:=found;
  if p_expected_revision is null or p_expected_revision<>(case when v_exists then v_ballot.revision else 0 end) then
    perform private.dw_fail('REVISION_CONFLICT'); end if;
  insert into private.dw_ballots(round_id,family_id,user_id,value) values(p_round_id,p_family_id,v_uid,p_value)
    on conflict(round_id,family_id,user_id) do update set value=excluded.value,
      revision=private.dw_ballots.revision+1,updated_at=clock_timestamp() returning * into v_ballot;
  perform private.dw_workshop_touch(p_session_id,'ballot.changed');
  perform private.dw_finish_operation(p_operation_id,'cast_vote',v_payload,
    jsonb_build_object('sessionId',p_session_id,'roundId',p_round_id,'revision',v_ballot.revision));
  return private.dw_workshop_snapshot(p_session_id);
end $$;

create or replace function private.dw_projector_snapshot(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' and not private.dw_can_project_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
  select jsonb_build_object('title',s.title,'phase',s.phase,'status',s.status,'focusSubmissionId',s.focus_submission_id,
    'projectorShowAuthors',s.projector_show_authors,'cursor',s.event_cursor,
    'participantCount',(select count(*) from public.dw_memberships where session_id=s.id and revoked_at is null and role<>'host'),
    'submissions',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'bundle',x.bundle,'revision',x.revision,'updatedAt',x.updated_at)
      || case when s.projector_show_authors then jsonb_build_object('authorName',p.full_name) else '{}'::jsonb end
      order by x.created_at,x.id) from public.dw_submissions x join public.dw_profiles p on p.user_id=x.author_id
      where x.session_id=s.id and x.status='shared'),'[]'::jsonb)) into v_result
    from public.dw_sessions s where s.id=p_session_id and (private.dw_member_role(s.id)='host' or private.dw_can_project_workspace(s.id));
  if v_result is null then perform private.dw_fail('FORBIDDEN'); end if;
  return v_result;
end $$;

create or replace function private.dw_workshop_projector_snapshot(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' and not private.dw_can_project_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
  select jsonb_build_object('sessionId',s.id,'title',s.title,'phase',s.phase,'status',s.status,'cursor',w.event_cursor,
    'regionWork',coalesce((select jsonb_agg(jsonb_build_object('regionId',region_id,'status',status,
      'revision',revision,'leaseExpiresAt',lease_expires_at) order by region_id) from private.dw_region_work where session_id=s.id),'[]'::jsonb),
    'familyCount',(select count(*) from private.dw_practice_families where session_id=s.id),
    'groupedSubmissionCount',(select count(*) from private.dw_family_members m join public.dw_submissions x on x.id=m.submission_id
      where m.session_id=s.id and x.status='shared'),
    'round',(select private.dw_round_json(r.id,true) from private.dw_voting_rounds r
      where r.session_id=s.id order by r.opened_at desc,r.id desc limit 1)) into v_result
    from public.dw_sessions s join private.dw_workshop_state w on w.session_id=s.id
    where s.id=p_session_id and (private.dw_member_role(s.id)='host' or private.dw_can_project_workspace(s.id));
  if v_result is null then perform private.dw_fail('FORBIDDEN'); end if;
  return v_result;
end $$;

create or replace function private.dw_barriers_projector_snapshot(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid();
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' and not private.dw_can_project_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
  return private.dw_barriers_json(p_session_id,true);
end $$;

create or replace function private.dw_roadmaps_projector_snapshot(p_session_id uuid,p_roadmap_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r text; result jsonb; selected jsonb; begin
  r:=private.dw_roadmap_read_guard(p_session_id); if r<>'host' and not private.dw_can_project_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
  if p_roadmap_id is not null then
    select jsonb_build_object('roadmapId',rm.id,'territory',rm.territory,'roomLevel',st.room_level,'revision',rm.revision,
      'items',private.dw_roadmap_items_json(rm.id,false),'basis',private.dw_roadmap_bases_json(p_session_id,rm.id),
      'series',private.dw_roadmap_series_json(rm.id),'statistics',private.dw_s6_heads_json(rm.id),'budget',private.dw_roadmap_budget(rm.id)) into selected
      from private.dw_roadmaps rm join private.dw_roadmap_state st on st.session_id=rm.session_id where rm.id=p_roadmap_id and rm.session_id=p_session_id;
    if selected is null then perform private.dw_fail('NOT_FOUND'); end if;
  end if;
  select jsonb_build_object('sessionId',s.id,'title',s.title,'cursor',st.event_cursor,'sourceCursor',st.source_cursor,
    'rooms',private.dw_roadmap_rooms_json(p_session_id),'selected',selected) into result
    from public.dw_sessions s join private.dw_roadmap_state st on st.session_id=s.id where s.id=p_session_id;
  if octet_length(result::text)>1048576 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
  return result;
end $$;

create or replace function private.dw_entry_rpc(p_token text,p_method text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_session private.dw_entry_sessions:=private.dw_entry_token(p_token); v_def record; v_key text; v_index integer;
 v_type text; v_value jsonb; v_sql text:=''; v_expr text; v_result jsonb; v_required integer;
 v_old_sub text:=current_setting('request.jwt.claim.sub',true); v_old_claims text:=current_setting('request.jwt.claims',true);
 v_old_id text:=current_setting('demography.entry_id',true); v_old_hash text:=current_setting('demography.entry_hash',true);
begin
 if p_method is null or not(p_method=any(array['dw_enter_workspace','dw_configure_workspace','dw_workspace_votes','dw_workspace_votes_projection','dw_workspace_vote','dw_workshop_survey','dw_workspace_read','dw_workspace_commit','dw_bootstrap','dw_join_session','dw_save_profile','dw_create_session','dw_available_sessions','dw_join_open_session','dw_session_snapshot','dw_session_cursor','dw_projector_snapshot','dw_update_session','dw_publish_submission','dw_moderate_submission','dw_invitation','dw_rotate_invitation','dw_set_member_role','dw_revoke_member','dw_workshop_snapshot','dw_workshop_cursor','dw_workshop_projector_snapshot','dw_workshop_round_snapshot','dw_region_work','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_cast_vote','dw_workshop_updates','dw_workshop_projector_updates','dw_cast_vote_updates','dw_barriers_snapshot','dw_barriers_cursor','dw_barriers_projector_snapshot','dw_save_barrier','dw_barrier_vote','dw_save_barrier_link','dw_save_solution','dw_barrier_evidence','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_roadmaps_index','dw_roadmaps_cursor','dw_roadmap_snapshot','dw_roadmap_version','dw_roadmaps_projector_snapshot','dw_configure_roadmaps','dw_join_roadmap','dw_save_roadmap_item','dw_capture_roadmap_fact','dw_capture_roadmap_basis','dw_freeze_roadmap','dw_review_roadmap','dw_roadmap_statistics_save','dw_roadmap_statistics_restore','dw_roadmap_statistics_history','dw_roadmap_statistics_series']::text[])) then perform private.dw_fail('FORBIDDEN'); end if;
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
