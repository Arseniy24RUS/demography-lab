-- Retry an existing practice link before checking the limit on new links.
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
  end if;
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
      if (select count(*) from private.dw_barrier_links where session_id=p_session_id)>=600 then perform private.dw_fail('BOARD_LIMIT'); end if;
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
