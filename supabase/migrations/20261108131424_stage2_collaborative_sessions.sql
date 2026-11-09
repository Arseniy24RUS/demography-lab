-- Stage 2: verified identities, teaching sessions and source-checked shared practice bundles.
-- Supabase supplies auth.users/auth.uid(). No auth schema or remote data is changed here.
-- Private is deliberately absent from PostgREST exposed schemas. Read supabase/README.md.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table private.facilitators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create table public.dw_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 200),
  revision bigint not null default 1 check(revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.dw_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  title text not null check(char_length(btrim(title)) between 1 and 200),
  scope text not null check(scope in ('municipality','region','federal')),
  region_id text,
  status text not null default 'open' check(status in ('open','paused','closed')),
  phase text not null default 'reading' check(phase in ('reading','review','discussion')),
  join_open boolean not null default true,
  focus_submission_id uuid,
  projector_show_authors boolean not null default false,
  revision bigint not null default 1 check(revision > 0),
  event_cursor bigint not null default 0 check(event_cursor >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(scope='federal' or (region_id is not null and char_length(region_id) between 1 and 160))
);
create index dw_sessions_owner on public.dw_sessions(owner_id);
create table public.dw_memberships (
  session_id uuid not null references public.dw_sessions(id),
  user_id uuid not null references public.dw_profiles(user_id),
  role text not null check(role in ('host','participant','observer')),
  revision bigint not null default 1 check(revision > 0),
  joined_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key(session_id,user_id)
);
create index dw_memberships_user_active on public.dw_memberships(user_id,session_id) where revoked_at is null;
create table private.invitations (
  session_id uuid primary key references public.dw_sessions(id),
  code text not null unique check(code ~ '^[A-F0-9]{12}$'),
  updated_at timestamptz not null default now()
);
create table private.join_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started timestamptz not null default now(),
  attempts integer not null default 0
);
create table private.source_versions (
  version_id text primary key,
  document_id text not null,
  normalization_version text not null,
  source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_hash text not null check(canonical_hash ~ '^[a-f0-9]{64}$'),
  title text not null,
  source_url text not null check(source_url like 'https://%'),
  region_id text not null,
  page_count integer not null check(page_count > 0),
  block_count integer not null check(block_count > 0),
  sealed boolean not null default false,
  created_at timestamptz not null default now()
);
create index source_versions_document on private.source_versions(document_id);
create table private.source_blocks (
  version_id text not null references private.source_versions(version_id),
  block_id text not null,
  block_order integer not null check(block_order >= 0),
  kind text not null,
  page_start integer not null check(page_start >= 1),
  page_end integer not null check(page_end >= page_start),
  canonical_text text not null,
  primary key(version_id,block_id),
  unique(version_id,block_order)
);
create table public.dw_submissions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.dw_sessions(id),
  author_id uuid not null references public.dw_profiles(user_id),
  local_key text not null check(char_length(local_key) between 1 and 160),
  bundle jsonb not null check(jsonb_typeof(bundle)='object'),
  status text not null default 'shared' check(status in ('shared','withdrawn')),
  revision bigint not null default 1 check(revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id,author_id,local_key),
  unique(session_id,id)
);
create index dw_submissions_session_status on public.dw_submissions(session_id,status,created_at);
create index dw_submissions_author on public.dw_submissions(author_id,session_id);
alter table public.dw_sessions add constraint dw_focus_same_session
  foreign key(id,focus_submission_id) references public.dw_submissions(session_id,id);
create table private.command_receipts (
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  operation_type text not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_id,operation_id)
);
create table private.audit_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.dw_sessions(id),
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  event_type text not null,
  entity_id uuid not null,
  entity_revision bigint not null,
  created_at timestamptz not null default now()
);
create index audit_events_session on private.audit_events(session_id,created_at);
-- Minimal durable notifications. Neither a bundle, email, invitation nor private profile is broadcast.
create table public.dw_session_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.dw_sessions(id),
  cursor bigint not null,
  event_type text not null,
  entity_id uuid not null,
  entity_revision bigint not null,
  created_at timestamptz not null default now(),
  unique(session_id,cursor)
);

alter table private.facilitators enable row level security;
alter table private.invitations enable row level security;
alter table private.join_attempts enable row level security;
alter table private.source_versions enable row level security;
alter table private.source_blocks enable row level security;
alter table private.command_receipts enable row level security;
alter table private.audit_events enable row level security;
alter table public.dw_profiles enable row level security;
alter table public.dw_sessions enable row level security;
alter table public.dw_memberships enable row level security;
alter table public.dw_submissions enable row level security;
alter table public.dw_session_events enable row level security;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on public.dw_profiles,public.dw_sessions,public.dw_memberships,public.dw_submissions,public.dw_session_events from public, anon, authenticated;
grant select on public.dw_profiles,public.dw_sessions,public.dw_memberships,public.dw_submissions,public.dw_session_events to authenticated;

-- SQLSTATE P0001 + stable machine-readable messages; UI supplies localized explanations.
create function private.dw_fail(p_code text) returns void language plpgsql set search_path='' as $$
begin raise exception using errcode='P0001', message=p_code; end $$;
create function private.dw_verified_uid() returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then perform private.dw_fail('AUTH_REQUIRED'); end if;
  if not exists(select 1 from auth.users where id=v_uid and email_confirmed_at is not null
      and coalesce(is_anonymous,true)=false and email is not null and email<>'') then
    perform private.dw_fail('EMAIL_NOT_VERIFIED');
  end if;
  return v_uid;
end $$;
create function private.dw_is_verified() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null
   and coalesce(is_anonymous,true)=false and email is not null and email<>'')
$$;
create function private.dw_member_role(p_session_id uuid) returns text language sql stable security definer set search_path='' as $$
 select role from public.dw_memberships where session_id=p_session_id and user_id=auth.uid()
   and revoked_at is null and private.dw_is_verified()
$$;
create function private.dw_can_read_profile(p_user_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select private.dw_is_verified() and (p_user_id=auth.uid() or exists(
   select 1 from public.dw_memberships mine join public.dw_memberships other using(session_id)
   where mine.user_id=auth.uid() and other.user_id=p_user_id and mine.revoked_at is null and other.revoked_at is null))
$$;
create policy dw_profile_read on public.dw_profiles for select to authenticated using(private.dw_can_read_profile(user_id));
create policy dw_session_read on public.dw_sessions for select to authenticated using(private.dw_member_role(id) is not null);
create policy dw_membership_read on public.dw_memberships for select to authenticated
  using(private.dw_member_role(session_id) is not null and revoked_at is null);
create policy dw_submission_read on public.dw_submissions for select to authenticated
  using(private.dw_member_role(session_id) is not null
    and (status='shared' or author_id=(select auth.uid()) or private.dw_member_role(session_id)='host'));
create policy dw_event_read on public.dw_session_events for select to authenticated using(private.dw_member_role(session_id) is not null);

-- An edition can be populated and sealed once. Updating text or appending blocks afterwards is forbidden.
create function private.dw_source_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='source_blocks' then
    if tg_op<>'INSERT' or not exists(select 1 from private.source_versions where version_id=new.version_id and not sealed) then
      perform private.dw_fail('SOURCE_IMMUTABLE');
    end if;
    if new.page_end>(select page_count from private.source_versions where version_id=new.version_id) then
      perform private.dw_fail('SOURCE_MISMATCH');
    end if;
    return new;
  end if;
  if tg_op='DELETE' then perform private.dw_fail('SOURCE_IMMUTABLE'); end if;
  if old.sealed or not new.sealed or (to_jsonb(old)-'sealed')<>(to_jsonb(new)-'sealed') then
    perform private.dw_fail('SOURCE_IMMUTABLE');
  end if;
  if (select count(*) from private.source_blocks where version_id=new.version_id)<>new.block_count then
    perform private.dw_fail('CORPUS_NOT_READY');
  end if;
  return new;
end $$;
create trigger dw_source_version_immutable before update or delete on private.source_versions
  for each row execute function private.dw_source_immutable();
create trigger dw_source_block_immutable before insert or update or delete on private.source_blocks
  for each row execute function private.dw_source_immutable();

create function private.dw_keys(p_value jsonb,p_allowed text[]) returns boolean language sql immutable set search_path='' as $$
 select case when jsonb_typeof(p_value)='object' then not exists(select 1 from jsonb_object_keys(p_value) k where not k=any(p_allowed)) else false end
$$;
create function private.dw_text(p_value jsonb,p_min integer,p_max integer) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(p_value)='string' and char_length(p_value#>>'{}') between p_min and p_max
   and (p_value#>>'{}') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]',false)
$$;
create function private.dw_id(p_value jsonb) returns boolean language sql immutable set search_path='' as $$
 select private.dw_text(p_value,1,160) and (p_value#>>'{}') !~ '\s' and (p_value#>>'{}') not in ('__proto__','prototype','constructor')
$$;
-- Serialize operation replay without serializing unrelated participants.
create function private.dw_begin_operation(p_operation_id uuid,p_kind text,p_payload jsonb) returns jsonb
 language plpgsql set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_old private.command_receipts; v_hash text;
begin
  if p_operation_id is null then perform private.dw_fail('INVALID_INPUT'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_operation_id::text,0));
  v_hash:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
  select * into v_old from private.command_receipts where actor_id=v_uid and operation_id=p_operation_id;
  if found then
    if v_old.operation_type<>p_kind or v_old.request_hash<>v_hash then perform private.dw_fail('IDEMPOTENCY_CONFLICT'); end if;
    return v_old.result;
  end if;
  return null;
end $$;
create function private.dw_finish_operation(p_operation_id uuid,p_kind text,p_payload jsonb,p_result jsonb) returns void
 language sql set search_path='' as $$
 insert into private.command_receipts(actor_id,operation_id,operation_type,request_hash,result)
 values(auth.uid(),p_operation_id,p_kind,encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'),p_result)
$$;
create function private.dw_event(p_session_id uuid,p_operation_id uuid,p_type text,p_entity_id uuid,p_revision bigint) returns void
 language plpgsql set search_path='' as $$
declare v_cursor bigint;
begin
  insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
    values(p_session_id,auth.uid(),p_operation_id,p_type,p_entity_id,p_revision);
  if p_session_id is not null then
    update public.dw_sessions set event_cursor=event_cursor+1 where id=p_session_id returning event_cursor into v_cursor;
    insert into public.dw_session_events(session_id,cursor,event_type,entity_id,entity_revision)
      values(p_session_id,v_cursor,p_type,p_entity_id,p_revision);
  end if;
end $$;
create function private.dw_session_json(p_session_id uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',s.id,'title',s.title,'scope',s.scope,'regionId',s.region_id,'status',s.status,
   'phase',s.phase,'role',private.dw_member_role(s.id),'revision',s.revision,'joinOpen',s.join_open,
   'focusSubmissionId',s.focus_submission_id,'projectorShowAuthors',s.projector_show_authors,
   'createdAt',s.created_at,'updatedAt',s.updated_at) from public.dw_sessions s where s.id=p_session_id
$$;
create function private.dw_snapshot(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_role text; v_result jsonb;
begin
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null then perform private.dw_fail('FORBIDDEN'); end if;
  -- One statement snapshot: cursor, members and submissions refer to the same MVCC state.
  select jsonb_build_object('session',private.dw_session_json(s.id),'cursor',s.event_cursor,
    'members',coalesce((select jsonb_agg(jsonb_build_object('userId',m.user_id,'fullName',p.full_name,
      'role',m.role,'joinedAt',m.joined_at,'revision',m.revision) order by m.joined_at,m.user_id)
      from public.dw_memberships m join public.dw_profiles p using(user_id)
      where m.session_id=s.id and m.revoked_at is null),'[]'::jsonb),
    'submissions',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'sessionId',x.session_id,
      'authorId',x.author_id,'authorName',p.full_name,'localKey',x.local_key,'bundle',x.bundle,
      'revision',x.revision,'status',x.status,'createdAt',x.created_at,'updatedAt',x.updated_at)
      order by x.created_at,x.id) from public.dw_submissions x join public.dw_profiles p on p.user_id=x.author_id
      where x.session_id=s.id and (x.status='shared' or x.author_id=v_uid or v_role='host')),'[]'::jsonb))
    into v_result from public.dw_sessions s where s.id=p_session_id and private.dw_member_role(s.id) is not null;
  if v_result is null then perform private.dw_fail('FORBIDDEN'); end if;
  return v_result;
end $$;
create function private.dw_projector_snapshot(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select jsonb_build_object('title',s.title,'phase',s.phase,'status',s.status,'focusSubmissionId',s.focus_submission_id,
    'projectorShowAuthors',s.projector_show_authors,'cursor',s.event_cursor,
    'participantCount',(select count(*) from public.dw_memberships where session_id=s.id and revoked_at is null and role<>'host'),
    'submissions',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'bundle',x.bundle,'revision',x.revision,'updatedAt',x.updated_at)
      || case when s.projector_show_authors then jsonb_build_object('authorName',p.full_name) else '{}'::jsonb end
      order by x.created_at,x.id) from public.dw_submissions x join public.dw_profiles p on p.user_id=x.author_id
      where x.session_id=s.id and x.status='shared'),'[]'::jsonb)) into v_result
    from public.dw_sessions s where s.id=p_session_id and private.dw_member_role(s.id)='host';
  if v_result is null then perform private.dw_fail('FORBIDDEN'); end if;
  return v_result;
end $$;

-- A bundle is not accepted on the client's assertion alone. Every quotation is checked against
-- an immutable, server-side canonical block using Unicode character offsets (not UTF-16 bytes).
create function private.dw_validate_bundle(p_bundle jsonb) returns jsonb language plpgsql set search_path='' as $$
declare
  v_practice jsonb; v_sources jsonb:='[]'; v_source jsonb; v_occ jsonb; v_anchor jsonb; v_span jsonb;
  v_evidence jsonb; v_condition jsonb; v_field text; v_value text; v_url text;
  v_version private.source_versions; v_block private.source_blocks;
  v_start integer; v_end integer; v_previous integer; v_from numeric; v_to numeric;
  v_ids text[]:='{}'; v_editions text[]:='{}'; v_occ_ids text[]:='{}'; v_exact text;
begin
  if p_bundle is null or octet_length(p_bundle::text)>131072
    or not private.dw_keys(p_bundle,array['schemaVersion','practice','occurrences','sources','note'])
    or p_bundle->'schemaVersion' is distinct from '1'::jsonb
    or not private.dw_text(p_bundle->'note',0,4000)
    or jsonb_typeof(p_bundle->'sources') is distinct from 'array'
    or jsonb_typeof(p_bundle->'occurrences') is distinct from 'array' then perform private.dw_fail('INVALID_INPUT'); end if;
  if jsonb_array_length(p_bundle->'sources') not between 1 and 128
    or jsonb_array_length(p_bundle->'occurrences') not between 1 and 128 then perform private.dw_fail('INVALID_INPUT'); end if;
  v_practice:=p_bundle->'practice';
  if v_practice is null or not private.dw_keys(v_practice,array['id','familyId','regionId','title','mechanism','eligibility','amount','conditions','occurrenceIds','evidence','reviewStatus'])
    or not private.dw_id(v_practice->'id') or not private.dw_id(v_practice->'familyId') or not private.dw_id(v_practice->'regionId')
    or not private.dw_text(v_practice->'title',1,500) or not private.dw_text(v_practice->'mechanism',1,20000)
    or jsonb_typeof(v_practice->'occurrenceIds') is distinct from 'array'
    or (v_practice?'reviewStatus' and coalesce(v_practice->>'reviewStatus','') not in ('candidate','verified','rejected')) then
    perform private.dw_fail('INVALID_INPUT');
  end if;
  foreach v_field in array array['eligibility','amount'] loop
    if v_practice?v_field and v_practice->v_field<>'null'::jsonb and not private.dw_text(v_practice->v_field,0,20000) then
      perform private.dw_fail('INVALID_INPUT'); end if;
  end loop;
  if v_practice?'conditions' then
    if jsonb_typeof(v_practice->'conditions')<>'array' then perform private.dw_fail('INVALID_INPUT'); end if;
    if jsonb_array_length(v_practice->'conditions')>500 then perform private.dw_fail('INVALID_INPUT'); end if;
    for v_condition in select value from jsonb_array_elements(v_practice->'conditions') loop
      if not private.dw_text(v_condition,0,5000) then perform private.dw_fail('INVALID_INPUT'); end if;
    end loop;
  end if;
  if jsonb_array_length(v_practice->'occurrenceIds') not between 1 and 128 then perform private.dw_fail('INVALID_INPUT'); end if;
  for v_condition in select value from jsonb_array_elements(v_practice->'occurrenceIds') loop
    if not private.dw_id(v_condition) or (v_condition#>>'{}')=any(v_ids) then perform private.dw_fail('INVALID_INPUT'); end if;
    v_ids:=array_append(v_ids,v_condition#>>'{}');
  end loop;
  for v_source in select value from jsonb_array_elements(p_bundle->'sources') loop
    if not private.dw_keys(v_source,array['sourceId','editionId','title','sha256','normalizationVersion','sourceUrl','regionId'])
      or not private.dw_id(v_source->'sourceId') or not private.dw_id(v_source->'editionId')
      or not private.dw_text(v_source->'title',1,1000)
      or coalesce(v_source->>'normalizationVersion','') not in ('unicode-nfc-lf-v1','poppler-layout-nfc-lf-rstrip-lines-blank-paragraphs-v1')
      or (v_source->>'editionId')=any(v_editions) then perform private.dw_fail('INVALID_INPUT'); end if;
    select * into v_version from private.source_versions where version_id=v_source->>'editionId' and sealed;
    if not found then perform private.dw_fail('CORPUS_NOT_READY'); end if;
    if v_version.document_id is distinct from v_source->>'sourceId'
      or v_version.normalization_version is distinct from v_source->>'normalizationVersion'
      or v_version.source_sha256 is distinct from v_source->>'sha256'
      or (v_source?'regionId' and v_version.region_id is distinct from v_source->>'regionId') then
      perform private.dw_fail('SOURCE_MISMATCH');
    end if;
    -- Do not repeat untrusted source titles/URLs as authoritative bibliographical metadata.
    v_sources:=v_sources||jsonb_build_array(jsonb_build_object('sourceId',v_version.document_id,'editionId',v_version.version_id,
      'title',v_version.title,'sha256',v_version.source_sha256,'normalizationVersion',v_version.normalization_version,
      'sourceUrl',v_version.source_url,'regionId',v_version.region_id));
    v_editions:=array_append(v_editions,v_version.version_id);
  end loop;
  for v_occ in select value from jsonb_array_elements(p_bundle->'occurrences') loop
    if not private.dw_keys(v_occ,array['id','documentId','versionId','anchor','reviewStatus','note'])
      or not private.dw_id(v_occ->'id') or not private.dw_id(v_occ->'documentId') or not private.dw_id(v_occ->'versionId')
      or coalesce(v_occ->>'reviewStatus','') not in ('candidate','verified','rejected')
      or (v_occ?'note' and not private.dw_text(v_occ->'note',0,20000))
      or (v_occ->>'id')=any(v_occ_ids) or not (v_occ->>'id')=any(v_ids)
      or not (v_occ->>'versionId')=any(v_editions) then perform private.dw_fail('INVALID_INPUT'); end if;
    v_occ_ids:=array_append(v_occ_ids,v_occ->>'id');
    v_anchor:=v_occ->'anchor';
    if v_anchor is null or not private.dw_keys(v_anchor,array['id','documentId','versionId','normalizationVersion','spans'])
      or not private.dw_id(v_anchor->'id')
      or v_anchor->>'documentId' is distinct from v_occ->>'documentId'
      or v_anchor->>'versionId' is distinct from v_occ->>'versionId'
      or jsonb_typeof(v_anchor->'spans') is distinct from 'array' then perform private.dw_fail('INVALID_INPUT'); end if;
    if jsonb_array_length(v_anchor->'spans') not between 1 and 256 then perform private.dw_fail('INVALID_INPUT'); end if;
    select * into v_version from private.source_versions where version_id=v_occ->>'versionId' and sealed;
    if v_version.document_id is distinct from v_occ->>'documentId'
      or v_version.region_id is distinct from v_practice->>'regionId'
      or v_version.normalization_version is distinct from v_anchor->>'normalizationVersion' then
      perform private.dw_fail('SOURCE_MISMATCH'); end if;
    v_previous:=-1;
    for v_span in select value from jsonb_array_elements(v_anchor->'spans') loop
      if not private.dw_keys(v_span,array['blockId','start','end','exact','prefix','suffix'])
        or not private.dw_id(v_span->'blockId') or not private.dw_text(v_span->'exact',1,20000)
        or not private.dw_text(v_span->'prefix',0,500) or not private.dw_text(v_span->'suffix',0,500)
        or jsonb_typeof(v_span->'start') is distinct from 'number' or jsonb_typeof(v_span->'end') is distinct from 'number' then
        perform private.dw_fail('INVALID_INPUT'); end if;
      v_from:=(v_span->>'start')::numeric; v_to:=(v_span->>'end')::numeric;
      if v_from<>trunc(v_from) or v_to<>trunc(v_to) or v_from<0 or v_to<=v_from or v_to>10000000 then
        perform private.dw_fail('INVALID_INPUT'); end if;
      v_start:=v_from::integer; v_end:=v_to::integer; v_exact:=v_span->>'exact';
      select * into v_block from private.source_blocks where version_id=v_version.version_id and block_id=v_span->>'blockId';
      if not found then perform private.dw_fail('SOURCE_MISMATCH'); end if;
      if v_block.block_order<=v_previous or v_end>char_length(v_block.canonical_text)
        or char_length(v_exact)<>v_end-v_start
        or substring(v_block.canonical_text from v_start+1 for v_end-v_start)<>v_exact
        or char_length(v_span->>'prefix')>v_start
        or substring(v_block.canonical_text from v_start-char_length(v_span->>'prefix')+1 for char_length(v_span->>'prefix'))<>v_span->>'prefix'
        or v_end+char_length(v_span->>'suffix')>char_length(v_block.canonical_text)
        or substring(v_block.canonical_text from v_end+1 for char_length(v_span->>'suffix'))<>v_span->>'suffix'
        or v_block.page_start<1 or v_block.page_end>v_version.page_count then
        perform private.dw_fail('SOURCE_MISMATCH'); end if;
      v_previous:=v_block.block_order;
    end loop;
  end loop;
  if cardinality(v_ids)<>cardinality(v_occ_ids) then perform private.dw_fail('INVALID_INPUT'); end if;
  if v_practice?'evidence' then
    if jsonb_typeof(v_practice->'evidence')<>'array' then perform private.dw_fail('INVALID_INPUT'); end if;
    if jsonb_array_length(v_practice->'evidence')>256 then perform private.dw_fail('INVALID_INPUT'); end if;
    for v_evidence in select value from jsonb_array_elements(v_practice->'evidence') loop
      if v_evidence?'field' and coalesce(v_evidence->>'field','') not in ('title','mechanism','eligibility','amount','conditions') then
        perform private.dw_fail('INVALID_INPUT'); end if;
      if v_evidence?'note' and not private.dw_text(v_evidence->'note',0,20000) then perform private.dw_fail('INVALID_INPUT'); end if;
      case v_evidence->>'kind'
      when 'fragment' then
        if not private.dw_keys(v_evidence,array['kind','field','occurrenceId','relation','reviewStatus','reviewedValue','note'])
          or not v_evidence?'field' or not private.dw_id(v_evidence->'occurrenceId')
          or not (v_evidence->>'occurrenceId')=any(v_occ_ids)
          or coalesce(v_evidence->>'relation','') not in ('supports','partial','contradicts')
          or coalesce(v_evidence->>'reviewStatus','') not in ('candidate','verified','rejected')
          or (v_evidence?'reviewedValue' and not private.dw_text(v_evidence->'reviewedValue',0,20000)) then
          perform private.dw_fail('INVALID_INPUT'); end if;
        if v_evidence->>'reviewStatus'='verified' then
          v_field:=v_evidence->>'field';
          if v_field='conditions' then
            select string_agg(value#>>'{}',E'\n' order by ord) into v_value
              from jsonb_array_elements(coalesce(v_practice->'conditions','[]')) with ordinality as e(value,ord);
          else v_value:=v_practice->>v_field; end if;
          if v_value is null or v_evidence->>'reviewedValue' is distinct from v_value then perform private.dw_fail('INVALID_INPUT'); end if;
        end if;
      when 'document' then
        if not private.dw_keys(v_evidence,array['kind','field','documentId','versionId','note'])
          or not private.dw_id(v_evidence->'documentId') or not private.dw_id(v_evidence->'versionId')
          or not (v_evidence->>'versionId')=any(v_editions)
          or not exists(select 1 from private.source_versions where version_id=v_evidence->>'versionId'
            and document_id=v_evidence->>'documentId') then perform private.dw_fail('INVALID_INPUT'); end if;
      when 'article' then
        v_url:=v_evidence->>'url';
        if not private.dw_keys(v_evidence,array['kind','field','url','title','note'])
          or not private.dw_text(v_evidence->'url',1,2000) or v_url !~ '^https?://[^/@[:space:]]+([/?#]|$)'
          or (v_evidence?'title' and not private.dw_text(v_evidence->'title',0,1000)) then perform private.dw_fail('INVALID_INPUT'); end if;
      else perform private.dw_fail('INVALID_INPUT');
      end case;
    end loop;
  end if;
  return jsonb_set(p_bundle,'{sources}',v_sources);
end $$;

create function private.dw_bootstrap() returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  select jsonb_build_object('profile',(select jsonb_build_object('userId',user_id,'fullName',full_name,'revision',revision)
    from public.dw_profiles where user_id=v_uid),
    'canCreateSession',exists(select 1 from private.facilitators where user_id=v_uid and revoked_at is null),
    'sessions',coalesce((select jsonb_agg(private.dw_session_json(s.id) order by s.created_at desc,s.id)
      from public.dw_sessions s join public.dw_memberships m on m.session_id=s.id
      where m.user_id=v_uid and m.revoked_at is null),'[]'::jsonb)) into v_result;
  return v_result;
end $$;
create function private.dw_save_profile(p_operation_id uuid,p_expected_revision bigint,p_full_name text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_old jsonb; v_profile public.dw_profiles; v_result jsonb; v_session uuid;
begin
  v_payload:=jsonb_build_object('revision',p_expected_revision,'fullName',p_full_name);
  v_old:=private.dw_begin_operation(p_operation_id,'save_profile',v_payload);
  if v_old is not null then return v_old; end if;
  if p_full_name is null or not private.dw_text(to_jsonb(p_full_name),1,200) or btrim(p_full_name)='' or p_expected_revision is null then
    perform private.dw_fail('INVALID_INPUT'); end if;
  perform pg_advisory_xact_lock(hashtextextended('profile:'||v_uid::text,0));
  select * into v_profile from public.dw_profiles where user_id=v_uid for update;
  if found then
    if v_profile.revision<>p_expected_revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
    update public.dw_profiles set full_name=btrim(p_full_name),revision=revision+1,updated_at=now()
      where user_id=v_uid returning * into v_profile;
  else
    if p_expected_revision<>0 then perform private.dw_fail('REVISION_CONFLICT'); end if;
    insert into public.dw_profiles(user_id,full_name) values(v_uid,btrim(p_full_name)) returning * into v_profile;
  end if;
  v_result:=jsonb_build_object('userId',v_profile.user_id,'fullName',v_profile.full_name,'revision',v_profile.revision);
  perform private.dw_finish_operation(p_operation_id,'save_profile',v_payload,v_result);
  perform private.dw_event(null,p_operation_id,'profile.saved',v_uid,v_profile.revision);
  for v_session in select session_id from public.dw_memberships where user_id=v_uid and revoked_at is null order by session_id loop
    perform private.dw_event(v_session,p_operation_id,'profile.saved',v_uid,v_profile.revision);
  end loop;
  return v_result;
end $$;
create function private.dw_create_session(p_operation_id uuid,p_title text,p_scope text,p_region_id text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_old jsonb; v_session uuid;
begin
  perform 1 from private.facilitators where user_id=v_uid and revoked_at is null for share;
  if not found then perform private.dw_fail('FORBIDDEN'); end if;
  if not exists(select 1 from public.dw_profiles where user_id=v_uid) then perform private.dw_fail('PROFILE_REQUIRED'); end if;
  v_payload:=jsonb_build_object('title',p_title,'scope',p_scope,'regionId',p_region_id);
  v_old:=private.dw_begin_operation(p_operation_id,'create_session',v_payload);
  if v_old is not null then return private.dw_snapshot((v_old->>'sessionId')::uuid); end if;
  if p_title is null or not private.dw_text(to_jsonb(p_title),1,200) or btrim(p_title)=''
    or p_scope is null or p_scope not in ('municipality','region','federal')
    or (p_region_id is not null and not private.dw_id(to_jsonb(p_region_id)))
    or (p_scope<>'federal' and p_region_id is null) then perform private.dw_fail('INVALID_INPUT'); end if;
  perform pg_advisory_xact_lock(hashtextextended('member-sessions:'||v_uid::text,0));
  if (select count(*) from public.dw_memberships where user_id=v_uid)>=1000 then perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  insert into public.dw_sessions(owner_id,title,scope,region_id) values(v_uid,btrim(p_title),p_scope,p_region_id) returning id into v_session;
  insert into public.dw_memberships(session_id,user_id,role) values(v_session,v_uid,'host');
  insert into private.invitations(session_id,code) values(v_session,upper(left(replace(gen_random_uuid()::text,'-',''),12)));
  perform private.dw_event(v_session,p_operation_id,'session.created',v_session,1);
  perform private.dw_finish_operation(p_operation_id,'create_session',v_payload,jsonb_build_object('sessionId',v_session,'revision',1));
  return private.dw_snapshot(v_session);
end $$;

create function private.dw_join_session(p_operation_id uuid,p_code text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_old jsonb; v_code text; v_result jsonb;
  v_session public.dw_sessions; v_attempt private.join_attempts; v_member public.dw_memberships;
begin
  if not exists(select 1 from public.dw_profiles where user_id=v_uid) then perform private.dw_fail('PROFILE_REQUIRED'); end if;
  if p_code is null or char_length(p_code)>128 then perform private.dw_fail('INVALID_INPUT'); end if;
  v_payload:=jsonb_build_object('code',p_code);
  v_old:=private.dw_begin_operation(p_operation_id,'join_session',v_payload);
  if v_old is not null then
    if v_old?'error' then return v_old; end if;
    return private.dw_snapshot((v_old->>'sessionId')::uuid);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('member-sessions:'||v_uid::text,0));
  insert into private.join_attempts(user_id) values(v_uid) on conflict do nothing;
  select * into v_attempt from private.join_attempts where user_id=v_uid for update;
  if v_attempt.window_started <= now()-interval '10 minutes' then
    update private.join_attempts set window_started=now(),attempts=0 where user_id=v_uid returning * into v_attempt;
  end if;
  if v_attempt.attempts>=8 then
    -- Return, not RAISE: a SQL exception would roll the rate-limit counter back.
    return jsonb_build_object('error',jsonb_build_object('code','RATE_LIMITED',
      'retryAfterSeconds',greatest(1,ceil(extract(epoch from v_attempt.window_started+interval '10 minutes'-now()))::integer)));
  end if;
  update private.join_attempts set attempts=attempts+1 where user_id=v_uid;
  v_code:=upper(regexp_replace(btrim(p_code),'[[:space:]-]','','g'));
  select s.* into v_session from public.dw_sessions s join private.invitations i on i.session_id=s.id
    where i.code=v_code for update of s;
  if not found then
    v_result:=jsonb_build_object('error',jsonb_build_object('code','INVALID_INVITATION'));
  else
    select * into v_member from public.dw_memberships where session_id=v_session.id and user_id=v_uid;
    if found then
      if v_member.revoked_at is not null then
        v_result:=jsonb_build_object('error',jsonb_build_object('code','FORBIDDEN'));
      else
        perform private.dw_finish_operation(p_operation_id,'join_session',v_payload,jsonb_build_object('sessionId',v_session.id));
        return private.dw_snapshot(v_session.id);
      end if;
    elsif not v_session.join_open or v_session.status='closed' then
      v_result:=jsonb_build_object('error',jsonb_build_object('code','JOIN_CLOSED'));
    elsif (select count(*) from public.dw_memberships where session_id=v_session.id and revoked_at is null)>=1000
      or (select count(*) from public.dw_memberships where user_id=v_uid and revoked_at is null)>=1000 then
      v_result:=jsonb_build_object('error',jsonb_build_object('code','LIMIT_EXCEEDED'));
    else
      insert into public.dw_memberships(session_id,user_id,role) values(v_session.id,v_uid,'participant');
      perform private.dw_event(v_session.id,p_operation_id,'member.joined',v_uid,1);
      perform private.dw_finish_operation(p_operation_id,'join_session',v_payload,jsonb_build_object('sessionId',v_session.id,'revision',1));
      return private.dw_snapshot(v_session.id);
    end if;
  end if;
  perform private.dw_finish_operation(p_operation_id,'join_session',v_payload,v_result);
  return v_result;
end $$;

create function private.dw_invitation(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select jsonb_build_object('code',i.code,'revision',s.revision) into v_result
    from private.invitations i join public.dw_sessions s on s.id=i.session_id where s.id=p_session_id;
  return v_result;
end $$;
create function private.dw_rotate_invitation(p_operation_id uuid,p_session_id uuid,p_expected_revision bigint) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_old jsonb; v_session public.dw_sessions;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'revision',p_expected_revision);
  v_old:=private.dw_begin_operation(p_operation_id,'rotate_invitation',v_payload);
  if v_old is not null then return private.dw_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if p_expected_revision is null or p_expected_revision<>v_session.revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  update private.invitations set code=upper(left(replace(gen_random_uuid()::text,'-',''),12)),updated_at=now() where session_id=p_session_id;
  update public.dw_sessions set revision=revision+1,updated_at=now() where id=p_session_id returning * into v_session;
  perform private.dw_event(p_session_id,p_operation_id,'invitation.rotated',p_session_id,v_session.revision);
  perform private.dw_finish_operation(p_operation_id,'rotate_invitation',v_payload,jsonb_build_object('sessionId',p_session_id,'revision',v_session.revision));
  return private.dw_snapshot(p_session_id);
end $$;
create function private.dw_update_session(p_operation_id uuid,p_session_id uuid,p_expected_revision bigint,p_patch jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_old jsonb; v_session public.dw_sessions; v_focus uuid;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'revision',p_expected_revision,'patch',p_patch);
  v_old:=private.dw_begin_operation(p_operation_id,'update_session',v_payload);
  if v_old is not null then return private.dw_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if p_expected_revision is null or p_expected_revision<>v_session.revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  if p_patch is null or p_patch='{}'::jsonb or not private.dw_keys(p_patch,array['title','status','phase','joinOpen','focusSubmissionId','projectorShowAuthors']) then
    perform private.dw_fail('INVALID_INPUT'); end if;
  if (p_patch?'title' and (not private.dw_text(p_patch->'title',1,200) or btrim(p_patch->>'title')=''))
    or (p_patch?'status' and coalesce(p_patch->>'status','') not in ('open','paused','closed'))
    or (p_patch?'phase' and coalesce(p_patch->>'phase','') not in ('reading','review','discussion'))
    or (p_patch?'joinOpen' and jsonb_typeof(p_patch->'joinOpen')<>'boolean')
    or (p_patch?'projectorShowAuthors' and jsonb_typeof(p_patch->'projectorShowAuthors')<>'boolean') then
    perform private.dw_fail('INVALID_INPUT'); end if;
  v_focus:=v_session.focus_submission_id;
  if p_patch?'focusSubmissionId' then
    if p_patch->'focusSubmissionId'='null'::jsonb then v_focus:=null;
    else
      if coalesce(p_patch->>'focusSubmissionId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        perform private.dw_fail('INVALID_INPUT'); end if;
      v_focus:=(p_patch->>'focusSubmissionId')::uuid;
      if not exists(select 1 from public.dw_submissions where id=v_focus and session_id=p_session_id and status='shared') then
        perform private.dw_fail('FORBIDDEN'); end if;
    end if;
  end if;
  update public.dw_sessions set title=coalesce(p_patch->>'title',title),status=coalesce(p_patch->>'status',status),
    phase=coalesce(p_patch->>'phase',phase),join_open=coalesce((p_patch->>'joinOpen')::boolean,join_open),
    projector_show_authors=coalesce((p_patch->>'projectorShowAuthors')::boolean,projector_show_authors),
    focus_submission_id=v_focus,revision=revision+1,updated_at=now()
    where id=p_session_id returning * into v_session;
  perform private.dw_event(p_session_id,p_operation_id,'session.updated',p_session_id,v_session.revision);
  perform private.dw_finish_operation(p_operation_id,'update_session',v_payload,jsonb_build_object('sessionId',p_session_id,'revision',v_session.revision));
  return private.dw_snapshot(p_session_id);
end $$;

create function private.dw_publish_submission(p_operation_id uuid,p_session_id uuid,p_local_key text,p_expected_revision bigint,p_bundle jsonb) returns jsonb
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
  if v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
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

create function private.dw_moderate_submission(p_operation_id uuid,p_session_id uuid,p_submission_id uuid,p_expected_revision bigint,p_status text) returns jsonb
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
    if v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
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

create function private.dw_set_member_role(p_operation_id uuid,p_session_id uuid,p_member_id uuid,p_expected_revision bigint,p_role text) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_old jsonb; v_member public.dw_memberships;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'memberId',p_member_id,'revision',p_expected_revision,'role',p_role);
  v_old:=private.dw_begin_operation(p_operation_id,'set_member_role',v_payload);
  if v_old is not null then return private.dw_snapshot(p_session_id); end if;
  perform 1 from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_member from public.dw_memberships where session_id=p_session_id and user_id=p_member_id and revoked_at is null for update;
  if not found or v_member.role='host' then perform private.dw_fail('FORBIDDEN'); end if;
  if p_role is null or p_role not in ('participant','observer') then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_expected_revision is null or p_expected_revision<>v_member.revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  update public.dw_memberships set role=p_role,revision=revision+1 where session_id=p_session_id and user_id=p_member_id returning * into v_member;
  perform private.dw_event(p_session_id,p_operation_id,'member.role_changed',p_member_id,v_member.revision);
  perform private.dw_finish_operation(p_operation_id,'set_member_role',v_payload,
    jsonb_build_object('sessionId',p_session_id,'entityId',p_member_id,'revision',v_member.revision));
  return private.dw_snapshot(p_session_id);
end $$;
create function private.dw_revoke_member(p_operation_id uuid,p_session_id uuid,p_member_id uuid,p_expected_revision bigint) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_old jsonb; v_member public.dw_memberships;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'memberId',p_member_id,'revision',p_expected_revision);
  v_old:=private.dw_begin_operation(p_operation_id,'revoke_member',v_payload);
  if v_old is not null then return private.dw_snapshot(p_session_id); end if;
  perform 1 from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_member from public.dw_memberships where session_id=p_session_id and user_id=p_member_id and revoked_at is null for update;
  if not found or v_member.role='host' then perform private.dw_fail('FORBIDDEN'); end if;
  if p_expected_revision is null or p_expected_revision<>v_member.revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  update public.dw_memberships set revoked_at=now(),revision=revision+1 where session_id=p_session_id and user_id=p_member_id returning * into v_member;
  perform private.dw_event(p_session_id,p_operation_id,'member.revoked',p_member_id,v_member.revision);
  perform private.dw_finish_operation(p_operation_id,'revoke_member',v_payload,
    jsonb_build_object('sessionId',p_session_id,'entityId',p_member_id,'revision',v_member.revision));
  return private.dw_snapshot(p_session_id);
end $$;

-- Public endpoints are SECURITY INVOKER; only the explicitly guarded private implementations elevate.
create function public.dw_bootstrap() returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_bootstrap() $$;
create function public.dw_save_profile(p_operation_id uuid,p_expected_revision bigint,p_full_name text) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_save_profile($1,$2,$3) $$;
create function public.dw_create_session(p_operation_id uuid,p_title text,p_scope text,p_region_id text) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_create_session($1,$2,$3,$4) $$;
create function public.dw_join_session(p_operation_id uuid,p_code text) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_join_session($1,$2) $$;
create function public.dw_session_snapshot(p_session_id uuid) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_snapshot($1) $$;
create function public.dw_projector_snapshot(p_session_id uuid) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_projector_snapshot($1) $$;
create function public.dw_update_session(p_operation_id uuid,p_session_id uuid,p_expected_revision bigint,p_patch jsonb) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_update_session($1,$2,$3,$4) $$;
create function public.dw_publish_submission(p_operation_id uuid,p_session_id uuid,p_local_key text,p_expected_revision bigint,p_bundle jsonb) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_publish_submission($1,$2,$3,$4,$5) $$;
create function public.dw_moderate_submission(p_operation_id uuid,p_session_id uuid,p_submission_id uuid,p_expected_revision bigint,p_status text) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_moderate_submission($1,$2,$3,$4,$5) $$;
create function public.dw_invitation(p_session_id uuid) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_invitation($1) $$;
create function public.dw_rotate_invitation(p_operation_id uuid,p_session_id uuid,p_expected_revision bigint) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_rotate_invitation($1,$2,$3) $$;
create function public.dw_set_member_role(p_operation_id uuid,p_session_id uuid,p_member_id uuid,p_expected_revision bigint,p_role text) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_set_member_role($1,$2,$3,$4,$5) $$;
create function public.dw_revoke_member(p_operation_id uuid,p_session_id uuid,p_member_id uuid,p_expected_revision bigint) returns jsonb language sql security invoker set search_path=''
 as $$ select private.dw_revoke_member($1,$2,$3,$4) $$;

revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema public to authenticated;
revoke all on function public.dw_bootstrap() from public, anon, authenticated;
grant execute on function public.dw_bootstrap(), private.dw_bootstrap() to authenticated;
revoke all on function public.dw_save_profile(uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.dw_save_profile(uuid,bigint,text), private.dw_save_profile(uuid,bigint,text) to authenticated;
revoke all on function public.dw_create_session(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.dw_create_session(uuid,text,text,text), private.dw_create_session(uuid,text,text,text) to authenticated;
revoke all on function public.dw_join_session(uuid,text) from public, anon, authenticated;
grant execute on function public.dw_join_session(uuid,text), private.dw_join_session(uuid,text) to authenticated;
revoke all on function public.dw_session_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.dw_session_snapshot(uuid), private.dw_snapshot(uuid) to authenticated;
revoke all on function public.dw_projector_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.dw_projector_snapshot(uuid), private.dw_projector_snapshot(uuid) to authenticated;
revoke all on function public.dw_update_session(uuid,uuid,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.dw_update_session(uuid,uuid,bigint,jsonb), private.dw_update_session(uuid,uuid,bigint,jsonb) to authenticated;
revoke all on function public.dw_publish_submission(uuid,uuid,text,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.dw_publish_submission(uuid,uuid,text,bigint,jsonb), private.dw_publish_submission(uuid,uuid,text,bigint,jsonb) to authenticated;
revoke all on function public.dw_moderate_submission(uuid,uuid,uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.dw_moderate_submission(uuid,uuid,uuid,bigint,text), private.dw_moderate_submission(uuid,uuid,uuid,bigint,text) to authenticated;
revoke all on function public.dw_invitation(uuid) from public, anon, authenticated;
grant execute on function public.dw_invitation(uuid), private.dw_invitation(uuid) to authenticated;
revoke all on function public.dw_rotate_invitation(uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.dw_rotate_invitation(uuid,uuid,bigint), private.dw_rotate_invitation(uuid,uuid,bigint) to authenticated;
revoke all on function public.dw_set_member_role(uuid,uuid,uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.dw_set_member_role(uuid,uuid,uuid,bigint,text), private.dw_set_member_role(uuid,uuid,uuid,bigint,text) to authenticated;
revoke all on function public.dw_revoke_member(uuid,uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.dw_revoke_member(uuid,uuid,uuid,bigint), private.dw_revoke_member(uuid,uuid,uuid,bigint) to authenticated;
grant execute on function private.dw_is_verified(),private.dw_member_role(uuid),private.dw_can_read_profile(uuid) to authenticated;

-- The notification table is optional when Realtime is unavailable; snapshots remain authoritative.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='dw_session_events') then
    alter publication supabase_realtime add table public.dw_session_events;
  end if;
end $$;

-- Poll this scalar first. Unchanged sessions do not retransmit every shared quotation.
create function private.dw_session_cursor(p_session_id uuid) returns bigint
 language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_cursor bigint;
begin
  select event_cursor into v_cursor from public.dw_sessions
    where id=p_session_id and private.dw_member_role(id) is not null;
  if not found then perform private.dw_fail('FORBIDDEN'); end if;
  return v_cursor;
end $$;
create function public.dw_session_cursor(p_session_id uuid) returns bigint
 language sql security invoker set search_path='' as $$ select private.dw_session_cursor($1) $$;
revoke all on function public.dw_session_cursor(uuid),private.dw_session_cursor(uuid) from public,anon,authenticated;
grant execute on function public.dw_session_cursor(uuid),private.dw_session_cursor(uuid) to authenticated;
