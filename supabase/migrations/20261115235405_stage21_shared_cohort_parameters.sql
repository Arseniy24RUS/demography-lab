-- One versioned set of cohort parameters per team. Historical snapshots remain unchanged.
alter table private.dw_roadmaps add column cohort_settings jsonb;
comment on column private.dw_roadmaps.cohort_settings is
  'Shared cohort parameters and optimistic revision; null uses the published default. Copied into newly frozen versions.';

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
    'series',private.dw_roadmap_series_json(r.id),'statistics',private.dw_s6_heads_json(r.id),'versions',private.dw_roadmap_versions_json(r.id),'budget',private.dw_roadmap_budget(r.id))
    ||case when r.cohort_settings is null then '{}'::jsonb
      else jsonb_build_object('cohortSettings',r.cohort_settings) end into result
    from private.dw_roadmaps r join private.dw_roadmap_state st on st.session_id=r.session_id join public.dw_sessions s on s.id=r.session_id
    where r.id=p_roadmap_id and r.session_id=p_session_id;
  if result is null then perform private.dw_fail('NOT_FOUND'); end if;
  if octet_length(result::text)>1048576 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
  return result;
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
  if snapshot ? 'cohortSettings' then
    material:=material||jsonb_build_object('cohortSettings',snapshot->'cohortSettings');
  end if;
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

create function private.dw_roadmap_cohort_save(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  fields text[]:=array['fertilityMultiplier','mortalityMultiplier','arrivalsMultiplier','departuresMultiplier'];
  room_id uuid;
  source_key text;
  current_settings jsonb;
  options jsonb;
  expected bigint;
  field text;
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  options:=p_input->'parameters';
  if not private.dw_s4_required(p_input,array['roadmapId','expectedRevision','parameters'])
    or not private.dw_s4_uuid(p_input->'roadmapId') or not private.dw_s4_integer(p_input->'expectedRevision')
    or not private.dw_s4_required(options,array['endYear']||fields)
    or not private.dw_s4_integer(options->'endYear',2025) then
    perform private.dw_fail('INVALID_INPUT');
  end if;
  if (options->>'endYear')::numeric>2100 then perform private.dw_fail('INVALID_INPUT'); end if;
  foreach field in array fields loop
    if jsonb_typeof(options->field)<>'number' then perform private.dw_fail('INVALID_INPUT'); end if;
    if (options->>field)::numeric not between 0 and 3 then perform private.dw_fail('INVALID_INPUT'); end if;
  end loop;
  room_id:=(p_input->>'roadmapId')::uuid;
  expected:=(p_input->>'expectedRevision')::bigint;
  perform private.dw_roadmap_write_guard(p_session_id,room_id);
  if private.dw_begin_operation(p_operation_id,'roadmap.cohort.save',payload) is not null then
    return private.dw_roadmap_snapshot(p_session_id,room_id);
  end if;
  select r.territory->>'key',r.cohort_settings into source_key,current_settings
    from private.dw_roadmaps r where r.id=room_id and r.session_id=p_session_id for update;
  if source_key is null or (source_key<>'region:respublika-mordoviia' and source_key!~'^rudn-mun-72196-[0-9]+$') then
    perform private.dw_fail('SOURCE_MISMATCH');
  end if;
  if coalesce((current_settings->>'revision')::bigint,0)<>expected then
    perform private.dw_fail('REVISION_CONFLICT');
  end if;
  if (current_settings->'parameters') is distinct from options then
    update private.dw_roadmaps
      set cohort_settings=jsonb_build_object('revision',expected+1,'parameters',options)
      where id=room_id;
    perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.cohort_saved');
  end if;
  perform private.dw_finish_operation(p_operation_id,'roadmap.cohort.save',payload,jsonb_build_object('id',room_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

create function public.dw_roadmap_cohort_save(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.dw_roadmap_cohort_save(p_operation_id,p_session_id,p_input)
$$;
revoke all on function private.dw_roadmap_cohort_save(uuid,uuid,jsonb),
  public.dw_roadmap_cohort_save(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.dw_roadmap_cohort_save(uuid,uuid,jsonb),
  public.dw_roadmap_cohort_save(uuid,uuid,jsonb) to authenticated;

-- Keep the existing declared-email gateway and extend only its allowlist.
do $migration$
declare gateway text := pg_get_functiondef('private.dw_entry_rpc(text,text,jsonb)'::regprocedure);
  anchor constant text := '''dw_roadmap_statistics_save''';
begin
  if strpos(gateway,anchor)=0 then raise exception 'Expected entry RPC allowlist'; end if;
  execute replace(gateway,anchor,anchor||',''dw_roadmap_cohort_save''');
end
$migration$;
