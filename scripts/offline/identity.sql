-- Deliberately local-only replacement of the mailbox gate. Domain authorization,
-- memberships, invitation codes, facilitator grants and all RPC checks are unchanged.
-- HTTP bearer sessions are checked against the durable server-side session store.
create or replace function private.dw_actor_eligible(p_user_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users u join offline.accounts a on a.user_id=u.id
    join private.dw_actors actor on actor.id=u.id and actor.disabled_at is null
    where u.id=p_user_id and u.raw_app_meta_data->>'offline'='true'
      and u.email_confirmed_at is null and u.is_anonymous=false
      and u.email is not null and u.email<>''
      and (a.kind='host' or (a.kind='participant'
        and not exists(select 1 from private.facilitators f where f.user_id=u.id)
        and not exists(select 1 from public.dw_memberships m where m.user_id=u.id and m.role='host'))))
$$;
revoke all on function private.dw_actor_eligible(uuid) from public,anon,authenticated;
create or replace function private.dw_verified_uid() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();
begin
  if v_uid is null then perform private.dw_fail('AUTH_REQUIRED'); end if;
  if not private.dw_actor_eligible(v_uid) then
    perform private.dw_fail('OFFLINE_IDENTITY_REQUIRED');
  end if;
  return v_uid;
end $$;
create or replace function private.dw_is_verified() returns boolean
language sql stable security definer set search_path='' as $$
  select private.dw_actor_eligible(auth.uid())
$$;
