-- Historical local identity gate from release 0.7 (95594cc), for upgrade tests only.
create or replace function private.dw_verified_uid() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();
begin
  if v_uid is null then perform private.dw_fail('AUTH_REQUIRED'); end if;
  if not exists(select 1 from auth.users u join offline.accounts a on a.user_id=u.id
    where u.id=v_uid and u.raw_app_meta_data->>'offline'='true'
      and u.email_confirmed_at is null and u.is_anonymous=false
      and u.email is not null and u.email<>'') then
    perform private.dw_fail('OFFLINE_IDENTITY_REQUIRED');
  end if;
  return v_uid;
end $$;
create or replace function private.dw_is_verified() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users u join offline.accounts a on a.user_id=u.id
    where u.id=auth.uid() and u.raw_app_meta_data->>'offline'='true'
      and u.email_confirmed_at is null and u.is_anonymous=false
      and u.email is not null and u.email<>'')
$$;
