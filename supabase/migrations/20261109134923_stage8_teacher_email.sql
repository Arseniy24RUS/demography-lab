-- Stage 8.1: the owner explicitly selects the same declared-email entry for teaching.
-- Only the exact normalized address below selects the teacher role. This is an
-- identification convention, not mailbox verification. The transport/session,
-- private-table boundaries, domain role checks and all saved actor UUIDs remain.

create or replace function private.dw_identify(p_email text,p_full_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_email text:=private.dw_normalize_email(p_email);
 v_name text:=normalize(private.dw_s8_trim(p_full_name),NFC); v_actor uuid; v_kind text;
 v_teacher boolean:=v_email='omnistat@yandex.ru'; v_legacy_operator uuid;
 v_operator_ids uuid[]; v_first_teacher_grant uuid; v_member public.dw_memberships;
 v_revision bigint; v_session_id uuid; v_cursor bigint; v_event text;
 v_operation_id uuid:=gen_random_uuid();
begin
 if p_email is null or char_length(p_email)>1024 or char_length(v_email)>254
   or v_email !~ '^[^[:space:]@[:cntrl:]]+@[^[:space:]@[:cntrl:]]+[.][^[:space:]@[:cntrl:]]+$'
   or v_name is null or not private.dw_text(to_jsonb(v_name),2,200) then perform private.dw_fail('INVALID_INPUT'); end if;
 perform pg_advisory_xact_lock(hashtextextended('declared-identity:'||v_email,0));
 select d.actor_id,a.kind into v_actor,v_kind from private.dw_declared_identities d
 join private.dw_actors a on a.id=d.actor_id where d.email=v_email for update of d;

 if v_teacher then
   -- The former single operator is the previously issued lecturer cabinet. Never
   -- choose an arbitrary operator when more than one exists, and never adopt a
   -- disabled/revoked one or an operator already bound to a different address.
   select array_agg(a.id order by a.id) into v_operator_ids
   from private.dw_actors a join private.facilitators f on f.user_id=a.id
   where a.kind='operator' and a.disabled_at is null and f.revoked_at is null;
   if cardinality(v_operator_ids)=1 and not exists(
     select 1 from private.dw_declared_identities d where d.actor_id=v_operator_ids[1] and d.email<>v_email
   ) then v_legacy_operator:=v_operator_ids[1]; end if;

   if v_actor is null then
     -- An exact-email legacy Auth teacher retains their UUID and authored work.
     select a.id,a.kind into v_actor,v_kind
     from private.dw_actors a join auth.users u on u.id=a.id
     join public.dw_profiles p on p.user_id=a.id
     where a.kind='auth' and private.dw_normalize_email(u.email)=v_email
       and a.disabled_at is null and not exists(
         select 1 from private.dw_declared_identities d where d.actor_id=a.id)
       and not exists(select 1 from private.facilitators f where f.user_id=a.id and f.revoked_at is not null)
     order by p.created_at,a.id limit 1;
     if v_actor is null and v_legacy_operator is not null then
       v_actor:=v_legacy_operator; v_kind:='operator';
     end if;
     if v_actor is not null then
       insert into private.dw_declared_identities(email,actor_id) values(v_email,v_actor);
     end if;
   end if;
 end if;

 if v_actor is null then
   insert into private.dw_actors(kind) values('declared') returning id into v_actor;
   insert into private.dw_declared_identities(email,actor_id) values(v_email,v_actor);
   insert into public.dw_profiles(user_id,full_name) values(v_actor,v_name);
   v_kind:='declared';
 else
   if exists(select 1 from private.dw_actors where id=v_actor and disabled_at is not null)
     or (not v_teacher and (v_kind not in ('declared','auth')
       or exists(select 1 from private.facilitators where user_id=v_actor)
       or exists(select 1 from public.dw_memberships where user_id=v_actor and role='host')))
     or (v_teacher and exists(select 1 from private.facilitators where user_id=v_actor and revoked_at is not null)) then
     perform private.dw_fail('FORBIDDEN');
   end if;
   update public.dw_profiles set full_name=v_name,revision=revision+1,updated_at=now()
     where user_id=v_actor and full_name is distinct from v_name returning revision into v_revision;
   if found then
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

 if v_teacher then
   insert into private.facilitators(user_id) values(v_actor) on conflict(user_id) do nothing
     returning user_id into v_first_teacher_grant;
   -- If the lecturer already used their email as a learner, preserve that actor
   -- and add teacher membership to their former single operator's classes once.
   -- The owner UUID, publications, authorship and sealed voting rosters never move.
   if v_first_teacher_grant is not null and v_legacy_operator is not null and v_legacy_operator<>v_actor then
     perform pg_advisory_xact_lock(hashtextextended('member-sessions:'||v_actor::text,0));
     for v_session_id in select s.id from public.dw_sessions s
       join public.dw_memberships m on m.session_id=s.id and m.user_id=v_legacy_operator
       where s.owner_id=v_legacy_operator and m.role='host' and m.revoked_at is null
       order by s.id for update of s loop
       select * into v_member from public.dw_memberships where session_id=v_session_id and user_id=v_actor for update;
       if found and (v_member.revoked_at is not null or v_member.role='host') then continue; end if;
       if v_member.user_id is null then
         insert into public.dw_memberships(session_id,user_id,role) values(v_session_id,v_actor,'host') returning revision into v_revision;
         v_event:='member.joined';
       else
         update public.dw_memberships set role='host',revision=revision+1
           where session_id=v_session_id and user_id=v_actor returning revision into v_revision;
         v_event:='member.role_changed';
       end if;
       insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
         values(v_session_id,v_actor,v_operation_id,v_event,v_actor,v_revision);
       update public.dw_sessions set event_cursor=event_cursor+1 where id=v_session_id returning event_cursor into v_cursor;
       insert into public.dw_session_events(session_id,cursor,event_type,entity_id,entity_revision)
         values(v_session_id,v_cursor,v_event,v_actor,v_revision);
     end loop;
   end if;
 end if;
 if (select count(*) from private.dw_entry_sessions where actor_id=v_actor and created_at>now()-interval '1 minute')>=30 then
   perform private.dw_fail('RATE_LIMITED');
 end if;
 return private.dw_entry_mint(v_actor,v_teacher);
end $$;

-- CREATE OR REPLACE retains the previous narrow grants. State them explicitly so
-- this migration never relies on PostgreSQL's default PUBLIC EXECUTE privilege.
revoke all on function private.dw_identify(text,text) from public,anon,authenticated;
grant execute on function private.dw_identify(text,text) to anon,authenticated;
