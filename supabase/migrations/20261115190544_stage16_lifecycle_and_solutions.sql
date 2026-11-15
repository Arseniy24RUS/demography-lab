-- Historical placements remain where they were recorded. New placements can
-- use the detailed path without inferring a new stage for an old card.
create function private.dw_lifecycle_stages(p_include_legacy boolean) returns text[]
language sql immutable set search_path='' as $$
  select array['education','work','first_child','second_child','third_plus_child',
    'conception','pregnancy','early_childhood','preschool','school']
    ||case when p_include_legacy then array['life_plans','preparation_pregnancy','infancy','next_child'] else array[]::text[] end
$$;
revoke all on function private.dw_lifecycle_stages(boolean) from public,anon,authenticated,service_role;

alter table private.dw_barriers
  add column source_note_id uuid,
  add foreign key(session_id,source_note_id) references private.dw_flipchart_notes(session_id,id),
  drop constraint dw_barriers_check1,
  drop constraint dw_barriers_title_check,
  add constraint dw_barriers_stage_check check(cardinality(stage_ids) between 1 and 14
    and primary_stage=any(stage_ids) and stage_ids <@ private.dw_lifecycle_stages(true)),
  add constraint dw_barriers_title_check check(char_length(btrim(title)) between
    (case when source_note_id is null then 5 else 1 end) and 240);
create unique index dw_barriers_source_note on private.dw_barriers(session_id,source_note_id) where source_note_id is not null;

alter table private.dw_barrier_links
  drop constraint dw_barrier_links_explanation_check,
  add constraint dw_barrier_links_explanation_check check(explanation='' or char_length(btrim(explanation)) between 10 and 4000);

alter table private.dw_solutions
  add column brief boolean not null default false,
  drop constraint dw_solutions_barrier_ids_check,
  drop constraint dw_solutions_title_check,
  drop constraint dw_solutions_target_group_check,
  drop constraint dw_solutions_mechanism_check,
  drop constraint dw_solutions_first_step_check,
  drop constraint dw_solutions_responsible_check,
  drop constraint dw_solutions_resources_check,
  drop constraint dw_solutions_success_indicator_check,
  add constraint dw_solutions_barrier_ids_check check(cardinality(barrier_ids) between 0 and 200),
  add constraint dw_solutions_fields_check check(
    char_length(btrim(title)) between (case when brief then 1 else 5 end) and 240
    and char_length(btrim(mechanism)) between (case when brief then 0 else 10 end) and 4000
    and char_length(btrim(target_group)) between (case when brief then 0 else 3 end) and 1000
    and char_length(btrim(first_step)) between (case when brief then 0 else 3 end) and 2000
    and char_length(btrim(responsible)) between (case when brief then 0 else 3 end) and 2000
    and char_length(btrim(resources)) between (case when brief then 0 else 3 end) and 2000
    and char_length(btrim(success_indicator)) between (case when brief then 0 else 3 end) and 2000);

create table private.dw_green_factor_links (
  session_id uuid not null,
  note_id uuid not null,
  barrier_id uuid not null,
  primary key(session_id,note_id,barrier_id),
  foreign key(session_id,note_id) references private.dw_flipchart_notes(session_id,id),
  foreign key(session_id,barrier_id) references private.dw_barriers(session_id,id)
);
alter table private.dw_green_factor_links enable row level security;
revoke all on private.dw_green_factor_links from public,anon,authenticated,service_role;

create function private.dw_green_factor_links_json(p_session_id uuid) returns jsonb
language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('noteId',l.note_id,'barrierId',l.barrier_id,
    'sourceBoard',n.board,'title',n.text) order by l.note_id,l.barrier_id),'[]'::jsonb)
  from private.dw_green_factor_links l
  join private.dw_flipchart_notes n on n.session_id=l.session_id and n.id=l.note_id
  join private.dw_barriers b on b.session_id=l.session_id and b.id=l.barrier_id
  where l.session_id=p_session_id and n.status='active' and b.status='active'
$$;
revoke all on function private.dw_green_factor_links_json(uuid) from public,anon,authenticated,service_role;

create function private.dw_green_factor_visibility_changed() returns trigger
language plpgsql set search_path='' as $$
begin
  if exists(select 1 from private.dw_green_factor_links where session_id=new.session_id and note_id=new.id) then
    perform private.dw_barrier_touch(new.session_id,'solution.factor.visibility');
  end if;
  return new;
end $$;
create trigger dw_green_factor_visibility_changed after update of status on private.dw_flipchart_notes
  for each row when (old.status is distinct from new.status and new.kind='condition')
  execute function private.dw_green_factor_visibility_changed();
revoke all on function private.dw_green_factor_visibility_changed() from public,anon,authenticated,service_role;

create function private.dw_import_flipchart_barrier(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  v_note private.dw_flipchart_notes;
  v_card private.dw_barriers;
  v_stages text[];
  v_updated text[];
begin
  if not private.dw_is_current_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
  perform private.dw_barrier_write_guard(p_session_id);
  if private.dw_begin_operation(p_operation_id,'barrier.import-factor',v_payload) is not null then
    return private.dw_barriers_snapshot(p_session_id);
  end if;
  if not private.dw_s4_required(p_input,array['noteId','stageIds']) or not private.dw_s4_uuid(p_input->'noteId')
    or jsonb_typeof(p_input->'stageIds')<>'array' then perform private.dw_fail('INVALID_INPUT'); end if;
  select array_agg(stage order by ordinal) into v_stages
    from jsonb_array_elements_text(p_input->'stageIds') with ordinality as a(stage,ordinal);
  if coalesce(cardinality(v_stages),0) not between 1 and 10
    or not v_stages<@private.dw_lifecycle_stages(false)
    or cardinality(v_stages)<>(select count(distinct stage) from unnest(v_stages) as a(stage)) then
    perform private.dw_fail('INVALID_INPUT');
  end if;
  select * into v_note from private.dw_flipchart_notes where session_id=p_session_id and id=(p_input->>'noteId')::uuid
    and kind='barrier' and status='active';
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  select * into v_card from private.dw_barriers where session_id=p_session_id and source_note_id=v_note.id;
  if not found then
    if (select count(*) from private.dw_barriers where session_id=p_session_id)>=200 then perform private.dw_fail('BOARD_LIMIT'); end if;
    -- Attribute the classification to the participant taking this action. The
    -- author of the earlier anonymous note is never read into the new record.
    insert into private.dw_barriers(session_id,author_id,title,description,primary_stage,stage_ids,evidence_kind,status,source_note_id)
      values(p_session_id,auth.uid(),v_note.text,'',v_stages[1],v_stages,'hypothesis','active',v_note.id)
      returning * into v_card;
    perform private.dw_barrier_touch(p_session_id,'barrier.import-factor');
  elsif v_card.status='archived' then
    perform private.dw_fail('BARRIER_ARCHIVED');
  elsif not v_stages<@v_card.stage_ids then
    select array_agg(stage order by ordinal) into v_updated
      from unnest(v_card.stage_ids||v_stages) with ordinality a(stage,ordinal)
      where ordinal=array_position(v_card.stage_ids||v_stages,stage);
    update private.dw_barriers set stage_ids=v_updated,revision=revision+1,updated_at=now()
      where id=v_card.id returning * into v_card;
    perform private.dw_barrier_touch(p_session_id,'barrier.import-factor');
  end if;
  perform private.dw_finish_operation(p_operation_id,'barrier.import-factor',v_payload,jsonb_build_object('id',v_card.id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;

create function private.dw_set_solution_barrier(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  v_barrier uuid;
  v_measure uuid;
  v_linked boolean;
  v_author private.dw_solutions;
  v_changed boolean:=false;
begin
  if not private.dw_is_current_workspace(p_session_id) then perform private.dw_fail('FORBIDDEN'); end if;
  perform private.dw_barrier_write_guard(p_session_id);
  if private.dw_begin_operation(p_operation_id,'solution.set-barrier',v_payload) is not null then
    return private.dw_barriers_snapshot(p_session_id);
  end if;
  if not private.dw_s4_required(p_input,array['kind','measureId','barrierId','linked'])
    or coalesce(p_input->>'kind','') not in ('factor','author')
    or not private.dw_s4_uuid(p_input->'measureId') or not private.dw_s4_uuid(p_input->'barrierId')
    or jsonb_typeof(p_input->'linked')<>'boolean' then perform private.dw_fail('INVALID_INPUT'); end if;
  v_barrier:=(p_input->>'barrierId')::uuid;
  v_measure:=(p_input->>'measureId')::uuid;
  v_linked:=(p_input->>'linked')::boolean;
  if not exists(select 1 from private.dw_barriers where session_id=p_session_id and id=v_barrier
    and (not v_linked or status='active')) then perform private.dw_fail('NOT_FOUND'); end if;
  if p_input->>'kind'='factor' then
    if not exists(select 1 from private.dw_flipchart_notes where session_id=p_session_id and id=v_measure
      and kind='condition' and (not v_linked or status='active')) then perform private.dw_fail('NOT_FOUND'); end if;
    if v_linked then
      if not exists(select 1 from private.dw_green_factor_links where session_id=p_session_id and note_id=v_measure and barrier_id=v_barrier) then
        if (select count(*) from private.dw_green_factor_links where session_id=p_session_id)>=2000 then perform private.dw_fail('BOARD_LIMIT'); end if;
        insert into private.dw_green_factor_links(session_id,note_id,barrier_id) values(p_session_id,v_measure,v_barrier);
        v_changed:=true;
      end if;
    else
      delete from private.dw_green_factor_links where session_id=p_session_id and note_id=v_measure and barrier_id=v_barrier;
      v_changed:=found;
    end if;
  else
    select * into v_author from private.dw_solutions where session_id=p_session_id and id=v_measure
      and (not v_linked or status='active');
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if v_linked is distinct from (v_barrier=any(v_author.barrier_ids)) then
      update private.dw_solutions set barrier_ids=case when v_linked then array_append(barrier_ids,v_barrier)
        else array_remove(barrier_ids,v_barrier) end,revision=revision+1,updated_at=now() where id=v_measure;
      v_changed:=true;
    end if;
  end if;
  if v_changed then perform private.dw_barrier_touch(p_session_id,'solution.set-barrier'); end if;
  perform private.dw_finish_operation(p_operation_id,'solution.set-barrier',v_payload,jsonb_build_object('id',v_measure));
  return private.dw_barriers_snapshot(p_session_id);
end $$;

create function public.dw_import_flipchart_barrier(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.dw_import_flipchart_barrier($1,$2,$3) $$;
create function public.dw_set_solution_barrier(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.dw_set_solution_barrier($1,$2,$3) $$;
revoke all on function public.dw_import_flipchart_barrier(uuid,uuid,jsonb),private.dw_import_flipchart_barrier(uuid,uuid,jsonb),
  public.dw_set_solution_barrier(uuid,uuid,jsonb),private.dw_set_solution_barrier(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.dw_import_flipchart_barrier(uuid,uuid,jsonb),private.dw_import_flipchart_barrier(uuid,uuid,jsonb),
  public.dw_set_solution_barrier(uuid,uuid,jsonb),private.dw_set_solution_barrier(uuid,uuid,jsonb) to authenticated;

-- Brief authored measures may start without connections. Keep the historical
-- representation byte-for-byte for solutions that already have a barrier.
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
  end if;
  if d is null then return null; end if;
  return jsonb_build_object('kind',p_kind,'source',d);
end $$;

create or replace function private.dw_barriers_json(p_session_id uuid,p_projector boolean default false) returns jsonb language sql stable set search_path='' as $$
  with family_options as materialized (select private.dw_barrier_family_options(p_session_id) as items)
  select jsonb_build_object('sessionId',s.id,'cursor',bs.event_cursor,
    'barriers',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'title',b.title,'description',b.description,'primaryStage',b.primary_stage,
      'stageIds',b.stage_ids,'evidenceKind',b.evidence_kind,'status',b.status,'priority',b.priority,'revision',b.revision,'contentRevision',b.content_revision,
      'createdAt',b.created_at,'updatedAt',b.updated_at,'authorName',case when not p_projector or s.projector_show_authors then p.full_name else null end,
      'totals',(select jsonb_build_object('support',count(*) filter(where v.value=1),'oppose',count(*) filter(where v.value=-1),
        'neutral',count(*) filter(where v.value=0),'cast',count(*) filter(where v.value is not null))
        from private.dw_barrier_votes v join public.dw_memberships mm on mm.session_id=v.session_id and mm.user_id=v.user_id
        where v.barrier_id=b.id and mm.revoked_at is null and mm.role in ('host','participant')))
      ||case when b.source_note_id is null then '{}'::jsonb else jsonb_build_object('sourceNoteId',b.source_note_id,
        'sourceBoard',(select board from private.dw_flipchart_notes n where n.session_id=b.session_id and n.id=b.source_note_id)) end
      ||case when p_projector then '{}'::jsonb else jsonb_build_object('authorId',b.author_id,
        'myVote',(select value from private.dw_barrier_votes where barrier_id=b.id and user_id=auth.uid()),
        'myVoteRevision',coalesce((select revision from private.dw_barrier_votes where barrier_id=b.id and user_id=auth.uid()),0)) end
      order by b.created_at,b.id) from private.dw_barriers b join public.dw_profiles p on p.user_id=b.author_id where b.session_id=s.id),'[]'::jsonb),
    'families',fo.items,
    'links',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'barrierId',l.barrier_id,'familyId',l.family_id,'relationship',l.relationship,
      'explanation',l.explanation,'prerequisites',l.prerequisites,'status',l.status,'revision',l.revision,'barrierContentRevision',l.barrier_content_revision,
      'evidenceId',l.evidence_id,'familyFingerprint',e.fingerprint,'familyTitle',e.material->>'title','createdAt',l.created_at,'updatedAt',l.updated_at,
      'authorName',case when not p_projector or s.projector_show_authors then p.full_name else null end,
      'staleReasons',to_jsonb(array_remove(array[
        case when b.content_revision<>l.barrier_content_revision then 'barrier_changed' end,
        case when b.status<>'active' then 'barrier_archived' end,
        case when cf.fingerprint is null then 'family_missing'
          when cf.fingerprint<>e.fingerprint then 'family_changed' end],null)))
      ||case when p_projector then '{}'::jsonb else jsonb_build_object('authorId',l.author_id) end order by l.created_at,l.id)
      from private.dw_barrier_links l join private.dw_barriers b on b.id=l.barrier_id join private.dw_barrier_evidence e on e.id=l.evidence_id
      left join lateral (select x->>'fingerprint' as fingerprint from jsonb_array_elements(fo.items) x where x->>'id'=l.family_id::text) cf on true
      join public.dw_profiles p on p.user_id=l.author_id where l.session_id=s.id),'[]'::jsonb),
    'solutions',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'barrierIds',a.barrier_ids,'title',a.title,'targetGroup',a.target_group,
      'mechanism',a.mechanism,'firstStep',a.first_step,'responsible',a.responsible,'resources',a.resources,'successIndicator',a.success_indicator,
      'risks',a.risks,'status',a.status,'revision',a.revision,'createdAt',a.created_at,'updatedAt',a.updated_at,
      'authorName',case when not p_projector or s.projector_show_authors then p.full_name else null end)
      ||case when a.brief then jsonb_build_object('format','brief') else '{}'::jsonb end
      ||case when p_projector then '{}'::jsonb else jsonb_build_object('authorId',a.author_id) end order by a.created_at,a.id)
      from private.dw_solutions a join public.dw_profiles p on p.user_id=a.author_id where a.session_id=s.id),'[]'::jsonb),
    'survey',(select case when p_projector then jsonb_build_object('title',q.title,'status',q.status,'responseCount',private.dw_survey_summary_json(q.id)->'responseCount')
      else private.dw_survey_summary_json(q.id) end from research.surveys q where q.session_id=s.id and q.status<>'purged'))
    ||case when private.dw_is_current_workspace(s.id) then jsonb_build_object('greenFactorLinks',private.dw_green_factor_links_json(s.id))
      else '{}'::jsonb end
    ||case when p_projector then jsonb_build_object('title',s.title,'scope',s.scope,'regionId',s.region_id,'phase',s.phase,'status',s.status) else '{}'::jsonb end
  from public.dw_sessions s join private.dw_barrier_state bs on bs.session_id=s.id cross join family_options fo where s.id=p_session_id
$$;

create or replace function private.dw_save_barrier(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_payload jsonb; v_old private.dw_barriers; v_id uuid; v_stages text[]; v_changed boolean; v_current boolean:=private.dw_is_current_workspace(p_session_id);
begin
  v_role:=private.dw_barrier_write_guard(p_session_id);
  v_payload:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  if private.dw_begin_operation(p_operation_id,'barrier.save',v_payload) is not null then return private.dw_barriers_snapshot(p_session_id); end if;
  if not private.dw_s4_required(p_input,array['barrierId','expectedRevision','title','description','primaryStage','stageIds','evidenceKind','status','priority'])
    or not (p_input->'barrierId'='null'::jsonb or private.dw_s4_uuid(p_input->'barrierId'))
    or not private.dw_s4_integer(p_input->'expectedRevision') or not private.dw_s4_text(p_input->'title',1,240)
    or not private.dw_text(p_input->'description',0,4000) or jsonb_typeof(p_input->'stageIds')<>'array'
    or not private.dw_text(p_input->'primaryStage',1,40) or jsonb_typeof(p_input->'priority')<>'boolean'
    or coalesce(p_input->>'evidenceKind','') not in ('observation','hypothesis','survey_summary')
    or coalesce(p_input->>'status','') not in ('active','archived') then perform private.dw_fail('INVALID_INPUT'); end if;
  if exists(select 1 from jsonb_array_elements(p_input->'stageIds') x where jsonb_typeof(x)<>'string') then perform private.dw_fail('INVALID_INPUT'); end if;
  select array_agg(x) into v_stages from jsonb_array_elements_text(p_input->'stageIds') x;
  if coalesce(cardinality(v_stages),0) not between 1 and (case when v_current then 14 else 8 end)
    or not v_stages <@ (case when v_current then private.dw_lifecycle_stages(true)
      else array['life_plans','first_child','preparation_pregnancy','infancy','early_childhood','preschool','school','next_child'] end)
    or not (p_input->>'primaryStage'=any(v_stages))
    or cardinality(v_stages)<>(select count(distinct x) from unnest(v_stages) x) then perform private.dw_fail('INVALID_INPUT'); end if;
  v_id:=(p_input->>'barrierId')::uuid;
  if v_id is null then
    if not private.dw_s4_text(p_input->'title',5,240) then perform private.dw_fail('INVALID_INPUT'); end if;
    if (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if (p_input->>'priority')::boolean and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    if (select count(*) from private.dw_barriers where session_id=p_session_id)>=200 then perform private.dw_fail('BOARD_LIMIT'); end if;
    insert into private.dw_barriers(session_id,author_id,title,description,primary_stage,stage_ids,evidence_kind,status,priority)
      values(p_session_id,auth.uid(),p_input->>'title',p_input->>'description',p_input->>'primaryStage',v_stages,
        p_input->>'evidenceKind',p_input->>'status',(p_input->>'priority')::boolean) returning id into v_id;
  else
    select * into v_old from private.dw_barriers where session_id=p_session_id and id=v_id;
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if v_old.source_note_id is null and not private.dw_s4_text(p_input->'title',5,240) then
      perform private.dw_fail('INVALID_INPUT');
    end if;
    if v_old.source_note_id is not null and v_old.title is distinct from p_input->>'title' then
      perform private.dw_fail('INVALID_INPUT');
    end if;
    if v_old.author_id<>auth.uid() and v_role<>'host' and (v_old.source_note_id is null
      or (v_old.title,v_old.description,v_old.evidence_kind,v_old.status,v_old.priority)
         is distinct from (p_input->>'title',p_input->>'description',p_input->>'evidenceKind',p_input->>'status',(p_input->>'priority')::boolean)) then
      perform private.dw_fail('FORBIDDEN');
    end if;
    if v_old.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if v_old.priority is distinct from (p_input->>'priority')::boolean and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    v_changed:=(v_old.title,v_old.description,v_old.evidence_kind,v_old.status)
      is distinct from (p_input->>'title',p_input->>'description',p_input->>'evidenceKind',p_input->>'status')
      or (not v_current and (v_old.primary_stage,v_old.stage_ids) is distinct from (p_input->>'primaryStage',v_stages));
    update private.dw_barriers set title=p_input->>'title',description=p_input->>'description',primary_stage=p_input->>'primaryStage',stage_ids=v_stages,
      evidence_kind=p_input->>'evidenceKind',status=p_input->>'status',priority=(p_input->>'priority')::boolean,
      revision=revision+1,content_revision=content_revision+case when v_changed then 1 else 0 end,updated_at=now() where id=v_id;
  end if;
  perform private.dw_barrier_touch(p_session_id,'barrier.saved');
  perform private.dw_finish_operation(p_operation_id,'barrier.save',v_payload,jsonb_build_object('id',v_id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;

create or replace function private.dw_save_barrier_link(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_payload jsonb; v_old private.dw_barrier_links; v_id uuid; v_barrier private.dw_barriers;
  v_material jsonb; v_fingerprint text; v_evidence uuid; v_family uuid;
  v_quick boolean:=private.dw_is_current_workspace(p_session_id) and coalesce(
    p_input->>'explanation'='' and p_input->>'prerequisites'='' and p_input->>'relationship'='potential',false);
begin
  v_role:=private.dw_barrier_write_guard(p_session_id);
  v_payload:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  if private.dw_begin_operation(p_operation_id,'barrier.link',v_payload) is not null then return private.dw_barriers_snapshot(p_session_id); end if;
  if not private.dw_s4_required(p_input,array['linkId','expectedRevision','barrierId','expectedBarrierRevision','familyId','expectedFamilyFingerprint','relationship','explanation','prerequisites','status'])
    or not (p_input->'linkId'='null'::jsonb or private.dw_s4_uuid(p_input->'linkId'))
    or not private.dw_s4_integer(p_input->'expectedRevision') or not private.dw_s4_integer(p_input->'expectedBarrierRevision',1)
    or not private.dw_s4_uuid(p_input->'barrierId') or not private.dw_s4_uuid(p_input->'familyId')
    or not coalesce((p_input->>'expectedFamilyFingerprint') ~ '^[a-f0-9]{64}$',false)
    or coalesce(p_input->>'relationship','') not in ('potential','partial','needs_adaptation')
    or (not v_quick and not private.dw_s4_text(p_input->'explanation',10,4000)) or not private.dw_text(p_input->'prerequisites',0,4000)
    or coalesce(p_input->>'status','') not in ('active','archived') then perform private.dw_fail('INVALID_INPUT'); end if;
  v_id:=(p_input->>'linkId')::uuid; v_family:=(p_input->>'familyId')::uuid;
  if v_id is not null then
    select * into v_old from private.dw_barrier_links where session_id=p_session_id and id=v_id;
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if v_old.author_id<>auth.uid() and v_role<>'host'
      and not(v_quick and v_old.explanation='' and v_old.prerequisites='' and v_old.relationship='potential') then
      perform private.dw_fail('FORBIDDEN');
    end if;
    if v_old.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if (v_old.barrier_id,v_old.family_id) is distinct from ((p_input->>'barrierId')::uuid,v_family) then perform private.dw_fail('INVALID_INPUT'); end if;
  elsif (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT');
  elsif (select count(*) from private.dw_barrier_links where session_id=p_session_id)>=600 then perform private.dw_fail('BOARD_LIMIT'); end if;
  select * into v_barrier from private.dw_barriers where session_id=p_session_id and id=(p_input->>'barrierId')::uuid;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_id is not null and p_input->>'status'='archived' then
    -- Remove an obsolete link without rewriting its original source evidence.
    update private.dw_barrier_links set relationship=p_input->>'relationship',explanation=p_input->>'explanation',prerequisites=p_input->>'prerequisites',
      status='archived',revision=revision+1,updated_at=now() where id=v_id;
  else
    if v_barrier.status<>'active' then perform private.dw_fail('BARRIER_ARCHIVED'); end if;
    if v_barrier.revision<>(p_input->>'expectedBarrierRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    v_material:=private.dw_barrier_family_material(p_session_id,v_family);
    if v_material is null then perform private.dw_fail('FAMILY_MISSING'); end if;
    v_fingerprint:=encode(sha256(convert_to(v_material::text,'UTF8')),'hex');
    if v_fingerprint<>p_input->>'expectedFamilyFingerprint' then perform private.dw_fail('FAMILY_CHANGED'); end if;
    if v_quick and v_id is null and p_input->>'status'='active' then
      select l.id into v_id from private.dw_barrier_links l
      join private.dw_barrier_evidence e on e.id=l.evidence_id
      where l.session_id=p_session_id and l.barrier_id=v_barrier.id and l.family_id=v_family and l.status='active'
        and l.barrier_content_revision=v_barrier.content_revision and e.fingerprint=v_fingerprint order by l.created_at,l.id limit 1;
      if found then
        perform private.dw_finish_operation(p_operation_id,'barrier.link',v_payload,jsonb_build_object('id',v_id));
        return private.dw_barriers_snapshot(p_session_id);
      end if;
      -- Reuse an obsolete quick link to the same pair when its evidence is refreshed.
      select l.id into v_id from private.dw_barrier_links l
      where l.session_id=p_session_id and l.barrier_id=v_barrier.id and l.family_id=v_family
        and l.explanation='' and l.prerequisites='' and l.relationship='potential' order by l.created_at,l.id limit 1;
    end if;
    select id into v_evidence from private.dw_barrier_evidence where session_id=p_session_id and family_id=v_family and fingerprint=v_fingerprint;
    if v_evidence is null then
      if octet_length(v_material::text)>8388608 or coalesce((select sum(octet_length(material::text)) from private.dw_barrier_evidence where session_id=p_session_id),0)
        +octet_length(v_material::text)>67108864 then perform private.dw_fail('EVIDENCE_LIMIT'); end if;
      insert into private.dw_barrier_evidence(session_id,family_id,fingerprint,material) values(p_session_id,v_family,v_fingerprint,v_material) returning id into v_evidence;
    end if;
    if v_id is null then
      insert into private.dw_barrier_links(session_id,barrier_id,family_id,author_id,relationship,explanation,prerequisites,status,barrier_content_revision,evidence_id)
        values(p_session_id,v_barrier.id,v_family,auth.uid(),p_input->>'relationship',p_input->>'explanation',p_input->>'prerequisites',p_input->>'status',v_barrier.content_revision,v_evidence)
        returning id into v_id;
    else
      update private.dw_barrier_links set relationship=p_input->>'relationship',explanation=p_input->>'explanation',prerequisites=p_input->>'prerequisites',status=p_input->>'status',
        barrier_content_revision=v_barrier.content_revision,evidence_id=v_evidence,revision=revision+1,updated_at=now() where id=v_id;
    end if;
  end if;
  perform private.dw_barrier_touch(p_session_id,'barrier.link');
  perform private.dw_finish_operation(p_operation_id,'barrier.link',v_payload,jsonb_build_object('id',v_id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;

create or replace function private.dw_save_solution(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_payload jsonb; v_old private.dw_solutions; v_id uuid; v_barriers uuid[]; v_field text;
  v_current boolean:=private.dw_is_current_workspace(p_session_id);
  v_brief boolean:=coalesce(p_input->'format'='"brief"'::jsonb,false);
begin
  v_role:=private.dw_barrier_write_guard(p_session_id);
  v_payload:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  if private.dw_begin_operation(p_operation_id,'barrier.solution',v_payload) is not null then return private.dw_barriers_snapshot(p_session_id); end if;
  if (p_input?'format' and (not v_brief or not v_current))
    or not private.dw_s4_required(p_input-'format',array['solutionId','expectedRevision','barrierIds','title','targetGroup','mechanism','firstStep','responsible','resources','successIndicator','risks','status'])
    or not (p_input->'solutionId'='null'::jsonb or private.dw_s4_uuid(p_input->'solutionId'))
    or not private.dw_s4_integer(p_input->'expectedRevision') or jsonb_typeof(p_input->'barrierIds')<>'array'
    or not private.dw_s4_text(p_input->'title',case when v_brief then 1 else 5 end,240)
    or not private.dw_s4_text(p_input->'targetGroup',case when v_brief then 0 else 3 end,1000)
    or not private.dw_s4_text(p_input->'mechanism',case when v_brief then 0 else 10 end,4000)
    or not private.dw_text(p_input->'risks',0,2000)
    or coalesce(p_input->>'status','') not in ('active','archived') then perform private.dw_fail('INVALID_INPUT'); end if;
  foreach v_field in array array['firstStep','responsible','resources','successIndicator'] loop
    if not private.dw_s4_text(p_input->v_field,case when v_brief then 0 else 3 end,2000) then perform private.dw_fail('INVALID_INPUT'); end if;
  end loop;
  if jsonb_array_length(p_input->'barrierIds') not between (case when v_current then 0 else 1 end)
    and (case when v_current then 200 else 20 end)
    or exists(select 1 from jsonb_array_elements(p_input->'barrierIds') x where not private.dw_s4_uuid(x)) then perform private.dw_fail('INVALID_INPUT'); end if;
  select coalesce(array_agg(x::uuid),'{}'::uuid[]) into v_barriers from jsonb_array_elements_text(p_input->'barrierIds') x;
  if cardinality(v_barriers)<>(select count(distinct x) from unnest(v_barriers) x)
    or cardinality(v_barriers)<>(select count(*) from private.dw_barriers where session_id=p_session_id and id=any(v_barriers)) then perform private.dw_fail('INVALID_INPUT'); end if;
  v_id:=(p_input->>'solutionId')::uuid;
  if v_id is null then
    if (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if (select count(*) from private.dw_solutions where session_id=p_session_id)>=200 then perform private.dw_fail('BOARD_LIMIT'); end if;
    insert into private.dw_solutions(session_id,author_id,barrier_ids,title,target_group,mechanism,first_step,responsible,resources,success_indicator,risks,status,brief)
      values(p_session_id,auth.uid(),v_barriers,p_input->>'title',p_input->>'targetGroup',p_input->>'mechanism',p_input->>'firstStep',p_input->>'responsible',
        p_input->>'resources',p_input->>'successIndicator',p_input->>'risks',p_input->>'status',v_brief) returning id into v_id;
  else
    select * into v_old from private.dw_solutions where session_id=p_session_id and id=v_id;
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if v_old.author_id<>auth.uid() and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    if v_old.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    update private.dw_solutions set barrier_ids=v_barriers,title=p_input->>'title',target_group=p_input->>'targetGroup',mechanism=p_input->>'mechanism',
      first_step=p_input->>'firstStep',responsible=p_input->>'responsible',resources=p_input->>'resources',success_indicator=p_input->>'successIndicator',risks=p_input->>'risks',
      status=p_input->>'status',brief=v_brief,revision=revision+1,updated_at=now() where id=v_id;
  end if;
  perform private.dw_barrier_touch(p_session_id,'solution.saved');
  perform private.dw_finish_operation(p_operation_id,'barrier.solution',v_payload,jsonb_build_object('id',v_id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;

create or replace function private.dw_entry_rpc(p_token text,p_method text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_session private.dw_entry_sessions:=private.dw_entry_token(p_token); v_def record; v_key text; v_index integer;
 v_type text; v_value jsonb; v_sql text:=''; v_expr text; v_result jsonb; v_required integer;
 v_old_sub text:=current_setting('request.jwt.claim.sub',true); v_old_claims text:=current_setting('request.jwt.claims',true);
 v_old_id text:=current_setting('demography.entry_id',true); v_old_hash text:=current_setting('demography.entry_hash',true);
begin
 if p_method is null or not(p_method=any(array['dw_flipchart_updates','dw_flipchart_add','dw_flipchart_vote','dw_flipchart_status','dw_enter_workspace','dw_configure_workspace','dw_workspace_votes','dw_workspace_votes_projection','dw_workspace_vote','dw_workshop_survey','dw_workspace_read','dw_workspace_commit','dw_bootstrap','dw_join_session','dw_save_profile','dw_create_session','dw_available_sessions','dw_join_open_session','dw_session_snapshot','dw_session_cursor','dw_projector_snapshot','dw_update_session','dw_publish_submission','dw_select_catalog_practice','dw_moderate_submission','dw_invitation','dw_rotate_invitation','dw_set_member_role','dw_revoke_member','dw_workshop_snapshot','dw_workshop_cursor','dw_workshop_projector_snapshot','dw_workshop_round_snapshot','dw_region_work','dw_save_family','dw_delete_family','dw_open_voting_round','dw_close_voting_round','dw_cast_vote','dw_workshop_updates','dw_workshop_projector_updates','dw_cast_vote_updates','dw_barriers_snapshot','dw_barriers_cursor','dw_barriers_projector_snapshot','dw_save_barrier','dw_import_flipchart_barrier','dw_set_solution_barrier','dw_barrier_vote','dw_save_barrier_link','dw_save_solution','dw_barrier_evidence','dw_save_survey','dw_manage_survey','dw_survey_host_state','dw_survey_invitation_state','dw_survey_research_export','dw_roadmaps_index','dw_roadmaps_cursor','dw_roadmap_presence','dw_roadmap_snapshot','dw_roadmap_version','dw_roadmaps_projector_snapshot','dw_configure_roadmaps','dw_join_roadmap','dw_save_roadmap_item','dw_capture_roadmap_fact','dw_capture_roadmap_basis','dw_freeze_roadmap','dw_review_roadmap','dw_roadmap_statistics_save','dw_roadmap_statistics_restore','dw_roadmap_statistics_history','dw_roadmap_statistics_series']::text[])) then perform private.dw_fail('FORBIDDEN'); end if;
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
