-- Stage 6: participant supplied actuals, immutable revisions and source-preserving patches.
-- The four shipped migrations and sealed source datasets remain byte-for-byte unchanged.

create table private.dw_roadmap_statistical_revisions (
  session_id uuid not null, roadmap_id uuid not null, metric_id text not null,
  revision integer not null check(revision between 1 and 500),
  action text not null check(action in ('save','restore')),
  series_id text, material jsonb, canonical_text text, fingerprint text,
  source_reference text, source_date date, reason text not null check(char_length(btrim(reason)) between 1 and 4000),
  created_by uuid not null references public.dw_profiles(user_id),
  created_by_name text not null check(char_length(btrim(created_by_name)) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key(roadmap_id,metric_id,revision),
  foreign key(session_id,roadmap_id) references private.dw_roadmaps(session_id,id),
  check(metric_id in ('births_total','deaths_total','pop_mid','mig_in_total','mig_out_total','mig_net_total','natural_change')),
  check((action='save' and series_id is not null and material is not null and canonical_text is not null and fingerprint is not null
      and source_reference is not null and char_length(btrim(source_reference)) between 1 and 2000)
    or (action='restore' and material is null and canonical_text is null and fingerprint is null and source_reference is null and source_date is null)),
  check(material is null or (octet_length(material::text)<=262144
    and encode(sha256(convert_to(canonical_text,'UTF8')),'hex')=fingerprint
    and material->>'id'=series_id and material->>'metricId'=metric_id
    and material->>'fingerprint'=fingerprint and material->>'canonicalJson'=canonical_text
    and (material-'fingerprint'-'canonicalJson')=canonical_text::jsonb))
);
create unique index dw_statistics_series_identity on private.dw_roadmap_statistical_revisions(roadmap_id,series_id) where action='save';
create index dw_statistics_revision_actor on private.dw_roadmap_statistical_revisions(created_by);
create index dw_statistics_revision_session on private.dw_roadmap_statistical_revisions(session_id,roadmap_id);
create table private.dw_roadmap_statistics_heads (
  roadmap_id uuid not null, metric_id text not null, revision integer not null,
  mode text not null check(mode in ('team','imported')), series_id text,
  updated_at timestamptz not null default now(),
  primary key(roadmap_id,metric_id),
  foreign key(roadmap_id,metric_id,revision) references private.dw_roadmap_statistical_revisions(roadmap_id,metric_id,revision),
  check(mode='imported' or series_id is not null)
);
alter table private.dw_roadmap_statistical_revisions enable row level security;
alter table private.dw_roadmap_statistics_heads enable row level security;
revoke all on private.dw_roadmap_statistical_revisions,private.dw_roadmap_statistics_heads from public,anon,authenticated;

create function private.dw_s6_immutable() returns trigger language plpgsql set search_path='' as $$
begin perform private.dw_fail('STATISTICS_IMMUTABLE'); return old; end $$;
create trigger dw_statistics_revision_immutable before update or delete on private.dw_roadmap_statistical_revisions
  for each row execute function private.dw_s6_immutable();

create function private.dw_s6_metric(p_metric text) returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_metric in ('births_total','deaths_total','pop_mid','mig_in_total','mig_out_total','mig_net_total','natural_change'),false)
$$;
create function private.dw_s6_required_text(v jsonb,p_max integer) returns boolean language sql immutable set search_path='' as $$
  select private.dw_text(v,1,p_max) and char_length(btrim(v#>>'{}',
    U&'\0009\000A\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0
$$;
create function private.dw_s6_definition(p_metric text) returns jsonb language sql immutable set search_path='' as $$
  select case when private.dw_s6_metric(p_metric) then jsonb_build_object(
    'metricId',p_metric,'title',case p_metric when 'births_total' then 'Число родившихся' when 'deaths_total' then 'Число умерших'
      when 'pop_mid' then 'Среднегодовая численность населения' when 'mig_in_total' then 'Число прибывших'
      when 'mig_out_total' then 'Число выбывших' when 'mig_net_total' then 'Миграционный прирост' else 'Естественный прирост' end,
    'unit','persons','semanticType',case when p_metric='pop_mid' then 'stock' else 'flow' end,
    'valueDomain',case when p_metric in ('mig_net_total','natural_change') then 'signed' else 'nonnegative' end,
    'aggregation',case when p_metric='pop_mid' then 'none' else 'sum' end,'decimals',case when p_metric='pop_mid' then 6 else 0 end,
    'reference',case when p_metric='pop_mid' then 'annual_average' else 'calendar_year' end) else null end
$$;
create function private.dw_s6_value(p_metric text,v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare n numeric; begin
  if v='null'::jsonb then return true; end if;
  if not private.dw_s5_number(v) then return false; end if;
  n:=(v#>>'{}')::numeric;
  return (p_metric in ('mig_net_total','natural_change') or n>=0)
    and case when p_metric='pop_mid' then n=round(n,6) else n=trunc(n) end;
end $$;
create function private.dw_s6_base_series(p_room uuid,p_metric text) returns jsonb language sql stable set search_path='' as $$
  select s.material from private.dw_roadmap_series s join private.dw_roadmaps r on r.dataset_id=s.dataset_id and r.territory_key=s.territory_key
    where r.id=p_room and s.material->>'metricId'=p_metric order by s.id limit 1
$$;
create function private.dw_s6_resolve_series(p_room uuid,p_series text,p_fingerprint text default null) returns jsonb
language sql stable set search_path='' as $$
  select material from (
    select s.material,s.fingerprint from private.dw_roadmap_series s join private.dw_roadmaps r
      on r.dataset_id=s.dataset_id and r.territory_key=s.territory_key where r.id=p_room and s.id=p_series
    union all
    select s.material,s.fingerprint from private.dw_roadmap_statistical_revisions s
      where s.roadmap_id=p_room and s.series_id=p_series and s.action='save'
  ) resolved where p_fingerprint is null or fingerprint=p_fingerprint limit 1
$$;
create function private.dw_s6_heads_json(p_room uuid) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('metricId',h.metric_id,'revision',h.revision,'mode',h.mode,
    'seriesId',h.series_id,'updatedAt',h.updated_at) order by h.metric_id),'[]'::jsonb)
    from private.dw_roadmap_statistics_heads h where h.roadmap_id=p_room
$$;
create or replace function private.dw_roadmap_series_json(p_room uuid) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(material order by material->>'id'),'[]'::jsonb) from (
    select s.material from private.dw_roadmap_series s join private.dw_roadmaps r on r.dataset_id=s.dataset_id and r.territory_key=s.territory_key
    where r.id=p_room and (exists(select 1 from private.dw_roadmap_statistics_heads h where h.roadmap_id=p_room and h.metric_id=s.material->>'metricId')
      or exists(select 1 from private.dw_roadmap_items i where i.roadmap_id=p_room and i.kind in ('scenario','fact') and i.data->>'seriesId'=s.id))
    union all
    select s.material from private.dw_roadmap_statistical_revisions s where s.roadmap_id=p_room and s.action='save'
      and (exists(select 1 from private.dw_roadmap_statistics_heads h where h.roadmap_id=p_room and h.mode='team' and h.series_id=s.series_id)
        or exists(select 1 from private.dw_roadmap_items i where i.roadmap_id=p_room and i.kind in ('scenario','fact') and i.data->>'seriesId'=s.series_id))
  ) sources
$$;

create function private.dw_roadmap_statistics_save(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); room_id uuid; metric text; definition jsonb;
  head private.dw_roadmap_statistics_heads%rowtype; r private.dw_roadmaps%rowtype; base jsonb; old_series jsonb; overrides jsonb;
  points jsonb; x jsonb; y integer; n integer; series_id text; material jsonb; canonical text; fp text; captured timestamptz:=now();
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input,array['roadmapId','metricId','expectedRevision','changes','sourceReference','sourceDate','reason','comparabilityNote'])
    or not private.dw_s4_uuid(p_input->'roadmapId') or not private.dw_s6_metric(p_input->>'metricId')
    or not private.dw_s4_integer(p_input->'expectedRevision') or (p_input->>'expectedRevision')::numeric>500
    or not private.dw_s6_required_text(p_input->'sourceReference',2000) or not private.dw_s6_required_text(p_input->'reason',4000)
    or not private.dw_text(p_input->'comparabilityNote',0,4000) or not private.dw_s5_date(p_input->'sourceDate')
    or jsonb_typeof(p_input->'changes') is distinct from 'array' then perform private.dw_fail('INVALID_INPUT'); end if;
  if jsonb_array_length(p_input->'changes') not between 1 and 301 then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid; metric:=p_input->>'metricId'; definition:=private.dw_s6_definition(metric);
  for x in select j from jsonb_array_elements(p_input->'changes') j loop
    if x->>'action'='set' then
      if not private.dw_s4_required(x,array['year','action','value']) or not private.dw_s6_value(metric,x->'value') then perform private.dw_fail('INVALID_INPUT'); end if;
    elsif x->>'action'='reset' then
      if not private.dw_s4_required(x,array['year','action']) then perform private.dw_fail('INVALID_INPUT'); end if;
    else perform private.dw_fail('INVALID_INPUT'); end if;
    if not private.dw_s5_year(x->'year') then perform private.dw_fail('INVALID_INPUT'); end if;
    if (x->>'year')::int>extract(year from now() at time zone 'UTC')::int then perform private.dw_fail('STATISTICS_FUTURE_YEAR'); end if;
  end loop;
  if (select count(distinct (j->>'year')::int) from jsonb_array_elements(p_input->'changes') j)<>jsonb_array_length(p_input->'changes') then perform private.dw_fail('INVALID_INPUT'); end if;
  perform private.dw_roadmap_write_guard(p_session_id,room_id);
  if private.dw_begin_operation(p_operation_id,'roadmap.statistics.save',payload) is not null then return private.dw_roadmap_snapshot(p_session_id,room_id); end if;
  select * into r from private.dw_roadmaps where id=room_id;
  select * into head from private.dw_roadmap_statistics_heads where roadmap_id=room_id and metric_id=metric for update;
  if coalesce(head.revision,0)<>(p_input->>'expectedRevision')::int then perform private.dw_fail('REVISION_CONFLICT'); end if;
  n:=coalesce(head.revision,0)+1; if n>500 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
  base:=private.dw_s6_base_series(room_id,metric);
  if head.mode='team' then old_series:=private.dw_s6_resolve_series(room_id,head.series_id); end if;
  overrides:=coalesce(old_series->'overrides','[]'::jsonb);
  for x in select j from jsonb_array_elements(p_input->'changes') j loop
    y:=(x->>'year')::int;
    select coalesce(jsonb_agg(j order by (j->>'year')::int),'[]'::jsonb) into overrides from jsonb_array_elements(overrides) j where (j->>'year')::int<>y;
    if x->>'action'='set' then overrides:=overrides||jsonb_build_array(jsonb_build_object(
      'year',y,'value',x->'value','sourceReference',btrim(p_input->>'sourceReference'),'sourceDate',p_input->'sourceDate',
      'reason',btrim(p_input->>'reason'),'revision',n,'updatedAt',captured)); end if;
  end loop;
  select coalesce(jsonb_agg(j order by (j->>'year')::int),'[]'::jsonb) into overrides from jsonb_array_elements(overrides) j;
  select coalesce(jsonb_agg(pt order by (pt->>'year')::int),'[]'::jsonb) into points from (
    select j pt from jsonb_array_elements(coalesce(base->'points','[]'::jsonb)) j
      where not exists(select 1 from jsonb_array_elements(overrides) o where o->'year'=j->'year')
    union all select jsonb_build_object('year',j->'year','value',j->'value') from jsonb_array_elements(overrides) j
  ) merged;
  if jsonb_array_length(points)>301 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
  series_id:='team-statistics:'||room_id::text||':'||metric||':'||n::text;
  material:=definition||jsonb_build_object('id',series_id,'territoryKey',r.territory_key,'sourceEditionId','team-statistics-v1',
    'sourceKind','team_reported','provenanceStatus','participant_supplied','geographyEditionId',coalesce(base->>'geographyEditionId',
      (select metadata->'index'->>'geographyEditionId' from private.dw_roadmap_datasets where id=r.dataset_id),r.territory->>'boundaryVersion',r.dataset_id),
    'geographyComparability','not_verified','comparabilityNote',p_input->'comparabilityNote','baseSeries',base,
    'points',points,'overrides',overrides,'revision',n,'sourceReference',btrim(p_input->>'sourceReference'),
    'sourceDate',p_input->'sourceDate','reason',btrim(p_input->>'reason'),'recordedAt',captured);
  canonical:=material::text; fp:=encode(sha256(convert_to(canonical,'UTF8')),'hex');
  material:=material||jsonb_build_object('canonicalJson',canonical,'fingerprint',fp);
  if octet_length(material::text)>262144 or octet_length(material::text)+(select coalesce(sum(octet_length(s.material::text)),0)
    from private.dw_roadmap_statistical_revisions s where s.roadmap_id=room_id)>33554432 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
  insert into private.dw_roadmap_statistical_revisions(session_id,roadmap_id,metric_id,revision,action,series_id,material,canonical_text,fingerprint,
    source_reference,source_date,reason,created_by,created_by_name,created_at)
    values(p_session_id,room_id,metric,n,'save',series_id,material,canonical,fp,btrim(p_input->>'sourceReference'),(p_input->>'sourceDate')::date,
      btrim(p_input->>'reason'),auth.uid(),(select full_name from public.dw_profiles where user_id=auth.uid()),captured);
  insert into private.dw_roadmap_statistics_heads(roadmap_id,metric_id,revision,mode,series_id,updated_at) values(room_id,metric,n,'team',series_id,captured)
    on conflict on constraint dw_roadmap_statistics_heads_pkey do update set revision=excluded.revision,mode=excluded.mode,series_id=excluded.series_id,updated_at=excluded.updated_at;
  perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.statistics_saved');
  perform private.dw_finish_operation(p_operation_id,'roadmap.statistics.save',payload,jsonb_build_object('id',series_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

create function private.dw_roadmap_statistics_restore(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); room_id uuid; metric text;
  head private.dw_roadmap_statistics_heads%rowtype; base jsonb; n integer; captured timestamptz:=now();
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input,array['roadmapId','metricId','expectedRevision','reason'])
    or not private.dw_s4_uuid(p_input->'roadmapId') or not private.dw_s6_metric(p_input->>'metricId')
    or not private.dw_s4_integer(p_input->'expectedRevision') or (p_input->>'expectedRevision')::numeric>500
    or not private.dw_s6_required_text(p_input->'reason',4000) then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid; metric:=p_input->>'metricId';
  perform private.dw_roadmap_write_guard(p_session_id,room_id);
  if private.dw_begin_operation(p_operation_id,'roadmap.statistics.restore',payload) is not null then return private.dw_roadmap_snapshot(p_session_id,room_id); end if;
  select * into head from private.dw_roadmap_statistics_heads where roadmap_id=room_id and metric_id=metric for update;
  if coalesce(head.revision,0)<>(p_input->>'expectedRevision')::int then perform private.dw_fail('REVISION_CONFLICT'); end if;
  n:=coalesce(head.revision,0)+1; if n>500 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
  base:=private.dw_s6_base_series(room_id,metric);
  insert into private.dw_roadmap_statistical_revisions(session_id,roadmap_id,metric_id,revision,action,series_id,reason,created_by,created_by_name,created_at)
    values(p_session_id,room_id,metric,n,'restore',base->>'id',btrim(p_input->>'reason'),auth.uid(),
      (select full_name from public.dw_profiles where user_id=auth.uid()),captured);
  insert into private.dw_roadmap_statistics_heads(roadmap_id,metric_id,revision,mode,series_id,updated_at) values(room_id,metric,n,'imported',base->>'id',captured)
    on conflict on constraint dw_roadmap_statistics_heads_pkey do update set revision=excluded.revision,mode=excluded.mode,series_id=excluded.series_id,updated_at=excluded.updated_at;
  perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.statistics_restored');
  perform private.dw_finish_operation(p_operation_id,'roadmap.statistics.restore',payload,jsonb_build_object('revision',n));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

create function private.dw_roadmap_statistics_history(p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare room_id uuid; metric text; before_revision integer; current_revision integer; entries jsonb; next_revision integer; begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input-'beforeRevision',array['roadmapId','metricId'])
    or not private.dw_s4_uuid(p_input->'roadmapId') or not private.dw_s6_metric(p_input->>'metricId')
    or (p_input?'beforeRevision' and (not private.dw_s4_integer(p_input->'beforeRevision',1) or (p_input->>'beforeRevision')::numeric>500)) then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid; metric:=p_input->>'metricId'; before_revision:=coalesce((p_input->>'beforeRevision')::int,501);
  if not exists(select 1 from private.dw_roadmaps where id=room_id and session_id=p_session_id) then perform private.dw_fail('NOT_FOUND'); end if;
  select revision into current_revision from private.dw_roadmap_statistics_heads where roadmap_id=room_id and metric_id=metric;
  select coalesce(jsonb_agg(jsonb_build_object('revision',s.revision,'action',s.action,'seriesId',s.series_id,
    'createdAt',s.created_at,'createdBy',s.created_by,'createdByName',s.created_by_name,
    'sourceReference',s.source_reference,'sourceDate',s.source_date,'reason',s.reason) order by s.revision desc),'[]'::jsonb),min(s.revision)
    into entries,next_revision from (select * from private.dw_roadmap_statistical_revisions where roadmap_id=room_id and metric_id=metric and revision<before_revision order by revision desc limit 50) s;
  if not exists(select 1 from private.dw_roadmap_statistical_revisions where roadmap_id=room_id and metric_id=metric and revision<next_revision) then next_revision:=null; end if;
  return jsonb_build_object('roadmapId',room_id,'metricId',metric,'currentRevision',coalesce(current_revision,0),'entries',entries,'nextBeforeRevision',next_revision);
end $$;
create function private.dw_roadmap_statistics_series(p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare room_id uuid; result jsonb; begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input,array['roadmapId','seriesId']) or not private.dw_s4_uuid(p_input->'roadmapId')
    or not private.dw_text(p_input->'seriesId',1,500) then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid;
  select jsonb_build_object('sessionId',s.session_id,'roadmapId',s.roadmap_id,'series',s.material) into result
    from private.dw_roadmap_statistical_revisions s where s.session_id=p_session_id and s.roadmap_id=room_id
      and s.series_id=p_input->>'seriesId' and s.action='save';
  if result is null then perform private.dw_fail('NOT_FOUND'); end if;
  return result;
end $$;

-- Only guarded handlers are accessible through the existing authenticated RPC boundary.
create function public.dw_roadmap_statistics_save(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_roadmap_statistics_save(p_operation_id,p_session_id,p_input) $$;
create function public.dw_roadmap_statistics_restore(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_roadmap_statistics_restore(p_operation_id,p_session_id,p_input) $$;
create function public.dw_roadmap_statistics_history(p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_roadmap_statistics_history(p_session_id,p_input) $$;
create function public.dw_roadmap_statistics_series(p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_roadmap_statistics_series(p_session_id,p_input) $$;
do $$ declare f record; begin
  for f in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('private','public') and (p.proname like 'dw_s6_%' or p.proname like 'dw_roadmap_statistics_%')
  loop execute format('revoke all on function %I.%I(%s) from public,anon,authenticated',f.nspname,f.proname,f.args); end loop;
end $$;
grant execute on function private.dw_roadmap_statistics_save(uuid,uuid,jsonb),public.dw_roadmap_statistics_save(uuid,uuid,jsonb) to authenticated;
grant execute on function private.dw_roadmap_statistics_restore(uuid,uuid,jsonb),public.dw_roadmap_statistics_restore(uuid,uuid,jsonb) to authenticated;
grant execute on function private.dw_roadmap_statistics_history(uuid,jsonb),public.dw_roadmap_statistics_history(uuid,jsonb) to authenticated;
grant execute on function private.dw_roadmap_statistics_series(uuid,jsonb),public.dw_roadmap_statistics_series(uuid,jsonb) to authenticated;
comment on table private.dw_roadmap_statistical_revisions is 'Immutable participant-supplied actuals and explicit restores. Per-year provenance is retained; revisions do not rewrite prior facts, scenarios or frozen versions.';
comment on table private.dw_roadmap_statistics_heads is 'Sparse per-room metric heads with compare-and-swap revisions. Missing head means revision zero and imported source, if available.';


-- Replace live resolvers only; no previous stored material is migrated or rewritten.
create or replace function private.dw_roadmap_snapshot(p_session_id uuid,p_roadmap_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare role text; result jsonb; begin
  role:=private.dw_roadmap_read_guard(p_session_id);
  select jsonb_build_object('sessionId',r.session_id,'roadmapId',r.id,'cursor',st.event_cursor,'sourceCursor',st.source_cursor,'revision',r.revision,
    'territory',r.territory,'roomLevel',st.room_level,'canEdit',s.status='open' and (role='host' or (role='participant' and exists(
      select 1 from private.dw_roadmap_assignments a where a.session_id=p_session_id and a.user_id=auth.uid() and a.roadmap_id=r.id))),
    'members',(select coalesce(jsonb_agg(jsonb_build_object('userId',p.user_id,'fullName',p.full_name) order by p.full_name,p.user_id),'[]'::jsonb)
      from private.dw_roadmap_assignments a join public.dw_memberships m on m.session_id=a.session_id and m.user_id=a.user_id
      join public.dw_profiles p on p.user_id=a.user_id where a.roadmap_id=r.id and m.revoked_at is null and m.role in ('host','participant')),
    'items',private.dw_roadmap_items_json(r.id),'basis',private.dw_roadmap_bases_json(p_session_id,r.id),
    'series',private.dw_roadmap_series_json(r.id),'statistics',private.dw_s6_heads_json(r.id),'versions',private.dw_roadmap_versions_json(r.id),'budget',private.dw_roadmap_budget(r.id)) into result
    from private.dw_roadmaps r join private.dw_roadmap_state st on st.session_id=r.session_id join public.dw_sessions s on s.id=r.session_id
    where r.id=p_roadmap_id and r.session_id=p_session_id;
  if result is null then perform private.dw_fail('NOT_FOUND'); end if;
  if octet_length(result::text)>1048576 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
  return result;
end $$;

create or replace function private.dw_s5_validate_data(k text,v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
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
    if v->>'sourceKind' not in ('registry','team_statistics','external_unverified')
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

create or replace function private.dw_roadmap_validate_room(p_room uuid) returns void language plpgsql set search_path='' as $$
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
    cross join lateral (select private.dw_s6_resolve_series(p_room,sc.data->>'seriesId',sc.data->>'seriesFingerprint') material) ser
    where i.roadmap_id=p_room and i.kind='indicator' and i.status='active' and (
      i.data->>'semanticType'<>ser.material->>'semanticType' or i.data->>'valueDomain'<>ser.material->>'valueDomain'
      or (ser.material->>'unit'='persons' and lower(btrim(i.data->>'unit')) not in ('persons','человек','чел.'))))
    then perform private.dw_fail('SCENARIO_INDICATOR_MISMATCH'); end if;
  for x in select i.data from private.dw_roadmap_items i where i.roadmap_id=p_room and i.kind='scenario' and i.status='active' loop
    p:=x.data->'parameters';
    s:=private.dw_s6_resolve_series(p_room,x.data->>'seriesId',x.data->>'seriesFingerprint');
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

create or replace function private.dw_save_roadmap_item(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
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
    if k='fact' and p_input->'data'->>'sourceKind' in ('registry','team_statistics') then perform private.dw_fail('SOURCE_MISMATCH'); end if;
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
    if k='fact' and (existing.data->>'sourceKind' in ('registry','team_statistics') or p_input->'data'->>'sourceKind' in ('registry','team_statistics'))
      and (existing.data-'interpretation')<>((p_input->'data')-'interpretation') then perform private.dw_fail('SOURCE_MISMATCH'); end if;
    update private.dw_roadmap_items set data=p_input->'data',status=p_input->>'status',revision=revision+1,updated_by=auth.uid(),updated_at=now() where id=item_id;
  end if;
  perform private.dw_roadmap_validate_room(room_id);
  perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.item_saved');
  perform private.dw_finish_operation(p_operation_id,'roadmap.item',v_payload,jsonb_build_object('id',item_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

create or replace function private.dw_capture_roadmap_fact(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); room_id uuid; item_id uuid; s jsonb; pt jsonb; d jsonb; attribution jsonb; existing private.dw_roadmap_items%rowtype;
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
  s:=private.dw_s6_resolve_series(room_id,p_input->>'seriesId',p_input->>'expectedSeriesFingerprint');
  if s is null then perform private.dw_fail('SOURCE_MISMATCH'); end if;
  select x into pt from jsonb_array_elements(s->'points') x where x->'year'=p_input->'year' and x->>'value' is not null;
  if pt is null then perform private.dw_fail('SOURCE_VALUE_MISSING'); end if;
  if s->>'sourceKind'='team_reported' then
    select o into attribution from jsonb_array_elements(s->'overrides') o where o->'year'=p_input->'year';
  end if;
  d:=jsonb_build_object('sourceKind',case when s->>'sourceKind'='team_reported' then 'team_statistics' else 'registry' end,'title',s->'title','interpretation',p_input->'interpretation','year',pt->'year','value',pt->'value','unit',s->'unit',
    'sourceReference',case when s->>'sourceKind'='team_reported' then coalesce(attribution->>'sourceReference',s->'baseSeries'->>'sourceUrl') else s->>'sourceUrl' end,
    'sourceDate',case when s->>'sourceKind'='team_reported' then attribution->'sourceDate' else null end,'seriesId',s->'id','seriesFingerprint',s->'fingerprint','metricId',s->'metricId');
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

create or replace function private.dw_freeze_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
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
  material:=jsonb_build_object('schemaVersion',2,'templateVersion','organizers-roadmap-1','calculationVersion','roadmap-analytics-1',
    'territory',snapshot->'territory','roomLevel',snapshot->'roomLevel','roadmapRevision',r.revision,
    'session',(select jsonb_build_object('title',title,'scope',scope,'regionId',region_id) from public.dw_sessions where id=p_session_id),
    'teamNames',(select coalesce(jsonb_agg(m->'fullName' order by m->>'fullName'),'[]'::jsonb) from jsonb_array_elements(snapshot->'members') m),
    'items',private.dw_roadmap_items_json(room_id,false),'basis',snapshot->'basis','series',snapshot->'series','statistics',snapshot->'statistics','evidence',evidence,'budget',snapshot->'budget');
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

create or replace function private.dw_roadmaps_projector_snapshot(p_session_id uuid,p_roadmap_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r text; result jsonb; selected jsonb; begin
  r:=private.dw_roadmap_read_guard(p_session_id); if r<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
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
