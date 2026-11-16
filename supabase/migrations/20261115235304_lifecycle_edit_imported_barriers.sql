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
    if not v_current and v_old.source_note_id is not null and v_old.title is distinct from p_input->>'title' then
      perform private.dw_fail('INVALID_INPUT');
    end if;
    -- Imported factors remain linked to their source note. The wording here is the workshop card.
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
    if v_current and v_old.status='active' and p_input->>'status'='archived' then
      -- Active authored measures remain available for other barriers or later pairing.
      update private.dw_solutions set barrier_ids=array_remove(barrier_ids,v_id),revision=revision+1,updated_at=now()
        where session_id=p_session_id and status='active' and v_id=any(barrier_ids);
    end if;
  end if;
  perform private.dw_barrier_touch(p_session_id,'barrier.saved');
  perform private.dw_finish_operation(p_operation_id,'barrier.save',v_payload,jsonb_build_object('id',v_id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;
