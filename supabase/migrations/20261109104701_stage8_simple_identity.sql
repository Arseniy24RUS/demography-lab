-- Stage 8: declared email + full name, with automatic opaque browser sessions.
-- No mailbox verification is fabricated. Existing Auth UUIDs and all authored work survive.
-- New learner identities are private application actors, never Supabase Auth accounts.

create table private.dw_actors (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('auth','declared','operator')),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  check((kind='auth' and auth_user_id=id) or (kind in ('declared','operator') and auth_user_id is null))
);
create table private.dw_declared_identities (
  email text primary key check(char_length(email) between 3 and 254),
  actor_id uuid not null unique references private.dw_actors(id),
  created_at timestamptz not null default now()
);
create table private.dw_entry_sessions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references private.dw_actors(id),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  operator boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check(expires_at>created_at)
);
create index dw_entry_sessions_actor on private.dw_entry_sessions(actor_id,created_at);
alter table private.dw_actors enable row level security;
alter table private.dw_declared_identities enable row level security;
alter table private.dw_entry_sessions enable row level security;
revoke all on private.dw_actors,private.dw_declared_identities,private.dw_entry_sessions from public,anon,authenticated;

create function private.dw_register_auth_actor() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into private.dw_actors(id,kind,auth_user_id) values(new.id,'auth',new.id);
  return new;
end $$;
revoke all on function private.dw_register_auth_actor() from public,anon,authenticated;
create trigger dw_register_auth_actor after insert on auth.users
for each row execute function private.dw_register_auth_actor();
-- Install the insert trigger before the backfill so concurrent Auth writes cannot
-- create a user without a registry row. Both steps run in the migration transaction.
insert into private.dw_actors(id,kind,auth_user_id)
 select id,'auth',id from auth.users on conflict(id) do nothing;

-- Replace only the target of six FKs, preserving UUIDs and each original delete action.
-- Actors are fully backfilled before the constraints change; no authored row is deleted.
alter table private.facilitators drop constraint facilitators_user_id_fkey,
 add constraint facilitators_actor_id_fkey foreign key(user_id) references private.dw_actors(id) on delete cascade;
alter table public.dw_profiles drop constraint dw_profiles_user_id_fkey,
 add constraint dw_profiles_actor_id_fkey foreign key(user_id) references private.dw_actors(id) on delete cascade;
alter table public.dw_sessions drop constraint dw_sessions_owner_id_fkey,
 add constraint dw_sessions_owner_actor_fkey foreign key(owner_id) references private.dw_actors(id);
alter table private.join_attempts drop constraint join_attempts_user_id_fkey,
 add constraint join_attempts_actor_id_fkey foreign key(user_id) references private.dw_actors(id) on delete cascade;
alter table private.command_receipts drop constraint command_receipts_actor_id_fkey,
 add constraint command_receipts_actor_registry_fkey foreign key(actor_id) references private.dw_actors(id);
alter table private.audit_events drop constraint audit_events_actor_id_fkey,
 add constraint audit_events_actor_registry_fkey foreign key(actor_id) references private.dw_actors(id);

create function private.dw_s8_trim(p_text text) returns text language sql immutable set search_path='' as $$
 select btrim(p_text,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||' '||chr(160)||chr(5760)||
   chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||
   chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
$$;
-- Explicit root-locale Unicode case conversion also handles dotted I and final sigma.
-- The same ICU collation is present in the hosted database and the shipped PGlite engine.
create function private.dw_normalize_email(p_email text) returns text language sql immutable set search_path='' as $$
 select lower(normalize(private.dw_s8_trim(p_email),NFC) collate "und-x-icu")
$$;
-- Existing learner profiles keep their original actor UUID. Privileged identities are
-- never adopted through a claimed email. Duplicate legacy addresses retain separate
-- histories; the earliest non-privileged profile is the deterministic entry identity.
insert into private.dw_declared_identities(email,actor_id)
select email,id from (
 select private.dw_normalize_email(u.email) email,u.id,
   row_number() over(partition by private.dw_normalize_email(u.email) order by p.created_at,u.id) position
 from auth.users u join public.dw_profiles p on p.user_id=u.id
 where coalesce(u.is_anonymous,true)=false and char_length(private.dw_normalize_email(u.email)) between 3 and 254
   and private.dw_normalize_email(u.email) ~ '^[^[:space:]@[:cntrl:]]+@[^[:space:]@[:cntrl:]]+[.][^[:space:]@[:cntrl:]]+$'
   and not exists(select 1 from private.facilitators f where f.user_id=u.id)
   and not exists(select 1 from public.dw_memberships m where m.user_id=u.id and m.role='host')
) eligible where position=1;
create function private.dw_entry_hash(p_token text) returns text language sql immutable set search_path='' as $$
 select encode(sha256(convert_to(p_token,'UTF8')),'hex')
$$;
create function private.dw_entry_token(p_token text) returns private.dw_entry_sessions
language plpgsql stable security definer set search_path='' as $$
declare v private.dw_entry_sessions;
begin
 if p_token is null or p_token !~ '^[a-f0-9]{64}$' then perform private.dw_fail('AUTH_REQUIRED'); end if;
 select s.* into v from private.dw_entry_sessions s join private.dw_actors a on a.id=s.actor_id
 where s.token_hash=private.dw_entry_hash(p_token) and s.revoked_at is null
   and s.expires_at>now() and a.disabled_at is null;
 if not found then perform private.dw_fail('AUTH_REQUIRED'); end if;
 if v.operator and not exists(select 1 from private.facilitators f where f.user_id=v.actor_id and f.revoked_at is null) then
   perform private.dw_fail('AUTH_REQUIRED');
 end if;
 if not v.operator and (exists(select 1 from private.facilitators f where f.user_id=v.actor_id)
   or exists(select 1 from public.dw_memberships m where m.user_id=v.actor_id and m.role='host')) then
   perform private.dw_fail('AUTH_REQUIRED');
 end if;
 return v;
end $$;
create function private.dw_entry_current_actor() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_id text:=nullif(current_setting('demography.entry_id',true),'');
 v_hash text:=nullif(current_setting('demography.entry_hash',true),''); v_actor uuid;
begin
 if v_id is null or v_id !~ '^[a-f0-9-]{36}$' or v_hash is null then return null; end if;
 select s.actor_id into v_actor from private.dw_entry_sessions s join private.dw_actors a on a.id=s.actor_id
 where s.id=v_id::uuid and s.token_hash=v_hash and s.actor_id=auth.uid() and s.revoked_at is null
   and s.expires_at>now() and a.disabled_at is null and
   ((s.operator and exists(select 1 from private.facilitators f where f.user_id=s.actor_id and f.revoked_at is null))
    or (not s.operator and not exists(select 1 from private.facilitators f where f.user_id=s.actor_id)
      and not exists(select 1 from public.dw_memberships m where m.user_id=s.actor_id and m.role='host')));
 return v_actor;
end $$;
create or replace function private.dw_verified_uid() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();
begin
 if v_uid is null then perform private.dw_fail('AUTH_REQUIRED'); end if;
 if private.dw_entry_current_actor()=v_uid then return v_uid; end if;
 if not exists(select 1 from auth.users u join private.dw_actors a on a.id=u.id
   where u.id=v_uid and u.email_confirmed_at is not null and coalesce(u.is_anonymous,true)=false
     and coalesce(u.email,'')<>'' and a.disabled_at is null) then perform private.dw_fail('EMAIL_NOT_VERIFIED'); end if;
 return v_uid;
end $$;
create or replace function private.dw_is_verified() returns boolean
language sql stable security definer set search_path='' as $$
 select private.dw_entry_current_actor() is not null or exists(
   select 1 from auth.users u join private.dw_actors a on a.id=u.id where u.id=auth.uid()
     and u.email_confirmed_at is not null and coalesce(u.is_anonymous,true)=false
     and coalesce(u.email,'')<>'' and a.disabled_at is null)
$$;
create or replace function private.dw_member_role(p_session_id uuid) returns text
language sql stable security definer set search_path='' as $$
 select m.role from public.dw_memberships m where m.session_id=p_session_id and m.user_id=auth.uid()
 and m.revoked_at is null and private.dw_is_verified()
 and (m.role<>'host' or private.dw_entry_current_actor() is null or exists(
   select 1 from private.dw_entry_sessions s where s.id::text=current_setting('demography.entry_id',true) and s.operator))
$$;
create or replace function private.dw_actor_eligible(p_user_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.dw_actors a where a.id=p_user_id and a.disabled_at is null and (
   (a.kind in ('declared','auth') and exists(select 1 from private.dw_declared_identities d where d.actor_id=a.id))
   or (a.kind='operator' and exists(select 1 from private.facilitators f where f.user_id=a.id and f.revoked_at is null))
   or (a.kind='auth' and exists(select 1 from auth.users u where u.id=a.id
     and u.email_confirmed_at is not null and coalesce(u.is_anonymous,true)=false and coalesce(u.email,'')<>''))))
$$;

create function private.dw_entry_dto(p_session private.dw_entry_sessions,p_token text) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('session',jsonb_build_object(
  'access_token',p_token,'token_type','bearer','expires_at',floor(extract(epoch from p_session.expires_at)),
  'expires_in',greatest(0,floor(extract(epoch from p_session.expires_at-now()))),
  'user',jsonb_build_object('id',a.id,'email',d.email,'email_confirmed_at',null,
    'user_metadata',jsonb_build_object('full_name',p.full_name,'email_verified',false),
    'app_metadata',jsonb_build_object('provider',case when p_session.operator then 'operator' else 'declared-email' end,'email_verified',false))))
 from private.dw_actors a join public.dw_profiles p on p.user_id=a.id
 left join private.dw_declared_identities d on d.actor_id=a.id where a.id=p_session.actor_id
$$;
create function private.dw_entry_mint(p_actor_id uuid,p_operator boolean default false) returns jsonb
language plpgsql set search_path='' as $$
declare v_token text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''); v private.dw_entry_sessions;
begin
 insert into private.dw_entry_sessions(actor_id,token_hash,operator,expires_at)
 values(p_actor_id,private.dw_entry_hash(v_token),p_operator,now()+interval '30 days') returning * into v;
 return private.dw_entry_dto(v,v_token);
end $$;
create function private.dw_identify(p_email text,p_full_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_email text:=private.dw_normalize_email(p_email);
 v_name text:=normalize(private.dw_s8_trim(p_full_name),NFC); v_actor uuid; v_kind text;
 v_revision bigint; v_session_id uuid; v_cursor bigint; v_operation_id uuid:=gen_random_uuid();
begin
 if p_email is null or char_length(p_email)>1024 or char_length(v_email)>254
   or v_email !~ '^[^[:space:]@[:cntrl:]]+@[^[:space:]@[:cntrl:]]+[.][^[:space:]@[:cntrl:]]+$'
   or v_name is null or not private.dw_text(to_jsonb(v_name),2,200) then perform private.dw_fail('INVALID_INPUT'); end if;
 perform pg_advisory_xact_lock(hashtextextended('declared-identity:'||v_email,0));
 select d.actor_id,a.kind into v_actor,v_kind from private.dw_declared_identities d
 join private.dw_actors a on a.id=d.actor_id where d.email=v_email for update of d;
 if v_actor is null then
   insert into private.dw_actors(kind) values('declared') returning id into v_actor;
   insert into private.dw_declared_identities(email,actor_id) values(v_email,v_actor);
   insert into public.dw_profiles(user_id,full_name) values(v_actor,v_name);
 else
   if v_kind not in ('declared','auth') or exists(select 1 from private.dw_actors where id=v_actor and disabled_at is not null)
     or exists(select 1 from private.facilitators where user_id=v_actor)
     or exists(select 1 from public.dw_memberships where user_id=v_actor and role='host') then
     perform private.dw_fail('FORBIDDEN');
   end if;
   update public.dw_profiles set full_name=v_name,revision=revision+1,updated_at=now()
     where user_id=v_actor and full_name is distinct from v_name returning revision into v_revision;
   if found then
     -- Equivalent to the existing profile.saved path, with a server-resolved actor
     -- because identify deliberately starts without any user Auth claims.
     insert into private.audit_events(actor_id,operation_id,event_type,entity_id,entity_revision)
       values(v_actor,v_operation_id,'profile.saved',v_actor,v_revision);
     for v_session_id in select session_id from public.dw_memberships where user_id=v_actor and revoked_at is null order by session_id loop
       insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
         values(v_session_id,v_actor,v_operation_id,'profile.saved',v_actor,v_revision);
       update public.dw_sessions set event_cursor=event_cursor+1 where id=v_session_id returning event_cursor into v_cursor;
       insert into public.dw_session_events(session_id,cursor,event_type,entity_id,entity_revision)
         values(v_session_id,v_cursor,'profile.saved',v_actor,v_revision);
     end loop;
   end if;
 end if;
 if (select count(*) from private.dw_entry_sessions where actor_id=v_actor and created_at>now()-interval '1 minute')>=30 then
   perform private.dw_fail('RATE_LIMITED');
 end if;
 return private.dw_entry_mint(v_actor,false);
end $$;
create function private.dw_entry_session(p_token text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v private.dw_entry_sessions:=private.dw_entry_token(p_token);
begin return private.dw_entry_dto(v,p_token); end $$;
create function private.dw_entry_logout(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v private.dw_entry_sessions:=private.dw_entry_token(p_token);
begin
 update private.dw_entry_sessions set revoked_at=now() where id=v.id;
 return jsonb_build_object('signedOut',true);
end $$;

-- Owner-only issuer: never exposed by PostgREST or the learner gateway.
-- An operator URL can carry this opaque capability automatically; claimed email is irrelevant.
create function private.dw_issue_operator_session(p_full_name text,p_actor_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=p_actor_id; v_name text:=normalize(private.dw_s8_trim(p_full_name),NFC);
begin
 if v_name is null or not private.dw_text(to_jsonb(v_name),2,200) then perform private.dw_fail('INVALID_INPUT'); end if;
 if v_actor is null then
   insert into private.dw_actors(kind) values('operator') returning id into v_actor;
   insert into public.dw_profiles(user_id,full_name) values(v_actor,v_name);
   insert into private.facilitators(user_id) values(v_actor);
 elsif not exists(select 1 from private.dw_actors a join private.facilitators f on f.user_id=a.id
   where a.id=v_actor and a.kind in ('operator','auth') and a.disabled_at is null and f.revoked_at is null) then
   perform private.dw_fail('FORBIDDEN');
 end if;
 return private.dw_entry_mint(v_actor,true);
end $$;

create function private.dw_available_sessions() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'scope',s.scope,'regionId',s.region_id)
   order by s.created_at desc,s.id),'[]'::jsonb) into v_result from (
   select * from public.dw_sessions s where s.status='open' and s.join_open
     and not exists(select 1 from public.dw_memberships m where m.session_id=s.id and m.user_id=v_uid and m.revoked_at is not null)
   order by s.created_at desc,s.id limit 100) s;
 return v_result;
end $$;
create function private.dw_join_open_session(p_session_id uuid,p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_session public.dw_sessions; v_member public.dw_memberships;
 v_payload jsonb:=jsonb_build_object('sessionId',p_session_id); v_old jsonb;
begin
 if not exists(select 1 from public.dw_profiles where user_id=v_uid) then perform private.dw_fail('PROFILE_REQUIRED'); end if;
 if p_session_id is null then perform private.dw_fail('INVALID_INPUT'); end if;
 perform pg_advisory_xact_lock(hashtextextended('member-sessions:'||v_uid::text,0));
 select * into v_session from public.dw_sessions where id=p_session_id for update;
 if not found then perform private.dw_fail('NOT_FOUND'); end if;
 if v_session.status<>'open' or not v_session.join_open then perform private.dw_fail('JOIN_CLOSED'); end if;
 select * into v_member from public.dw_memberships where session_id=p_session_id and user_id=v_uid;
 if found and v_member.revoked_at is not null then perform private.dw_fail('FORBIDDEN'); end if;
 v_old:=private.dw_begin_operation(p_operation_id,'join_open_session',v_payload);
 if v_old is not null then return private.dw_snapshot(p_session_id); end if;
 if v_member.user_id is null then
   if (select count(*) from public.dw_memberships where session_id=p_session_id and revoked_at is null)>=1000
     or (select count(*) from public.dw_memberships where user_id=v_uid and revoked_at is null)>=1000 then
     perform private.dw_fail('LIMIT_EXCEEDED');
   end if;
   insert into public.dw_memberships(session_id,user_id,role) values(p_session_id,v_uid,'participant');
   perform private.dw_event(p_session_id,p_operation_id,'member.joined',v_uid,1);
 end if;
 perform private.dw_finish_operation(p_operation_id,'join_open_session',v_payload,jsonb_build_object('sessionId',p_session_id));
 return private.dw_snapshot(p_session_id);
end $$;

create function public.dw_available_sessions() returns jsonb language sql security invoker set search_path='' as $$ select private.dw_available_sessions() $$;
create function public.dw_join_open_session(p_session_id uuid,p_operation_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_join_open_session($1,$2) $$;
revoke all on function public.dw_available_sessions(),public.dw_join_open_session(uuid,uuid) from public,anon,authenticated;
grant execute on function public.dw_available_sessions(),private.dw_available_sessions(),public.dw_join_open_session(uuid,uuid),private.dw_join_open_session(uuid,uuid) to authenticated;

create function private.dw_entry_rpc(p_token text,p_method text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_session private.dw_entry_sessions:=private.dw_entry_token(p_token); v_def record; v_key text; v_index integer;
 v_type text; v_value jsonb; v_sql text:=''; v_expr text; v_result jsonb; v_required integer;
 v_old_sub text:=current_setting('request.jwt.claim.sub',true); v_old_claims text:=current_setting('request.jwt.claims',true);
 v_old_id text:=current_setting('demography.entry_id',true); v_old_hash text:=current_setting('demography.entry_hash',true);
begin
 if p_method is null or not(p_method=any(array['dw_bootstrap','dw_join_session','dw_save_profile','dw_create_session','dw_available_sessions','dw_join_open_session','dw_session_snapshot','dw_session_cursor','dw_projector_snapshot','dw_update_session','dw_publish_submission','dw_moderate_submission','dw_invitation','dw_rotate_invitation','dw_set_member_role','dw_revoke_member','dw_workshop_snapshot','dw_workshop_cursor','dw_workshop_projector_snapshot','dw_workshop_round_snapshot','dw_region_work','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_cast_vote','dw_workshop_updates','dw_workshop_projector_updates','dw_cast_vote_updates','dw_barriers_snapshot','dw_barriers_cursor','dw_barriers_projector_snapshot','dw_save_barrier','dw_barrier_vote','dw_save_barrier_link','dw_save_solution','dw_barrier_evidence','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_roadmaps_index','dw_roadmaps_cursor','dw_roadmap_snapshot','dw_roadmap_version','dw_roadmaps_projector_snapshot','dw_configure_roadmaps','dw_join_roadmap','dw_save_roadmap_item','dw_capture_roadmap_fact','dw_capture_roadmap_basis','dw_freeze_roadmap','dw_review_roadmap','dw_roadmap_statistics_save','dw_roadmap_statistics_restore','dw_roadmap_statistics_history','dw_roadmap_statistics_series']::text[])) then perform private.dw_fail('FORBIDDEN'); end if;
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

create function public.dw_identify(p_email text,p_full_name text) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_identify($1,$2) $$;
create function public.dw_entry_session(p_token text) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_entry_session($1) $$;
create function public.dw_entry_logout(p_token text) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_entry_logout($1) $$;
create function public.dw_entry_rpc(p_token text,p_method text,p_args jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_entry_rpc($1,$2,$3) $$;

-- Revoke defaults on every new helper. Existing Auth entry points retain their exact grants.
revoke all on function private.dw_s8_trim(text),private.dw_normalize_email(text),private.dw_entry_hash(text),
 private.dw_entry_token(text),private.dw_entry_current_actor(),private.dw_actor_eligible(uuid),
 private.dw_entry_dto(private.dw_entry_sessions,text),private.dw_entry_mint(uuid,boolean),
 private.dw_identify(text,text),private.dw_entry_session(text),private.dw_entry_logout(text),
 private.dw_issue_operator_session(text,uuid),private.dw_available_sessions(),private.dw_join_open_session(uuid,uuid),
 private.dw_entry_rpc(text,text,jsonb) from public,anon,authenticated;
revoke all on function public.dw_identify(text,text),public.dw_entry_session(text),public.dw_entry_logout(text),public.dw_entry_rpc(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.dw_identify(text,text),private.dw_identify(text,text),public.dw_entry_session(text),private.dw_entry_session(text),
 public.dw_entry_logout(text),private.dw_entry_logout(text),public.dw_entry_rpc(text,text,jsonb),private.dw_entry_rpc(text,text,jsonb) to anon,authenticated;
grant execute on function private.dw_available_sessions(),private.dw_join_open_session(uuid,uuid) to authenticated;

-- Voting fixes the eligible roster using the declared/legacy/operator actor contract.


create or replace function private.dw_open_voting_round(p_operation_id uuid,p_session_id uuid,p_title text,p_results_visibility text,
  p_expected_board_revision bigint,p_settings jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb; v_session public.dw_sessions;
  v_state private.dw_workshop_state; v_round uuid:=gen_random_uuid(); v_eligible integer; v_families integer;
  v_settings jsonb:=coalesce(p_settings,'{}'::jsonb); v_prompt text; v_min_coverage numeric:=0.7; v_min_votes numeric;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'title',p_title,'visibility',p_results_visibility,
    'boardRevision',p_expected_board_revision,'settings',v_settings);
  v_replay:=private.dw_begin_operation(p_operation_id,'open_voting_round',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if v_session.phase<>'discussion' then perform private.dw_fail('PHASE_CLOSED'); end if;
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
