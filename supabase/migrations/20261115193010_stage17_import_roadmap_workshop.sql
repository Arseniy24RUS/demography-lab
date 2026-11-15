alter table private.dw_roadmap_bases add column copied_at timestamptz;
alter table private.dw_roadmap_basis_materials
  drop constraint dw_roadmap_basis_materials_source_kind_check,
  add constraint dw_roadmap_basis_materials_source_kind_check
    check(source_kind in ('barrier','link','solution','factor'));

create table private.dw_roadmap_workshop_imports (
  session_id uuid not null,
  roadmap_id uuid not null,
  source_kind text not null check(source_kind in ('barrier','family','solution','factor')),
  source_id uuid not null,
  primary key(roadmap_id,source_kind,source_id),
  foreign key(session_id,roadmap_id) references private.dw_roadmaps(session_id,id)
);
alter table private.dw_roadmap_workshop_imports enable row level security;
revoke all on private.dw_roadmap_workshop_imports from public,anon,authenticated,service_role;

-- Use the same immutable source material as dw_capture_roadmap_basis.
create function private.dw_roadmap_import_basis(p_session uuid,p_room uuid,p_kind text,p_id uuid)
returns boolean language plpgsql set search_path='' as $$
declare d jsonb; fp text; source_rev bigint; v_material_id uuid;
begin
  if exists(select 1 from private.dw_roadmap_bases b
    join private.dw_roadmap_basis_materials m on m.id=b.material_id
    where b.roadmap_id=p_room and b.status='active' and b.copied_at is not null
      and m.source_kind=p_kind and m.source_id=p_id) then
    return false;
  end if;
  d:=private.dw_roadmap_ground(p_session,p_kind,p_id);
  if d is null or d->'source'->>'status'<>'active' then perform private.dw_fail('SOURCE_STALE'); end if;
  if p_kind='barrier' then
    select b.revision into source_rev from private.dw_barriers b where b.session_id=p_session and b.id=p_id;
  else
    source_rev:=(d->'source'->>'revision')::bigint;
  end if;
  fp:=encode(sha256(convert_to(d::text,'UTF8')),'hex');
  insert into private.dw_roadmap_basis_materials(session_id,source_kind,source_id,source_revision,fingerprint,material)
    values(p_session,p_kind,p_id,source_rev,fp,d)
    on conflict(session_id,source_kind,source_id,fingerprint) do nothing;
  select m.id into v_material_id from private.dw_roadmap_basis_materials m
    where m.session_id=p_session and m.source_kind=p_kind and m.source_id=p_id and m.fingerprint=fp;
  update private.dw_roadmap_bases set copied_at=now(),updated_at=now(),revision=revision+1
    where roadmap_id=p_room and material_id=v_material_id and status='active';
  if found then return true; end if;
  if (select count(*) from private.dw_roadmap_bases where roadmap_id=p_room)>=40 then
    perform private.dw_fail('ROADMAP_LIMIT');
  end if;
  insert into private.dw_roadmap_bases(session_id,roadmap_id,material_id,rationale,status,copied_at)
    values(p_session,p_room,v_material_id,'','active',now());
  return true;
end $$;
revoke all on function private.dw_roadmap_import_basis(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;

create function private.dw_import_roadmap_workshop(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  room_id uuid;
  selected_barriers uuid[];
  v_source_id uuid;
  barrier private.dw_barriers%rowtype;
  diagnosis private.dw_roadmap_items%rowtype;
  selected_measure jsonb;
  measure_kind text;
  original jsonb;
  related record;
  copied boolean;
  changed boolean:=false;
  problem_additions text[]:=array[]::text[];
  activity_data jsonb;
begin
  perform private.dw_roadmap_read_guard(p_session_id);
  if not private.dw_s4_required(p_input,array['roadmapId','barrierIds','measures'])
      or not private.dw_s4_uuid(p_input->'roadmapId')
      or not private.dw_s5_ids(p_input->'barrierIds',40)
      or jsonb_array_length(p_input->'barrierIds')=0
      or jsonb_typeof(p_input->'measures') is distinct from 'array'
      or jsonb_array_length(p_input->'measures')>40 then perform private.dw_fail('INVALID_INPUT'); end if;
  for selected_measure in select value from jsonb_array_elements(p_input->'measures') loop
    if not private.dw_s4_required(selected_measure,array['kind','id'])
      or not private.dw_s4_uuid(selected_measure->'id')
      or coalesce(selected_measure->>'kind','') not in ('family','factor','solution') then
      perform private.dw_fail('INVALID_INPUT');
    end if;
  end loop;
  if (select count(*)<>count(distinct value) from jsonb_array_elements(p_input->'measures')) then
    perform private.dw_fail('INVALID_INPUT');
  end if;
  room_id:=(p_input->>'roadmapId')::uuid;
  perform private.dw_roadmap_write_guard(p_session_id,room_id);
  if private.dw_begin_operation(p_operation_id,'roadmap.workshop_import',payload) is not null then
    return private.dw_roadmap_snapshot(p_session_id,room_id);
  end if;
  select array_agg(value::uuid order by ordinal) into selected_barriers
    from jsonb_array_elements_text(p_input->'barrierIds') with ordinality as xs(value,ordinal);
  foreach v_source_id in array selected_barriers loop
    if exists(select 1 from private.dw_roadmap_workshop_imports i
      where i.roadmap_id=room_id and i.source_kind='barrier' and i.source_id=v_source_id) then
      continue;
    end if;
    select * into barrier from private.dw_barriers b
      where b.session_id=p_session_id and b.id=v_source_id and b.status='active';
    if not found then perform private.dw_fail('SOURCE_STALE'); end if;
    perform private.dw_roadmap_import_basis(p_session_id,room_id,'barrier',v_source_id);
    insert into private.dw_roadmap_workshop_imports(session_id,roadmap_id,source_kind,source_id)
      values(p_session_id,room_id,'barrier',v_source_id);
    problem_additions:=array_append(problem_additions,concat_ws(E'\n',barrier.title,nullif(barrier.description,'')));
    changed:=true;
  end loop;
  if cardinality(problem_additions)>0 then
    select * into strict diagnosis from private.dw_roadmap_items i where i.roadmap_id=room_id and i.kind='diagnosis';
    diagnosis.data:=jsonb_set(diagnosis.data,'{problem}',to_jsonb(concat_ws(E'\n\n',
      nullif(diagnosis.data->>'problem',''),array_to_string(problem_additions,E'\n\n'))));
    if not private.dw_s5_validate_data('diagnosis',diagnosis.data) then perform private.dw_fail('ROADMAP_LIMIT'); end if;
    update private.dw_roadmap_items set data=diagnosis.data,revision=revision+1,updated_by=auth.uid(),updated_at=now()
      where id=diagnosis.id;
  end if;
  for selected_measure in select value from jsonb_array_elements(p_input->'measures') loop
    measure_kind:=selected_measure->>'kind';
    v_source_id:=(selected_measure->>'id')::uuid;
    original:=null;
    select exists(select 1 from private.dw_roadmap_workshop_imports i
      where i.roadmap_id=room_id and i.source_kind=measure_kind and i.source_id=v_source_id) into copied;
    if measure_kind='family' then
      for related in
        select l.id,e.material from private.dw_barrier_links l
        join private.dw_barrier_evidence e on e.id=l.evidence_id and e.session_id=l.session_id
        where l.session_id=p_session_id and l.family_id=v_source_id and l.barrier_id=any(selected_barriers)
          and l.status='active' and not private.dw_roadmap_link_stale(p_session_id,l.id)
        order by l.created_at,l.id
      loop
        original:=coalesce(original,related.material);
        if private.dw_roadmap_import_basis(p_session_id,room_id,'link',related.id) then changed:=true; end if;
      end loop;
    elsif measure_kind='solution' then
      select private.dw_roadmap_ground(p_session_id,'solution',s.id)->'source' into original
        from private.dw_solutions s
        where s.session_id=p_session_id and s.id=v_source_id and s.status='active' and exists(
          select 1 from private.dw_barriers b where b.session_id=p_session_id and b.status='active'
          and b.id=any(s.barrier_ids) and b.id=any(selected_barriers));
      if original is not null and not copied then
        perform private.dw_roadmap_import_basis(p_session_id,room_id,'solution',v_source_id);
      end if;
    else
      select private.dw_roadmap_ground(p_session_id,'factor',n.id)->'source' into original
        from private.dw_flipchart_notes n
        where n.session_id=p_session_id and n.id=v_source_id and n.kind='condition' and n.status='active' and exists(
          select 1 from private.dw_green_factor_links l join private.dw_barriers b
            on b.session_id=l.session_id and b.id=l.barrier_id
          where l.session_id=n.session_id and l.note_id=n.id and l.barrier_id=any(selected_barriers) and b.status='active');
      if original is not null and not copied then
        perform private.dw_roadmap_import_basis(p_session_id,room_id,'factor',v_source_id);
      end if;
    end if;
    if copied then continue; end if;
    if original is null then perform private.dw_fail('SOURCE_STALE'); end if;
    if (select count(*) from private.dw_roadmap_items i where i.roadmap_id=room_id and i.kind='activity')>=private.dw_s5_item_limit('activity') then
      perform private.dw_fail('ROADMAP_LIMIT');
    end if;
    activity_data:=jsonb_build_object(
      'title',left(original->>'title',240),'description',coalesce(original->>'mechanism',''),
      'objectiveId',null,'targetGroup',coalesce(original->>'targetGroup',''),'scale','','startDate',null,'endDate',null,
      'responsible',left(coalesce(original->>'responsible',''),1000),'partners','',
      'deliverable',coalesce(original->>'firstStep',''),'completionCriterion',coalesce(original->>'successIndicator',''),
      'authorityLevel','unknown','legalBasis','','approvalStatus','unknown','responsibleBody','','necessaryDecision','',
      'indicatorIds','[]'::jsonb,'dependencies','[]'::jsonb,'stage','implementation','stageLabel','','progressStatus','planned');
    if not private.dw_s5_validate_data('activity',activity_data) then perform private.dw_fail('INVALID_INPUT'); end if;
    insert into private.dw_roadmap_items(session_id,roadmap_id,kind,data,created_by,updated_by)
      values(p_session_id,room_id,'activity',activity_data,auth.uid(),auth.uid());
    insert into private.dw_roadmap_workshop_imports(session_id,roadmap_id,source_kind,source_id)
      values(p_session_id,room_id,measure_kind,v_source_id);
    changed:=true;
  end loop;
  if changed then
    perform private.dw_roadmap_validate_room(room_id);
    perform private.dw_roadmap_touch(p_session_id,room_id,'roadmap.workshop_imported');
  end if;
  perform private.dw_finish_operation(p_operation_id,'roadmap.workshop_import',payload,jsonb_build_object('id',room_id));
  return private.dw_roadmap_snapshot(p_session_id,room_id);
end $$;

create function public.dw_import_roadmap_workshop(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select private.dw_import_roadmap_workshop(p_operation_id,p_session_id,p_input) $$;
revoke all on function public.dw_import_roadmap_workshop(uuid,uuid,jsonb),private.dw_import_roadmap_workshop(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.dw_import_roadmap_workshop(uuid,uuid,jsonb),private.dw_import_roadmap_workshop(uuid,uuid,jsonb) to authenticated;

create or replace function private.dw_roadmap_ground(p_session uuid,p_kind text,p_id uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare d jsonb;
begin
  if p_kind='barrier' then d:=private.dw_roadmap_barrier_ground(p_session,p_id);
  elsif p_kind='solution' then
    select jsonb_build_object('id',s.id,'title',s.title,'targetGroup',s.target_group,'mechanism',s.mechanism,'firstStep',s.first_step,
      'responsible',s.responsible,'resources',s.resources,'successIndicator',s.success_indicator,'risks',s.risks,'revision',s.revision,'status',s.status,
      'barriers',coalesce((select jsonb_agg(private.dw_roadmap_barrier_ground(p_session,x) order by x) from unnest(s.barrier_ids) x),'[]'::jsonb)) into d
      from private.dw_solutions s where s.session_id=p_session and s.id=p_id;
  elsif p_kind='link' then
    select jsonb_build_object('id',l.id,'relationship',l.relationship,'explanation',l.explanation,'prerequisites',l.prerequisites,
      'revision',l.revision,'status',l.status,'barrier',private.dw_roadmap_barrier_ground(p_session,l.barrier_id),'evidenceId',l.evidence_id,
      'familyTitle',e.material->'title','familyFingerprint',e.fingerprint) into d
      from private.dw_barrier_links l join private.dw_barrier_evidence e on e.id=l.evidence_id and e.session_id=l.session_id
      where l.session_id=p_session and l.id=p_id;
  elsif p_kind='factor' then
    select jsonb_build_object('id',n.id,'title',n.text,'board',n.board,'revision',n.revision,
      'status',case when n.status='active' then 'active' else 'archived' end,
      'barriers',coalesce((select jsonb_agg(private.dw_roadmap_barrier_ground(p_session,l.barrier_id) order by l.barrier_id)
        from private.dw_green_factor_links l join private.dw_barriers b on b.session_id=l.session_id and b.id=l.barrier_id
        where l.session_id=p_session and l.note_id=n.id and b.status='active'),'[]'::jsonb))
      into d from private.dw_flipchart_notes n where n.session_id=p_session and n.id=p_id and n.kind='condition';
  end if;
  if d is null then return null; end if;
  return jsonb_build_object('kind',p_kind,'source',d);
end $$;

create or replace function private.dw_roadmap_bases_json(p_session uuid,p_room uuid) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'sourceKind',m.source_kind,'sourceId',m.source_id,'sourceRevision',m.source_revision,
    'fingerprint',m.fingerprint,'material',m.material,'rationale',b.rationale,'status',b.status,'revision',b.revision,
    'createdAt',b.created_at,'updatedAt',b.updated_at,'staleReasons',case when b.copied_at is not null then '[]'::jsonb else to_jsonb(array_remove(array[
      case when g.current is null then 'source_missing' end,
      case when g.current is not null and encode(sha256(convert_to(g.current::text,'UTF8')),'hex')<>m.fingerprint then 'source_changed' end,
      case when g.current->'source'->>'status'='archived' then 'source_archived' end,
      case when m.source_kind='link' and private.dw_roadmap_link_stale(p_session,m.source_id) then 'source_basis_stale' end],null)) end) order by b.created_at,b.id),'[]'::jsonb)
    from private.dw_roadmap_bases b join private.dw_roadmap_basis_materials m on m.id=b.material_id and m.session_id=b.session_id
    cross join lateral(select private.dw_roadmap_ground(p_session,m.source_kind,m.source_id) as current) g
    where b.session_id=p_session and b.roadmap_id=p_room
$$;

create or replace function private.dw_entry_rpc(p_token text,p_method text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_session private.dw_entry_sessions:=private.dw_entry_token(p_token); v_def record; v_key text; v_index integer;
 v_type text; v_value jsonb; v_sql text:=''; v_expr text; v_result jsonb; v_required integer;
 v_old_sub text:=current_setting('request.jwt.claim.sub',true); v_old_claims text:=current_setting('request.jwt.claims',true);
 v_old_id text:=current_setting('demography.entry_id',true); v_old_hash text:=current_setting('demography.entry_hash',true);
begin
 if p_method is null or not(p_method=any(array['dw_flipchart_updates','dw_flipchart_add','dw_flipchart_vote','dw_flipchart_status','dw_enter_workspace','dw_configure_workspace','dw_workspace_votes','dw_workspace_votes_projection','dw_workspace_vote','dw_workshop_survey','dw_workspace_read','dw_workspace_commit','dw_bootstrap','dw_join_session','dw_save_profile','dw_create_session','dw_available_sessions','dw_join_open_session','dw_session_snapshot','dw_session_cursor','dw_projector_snapshot','dw_update_session','dw_publish_submission','dw_select_catalog_practice','dw_moderate_submission','dw_invitation','dw_rotate_invitation','dw_set_member_role','dw_revoke_member','dw_workshop_snapshot','dw_workshop_cursor','dw_workshop_projector_snapshot','dw_workshop_round_snapshot','dw_region_work','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_cast_vote','dw_workshop_updates','dw_workshop_projector_updates','dw_cast_vote_updates','dw_barriers_snapshot','dw_barriers_cursor','dw_barriers_projector_snapshot','dw_save_barrier','dw_import_flipchart_barrier','dw_set_solution_barrier','dw_barrier_vote','dw_save_barrier_link','dw_save_solution','dw_barrier_evidence','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_roadmaps_index','dw_roadmaps_cursor','dw_roadmap_presence','dw_roadmap_snapshot','dw_roadmap_version','dw_roadmaps_projector_snapshot','dw_configure_roadmaps','dw_join_roadmap','dw_save_roadmap_item','dw_capture_roadmap_fact','dw_capture_roadmap_basis','dw_import_roadmap_workshop','dw_freeze_roadmap','dw_review_roadmap','dw_roadmap_statistics_save','dw_roadmap_statistics_restore','dw_roadmap_statistics_history','dw_roadmap_statistics_series']::text[])) then perform private.dw_fail('FORBIDDEN'); end if;
 if not v_session.operator and p_method=any(array['dw_configure_workspace','dw_create_session','dw_invitation','dw_rotate_invitation','dw_update_session','dw_moderate_submission','dw_set_member_role','dw_revoke_member','dw_projector_snapshot','dw_workshop_projector_snapshot','dw_workshop_projector_updates','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_barriers_projector_snapshot','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_configure_roadmaps','dw_roadmaps_projector_snapshot']::text[]) and not (p_method=any(array['dw_save_family','dw_delete_family','dw_projector_snapshot','dw_workshop_projector_snapshot','dw_workshop_projector_updates','dw_barriers_projector_snapshot','dw_roadmaps_projector_snapshot']::text[]) and exists(select 1 from private.dw_current_workspace where session_id::text=p_args->>'p_session_id')) then perform private.dw_fail('FORBIDDEN'); end if;
 if p_args is null or jsonb_typeof(p_args)<>'object' or octet_length(p_args::text)>8388608 then perform private.dw_fail('INVALID_INPUT'); end if;
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=p_method)<>1 then perform private.dw_fail('SCHEMA_MISSING'); end if;
 select p.proargnames as names,p.pronargdefaults as defaults,
   array(select format_type(t,null) from unnest(p.proargtypes) t) as types into v_def
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=p_method;
 if not found then perform private.dw_fail('SCHEMA_MISSING'); end if;
 if cardinality(v_def.names) is distinct from cardinality(v_def.types) and cardinality(v_def.types)>0 then perform private.dw_fail('SCHEMA_MISSING'); end if;
 if exists(select 1 from jsonb_object_keys(p_args) k where not(k=any(coalesce(v_def.names,array[]::text[])))) then perform private.dw_fail('INVALID_INPUT'); end if;
 v_required:=cardinality(v_def.types)-v_def.defaults;
 if exists(select 1 from generate_series(1,v_required) i where not(p_args ? v_def.names[i])) then perform private.dw_fail('INVALID_INPUT'); end if;
 for v_index in 1..coalesce(cardinality(v_def.types),0) loop
   v_key:=v_def.names[v_index]; v_type:=v_def.types[v_index];
   if v_key !~ '^p_[a-z0-9_]+$' or v_type<>all(array['uuid','text','jsonb','integer','bigint','boolean','uuid[]','text[]']) then
     perform private.dw_fail('SCHEMA_MISSING');
   end if;
   if not(p_args ? v_key) then continue; end if;
   v_value:=p_args->v_key;
   if v_value='null'::jsonb then v_expr:='null::'||v_type;
   elsif v_type='jsonb' then v_expr:=format('%L::jsonb',v_value::text);
   elsif v_type in ('uuid[]','text[]') then
     if jsonb_typeof(v_value)<>'array' or exists(select 1 from jsonb_array_elements(v_value) x where jsonb_typeof(x)<>'string') then
       perform private.dw_fail('INVALID_INPUT');
     end if;
     v_expr:=format('array(select jsonb_array_elements_text(%L::jsonb))::%s',v_value::text,v_type);
   else
     if jsonb_typeof(v_value) in ('array','object') then perform private.dw_fail('INVALID_INPUT'); end if;
     v_expr:=format('%L::%s',p_args->>v_key,v_type);
   end if;
   v_sql:=v_sql||case when v_sql='' then '' else ',' end||format('%I => %s',v_key,v_expr);
 end loop;
 begin
   perform set_config('request.jwt.claim.sub',v_session.actor_id::text,true);
   perform set_config('request.jwt.claims',jsonb_build_object('sub',v_session.actor_id,'role','authenticated',
     'app_metadata',jsonb_build_object('provider','declared-email','email_verified',false))::text,true);
   perform set_config('demography.entry_id',v_session.id::text,true);
   perform set_config('demography.entry_hash',v_session.token_hash,true);
   execute format('select public.%I(%s)',p_method,v_sql) into v_result;
 exception when others then
   perform set_config('request.jwt.claim.sub',coalesce(v_old_sub,''),true);
   perform set_config('request.jwt.claims',coalesce(v_old_claims,''),true);
   perform set_config('demography.entry_id',coalesce(v_old_id,''),true);
   perform set_config('demography.entry_hash',coalesce(v_old_hash,''),true);
   if sqlstate in ('22P02','22003','22023') then perform private.dw_fail('INVALID_INPUT'); end if;
   raise;
 end;
 perform set_config('request.jwt.claim.sub',coalesce(v_old_sub,''),true);
 perform set_config('request.jwt.claims',coalesce(v_old_claims,''),true);
 perform set_config('demography.entry_id',coalesce(v_old_id,''),true);
 perform set_config('demography.entry_hash',coalesce(v_old_hash,''),true);
 return v_result;
end $$;
