-- The current print read and explicit checkpoints share one canonical material builder.
create function private.dw_roadmap_export_material(p_session uuid,p_room uuid) returns jsonb
language sql stable set search_path='' as $$
  with selected as materialized (
    select r.*,st.room_level,s.title,s.scope,s.region_id,private.dw_roadmap_bases_json(s.id,r.id) as report_basis
    from private.dw_roadmaps r join private.dw_roadmap_state st on st.session_id=r.session_id
    join public.dw_sessions s on s.id=r.session_id
    where r.id=p_room and r.session_id=p_session
  )
  select jsonb_build_object('schemaVersion',2,'templateVersion','organizers-roadmap-1','calculationVersion','roadmap-analytics-1',
    'territory',r.territory,'roomLevel',r.room_level,'roadmapRevision',r.revision,
    'session',jsonb_build_object('title',r.title,'scope',r.scope,'regionId',r.region_id),
    'teamNames',(select coalesce(jsonb_agg(p.full_name order by p.full_name),'[]'::jsonb)
      from private.dw_roadmap_assignments a join public.dw_memberships m on m.session_id=a.session_id and m.user_id=a.user_id
      join public.dw_profiles p on p.user_id=a.user_id
      where a.roadmap_id=r.id and m.revoked_at is null and m.role in ('host','participant')),
    'items',private.dw_roadmap_items_json(r.id,false),'basis',r.report_basis,
    'series',private.dw_roadmap_series_json(r.id),'statistics',private.dw_s6_heads_json(r.id),
    'evidence',(select coalesce(jsonb_agg(e.material||jsonb_build_object(
      'id',e.id,'sessionId',e.session_id,'fingerprint',e.fingerprint) order by e.id),'[]'::jsonb)
      from private.dw_barrier_evidence e where e.session_id=p_session and e.id in (
        select (b->'material'->'source'->>'evidenceId')::uuid from jsonb_array_elements(r.report_basis) b where b->>'sourceKind'='link')),
    'budget',private.dw_roadmap_budget(r.id))
    ||case when r.cohort_settings is null then '{}'::jsonb else jsonb_build_object('cohortSettings',r.cohort_settings) end
  from selected r
$$;
revoke all on function private.dw_roadmap_export_material(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.dw_freeze_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); room_id uuid; r private.dw_roadmaps%rowtype;
  material jsonb; n integer; version_id uuid:=gen_random_uuid(); fp text; bytes bigint;
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
  material:=private.dw_roadmap_export_material(p_session_id,room_id);
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

create or replace function private.dw_roadmap_version(p_session_id uuid,p_roadmap_id uuid,p_version_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; material jsonb; modified_at timestamptz; begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if p_version_id is null then
    -- The material and envelope timestamp use one statement snapshot.
    select private.dw_roadmap_export_material(r.session_id,r.id),r.updated_at
      into material,modified_at from private.dw_roadmaps r where r.id=p_roadmap_id and r.session_id=p_session_id;
    if material is null then perform private.dw_fail('NOT_FOUND'); end if;
    if octet_length(material::text)>8388608 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
    return jsonb_build_object('id',p_roadmap_id,'number',1,'kind','draft','title','Текущая дорожная карта',
      'roadmapRevision',material->'roadmapRevision','sha256',encode(sha256(convert_to(material::text,'UTF8')),'hex'),
      'createdAt',modified_at,'review',null,'sessionId',p_session_id,'roadmapId',p_roadmap_id,
      'canonicalJson',material::text,'snapshot',material);
  end if;
  select summary||jsonb_build_object('sessionId',v.session_id,'roadmapId',v.roadmap_id,'canonicalJson',v.material::text,'snapshot',v.material) into result
    from private.dw_roadmap_versions v cross join lateral jsonb_array_elements(private.dw_roadmap_versions_json(p_roadmap_id)) summary
    where v.id=p_version_id and v.session_id=p_session_id and v.roadmap_id=p_roadmap_id and summary->>'id'=v.id::text;
  if result is null then perform private.dw_fail('NOT_FOUND'); end if;
  return result;
end $$;
