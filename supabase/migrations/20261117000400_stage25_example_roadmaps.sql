-- A demonstration is a separate project over the exact canonical geography.
-- Normal teams retain one room per territory; a sample never occupies their room.
alter table private.dw_roadmaps add column example_label text
  check (example_label is null or char_length(btrim(example_label)) between 1 and 80);
alter table private.dw_roadmaps drop constraint dw_roadmaps_session_id_territory_key_key;
create unique index dw_roadmap_normal_territory on private.dw_roadmaps(session_id,territory_key)
  where example_label is null;
create unique index dw_roadmap_example_label on private.dw_roadmaps(session_id,example_label)
  where example_label is not null;

do $migration$
declare definition text; anchor text;
begin
  definition:=pg_get_functiondef('private.dw_s22_join_geographic_roadmap(uuid,uuid,jsonb)'::regprocedure);
  anchor:='where session_id=p_session_id and territory_key=t.territory_key;';
  if strpos(definition,anchor)=0 then raise exception 'Expected geographical join lookup'; end if;
  execute replace(definition,anchor,'where session_id=p_session_id and territory_key=t.territory_key and example_label is null;');

  definition:=pg_get_functiondef('private.dw_roadmap_write_guard(uuid,uuid,boolean)'::regprocedure);
  anchor:='if r<>''host'' and not exists(select 1 from private.dw_roadmap_assignments';
  if strpos(definition,anchor)=0 then raise exception 'Expected room membership write guard'; end if;
  execute replace(definition,anchor,
    'if r<>''host'' and exists(select 1 from private.dw_roadmaps where id=p_room and session_id=p_session and example_label is not null) then perform private.dw_fail(''FORBIDDEN''); end if;'||E'\n    '||anchor);

  definition:=pg_get_functiondef('private.dw_roadmap_rooms_json(uuid)'::regprocedure);
  anchor:='''updatedAt'',r.updated_at)';
  if strpos(definition,anchor)=0 then raise exception 'Expected room summary'; end if;
  execute replace(definition,anchor,anchor||'||case when r.example_label is null then ''{}''::jsonb else jsonb_build_object(''exampleLabel'',r.example_label) end');

  definition:=pg_get_functiondef('private.dw_roadmap_snapshot(uuid,uuid)'::regprocedure);
  anchor:='role=''participant'' and exists(';
  if strpos(definition,anchor)=0 then raise exception 'Expected snapshot edit permission'; end if;
  definition:=replace(definition,anchor,'role=''participant'' and r.example_label is null and exists(');
  anchor:='if result is null then perform private.dw_fail(''NOT_FOUND''); end if;';
  if strpos(definition,anchor)=0 then raise exception 'Expected snapshot lookup guard'; end if;
  execute replace(definition,anchor,anchor||E'\n  '||
    'result:=result||coalesce((select jsonb_build_object(''exampleLabel'',example_label) from private.dw_roadmaps where id=p_roadmap_id and session_id=p_session_id and example_label is not null),''{}''::jsonb);');

  definition:=pg_get_functiondef('private.dw_roadmap_export_material(uuid,uuid)'::regprocedure);
  anchor:='from selected r';
  if strpos(definition,anchor)=0 then raise exception 'Expected canonical export material'; end if;
  execute replace(definition,anchor,
    '||case when r.example_label is null then ''{}''::jsonb else jsonb_build_object(''exampleLabel'',r.example_label) end'||E'\n  '||anchor);

  definition:=pg_get_functiondef('private.dw_roadmaps_projector_snapshot(uuid,uuid)'::regprocedure);
  anchor:='if selected is null then perform private.dw_fail(''NOT_FOUND''); end if;';
  if strpos(definition,anchor)=0 then raise exception 'Expected projector room lookup'; end if;
  execute replace(definition,anchor,anchor||E'\n    '||
    'selected:=selected||coalesce((select jsonb_build_object(''exampleLabel'',example_label) from private.dw_roadmaps where id=p_roadmap_id and session_id=p_session_id and example_label is not null),''{}''::jsonb);');
end
$migration$;
