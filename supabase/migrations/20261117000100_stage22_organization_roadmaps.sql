-- Organization teams are workshop-owned rooms, never rows in the sealed geographic registry.
alter table private.dw_roadmaps alter column dataset_id drop not null;
alter table private.dw_roadmaps add constraint dw_roadmap_organization_dataset check (
  (dataset_id is null and coalesce(territory->>'level','')='organization')
  or (dataset_id is not null and coalesce(territory->>'level','')<>'organization')
);
alter table private.dw_roadmaps add constraint dw_roadmap_organization_identity check (
  coalesce(territory->>'level','')<>'organization' or coalesce((
    territory_key='organization:'||id::text and territory->>'key'=territory_key
    and territory->>'sourceEditionId'='custom-organization-v1'
    and territory->>'sourceType'='organization' and territory->>'geographicStatus'='not-geographic'
    and territory->>'sourceUrl'='urn:demography:organization:'||id::text
    and territory->'regionId'='null'::jsonb and territory->'sourceCode'='null'::jsonb
    and territory->'boundaryVersion'='null'::jsonb and cohort_settings is null
    and char_length(territory->>'name') between 1 and 200
  ),false)
);
create unique index dw_roadmap_organization_name on private.dw_roadmaps(session_id,lower(territory->>'name'))
  where territory->>'level'='organization';

-- The session write guard holds the session row lock before callers enter this helper.
create function private.dw_s22_assign_organization(p_session uuid,p_room uuid,p_expected bigint) returns void
language plpgsql set search_path='' as $$
declare previous_room uuid; current_revision bigint;
begin
  select roadmap_id,revision into previous_room,current_revision from private.dw_roadmap_assignments
    where session_id=p_session and user_id=auth.uid();
  if coalesce(current_revision,0)<>p_expected then perform private.dw_fail('REVISION_CONFLICT'); end if;
  insert into private.dw_roadmap_assignments(session_id,user_id,roadmap_id) values(p_session,auth.uid(),p_room)
    on conflict(session_id,user_id) do update set roadmap_id=excluded.roadmap_id,revision=private.dw_roadmap_assignments.revision+1;
  if previous_room is not null and previous_room<>p_room then
    perform private.dw_roadmap_touch(p_session,previous_room,'roadmap.member_left');
  end if;
  perform private.dw_roadmap_touch(p_session,p_room,'roadmap.joined');
end $$;
revoke all on function private.dw_s22_assign_organization(uuid,uuid,bigint) from public,anon,authenticated,service_role;

create function private.dw_create_organization_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  receipt jsonb; organization_name text; room_id uuid; kind text; data jsonb; current_revision bigint;
begin
  perform private.dw_roadmap_write_guard(p_session_id);
  receipt:=private.dw_begin_operation(p_operation_id,'roadmap.organization.create',payload);
  if receipt is not null then return private.dw_roadmap_snapshot(p_session_id,(receipt->>'id')::uuid); end if;
  if not private.dw_s4_required(p_input,array['name','expectedAssignmentRevision'])
    or jsonb_typeof(p_input->'name') is distinct from 'string'
    or not private.dw_s4_integer(p_input->'expectedAssignmentRevision') then perform private.dw_fail('INVALID_INPUT'); end if;
  organization_name:=p_input->>'name';
  if char_length(organization_name)>2000 or organization_name~'[\x01-\x08\x0E-\x1F\x7F]' then perform private.dw_fail('INVALID_INPUT'); end if;
  organization_name:=btrim(regexp_replace(normalize(organization_name,NFC),
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g'));
  if char_length(organization_name) not between 1 and 200 then perform private.dw_fail('INVALID_INPUT'); end if;
  select revision into current_revision from private.dw_roadmap_assignments where session_id=p_session_id and user_id=auth.uid();
  if coalesce(current_revision,0)<>(p_input->>'expectedAssignmentRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
  select id into room_id from private.dw_roadmaps where session_id=p_session_id
    and territory->>'level'='organization' and lower(territory->>'name')=lower(organization_name);
  if room_id is null then
    if (select count(*) from private.dw_roadmaps where session_id=p_session_id)>=1000 then perform private.dw_fail('ROADMAP_LIMIT'); end if;
    room_id:=gen_random_uuid();
    insert into private.dw_roadmaps(id,session_id,dataset_id,territory_key,territory) values(
      room_id,p_session_id,null,'organization:'||room_id::text,jsonb_build_object(
        'key','organization:'||room_id::text,'name',organization_name,'level','organization','regionId',null,
        'sourceEditionId','custom-organization-v1','sourceCode',null,'sourceType','organization',
        'geographicStatus','not-geographic','sourceUrl','urn:demography:organization:'||room_id::text,'boundaryVersion',null));
    foreach kind in array array['passport','diagnosis','monitoring'] loop
      data:=case kind when 'passport' then jsonb_build_object('title','','targetGroup','','partners','','goal','','objectives','[]'::jsonb,
        'startDate',null,'endDate',null,'expectedResult','','defenseDate',null,'humanResources','','materialResources','','informationResources','')
        when 'diagnosis' then jsonb_build_object('problem','','causeHypothesis','','conclusion','')
        else jsonb_build_object('frequency','','method','','responsible','','interimReportDate',null,'finalReportDate',null,
          'qualitativeResults','','sustainability','') end;
      insert into private.dw_roadmap_items(session_id,roadmap_id,kind,data,created_by,updated_by)
        values(p_session_id,room_id,kind,data,auth.uid(),auth.uid());
    end loop;
  end if;
  perform private.dw_s22_assign_organization(p_session_id,room_id,(p_input->>'expectedAssignmentRevision')::bigint);
  perform private.dw_finish_operation(p_operation_id,'roadmap.organization.create',payload,jsonb_build_object('id',room_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;
create function public.dw_create_organization_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$
  select private.dw_create_organization_roadmap(p_operation_id,p_session_id,p_input)
$$;
revoke all on function private.dw_create_organization_roadmap(uuid,uuid,jsonb),public.dw_create_organization_roadmap(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function private.dw_create_organization_roadmap(uuid,uuid,jsonb),public.dw_create_organization_roadmap(uuid,uuid,jsonb)
  to authenticated;

-- Retain the geographical join handler, including its sealed dataset and scope checks.
do $migration$
declare definition text:=pg_get_functiondef('private.dw_join_roadmap(uuid,uuid,jsonb)'::regprocedure);
begin
  if strpos(definition,'FUNCTION private.dw_join_roadmap(')=0 then raise exception 'Expected geographic join handler'; end if;
  execute replace(definition,'FUNCTION private.dw_join_roadmap(','FUNCTION private.dw_s22_join_geographic_roadmap(');
end
$migration$;
revoke all on function private.dw_s22_join_geographic_roadmap(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create or replace function private.dw_join_roadmap(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input); receipt jsonb; room_id uuid;
begin
  if not coalesce(p_input ? 'roadmapId',false) then
    return private.dw_s22_join_geographic_roadmap(p_operation_id,p_session_id,p_input);
  end if;
  perform private.dw_roadmap_write_guard(p_session_id);
  receipt:=private.dw_begin_operation(p_operation_id,'roadmap.join',payload);
  if receipt is not null then return private.dw_roadmap_snapshot(p_session_id,(receipt->>'id')::uuid); end if;
  if not private.dw_s4_required(p_input,array['roadmapId','expectedAssignmentRevision'])
    or not private.dw_s4_uuid(p_input->'roadmapId')
    or not private.dw_s4_integer(p_input->'expectedAssignmentRevision') then perform private.dw_fail('INVALID_INPUT'); end if;
  room_id:=(p_input->>'roadmapId')::uuid;
  if not exists(select 1 from private.dw_roadmaps where id=room_id and session_id=p_session_id
    and territory->>'level'='organization') then perform private.dw_fail('NOT_FOUND'); end if;
  perform private.dw_s22_assign_organization(p_session_id,room_id,(p_input->>'expectedAssignmentRevision')::bigint);
  perform private.dw_finish_operation(p_operation_id,'roadmap.join',payload,jsonb_build_object('id',room_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

-- Statistics and demographic forecasts require a geographical room. These checks
-- run after the existing membership/room write guard and before receipt replay.
create function private.dw_s22_require_geographic_room(p_room uuid) returns void language plpgsql set search_path='' as $$
begin
  if exists(select 1 from private.dw_roadmaps where id=p_room and territory->>'level'='organization') then
    perform private.dw_fail('ORGANIZATION_STATISTICS_UNAVAILABLE');
  end if;
end $$;
revoke all on function private.dw_s22_require_geographic_room(uuid) from public,anon,authenticated,service_role;
do $migration$
declare handler text; definition text;
  anchor constant text:='perform private.dw_roadmap_write_guard(p_session_id,room_id);';
begin
  foreach handler in array array['dw_roadmap_statistics_save','dw_roadmap_statistics_restore','dw_capture_roadmap_fact','dw_roadmap_cohort_save'] loop
    definition:=pg_get_functiondef(('private.'||handler||'(uuid,uuid,jsonb)')::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Expected roadmap write guard in %',handler; end if;
    execute replace(definition,anchor,anchor||E'\n  perform private.dw_s22_require_geographic_room(room_id);');
  end loop;
  definition:=pg_get_functiondef('private.dw_save_roadmap_item(uuid,uuid,jsonb)'::regprocedure);
  if strpos(definition,anchor)=0 then raise exception 'Expected item write guard'; end if;
  execute replace(definition,anchor,anchor||E'\n  if k=''scenario'' or (k=''fact'' and p_input->''data''->>''sourceKind''<>''external_unverified'') then\n    perform private.dw_s22_require_geographic_room(room_id);\n  end if;');
end
$migration$;

-- Every current serializer emits the room's own kind; global session/configuration
-- scopes remain geographical. Existing frozen bytes and their hashes are untouched.
do $migration$
declare definition text; handler text; alias text; signature text;
begin
  foreach handler in array array['dw_roadmap_snapshot','dw_roadmaps_projector_snapshot','dw_roadmap_export_material'] loop
    alias:=case when handler='dw_roadmaps_projector_snapshot' then 'rm' else 'r' end;
    signature:='private.'||handler||'(uuid,uuid)';
    definition:=pg_get_functiondef(signature::regprocedure);
    if strpos(definition,'''roomLevel'',st.room_level')>0 then
      definition:=replace(definition,'''roomLevel'',st.room_level','''roomLevel'',case when '||alias||'.territory->>''level''=''organization'' then ''organization'' else st.room_level end');
    elsif strpos(definition,'''roomLevel'',r.room_level')>0 then
      definition:=replace(definition,'''roomLevel'',r.room_level','''roomLevel'',case when r.territory->>''level''=''organization'' then ''organization'' else r.room_level end');
    else raise exception 'Expected room level in %',handler;
    end if;
    execute definition;
  end loop;
end
$migration$;

-- Extend the existing gateway without changing its role or token policy.
do $migration$
declare gateway text:=pg_get_functiondef('private.dw_entry_rpc(text,text,jsonb)'::regprocedure);
  anchor constant text:='''dw_join_roadmap''';
begin
  if strpos(gateway,anchor)=0 then raise exception 'Expected entry RPC allowlist'; end if;
  execute replace(gateway,anchor,anchor||',''dw_create_organization_roadmap''');
end
$migration$;
