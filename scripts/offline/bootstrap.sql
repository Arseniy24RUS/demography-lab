-- Local runtime authentication substrate. This file is never applied to Supabase.
-- A local identity is bound to a private device/recovery secret, not a verified mailbox.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema offline;
revoke all on schema offline from public,anon,authenticated;
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz,
  is_anonymous boolean not null default false,
  raw_user_meta_data jsonb not null default '{}',
  raw_app_meta_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable set search_path='' as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable set search_path='' as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)
$$;
grant usage on schema auth to anon,authenticated,service_role;
grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
revoke all on auth.users from public,anon,authenticated;
create table offline.migrations(name text primary key,sha256 text not null,applied_at timestamptz not null default now());
create table offline.settings(key text primary key,value jsonb not null);
create table offline.accounts (
  user_id uuid primary key references auth.users(id),
  recovery_hash text unique,
  kind text not null check(kind in ('participant','host')),
  created_at timestamptz not null default now(),
  check ((kind='participant')=(recovery_hash is not null))
);
create unique index offline_one_host on offline.accounts(kind) where kind='host';
create table offline.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  access_hash text unique not null,
  refresh_hash text unique not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index offline_session_user on offline.sessions(user_id);
alter table auth.users enable row level security;
alter table offline.accounts enable row level security;
alter table offline.sessions enable row level security;
alter table offline.settings enable row level security;
alter table offline.migrations enable row level security;
revoke all on all tables in schema offline from public,anon,authenticated;
