/** Owner-side preparation. No public seed/reset endpoint, no credentials in the template. */
import { createHash } from 'node:crypto';

const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu;
export const EXAMPLE_TEACHER_NAME = 'Ситковский Арсений Михайлович';
export function buildSeedExampleSql(template, { mode = 'online', teacherId } = {}) {
  if (!['online', 'offline'].includes(mode) || (mode === 'offline' && !uuid.test(teacherId ?? '')))
    throw new Error('EXAMPLE_IDENTITY_MODE_INVALID');
  if (template.exampleLabel !== 'ПРИМЕР' || template.territory.key !== 'rudn-mun-72196-904'
      || !Array.isArray(template.items) || template.items.length < 10 || !Array.isArray(template.factCaptures))
    throw new Error('EXAMPLE_TEMPLATE_INVALID');
  const json = JSON.stringify(template);
  const tag = `$material_${createHash('sha256').update(json).digest('hex').slice(0, 16)}$`;
  if (json.includes(tag)) throw new Error('EXAMPLE_QUOTING_COLLISION');
  const identity = mode === 'online' ? `
  identity:=public.dw_identify('omnistat@yandex.ru','${EXAMPLE_TEACHER_NAME}')->'session';
  entry:=private.dw_entry_token(identity->>'access_token');
  teacher_id:=entry.actor_id;
  perform set_config('demography.entry_id',entry.id::text,true);
  perform set_config('demography.entry_hash',entry.token_hash,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher_id,'role','authenticated',
    'app_metadata',jsonb_build_object('provider','declared-email','email_verified',false))::text,true);`
    : `teacher_id:='${teacherId}'::uuid;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher_id,'role','authenticated',
    'app_metadata',jsonb_build_object('offline',true,'provider','offline'))::text,true);`;
  return `do $seed_example$
declare material jsonb:=${tag}${json}${tag}::jsonb; identity jsonb; entry private.dw_entry_sessions%rowtype;
  teacher_id uuid; session_id uuid; room_id uuid; current_snapshot jsonb; current_index jsonb;
  source_item jsonb; data jsonb; item_id uuid; expected bigint; reference_map jsonb:='{}'; old_ids uuid[];
  created_id uuid; field text; singleton boolean; p jsonb; saved_id uuid;
begin
  -- Repeating preparation cannot overwrite an existing example or any participant's work.
  if exists(select 1 from private.dw_roadmaps where example_label='ПРИМЕР') then return; end if;
  if exists(select 1 from private.dw_roadmaps) or exists(select 1 from public.dw_submissions)
    or exists(select 1 from private.dw_barriers) or exists(select 1 from private.dw_flipchart_notes)
    or exists(select 1 from private.dw_workspaces) or (select count(*) from public.dw_profiles)>1 then
    raise exception 'EXAMPLE_REQUIRES_PREPARED_EMPTY_WORKSPACE';
  end if;
  ${identity}
  perform set_config('request.jwt.claim.sub',teacher_id::text,true);
  if not exists(select 1 from private.facilitators where user_id=teacher_id and revoked_at is null) then
    raise exception 'EXAMPLE_TEACHER_REQUIRED';
  end if;
  current_snapshot:=public.dw_enter_workspace(gen_random_uuid());
  session_id:=(current_snapshot#>>'{session,id}')::uuid;
  current_snapshot:=public.dw_configure_workspace(gen_random_uuid(),session_id,(current_snapshot#>>'{session,revision}')::bigint,
    jsonb_build_object('title','Демографическая мастерская','scope','municipality','regionId','respublika-mordoviia'));
  current_index:=public.dw_roadmaps_index(session_id);
  current_snapshot:=public.dw_join_roadmap(gen_random_uuid(),session_id,jsonb_build_object(
    'territoryKey',material#>>'{territory,key}','dataEditionId',material->>'datasetId',
    'expectedAssignmentRevision',(current_index->>'assignmentRevision')::bigint));
  room_id:=(current_snapshot->>'roadmapId')::uuid;
  if (select territory from private.dw_roadmaps where id=room_id) is distinct from material->'territory' then
    raise exception 'EXAMPLE_CANONICAL_GEOGRAPHY_MISMATCH';
  end if;
  update private.dw_roadmaps set example_label='ПРИМЕР' where id=room_id;
  for source_item in select value from jsonb_array_elements(material->'items') loop
    data:=source_item->'data';
    if source_item->>'kind'='indicator' and data->>'scenarioId' is not null then
      if not(reference_map ? (data->>'scenarioId')) then raise exception 'EXAMPLE_SCENARIO_REFERENCE'; end if;
      data:=jsonb_set(data,'{scenarioId}',reference_map->(data->>'scenarioId'));
    elsif source_item->>'kind'='activity' then
      if exists(select 1 from jsonb_array_elements_text(data->'indicatorIds') x where not(reference_map ? x))
        or exists(select 1 from jsonb_array_elements(data->'dependencies') x where not(reference_map ? (x->>'predecessorId'))) then
        raise exception 'EXAMPLE_ACTIVITY_REFERENCE';
      end if;
      data:=jsonb_set(data,'{indicatorIds}',coalesce((select jsonb_agg(reference_map->x order by n)
        from jsonb_array_elements_text(data->'indicatorIds') with ordinality q(x,n)),'[]'::jsonb));
      data:=jsonb_set(data,'{dependencies}',coalesce((select jsonb_agg(x||jsonb_build_object('predecessorId',reference_map->(x->>'predecessorId')) order by n)
        from jsonb_array_elements(data->'dependencies') with ordinality q(x,n)),'[]'::jsonb));
    elsif source_item->>'kind' in ('cost','funding') then
      field:=case source_item->>'kind' when 'cost' then 'activityId' else 'costLineId' end;
      if not(reference_map ? (data->>field)) then raise exception 'EXAMPLE_BUDGET_REFERENCE'; end if;
      data:=jsonb_set(data,array[field],reference_map->(data->>field));
    end if;
    singleton:=source_item->>'kind' in ('passport','diagnosis','monitoring');
    item_id:=null; expected:=0;
    if singleton then
      select (i->>'id')::uuid,(i->>'revision')::bigint into item_id,expected
        from jsonb_array_elements(current_snapshot->'items') i where i->>'kind'=source_item->>'kind';
      if item_id is null then raise exception 'EXAMPLE_SINGLETON_MISSING'; end if;
    end if;
    select coalesce(array_agg((i->>'id')::uuid),'{}') into old_ids from jsonb_array_elements(current_snapshot->'items') i;
    current_snapshot:=public.dw_save_roadmap_item(gen_random_uuid(),session_id,jsonb_build_object(
      'roadmapId',room_id,'itemId',item_id,'expectedRevision',expected,'kind',source_item->>'kind','data',data,'status','active'));
    if singleton then created_id:=item_id;
    else select (i->>'id')::uuid into created_id from jsonb_array_elements(current_snapshot->'items') i
      where not((i->>'id')::uuid=any(old_ids));
    end if;
    if created_id is null then raise exception 'EXAMPLE_CREATED_ITEM_MISSING'; end if;
    reference_map:=reference_map||jsonb_build_object(source_item->>'id',created_id);
  end loop;
  for p in select value from jsonb_array_elements(material->'factCaptures') loop
    current_snapshot:=public.dw_capture_roadmap_fact(gen_random_uuid(),session_id,(p-'localId')||jsonb_build_object(
      'roadmapId',room_id,'itemId',null,'expectedRevision',0));
  end loop;
  current_snapshot:=public.dw_roadmap_cohort_save(gen_random_uuid(),session_id,jsonb_build_object(
    'roadmapId',room_id,'expectedRevision',0,'parameters',material->'cohortParameters'));
  current_snapshot:=public.dw_freeze_roadmap(gen_random_uuid(),session_id,jsonb_build_object(
    'roadmapId',room_id,'expectedRevision',(current_snapshot->>'revision')::bigint,
    'title','ПРИМЕР — полный учебный проект Саранска 2027–2029','kind','submitted'));
  if jsonb_array_length(current_snapshot->'items')<>jsonb_array_length(material->'items')+jsonb_array_length(material->'factCaptures')
    or jsonb_array_length(current_snapshot->'versions')<>1 then raise exception 'EXAMPLE_COMPLETENESS_CHECK'; end if;
  perform private.dw_roadmap_validate_room(room_id);
  if entry.id is not null then delete from private.dw_entry_sessions where id=entry.id; end if;
end
$seed_example$;`;
}
