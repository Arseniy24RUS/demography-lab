-- Stage 5: source-qualified territories, shared territorial rooms and immutable roadmaps.
-- Previous migrations, canonical quotations and the independent research channel are preserved.
create table private.dw_roadmap_datasets (
  id text primary key, metadata jsonb not null, territory_count integer not null check(territory_count>0),
  series_count integer not null check(series_count>=0), sealed boolean not null default false,
  created_at timestamptz not null default now()
);
create table private.dw_roadmap_territories (
  dataset_id text not null references private.dw_roadmap_datasets(id), territory_key text not null,
  level text not null check(level in ('municipality','administrative_district','region','federal')),
  region_id text, room_eligible boolean not null, material jsonb not null, catalog_record jsonb not null,
  primary key(dataset_id,territory_key), check(octet_length(material::text)<=16384)
);
create index dw_roadmap_territory_region on private.dw_roadmap_territories(dataset_id,region_id,level);
create table private.dw_roadmap_series (
  dataset_id text not null, id text not null, territory_key text not null,
  fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'), material jsonb not null,
  canonical_text text not null,
  primary key(dataset_id,id), foreign key(dataset_id,territory_key) references private.dw_roadmap_territories(dataset_id,territory_key),
  check(octet_length(material::text)<=1048576),
  check(encode(sha256(convert_to(canonical_text,'UTF8')),'hex')=fingerprint),
  check(material->>'id'=id and material->>'territoryKey'=territory_key and material->>'fingerprint'=fingerprint)
);
create index dw_roadmap_series_territory on private.dw_roadmap_series(dataset_id,territory_key);
create table private.dw_roadmap_state (
  session_id uuid primary key references public.dw_sessions(id), room_level text not null check(room_level in ('municipality','region','federal')),
  dataset_id text references private.dw_roadmap_datasets(id), revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  event_cursor bigint not null default 0 check(event_cursor between 0 and 9007199254740991),
  source_cursor bigint not null default 0 check(source_cursor between 0 and 9007199254740991)
);
insert into private.dw_roadmap_state(session_id,room_level) select id,scope from public.dw_sessions;
create table private.dw_roadmaps (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.dw_sessions(id),
  dataset_id text not null, territory_key text not null, territory jsonb not null,
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(session_id,territory_key), unique(session_id,id),
  foreign key(dataset_id,territory_key) references private.dw_roadmap_territories(dataset_id,territory_key)
);
create table private.dw_roadmap_assignments (
  session_id uuid not null, user_id uuid not null references public.dw_profiles(user_id), roadmap_id uuid not null,
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  primary key(session_id,user_id), foreign key(session_id,roadmap_id) references private.dw_roadmaps(session_id,id)
);
create index dw_roadmap_assignments_room on private.dw_roadmap_assignments(session_id,roadmap_id);
create table private.dw_roadmap_items (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, roadmap_id uuid not null,
  kind text not null check(kind in ('passport','diagnosis','monitoring','activity','indicator','scenario','cost','funding','risk','fact')),
  data jsonb not null check(jsonb_typeof(data)='object' and octet_length(data::text)<=131072),
  status text not null default 'active' check(status in ('active','archived')),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  created_by uuid not null references public.dw_profiles(user_id), updated_by uuid not null references public.dw_profiles(user_id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(roadmap_id,id), foreign key(session_id,roadmap_id) references private.dw_roadmaps(session_id,id)
);
create unique index dw_roadmap_singleton on private.dw_roadmap_items(roadmap_id,kind) where kind in ('passport','diagnosis','monitoring');
create index dw_roadmap_item_kind on private.dw_roadmap_items(roadmap_id,kind,status);
create index dw_roadmap_items_created_by on private.dw_roadmap_items(created_by);
create index dw_roadmap_items_updated_by on private.dw_roadmap_items(updated_by);
create table private.dw_roadmap_basis_materials (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.dw_sessions(id),
  source_kind text not null check(source_kind in ('barrier','link','solution')), source_id uuid not null,
  source_revision bigint not null check(source_revision>0), fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
  material jsonb not null check(jsonb_typeof(material)='object' and octet_length(material::text)<=131072),
  unique(session_id,source_kind,source_id,fingerprint), unique(session_id,id)
);
create table private.dw_roadmap_bases (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, roadmap_id uuid not null,
  material_id uuid not null, rationale text not null check(char_length(rationale)<=4000),
  status text not null check(status in ('active','archived')), revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(session_id,roadmap_id) references private.dw_roadmaps(session_id,id),
  foreign key(session_id,material_id) references private.dw_roadmap_basis_materials(session_id,id)
);
create index dw_roadmap_bases_room on private.dw_roadmap_bases(roadmap_id);
create index dw_roadmap_bases_material on private.dw_roadmap_bases(material_id);
create table private.dw_roadmap_versions (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, roadmap_id uuid not null,
  number integer not null check(number between 1 and 30), kind text not null check(kind in ('draft','submitted')),
  title text not null check(char_length(btrim(title)) between 1 and 240), roadmap_revision bigint not null,
  material jsonb not null check(octet_length(material::text)<=8388608), sha256 text not null,
  created_at timestamptz not null default now(),
  unique(roadmap_id,number), unique(roadmap_id,id), foreign key(session_id,roadmap_id) references private.dw_roadmaps(session_id,id),
  check(sha256=encode(sha256(convert_to(material::text,'UTF8')),'hex'))
);
create table private.dw_roadmap_reviews (
  version_id uuid primary key references private.dw_roadmap_versions(id),
  decision text not null check(decision in ('revise','discussed')), comment text not null check(char_length(btrim(comment)) between 1 and 4000),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  reviewer_id uuid not null references public.dw_profiles(user_id), reviewed_at timestamptz not null default now()
);
create index dw_roadmap_reviews_reviewer on private.dw_roadmap_reviews(reviewer_id);
create table public.dw_roadmap_events (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.dw_sessions(id), roadmap_id uuid,
  cursor bigint not null check(cursor>0), event_type text not null, created_at timestamptz not null default now(), unique(session_id,cursor)
);

do $$ declare n text; begin
  foreach n in array array['dw_roadmap_datasets','dw_roadmap_territories','dw_roadmap_series','dw_roadmap_state','dw_roadmaps',
    'dw_roadmap_assignments','dw_roadmap_items','dw_roadmap_basis_materials','dw_roadmap_bases','dw_roadmap_versions','dw_roadmap_reviews'] loop
    execute format('alter table private.%I enable row level security',n);
    execute format('revoke all on private.%I from public,anon,authenticated',n);
  end loop;
end $$;
alter table public.dw_roadmap_events enable row level security;
revoke all on public.dw_roadmap_events from public,anon,authenticated;
grant select on public.dw_roadmap_events to authenticated;
create policy dw_roadmap_events_read on public.dw_roadmap_events for select to authenticated using(private.dw_member_role(session_id) is not null);

create function private.dw_s5_number(v jsonb) returns boolean language sql immutable set search_path='' as $$
  select case when jsonb_typeof(v)='number' then abs((v#>>'{}')::numeric)<=1e15 else false end
$$;
create function private.dw_s5_year(v jsonb) returns boolean language sql immutable set search_path='' as $$
  select case when private.dw_s4_integer(v,1900) then (v#>>'{}')::numeric<=2200 else false end
$$;
create function private.dw_s5_date(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare d date; begin
  if v='null'::jsonb then return true; end if;
  if not private.dw_text(v,10,10) or (v#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  begin d:=(v#>>'{}')::date; exception when others then return false; end;
  return d between date '1900-01-01' and date '2200-12-31' and d::text=v#>>'{}';
end $$;
create function private.dw_s5_dates(v jsonb) returns boolean language sql immutable set search_path='' as $$
  select private.dw_s5_date(v->'startDate') and private.dw_s5_date(v->'endDate')
    and ((v->'startDate'='null'::jsonb and v->'endDate'='null'::jsonb) or
      (v->>'startDate' is not null and v->>'endDate' is not null and v->>'startDate'<=v->>'endDate'))
$$;
create function private.dw_s5_ids(v jsonb,p_max integer) returns boolean language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(v) is distinct from 'array' then return false; end if;
  return jsonb_array_length(v)<=p_max and not exists(select 1 from jsonb_array_elements(v) x where not private.dw_s4_uuid(x))
    and jsonb_array_length(v)=(select count(distinct x) from jsonb_array_elements(v) x);
end $$;
create function private.dw_s5_domain(v numeric,d text) returns boolean language sql immutable set search_path='' as $$
  select d='signed' or (v>=0 and (d<>'percent' or v<=100) and (d<>'ratio' or v<=1))
$$;
create function private.dw_s5_series_array(v jsonb) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_array('canonical-municipal-series-1',v->'id',v->'territoryKey',v->'metricId',v->'title',v->'unit',v->'semanticType',
    v->'valueDomain',v->'aggregation',v->'decimals',v->'reference',v->'sourceEditionId',v->'sourceUrl',v->'sourcePath',v->'sourceSha256',
    v->'sourceCommit',v->'sourceKind',v->'provenanceStatus',v->'sourceMunicipalityKey',v->'geographyEditionId',v->'geographyComparability',
    v->'comparabilityNote',(select jsonb_agg(jsonb_build_array(x->'year',x->'value') order by ord) from jsonb_array_elements(v->'points') with ordinality t(x,ord)))
$$;
create function private.dw_roadmap_dataset_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='dw_roadmap_datasets' then
    if tg_op='DELETE' or old.sealed or not new.sealed or (to_jsonb(old)-'sealed')<>(to_jsonb(new)-'sealed') then perform private.dw_fail('DATASET_IMMUTABLE'); end if;
    if (select count(*) from private.dw_roadmap_territories where dataset_id=new.id)<>new.territory_count
      or (select count(*) from private.dw_roadmap_series where dataset_id=new.id)<>new.series_count then perform private.dw_fail('DATASET_NOT_READY'); end if;
    return new;
  end if;
  if tg_op<>'INSERT' or not exists(select 1 from private.dw_roadmap_datasets where id=new.dataset_id and not sealed) then perform private.dw_fail('DATASET_IMMUTABLE'); end if;
  if tg_table_name='dw_roadmap_series' then
    if new.canonical_text::jsonb<>private.dw_s5_series_array(new.material) then perform private.dw_fail('SOURCE_MISMATCH'); end if;
  end if;
  return new;
end $$;
create trigger dw_roadmap_dataset_immutable before update or delete on private.dw_roadmap_datasets for each row execute function private.dw_roadmap_dataset_immutable();
create trigger dw_roadmap_territory_immutable before insert or update or delete on private.dw_roadmap_territories for each row execute function private.dw_roadmap_dataset_immutable();
create trigger dw_roadmap_series_immutable before insert or update or delete on private.dw_roadmap_series for each row execute function private.dw_roadmap_dataset_immutable();
create function private.dw_roadmap_material_immutable() returns trigger language plpgsql set search_path='' as $$
begin perform private.dw_fail('ROADMAP_VERSION_IMMUTABLE'); return old; end $$;
create trigger dw_roadmap_basis_immutable before update or delete on private.dw_roadmap_basis_materials for each row execute function private.dw_roadmap_material_immutable();
create trigger dw_roadmap_version_immutable before update or delete on private.dw_roadmap_versions for each row execute function private.dw_roadmap_material_immutable();

create function private.dw_roadmap_touch(p_session uuid,p_room uuid,p_kind text,p_source boolean default false) returns void language plpgsql set search_path='' as $$
declare n bigint; begin
  update private.dw_roadmap_state set event_cursor=event_cursor+1,source_cursor=source_cursor+case when p_source then 1 else 0 end
    where session_id=p_session returning event_cursor into n;
  if p_room is not null then update private.dw_roadmaps set revision=revision+1,updated_at=now() where id=p_room and session_id=p_session; end if;
  insert into public.dw_roadmap_events(session_id,roadmap_id,cursor,event_type) values(p_session,p_room,n,p_kind);
end $$;
create function private.dw_roadmap_session_created() returns trigger language plpgsql security definer set search_path='' as $$
begin insert into private.dw_roadmap_state(session_id,room_level) values(new.id,new.scope); return new; end $$;
create trigger dw_roadmap_session_created after insert on public.dw_sessions for each row execute function private.dw_roadmap_session_created();
create function private.dw_roadmap_source_bridge() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.event_type in ('barrier.saved','barrier.link','solution.saved','sources.changed','family.saved','family.deleted','session.changed','membership.changed','profile.changed') then
    perform private.dw_roadmap_touch(new.session_id,null,new.event_type,true);
  end if;
  return new;
end $$;
create trigger dw_roadmap_source_bridge after insert on public.dw_barrier_events for each row execute function private.dw_roadmap_source_bridge();
create function private.dw_roadmap_read_guard(p_session uuid) returns text language plpgsql security definer set search_path='' as $$
declare u uuid:=private.dw_verified_uid(); r text; begin
  r:=private.dw_member_role(p_session); if r is null then perform private.dw_fail('FORBIDDEN'); end if; return r;
end $$;
create function private.dw_roadmap_write_guard(p_session uuid,p_room uuid default null,p_host boolean default false) returns text
language plpgsql security definer set search_path='' as $$
declare r text; s text; begin
  r:=private.dw_roadmap_read_guard(p_session);
  if r='observer' or (p_host and r<>'host') then perform private.dw_fail('FORBIDDEN'); end if;
  select status into s from public.dw_sessions where id=p_session for update;
  r:=private.dw_roadmap_read_guard(p_session);
  if r='observer' or (p_host and r<>'host') then perform private.dw_fail('FORBIDDEN'); end if;
  if s<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if p_room is not null then
    if not exists(select 1 from private.dw_roadmaps where session_id=p_session and id=p_room) then perform private.dw_fail('NOT_FOUND'); end if;
    if r<>'host' and not exists(select 1 from private.dw_roadmap_assignments where session_id=p_session and user_id=auth.uid() and roadmap_id=p_room)
      then perform private.dw_fail('ROADMAP_ROOM_REQUIRED'); end if;
  end if;
  return r;
end $$;

create function private.dw_roadmap_barrier_ground(p_session uuid,p_id uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',id,'title',title,'description',description,'stageIds',stage_ids,'evidenceKind',evidence_kind,'contentRevision',content_revision,'status',status)
  from private.dw_barriers where session_id=p_session and id=p_id
$$;
create function private.dw_roadmap_ground(p_session uuid,p_kind text,p_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare d jsonb; begin
  if p_kind='barrier' then d:=private.dw_roadmap_barrier_ground(p_session,p_id);
  elsif p_kind='solution' then
    select jsonb_build_object('id',s.id,'title',s.title,'targetGroup',s.target_group,'mechanism',s.mechanism,'firstStep',s.first_step,
      'responsible',s.responsible,'resources',s.resources,'successIndicator',s.success_indicator,'risks',s.risks,'revision',s.revision,'status',s.status,
      'barriers',(select jsonb_agg(private.dw_roadmap_barrier_ground(p_session,x) order by x) from unnest(s.barrier_ids) x)) into d
      from private.dw_solutions s where s.session_id=p_session and s.id=p_id;
  elsif p_kind='link' then
    select jsonb_build_object('id',l.id,'relationship',l.relationship,'explanation',l.explanation,'prerequisites',l.prerequisites,
      'revision',l.revision,'status',l.status,'barrier',private.dw_roadmap_barrier_ground(p_session,l.barrier_id),'evidenceId',l.evidence_id,
      'familyTitle',e.material->'title','familyFingerprint',e.fingerprint) into d
      from private.dw_barrier_links l join private.dw_barrier_evidence e on e.id=l.evidence_id and e.session_id=l.session_id
      where l.session_id=p_session and l.id=p_id;
  end if;
  if d is null then return null; end if;
  return jsonb_build_object('kind',p_kind,'source',d);
end $$;
create function private.dw_roadmap_link_stale(p_session uuid,p_link uuid) returns boolean language sql stable set search_path='' as $$
  select coalesce((select l.status<>'active' or b.status<>'active' or b.content_revision<>l.barrier_content_revision
    or e.fingerprint is distinct from encode(sha256(convert_to(private.dw_barrier_family_material(p_session,l.family_id)::text,'UTF8')),'hex')
    from private.dw_barrier_links l join private.dw_barriers b on b.id=l.barrier_id and b.session_id=l.session_id
    join private.dw_barrier_evidence e on e.id=l.evidence_id and e.session_id=l.session_id where l.session_id=p_session and l.id=p_link),true)
$$;
create function private.dw_roadmap_bases_json(p_session uuid,p_room uuid) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'sourceKind',m.source_kind,'sourceId',m.source_id,'sourceRevision',m.source_revision,
    'fingerprint',m.fingerprint,'material',m.material,'rationale',b.rationale,'status',b.status,'revision',b.revision,
    'createdAt',b.created_at,'updatedAt',b.updated_at,'staleReasons',to_jsonb(array_remove(array[
      case when g.current is null then 'source_missing' end,
      case when g.current is not null and encode(sha256(convert_to(g.current::text,'UTF8')),'hex')<>m.fingerprint then 'source_changed' end,
      case when g.current->'source'->>'status'='archived' then 'source_archived' end,
      case when m.source_kind='link' and private.dw_roadmap_link_stale(p_session,m.source_id) then 'source_basis_stale' end],null))) order by b.created_at,b.id),'[]'::jsonb)
    from private.dw_roadmap_bases b join private.dw_roadmap_basis_materials m on m.id=b.material_id and m.session_id=b.session_id
    cross join lateral(select private.dw_roadmap_ground(p_session,m.source_kind,m.source_id) as current) g
    where b.session_id=p_session and b.roadmap_id=p_room
$$;

create function private.dw_roadmap_cost(v jsonb) returns numeric language sql immutable set search_path='' as $$
  select round((v->>'quantity')::numeric * (v->>'unitPriceKopecks')::numeric * (v->>'periods')::numeric,0)
$$;
create function private.dw_roadmap_budget(p_room uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare rows jsonb; result jsonb; k text; begin
  with costs as (select id,(data->>'year')::integer as year,data->>'cashKind' kind,private.dw_roadmap_cost(data) amount
      from private.dw_roadmap_items where roadmap_id=p_room and kind='cost' and status='active'),
    funding as (select (data->>'costLineId')::uuid cost_id,
      coalesce(sum((data->>'amountKopecks')::numeric) filter(where data->>'status'='confirmed'),0) confirmed,
      coalesce(sum((data->>'amountKopecks')::numeric) filter(where data->>'status'<>'confirmed'),0) expected
      from private.dw_roadmap_items where roadmap_id=p_room and kind='funding' and status='active' group by 1),
    years as (select c.year,
      coalesce(sum(c.amount) filter(where c.kind='cash'),0) need,
      coalesce(sum(c.amount) filter(where c.kind='in_kind'),0) inkind,
      coalesce(sum(f.confirmed) filter(where c.kind='cash'),0) confirmed,
      coalesce(sum(f.expected) filter(where c.kind='cash'),0) expected from costs c left join funding f on f.cost_id=c.id group by c.year)
  select coalesce(jsonb_agg(jsonb_build_object('year',year,'needCashKopecks',need,'inKindKopecks',inkind,'confirmedKopecks',confirmed,'expectedKopecks',expected,
      'confirmedGapKopecks',need-confirmed,'remainingAfterExpectedKopecks',need-confirmed-expected) order by year),'[]'::jsonb) into rows from years;
  result:=jsonb_build_object('years',rows);
  foreach k in array array['needCashKopecks','inKindKopecks','confirmedKopecks','expectedKopecks','confirmedGapKopecks','remainingAfterExpectedKopecks'] loop
    result:=result||jsonb_build_object(k,(select coalesce(sum((x->>k)::numeric),0) from jsonb_array_elements(rows) x));
    if (result->>k)::numeric not between 0 and 9007199254740991 then perform private.dw_fail('BUDGET_OVERFLOW'); end if;
  end loop;
  return result;
end $$;

create function private.dw_roadmap_rooms_json(p_session uuid) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'territory',r.territory,'revision',r.revision,
    'memberCount',(select count(*) from private.dw_roadmap_assignments a join public.dw_memberships m on m.session_id=a.session_id and m.user_id=a.user_id
      where a.roadmap_id=r.id and m.revoked_at is null and m.role in ('host','participant')),
    'activeItemCount',(select count(*) from private.dw_roadmap_items i where i.roadmap_id=r.id and i.status='active'),
    'versionCount',(select count(*) from private.dw_roadmap_versions v where v.roadmap_id=r.id),
    'latestVersionKind',(select kind from private.dw_roadmap_versions v where v.roadmap_id=r.id order by number desc limit 1),'updatedAt',r.updated_at) order by r.territory->>'name',r.id),'[]'::jsonb)
  from private.dw_roadmaps r where session_id=p_session
$$;
create function private.dw_roadmap_items_json(p_room uuid,p_named boolean default true) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'data',i.data,'status',i.status,'revision',i.revision)
    ||case when p_named then jsonb_build_object('createdBy',i.created_by,'createdByName',c.full_name,'updatedBy',i.updated_by,'updatedByName',u.full_name,
      'createdAt',i.created_at,'updatedAt',i.updated_at) else '{}'::jsonb end order by i.created_at,i.id),'[]'::jsonb)
  from private.dw_roadmap_items i join public.dw_profiles c on c.user_id=i.created_by join public.dw_profiles u on u.user_id=i.updated_by where roadmap_id=p_room
$$;
create function private.dw_roadmap_versions_json(p_room uuid) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'number',v.number,'kind',v.kind,'title',v.title,'roadmapRevision',v.roadmap_revision,
    'sha256',v.sha256,'createdAt',v.created_at,'review',case when r.version_id is not null then jsonb_build_object('decision',r.decision,'comment',r.comment,
    'revision',r.revision,'reviewedAt',r.reviewed_at,'reviewerName',p.full_name) else null end) order by v.number desc),'[]'::jsonb)
  from private.dw_roadmap_versions v left join private.dw_roadmap_reviews r on r.version_id=v.id left join public.dw_profiles p on p.user_id=r.reviewer_id where v.roadmap_id=p_room
$$;
create function private.dw_roadmap_series_json(p_room uuid) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(s.material order by s.id),'[]'::jsonb) from private.dw_roadmap_series s join private.dw_roadmaps r on r.dataset_id=s.dataset_id
  where r.id=p_room and exists(select 1 from private.dw_roadmap_items i where i.roadmap_id=p_room and i.kind in ('scenario','fact') and i.data->>'seriesId'=s.id)
$$;
create function private.dw_roadmaps_index(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r text; result jsonb; begin
  r:=private.dw_roadmap_read_guard(p_session_id);
  select jsonb_build_object('sessionId',s.session_id,'cursor',s.event_cursor,'sourceCursor',s.source_cursor,
    'configuration',jsonb_build_object('roomLevel',s.room_level,'revision',s.revision,'dataEditionId',s.dataset_id,
      'locked',exists(select 1 from private.dw_roadmaps where session_id=s.session_id)),
    'myRoadmapId',case when r<>'observer' then a.roadmap_id else null end,'assignmentRevision',coalesce(a.revision,0),
    'rooms',private.dw_roadmap_rooms_json(p_session_id)) into result
    from private.dw_roadmap_state s left join private.dw_roadmap_assignments a on a.session_id=s.session_id and a.user_id=auth.uid() where s.session_id=p_session_id;
  return result;
end $$;
create function private.dw_roadmaps_cursor(p_session_id uuid) returns bigint language plpgsql security definer set search_path='' as $$
begin perform private.dw_roadmap_read_guard(p_session_id); return (select event_cursor from private.dw_roadmap_state where session_id=p_session_id); end $$;
create function private.dw_roadmap_snapshot(p_session_id uuid,p_roadmap_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare role text; result jsonb; begin
  role:=private.dw_roadmap_read_guard(p_session_id);
  select jsonb_build_object('sessionId',r.session_id,'roadmapId',r.id,'cursor',st.event_cursor,'sourceCursor',st.source_cursor,'revision',r.revision,
    'territory',r.territory,'roomLevel',st.room_level,'canEdit',s.status='open' and (role='host' or (role='participant' and exists(
      select 1 from private.dw_roadmap_assignments a where a.session_id=p_session_id and a.user_id=auth.uid() and a.roadmap_id=r.id))),
    'members',(select coalesce(jsonb_agg(jsonb_build_object('userId',p.user_id,'fullName',p.full_name) order by p.full_name,p.user_id),'[]'::jsonb)
      from private.dw_roadmap_assignments a join public.dw_memberships m on m.session_id=a.session_id and m.user_id=a.user_id
      join public.dw_profiles p on p.user_id=a.user_id where a.roadmap_id=r.id and m.revoked_at is null and m.role in ('host','participant')),
    'items',private.dw_roadmap_items_json(r.id),'basis',private.dw_roadmap_bases_json(p_session_id,r.id),
    'series',private.dw_roadmap_series_json(r.id),'versions',private.dw_roadmap_versions_json(r.id),'budget',private.dw_roadmap_budget(r.id)) into result
    from private.dw_roadmaps r join private.dw_roadmap_state st on st.session_id=r.session_id join public.dw_sessions s on s.id=r.session_id
    where r.id=p_roadmap_id and r.session_id=p_session_id;
  if result is null then perform private.dw_fail('NOT_FOUND'); end if;
  if octet_length(result::text)>1048576 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
  return result;
end $$;




-- The server validates the same closed wire shape as TypeScript. Invalid types
-- never reach casts in a mutation; no client-computed budgets or projections enter SQL.
create function private.dw_s5_validate_data(k text,v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare keys text[]; field text; x jsonb; p jsonb; n numeric; maxlen integer;
begin
  case k
    when 'passport' then keys:=array['title','targetGroup','partners','goal','objectives','startDate','endDate','expectedResult','defenseDate','humanResources','materialResources','informationResources'];
    when 'diagnosis' then keys:=array['problem','causeHypothesis','conclusion'];
    when 'monitoring' then keys:=array['frequency','method','responsible','interimReportDate','finalReportDate','qualitativeResults','sustainability'];
    when 'activity' then keys:=array['title','description','objectiveId','targetGroup','scale','startDate','endDate','responsible','partners','deliverable','completionCriterion','authorityLevel','legalBasis','approvalStatus','responsibleBody','necessaryDecision','indicatorIds','dependencies','stage','stageLabel','progressStatus'];
    when 'indicator' then keys:=array['title','definition','kind','unit','semanticType','valueDomain','numeratorDefinition','denominatorDefinition','baselineValue','baselineYear','annualTargets','sourceReference','frequency','responsible','limitations','scenarioId'];
    when 'scenario' then keys:=array['title','seriesId','seriesFingerprint','assumptions','parameters'];
    when 'cost' then keys:=array['activityId','year','title','unit','quantity','unitPriceKopecks','periods','cashKind','priceStatus','priceSource','priceDate'];
    when 'funding' then keys:=array['costLineId','sourceName','sourceKind','amountKopecks','status','sourceReference','sourceDate','originReference'];
    when 'risk' then keys:=array['title','mitigation','owner','trigger','contingency'];
    when 'fact' then keys:=array['sourceKind','title','interpretation','year','value','unit','sourceReference','sourceDate','seriesId','seriesFingerprint','metricId'];
    else return false;
  end case;
  if not private.dw_s4_required(v,keys) or octet_length(v::text)>131072 then return false; end if;
  -- All human-readable fields have explicit limits; enum/ID/numeric fields follow below.
  foreach field in array keys loop
    if v->field='null'::jsonb and not (field=any(array['startDate','endDate','defenseDate','interimReportDate','finalReportDate','priceDate','sourceDate','objectiveId','baselineValue','baselineYear','scenarioId'])
      or (k='fact' and field=any(array['year','value','seriesId','seriesFingerprint','metricId']))) then return false; end if;
    if field=any(array['title','targetGroup','partners','goal','expectedResult','humanResources','materialResources','informationResources',
      'problem','causeHypothesis','conclusion','frequency','method','responsible','qualitativeResults','sustainability',
      'description','scale','deliverable','completionCriterion','legalBasis','responsibleBody','necessaryDecision','stageLabel',
      'definition','unit','numeratorDefinition','denominatorDefinition','sourceReference','limitations','assumptions',
      'priceSource','sourceName','originReference','mitigation','owner','trigger','contingency','interpretation']) then
      maxlen:=case when field=any(array['title','stageLabel','sourceName']) then 240 when field='unit' then 120
        when field=any(array['frequency','responsible','scale','responsibleBody','owner']) then 1000 else 4000 end;
      if not private.dw_text(v->field,0,maxlen) then return false; end if;
    end if;
    if field=any(array['startDate','endDate','defenseDate','interimReportDate','finalReportDate','priceDate','sourceDate'])
      and not private.dw_s5_date(v->field) then return false; end if;
  end loop;
  if k in ('passport','activity') and not private.dw_s5_dates(v) then return false; end if;
  if k='passport' then
    if jsonb_typeof(v->'objectives')<>'array' or jsonb_array_length(v->'objectives')>30 then return false; end if;
    for x in select value from jsonb_array_elements(v->'objectives') loop
      if not private.dw_s4_required(x,array['id','title']) or not private.dw_s4_uuid(x->'id') or not private.dw_text(x->'title',0,1000) then return false; end if;
    end loop;
    if (select count(*)<>count(distinct q->>'id') from jsonb_array_elements(v->'objectives') q) then return false; end if;
  elsif k='activity' then
    if not (v->'objectiveId'='null'::jsonb or private.dw_s4_uuid(v->'objectiveId'))
      or v->>'authorityLevel' not in ('municipal','regional','federal','organization','joint','unknown')
      or v->>'approvalStatus' not in ('unknown','requires_decision','verified_source','contradiction')
      or v->>'stage' not in ('preparation','implementation','evaluation','custom')
      or v->>'progressStatus' not in ('planned','in_progress','completed')
      or not private.dw_s5_ids(v->'indicatorIds',20)
      or jsonb_typeof(v->'dependencies')<>'array' or jsonb_array_length(v->'dependencies')>40 then return false; end if;
    for x in select value from jsonb_array_elements(v->'dependencies') loop
      if not private.dw_s4_required(x,array['predecessorId','lagDays']) or not private.dw_s4_uuid(x->'predecessorId')
        or not private.dw_s4_integer(x->'lagDays') or (x->>'lagDays')::numeric>3650 then return false; end if;
    end loop;
    if (select count(*)<>count(distinct q->>'predecessorId') from jsonb_array_elements(v->'dependencies') q) then return false; end if;
  elsif k='indicator' then
    if v->>'kind' not in ('resource','output','family_outcome','demographic_context')
      or v->>'semanticType' not in ('stock','flow','rate','share')
      or v->>'valueDomain' not in ('nonnegative','signed','percent','ratio')
      or not (v->'scenarioId'='null'::jsonb or private.dw_s4_uuid(v->'scenarioId'))
      or not (v->'baselineValue'='null'::jsonb or private.dw_s5_number(v->'baselineValue'))
      or not (v->'baselineYear'='null'::jsonb or private.dw_s5_year(v->'baselineYear'))
      or ((v->'baselineYear'='null'::jsonb)<>(v->'baselineValue'='null'::jsonb))
      or jsonb_typeof(v->'annualTargets')<>'array' or jsonb_array_length(v->'annualTargets')>31 then return false; end if;
    if v->>'baselineValue' is not null and not private.dw_s5_domain((v->>'baselineValue')::numeric,v->>'valueDomain') then return false; end if;
    for x in select value from jsonb_array_elements(v->'annualTargets') loop
      if not private.dw_s4_required(x,array['year','value']) or not private.dw_s5_year(x->'year')
        or not private.dw_s5_number(x->'value') or not private.dw_s5_domain((x->>'value')::numeric,v->>'valueDomain') then return false; end if;
    end loop;
    if (select count(*)<>count(distinct q->>'year') from jsonb_array_elements(v->'annualTargets') q) then return false; end if;
  elsif k='scenario' then
    if not private.dw_text(v->'seriesId',1,500) or v->>'seriesId'~'[[:space:]]' or not private.dw_text(v->'seriesFingerprint',64,64)
      or v->>'seriesFingerprint'!~'^[a-f0-9]{64}$' then return false; end if;
    p:=v->'parameters';
    if not private.dw_s4_required(p,array['metricId','historyStartYear','historyEndYear','endYear','baselineMethod','targetMode','targetValue'])
      or not private.dw_text(p->'metricId',1,500) or p->>'metricId'~'[[:space:]]'
      or not private.dw_s5_year(p->'historyStartYear') or not private.dw_s5_year(p->'historyEndYear') or not private.dw_s5_year(p->'endYear')
      or p->>'baselineMethod' not in ('last_value','linear')
      or p->>'targetMode' not in ('absolute_end','relative_end','annual_growth','absolute_delta_end','percentage_points')
      or not private.dw_s5_number(p->'targetValue') then return false; end if;
    if (p->>'historyStartYear')::int>(p->>'historyEndYear')::int or (p->>'endYear')::int<=(p->>'historyEndYear')::int
      or (p->>'historyEndYear')::int-(p->>'historyStartYear')::int>100
      or (p->>'targetMode'='annual_growth' and (p->>'targetValue')::numeric< -100) then return false; end if;
  elsif k='cost' then
    if not private.dw_s4_uuid(v->'activityId') or not private.dw_s5_year(v->'year')
      or not private.dw_text(v->'quantity',1,14) or v->>'quantity'!~'^(0|[1-9][0-9]{0,9})([.][0-9]{1,3})?$'
      or not private.dw_s4_integer(v->'unitPriceKopecks') or not private.dw_s4_integer(v->'periods',1)
      or (v->>'periods')::numeric>10000 or v->>'cashKind' not in ('cash','in_kind')
      or v->>'priceStatus' not in ('confirmed','estimated') then return false; end if;
    if private.dw_roadmap_cost(v)>9007199254740991 then return false; end if;
    if v->>'priceStatus'='confirmed' and (length(btrim(v->>'priceSource'))=0 or v->>'priceDate' is null) then return false; end if;
  elsif k='funding' then
    if not private.dw_s4_uuid(v->'costLineId') or not private.dw_s4_integer(v->'amountKopecks')
      or v->>'sourceKind' not in ('municipal_budget','regional_budget','federal_budget','employer','grant','other')
      or v->>'status' not in ('confirmed','budget_draft','application','assumption') then return false; end if;
    if v->>'status'='confirmed' and (length(btrim(v->>'sourceReference'))<3 or v->>'sourceDate' is null) then return false; end if;
  elsif k='fact' then
    if v->>'sourceKind' not in ('registry','external_unverified')
      or not (v->'year'='null'::jsonb or private.dw_s5_year(v->'year'))
      or not (v->'value'='null'::jsonb or private.dw_s5_number(v->'value')) then return false; end if;
    if v->>'sourceKind'='external_unverified' then
      if v->'seriesId'<>'null'::jsonb or v->'seriesFingerprint'<>'null'::jsonb or v->'metricId'<>'null'::jsonb then return false; end if;
    else
      if v->>'year' is null or v->>'value' is null or not private.dw_text(v->'seriesId',1,500)
        or not private.dw_text(v->'metricId',1,500) or not private.dw_text(v->'seriesFingerprint',64,64)
        or v->>'seriesFingerprint'!~'^[a-f0-9]{64}$' then return false; end if;
    end if;
  end if;
  return true;
exception when data_exception then return false;
end $$;

create function private.dw_roadmap_validate_room(p_room uuid) returns void language plpgsql set search_path='' as $$
declare x record; s jsonb; p jsonb; point jsonb; base numeric; cnt integer; start_year integer; end_year integer; first_year integer; horizon integer; result_value numeric; mean_x numeric; mean_y numeric; slope numeric; intercept numeric; base_end numeric; base_first numeric;
begin
  -- References are always local and point to active records. An archive is a
  -- deliberate operation; dependencies cannot silently disappear.
  if exists(select 1 from private.dw_roadmap_items i where i.roadmap_id=p_room and i.status='active' and (
    (i.kind='activity' and (
      (i.data->>'objectiveId' is not null and not exists(select 1 from private.dw_roadmap_items pass,jsonb_array_elements(pass.data->'objectives') o
        where pass.roadmap_id=p_room and pass.kind='passport' and o->>'id'=i.data->>'objectiveId'))
      or exists(select 1 from jsonb_array_elements_text(i.data->'indicatorIds') j where not exists(
        select 1 from private.dw_roadmap_items t where t.roadmap_id=p_room and t.id::text=j and t.kind='indicator' and t.status='active'))
      or exists(select 1 from jsonb_array_elements(i.data->'dependencies') j where j->>'predecessorId'=i.id::text or not exists(
        select 1 from private.dw_roadmap_items t where t.roadmap_id=p_room and t.id::text=j->>'predecessorId' and t.kind='activity' and t.status='active'))))
    or (i.kind='indicator' and i.data->>'scenarioId' is not null and not exists(select 1 from private.dw_roadmap_items t
      where t.roadmap_id=p_room and t.id::text=i.data->>'scenarioId' and t.kind='scenario' and t.status='active'))
    or (i.kind='cost' and not exists(select 1 from private.dw_roadmap_items t where t.roadmap_id=p_room and t.id::text=i.data->>'activityId' and t.kind='activity' and t.status='active'))
    or (i.kind='funding' and not exists(select 1 from private.dw_roadmap_items t where t.roadmap_id=p_room and t.id::text=i.data->>'costLineId'
      and t.kind='cost' and t.status='active' and t.data->>'cashKind'='cash'))
  )) then perform private.dw_fail('ROADMAP_REFERENCE'); end if;
  if exists(
    with recursive edges as (
      select i.id a,(j->>'predecessorId')::uuid b from private.dw_roadmap_items i,jsonb_array_elements(i.data->'dependencies') j
        where i.roadmap_id=p_room and i.kind='activity' and i.status='active'
    ), reach(a,b) as (
      select a,b from edges union
      select r.a,e.b from reach r join edges e on e.a=r.b
    ) select 1 from reach where a=b
  ) then perform private.dw_fail('ROADMAP_CYCLE'); end if;
  if exists(select 1 from private.dw_roadmap_items c where c.roadmap_id=p_room and c.kind='cost' and c.status='active'
    and (select coalesce(sum((f.data->>'amountKopecks')::numeric),0) from private.dw_roadmap_items f
      where f.roadmap_id=p_room and f.kind='funding' and f.status='active' and f.data->>'costLineId'=c.id::text)>private.dw_roadmap_cost(c.data))
    then perform private.dw_fail('BUDGET_OVERALLOCATED'); end if;
  perform private.dw_roadmap_budget(p_room);
  if exists(select 1 from private.dw_roadmap_items i join private.dw_roadmap_items sc on sc.roadmap_id=i.roadmap_id and sc.id::text=i.data->>'scenarioId'
    join private.dw_roadmaps r on r.id=i.roadmap_id join private.dw_roadmap_series ser on ser.dataset_id=r.dataset_id and ser.id=sc.data->>'seriesId'
    where i.roadmap_id=p_room and i.kind='indicator' and i.status='active' and (
      i.data->>'semanticType'<>ser.material->>'semanticType' or i.data->>'valueDomain'<>ser.material->>'valueDomain'
      or (ser.material->>'unit'='persons' and lower(btrim(i.data->>'unit')) not in ('persons','человек','чел.'))))
    then perform private.dw_fail('SCENARIO_INDICATOR_MISMATCH'); end if;
  for x in select i.data from private.dw_roadmap_items i where i.roadmap_id=p_room and i.kind='scenario' and i.status='active' loop
    p:=x.data->'parameters';
    select ser.material into s from private.dw_roadmap_series ser join private.dw_roadmaps r on r.dataset_id=ser.dataset_id and r.territory_key=ser.territory_key
      where r.id=p_room and ser.id=x.data->>'seriesId' and ser.fingerprint=x.data->>'seriesFingerprint';
    if s is null or s->>'metricId'<>p->>'metricId' then perform private.dw_fail('SOURCE_MISMATCH'); end if;
    start_year:=(p->>'historyStartYear')::int; end_year:=(p->>'historyEndYear')::int;
    select pt into point from jsonb_array_elements(s->'points') pt
      where (pt->>'year')::int between start_year and end_year and pt->>'value' is not null order by (pt->>'year')::int desc limit 1;
    if point is null then perform private.dw_fail('SCENARIO_HISTORY'); end if;
    base:=(point->>'value')::numeric;
    select count(*),min((pt->>'year')::int) into cnt,first_year from jsonb_array_elements(s->'points') pt
      where (pt->>'year')::int between start_year and end_year and pt->>'value' is not null;
    end_year:=(point->>'year')::int; horizon:=(p->>'endYear')::int-end_year;
    if horizon<1 or horizon>30 then perform private.dw_fail('SCENARIO_HISTORY'); end if;
    if p->>'baselineMethod'='linear' and (cnt<5 or cnt<>end_year-first_year+1) then perform private.dw_fail('SCENARIO_HISTORY'); end if;
    base_end:=base; base_first:=base;
    if p->>'baselineMethod'='linear' then
      select avg((pt->>'year')::numeric-first_year),avg((pt->>'value')::numeric) into mean_x,mean_y
        from jsonb_array_elements(s->'points') pt where (pt->>'year')::int between first_year and end_year and pt->>'value' is not null;
      select sum(((pt->>'year')::numeric-first_year-mean_x)*((pt->>'value')::numeric-mean_y)) /
        sum(power((pt->>'year')::numeric-first_year-mean_x,2)) into slope
        from jsonb_array_elements(s->'points') pt where (pt->>'year')::int between first_year and end_year and pt->>'value' is not null;
      intercept:=mean_y-slope*mean_x;
      base_end:=intercept+slope*((p->>'endYear')::int-first_year); base_first:=intercept+slope*(end_year+1-first_year);
      if s->>'valueDomain'<>'signed' then base_end:=greatest(0,base_end); base_first:=greatest(0,base_first); end if;
    end if;
    if p->>'targetMode' in ('relative_end','annual_growth') and (s->>'valueDomain'='signed' or base<=0 or (p->>'targetMode'='relative_end' and least(base_first,base_end)<=0))
      then perform private.dw_fail('SCENARIO_DOMAIN'); end if;
    if p->>'targetMode'='percentage_points' and s->>'valueDomain'<>'percent' then perform private.dw_fail('SCENARIO_DOMAIN'); end if;
    if p->>'targetMode'='absolute_end' then result_value:=(p->>'targetValue')::numeric;
    elsif p->>'targetMode'='absolute_delta_end' then result_value:=base_end+(p->>'targetValue')::numeric;
    elsif p->>'targetMode'='relative_end' then result_value:=base_end*(1+(p->>'targetValue')::numeric/100);
    elsif p->>'targetMode'='annual_growth' then result_value:=base*power(1+(p->>'targetValue')::numeric/100,horizon);
    else result_value:=base_end+(p->>'targetValue')::numeric; end if;
    if abs(result_value)>1e15 or not private.dw_s5_domain(result_value,s->>'valueDomain') then perform private.dw_fail('SCENARIO_DOMAIN'); end if;
  end loop;
end $$;

create function private.dw_s5_item_limit(k text) returns integer language sql immutable set search_path='' as $$
  select case k when 'passport' then 1 when 'diagnosis' then 1 when 'monitoring' then 1 when 'activity' then 40
    when 'indicator' then 20 when 'scenario' then 20 when 'cost' then 100 when 'funding' then 200 when 'risk' then 30 when 'fact' then 20 else 0 end
$$;


create function private.dw_configure_roadmaps(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); st private.dw_roadmap_state%rowtype;
begin
  perform private.dw_roadmap_write_guard(p_session_id,null,true);
  if private.dw_begin_operation(p_operation_id,'roadmap.configure',v_payload) is not null then return private.dw_roadmaps_index(p_session_id); end if;
  if not private.dw_s4_required(p_input,array['expectedRevision','roomLevel']) or not private.dw_s4_integer(p_input->'expectedRevision',1)
    or coalesce(p_input->>'roomLevel','') not in ('municipality','region','federal') then perform private.dw_fail('INVALID_INPUT'); end if;
  select * into st from private.dw_roadmap_state where session_id=p_session_id;
  if st.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
  if exists(select 1 from private.dw_roadmaps where session_id=p_session_id) then perform private.dw_fail('ROADMAP_CONFIGURATION_LOCKED'); end if;
  update private.dw_roadmap_state set room_level=p_input->>'roomLevel',revision=revision+1 where session_id=p_session_id;
  perform private.dw_roadmap_touch(p_session_id,null,'roadmap.configured');
  perform private.dw_finish_operation(p_operation_id,'roadmap.configure',v_payload,'{}'::jsonb);
  return private.dw_roadmaps_index(p_session_id);
end $$;

create function private.dw_join_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
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
  if st.room_level<>'federal' and session_region is not null and t.region_id is distinct from session_region then perform private.dw_fail('TERRITORY_OUT_OF_SCOPE'); end if;
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

create function private.dw_save_roadmap_item(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); room_id uuid; item_id uuid; k text; existing private.dw_roadmap_items%rowtype;
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input,array['roadmapId','itemId','expectedRevision','kind','data','status'])
    or not private.dw_s4_uuid(p_input->'roadmapId') or not (p_input->'itemId'='null'::jsonb or private.dw_s4_uuid(p_input->'itemId'))
    or not private.dw_s4_integer(p_input->'expectedRevision') or coalesce(p_input->>'status','') not in ('active','archived')
    or not private.dw_s5_validate_data(p_input->>'kind',p_input->'data') then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid; item_id:=(p_input->>'itemId')::uuid; k:=p_input->>'kind';
  perform private.dw_roadmap_write_guard(p_session_id,room_id);
  if private.dw_begin_operation(p_operation_id,'roadmap.item',v_payload) is not null then return private.dw_roadmap_snapshot(p_session_id,room_id); end if;
  if item_id is null then
    if (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if k in ('passport','diagnosis','monitoring') then perform private.dw_fail('ROADMAP_SINGLETON'); end if;
    if k='fact' and p_input->'data'->>'sourceKind'='registry' then perform private.dw_fail('SOURCE_MISMATCH'); end if;
    if (select count(*) from private.dw_roadmap_items where roadmap_id=room_id and kind=k)>=private.dw_s5_item_limit(k) then perform private.dw_fail('ROADMAP_LIMIT'); end if;
    item_id:=gen_random_uuid();
    insert into private.dw_roadmap_items(id,session_id,roadmap_id,kind,data,status,created_by,updated_by)
      values(item_id,p_session_id,room_id,k,p_input->'data',p_input->>'status',auth.uid(),auth.uid());
  else
    select * into existing from private.dw_roadmap_items where roadmap_id=room_id and id=item_id;
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if existing.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if existing.kind<>k then perform private.dw_fail('INVALID_INPUT'); end if;
    if k in ('passport','diagnosis','monitoring') and p_input->>'status'<>'active' then perform private.dw_fail('ROADMAP_SINGLETON'); end if;
    if k='fact' and (existing.data->>'sourceKind'='registry' or p_input->'data'->>'sourceKind'='registry')
      and (existing.data-'interpretation')<>((p_input->'data')-'interpretation') then perform private.dw_fail('SOURCE_MISMATCH'); end if;
    update private.dw_roadmap_items set data=p_input->'data',status=p_input->>'status',revision=revision+1,updated_by=auth.uid(),updated_at=now() where id=item_id;
  end if;
  perform private.dw_roadmap_validate_room(room_id);
  perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.item_saved');
  perform private.dw_finish_operation(p_operation_id,'roadmap.item',v_payload,jsonb_build_object('id',item_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

create function private.dw_capture_roadmap_fact(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); room_id uuid; item_id uuid; s jsonb; pt jsonb; d jsonb; existing private.dw_roadmap_items%rowtype;
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input,array['roadmapId','itemId','expectedRevision','seriesId','expectedSeriesFingerprint','year','interpretation'])
    or not private.dw_s4_uuid(p_input->'roadmapId') or not (p_input->'itemId'='null'::jsonb or private.dw_s4_uuid(p_input->'itemId'))
    or not private.dw_s4_integer(p_input->'expectedRevision') or not private.dw_text(p_input->'seriesId',1,500)
    or not private.dw_text(p_input->'expectedSeriesFingerprint',64,64) or not private.dw_s5_year(p_input->'year')
    or not private.dw_text(p_input->'interpretation',0,4000) then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid; item_id:=(p_input->>'itemId')::uuid;
  perform private.dw_roadmap_write_guard(p_session_id,room_id);
  if private.dw_begin_operation(p_operation_id,'roadmap.fact',v_payload) is not null then return private.dw_roadmap_snapshot(p_session_id,room_id); end if;
  select ser.material into s from private.dw_roadmap_series ser join private.dw_roadmaps r on r.dataset_id=ser.dataset_id and r.territory_key=ser.territory_key
    where r.id=room_id and ser.id=p_input->>'seriesId' and ser.fingerprint=p_input->>'expectedSeriesFingerprint';
  if s is null then perform private.dw_fail('SOURCE_MISMATCH'); end if;
  select x into pt from jsonb_array_elements(s->'points') x where x->'year'=p_input->'year' and x->>'value' is not null;
  if pt is null then perform private.dw_fail('SOURCE_VALUE_MISSING'); end if;
  d:=jsonb_build_object('sourceKind','registry','title',s->'title','interpretation',p_input->'interpretation','year',pt->'year','value',pt->'value','unit',s->'unit',
    'sourceReference',s->>'sourceUrl','sourceDate',null,'seriesId',s->'id','seriesFingerprint',s->'fingerprint','metricId',s->'metricId');
  if item_id is null then
    if (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if (select count(*) from private.dw_roadmap_items where roadmap_id=room_id and kind='fact')>=20 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
    item_id:=gen_random_uuid();
    insert into private.dw_roadmap_items(id,session_id,roadmap_id,kind,data,created_by,updated_by) values(item_id,p_session_id,room_id,'fact',d,auth.uid(),auth.uid());
  else
    select * into existing from private.dw_roadmap_items where roadmap_id=room_id and id=item_id and kind='fact';
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if existing.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    update private.dw_roadmap_items set data=d,status='active',revision=revision+1,updated_by=auth.uid(),updated_at=now() where id=item_id;
  end if;
  perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.fact_captured');
  perform private.dw_finish_operation(p_operation_id,'roadmap.fact',v_payload,jsonb_build_object('id',item_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

create function private.dw_capture_roadmap_basis(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); room_id uuid; basis_id uuid; v_source_id uuid; v_material_id uuid;
  existing private.dw_roadmap_bases%rowtype; saved private.dw_roadmap_basis_materials%rowtype; material jsonb; fp text; rev bigint; v_source_kind text;
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input,array['roadmapId','basisId','expectedRevision','sourceKind','sourceId','expectedSourceRevision','rationale','status'])
    or not private.dw_s4_uuid(p_input->'roadmapId') or not (p_input->'basisId'='null'::jsonb or private.dw_s4_uuid(p_input->'basisId'))
    or not private.dw_s4_integer(p_input->'expectedRevision') or not private.dw_s4_integer(p_input->'expectedSourceRevision',1)
    or not private.dw_s4_uuid(p_input->'sourceId') or coalesce(p_input->>'sourceKind','') not in ('barrier','link','solution')
    or not private.dw_text(p_input->'rationale',0,4000) or coalesce(p_input->>'status','') not in ('active','archived') then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid; basis_id:=(p_input->>'basisId')::uuid; v_source_id:=(p_input->>'sourceId')::uuid; v_source_kind:=p_input->>'sourceKind';
  perform private.dw_roadmap_write_guard(p_session_id,room_id);
  if private.dw_begin_operation(p_operation_id,'roadmap.basis',v_payload) is not null then return private.dw_roadmap_snapshot(p_session_id,room_id); end if;
  if basis_id is null then
    if (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if (select count(*) from private.dw_roadmap_bases where roadmap_id=room_id)>=40 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
    if p_input->>'status'<>'active' then perform private.dw_fail('INVALID_INPUT'); end if;
  else
    select * into existing from private.dw_roadmap_bases where roadmap_id=room_id and id=basis_id;
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if existing.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    select * into saved from private.dw_roadmap_basis_materials where id=existing.material_id;
    if saved.source_kind<>v_source_kind or saved.source_id<>v_source_id then perform private.dw_fail('SOURCE_MISMATCH'); end if;
  end if;
  if p_input->>'status'='archived' then
    if saved.source_revision<>(p_input->>'expectedSourceRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    v_material_id:=saved.id;
  else
    material:=private.dw_roadmap_ground(p_session_id,v_source_kind,v_source_id);
    if material is null then perform private.dw_fail('NOT_FOUND'); end if;
    if v_source_kind='barrier' then select revision into rev from private.dw_barriers where id=v_source_id and session_id=p_session_id;
    else rev:=(material->'source'->>'revision')::bigint; end if;
    if rev<>(p_input->>'expectedSourceRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if material->'source'->>'status'<>'active' then perform private.dw_fail('SOURCE_ARCHIVED'); end if;
    if v_source_kind='link' and private.dw_roadmap_link_stale(p_session_id,v_source_id) then perform private.dw_fail('SOURCE_STALE'); end if;
    if v_source_kind='solution' and exists(select 1 from jsonb_array_elements(material->'source'->'barriers') b where b->>'status'<>'active') then perform private.dw_fail('SOURCE_STALE'); end if;
    fp:=encode(sha256(convert_to(material::text,'UTF8')),'hex');
    insert into private.dw_roadmap_basis_materials(session_id,source_kind,source_id,source_revision,fingerprint,material)
      values(p_session_id,v_source_kind,v_source_id,rev,fp,material) on conflict(session_id,source_kind,source_id,fingerprint) do nothing;
    select id into v_material_id from private.dw_roadmap_basis_materials m where m.session_id=p_session_id and m.source_kind=v_source_kind and m.source_id=v_source_id and m.fingerprint=fp;
  end if;
  if basis_id is null then
    basis_id:=gen_random_uuid();
    insert into private.dw_roadmap_bases(id,session_id,roadmap_id,material_id,rationale,status) values(basis_id,p_session_id,room_id,v_material_id,p_input->>'rationale',p_input->>'status');
  else
    update private.dw_roadmap_bases set material_id=v_material_id,rationale=p_input->>'rationale',status=p_input->>'status',revision=revision+1,updated_at=now() where id=basis_id;
  end if;
  perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.basis_captured');
  perform private.dw_finish_operation(p_operation_id,'roadmap.basis',v_payload,jsonb_build_object('id',basis_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;


create function private.dw_freeze_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); room_id uuid; r private.dw_roadmaps%rowtype;
  snapshot jsonb; material jsonb; evidence jsonb; n integer; version_id uuid:=gen_random_uuid(); fp text; bytes bigint;
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input,array['roadmapId','expectedRevision','title','kind']) or not private.dw_s4_uuid(p_input->'roadmapId')
    or not private.dw_s4_integer(p_input->'expectedRevision',1) or not private.dw_s4_text(p_input->'title',1,240)
    or coalesce(p_input->>'kind','') not in ('draft','submitted') then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid;
  perform private.dw_roadmap_write_guard(p_session_id,room_id);
  if private.dw_begin_operation(p_operation_id,'roadmap.freeze',v_payload) is not null then return private.dw_roadmap_snapshot(p_session_id,room_id); end if;
  select * into r from private.dw_roadmaps where id=room_id;
  if r.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
  select coalesce(max(number),0)+1 into n from private.dw_roadmap_versions where roadmap_id=room_id;
  if n>30 then perform private.dw_fail('ROADMAP_VERSION_LIMIT'); end if;
  perform private.dw_roadmap_validate_room(room_id);
  snapshot:=private.dw_roadmap_snapshot(p_session_id,room_id);
  select coalesce(jsonb_agg(e.material||jsonb_build_object('id',e.id,'sessionId',e.session_id,'fingerprint',e.fingerprint) order by e.id),'[]'::jsonb)
    into evidence from private.dw_barrier_evidence e where e.session_id=p_session_id and e.id in (
      select (b->'material'->'source'->>'evidenceId')::uuid from jsonb_array_elements(snapshot->'basis') b where b->>'sourceKind'='link');
  material:=jsonb_build_object('schemaVersion',1,'templateVersion','organizers-roadmap-1','calculationVersion','roadmap-analytics-1',
    'territory',snapshot->'territory','roomLevel',snapshot->'roomLevel','roadmapRevision',r.revision,
    'session',(select jsonb_build_object('title',title,'scope',scope,'regionId',region_id) from public.dw_sessions where id=p_session_id),
    'teamNames',(select coalesce(jsonb_agg(m->'fullName' order by m->>'fullName'),'[]'::jsonb) from jsonb_array_elements(snapshot->'members') m),
    'items',private.dw_roadmap_items_json(room_id,false),'basis',snapshot->'basis','series',snapshot->'series','evidence',evidence,'budget',snapshot->'budget');
  bytes:=octet_length(material::text);
  if bytes>8388608 or bytes+(select coalesce(sum(octet_length(v.material::text)),0) from private.dw_roadmap_versions v where v.roadmap_id=room_id)>134217728
    then perform private.dw_fail('ROADMAP_VERSION_LIMIT'); end if;
  fp:=encode(sha256(convert_to(material::text,'UTF8')),'hex');
  insert into private.dw_roadmap_versions(id,session_id,roadmap_id,number,kind,title,roadmap_revision,material,sha256)
    values(version_id,p_session_id,room_id,n,p_input->>'kind',btrim(p_input->>'title'),r.revision,material,fp);
  perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.frozen');
  perform private.dw_finish_operation(p_operation_id,'roadmap.freeze',v_payload,jsonb_build_object('id',version_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

create function private.dw_review_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); room_id uuid; v_version_id uuid; current_revision bigint;
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input,array['roadmapId','versionId','expectedRevision','decision','comment'])
    or not private.dw_s4_uuid(p_input->'roadmapId') or not private.dw_s4_uuid(p_input->'versionId') or not private.dw_s4_integer(p_input->'expectedRevision')
    or coalesce(p_input->>'decision','') not in ('revise','discussed') or not private.dw_s4_text(p_input->'comment',1,4000) then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid; v_version_id:=(p_input->>'versionId')::uuid;
  perform private.dw_roadmap_write_guard(p_session_id,room_id,true);
  if private.dw_begin_operation(p_operation_id,'roadmap.review',v_payload) is not null then return private.dw_roadmap_snapshot(p_session_id,room_id); end if;
  if not exists(select 1 from private.dw_roadmap_versions v where v.id=v_version_id and v.roadmap_id=room_id and v.session_id=p_session_id)
    then perform private.dw_fail('NOT_FOUND'); end if;
  select revision into current_revision from private.dw_roadmap_reviews v where v.version_id=v_version_id;
  if coalesce(current_revision,0)<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
  insert into private.dw_roadmap_reviews(version_id,decision,comment,reviewer_id) values(v_version_id,p_input->>'decision',btrim(p_input->>'comment'),auth.uid())
    on conflict on constraint dw_roadmap_reviews_pkey do update set decision=excluded.decision,comment=excluded.comment,revision=private.dw_roadmap_reviews.revision+1,reviewer_id=auth.uid(),reviewed_at=now();
  perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.reviewed');
  perform private.dw_finish_operation(p_operation_id,'roadmap.review',v_payload,jsonb_build_object('id',v_version_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

create function private.dw_roadmap_version(p_session_id uuid,p_roadmap_id uuid,p_version_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; begin
  perform private.dw_roadmap_read_guard(p_session_id);
  select summary||jsonb_build_object('sessionId',v.session_id,'roadmapId',v.roadmap_id,'canonicalJson',v.material::text,'snapshot',v.material) into result
    from private.dw_roadmap_versions v cross join lateral jsonb_array_elements(private.dw_roadmap_versions_json(p_roadmap_id)) summary
    where v.id=p_version_id and v.session_id=p_session_id and v.roadmap_id=p_roadmap_id and summary->>'id'=v.id::text;
  if result is null then perform private.dw_fail('NOT_FOUND'); end if;
  return result;
end $$;

create function private.dw_roadmaps_projector_snapshot(p_session_id uuid,p_roadmap_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r text; result jsonb; selected jsonb; begin
  r:=private.dw_roadmap_read_guard(p_session_id); if r<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if p_roadmap_id is not null then
    select jsonb_build_object('roadmapId',rm.id,'territory',rm.territory,'roomLevel',st.room_level,'revision',rm.revision,
      'items',private.dw_roadmap_items_json(rm.id,false),'basis',private.dw_roadmap_bases_json(p_session_id,rm.id),
      'series',private.dw_roadmap_series_json(rm.id),'budget',private.dw_roadmap_budget(rm.id)) into selected
      from private.dw_roadmaps rm join private.dw_roadmap_state st on st.session_id=rm.session_id where rm.id=p_roadmap_id and rm.session_id=p_session_id;
    if selected is null then perform private.dw_fail('NOT_FOUND'); end if;
  end if;
  select jsonb_build_object('sessionId',s.id,'title',s.title,'cursor',st.event_cursor,'sourceCursor',st.source_cursor,
    'rooms',private.dw_roadmap_rooms_json(p_session_id),'selected',selected) into result
    from public.dw_sessions s join private.dw_roadmap_state st on st.session_id=s.id where s.id=p_session_id;
  if octet_length(result::text)>1048576 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
  return result;
end $$;




-- Only these RPC handlers are callable. Helpers and private tables remain inaccessible.
create function public.dw_configure_roadmaps(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_configure_roadmaps(p_operation_id,p_session_id,p_input) $$;
create function public.dw_join_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_join_roadmap(p_operation_id,p_session_id,p_input) $$;
create function public.dw_save_roadmap_item(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_save_roadmap_item(p_operation_id,p_session_id,p_input) $$;
create function public.dw_capture_roadmap_fact(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_capture_roadmap_fact(p_operation_id,p_session_id,p_input) $$;
create function public.dw_capture_roadmap_basis(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_capture_roadmap_basis(p_operation_id,p_session_id,p_input) $$;
create function public.dw_freeze_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_freeze_roadmap(p_operation_id,p_session_id,p_input) $$;
create function public.dw_review_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_review_roadmap(p_operation_id,p_session_id,p_input) $$;
create function public.dw_roadmaps_index(p_session_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_roadmaps_index(p_session_id) $$;
create function public.dw_roadmaps_cursor(p_session_id uuid) returns bigint language sql security invoker set search_path='' as $$ select private.dw_roadmaps_cursor(p_session_id) $$;
create function public.dw_roadmap_snapshot(p_session_id uuid,p_roadmap_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_roadmap_snapshot(p_session_id,p_roadmap_id) $$;
create function public.dw_roadmap_version(p_session_id uuid,p_roadmap_id uuid,p_version_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_roadmap_version(p_session_id,p_roadmap_id,p_version_id) $$;
create function public.dw_roadmaps_projector_snapshot(p_session_id uuid,p_roadmap_id uuid default null) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_roadmaps_projector_snapshot(p_session_id,p_roadmap_id) $$;

do $$ declare r record; begin
  for r in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('private','public') and (p.proname like 'dw_roadmap%' or p.proname like 'dw_s5_%'
      or p.proname in ('dw_configure_roadmaps','dw_join_roadmap','dw_save_roadmap_item','dw_capture_roadmap_fact','dw_capture_roadmap_basis','dw_freeze_roadmap','dw_review_roadmap'))
  loop execute format('revoke all on function %I.%I(%s) from public,anon,authenticated',r.nspname,r.proname,r.args); end loop;
end $$;
grant execute on function private.dw_configure_roadmaps(uuid,uuid,jsonb), public.dw_configure_roadmaps(uuid,uuid,jsonb) to authenticated;
grant execute on function private.dw_join_roadmap(uuid,uuid,jsonb), public.dw_join_roadmap(uuid,uuid,jsonb) to authenticated;
grant execute on function private.dw_save_roadmap_item(uuid,uuid,jsonb), public.dw_save_roadmap_item(uuid,uuid,jsonb) to authenticated;
grant execute on function private.dw_capture_roadmap_fact(uuid,uuid,jsonb), public.dw_capture_roadmap_fact(uuid,uuid,jsonb) to authenticated;
grant execute on function private.dw_capture_roadmap_basis(uuid,uuid,jsonb), public.dw_capture_roadmap_basis(uuid,uuid,jsonb) to authenticated;
grant execute on function private.dw_freeze_roadmap(uuid,uuid,jsonb), public.dw_freeze_roadmap(uuid,uuid,jsonb) to authenticated;
grant execute on function private.dw_review_roadmap(uuid,uuid,jsonb), public.dw_review_roadmap(uuid,uuid,jsonb) to authenticated;
grant execute on function private.dw_roadmaps_index(uuid), public.dw_roadmaps_index(uuid) to authenticated;
grant execute on function private.dw_roadmaps_cursor(uuid), public.dw_roadmaps_cursor(uuid) to authenticated;
grant execute on function private.dw_roadmap_snapshot(uuid,uuid), public.dw_roadmap_snapshot(uuid,uuid) to authenticated;
grant execute on function private.dw_roadmap_version(uuid,uuid,uuid), public.dw_roadmap_version(uuid,uuid,uuid) to authenticated;
grant execute on function private.dw_roadmaps_projector_snapshot(uuid,uuid), public.dw_roadmaps_projector_snapshot(uuid,uuid) to authenticated;

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.dw_roadmap_events;
  end if;
end $$;
comment on table public.dw_roadmap_events is 'Payload-free invalidations only; active session membership required. Poll the cursor after reconnect.';
comment on table private.dw_roadmap_versions is 'Immutable JSONB bytes with SHA-256. Reviewer commentary is stored separately. Submitted means peer review, not official adoption.';
