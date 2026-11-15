-- Keep a note and its votes when its final territorial contribution is removed.
-- An automatic withdrawal can be revived by any participant choosing a territory.
alter table private.dw_flipchart_notes add column territory_deselected boolean not null default false
  check (not territory_deselected or (board='objective' and status='withdrawn'));

create or replace function private.dw_flipchart_add_result(p_session_id uuid,p_note_id uuid,p_viewer uuid,p_include_territories boolean)
returns jsonb language sql stable set search_path='' as $$
  select case when p_include_territories and p_note_id is not null then jsonb_set(r.result,'{note}',
    (r.result->'note') || case when exists (select 1 from private.dw_flipchart_notes
      where session_id=p_session_id and id=p_note_id and territory_deselected)
      then jsonb_build_object('territoryCount',0,'territoryKeys','[]'::jsonb)
      else private.dw_flipchart_territory_json(p_session_id,p_note_id,false) end,false)
    else r.result end
  from (select private.dw_flipchart_result_json(p_session_id,p_note_id,p_viewer) as result) r
$$;

create or replace function private.dw_flipchart_add(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_text text; v_cursor bigint; v_id uuid; v_replay jsonb;
  v_board text; v_key text; v_kind text; v_added private.dw_flipchart_notes;
  v_territory text:=p_input->>'territoryKey'; v_selected boolean:=true;
  v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  v_replay:=private.dw_begin_operation(p_operation_id,'flipchart_add',v_payload);
  perform private.dw_flipchart_lock(p_session_id);
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  if v_replay is not null then
    return private.dw_flipchart_add_result(p_session_id,(v_replay->>'noteId')::uuid,v_uid,v_territory is not null);
  end if;

  v_kind:=p_input->>'kind';
  if p_input is null or not private.dw_keys(p_input,array['kind','text','board','factorKey','territoryKey','territorySelected'])
    or not(p_input ?& array['kind','text']) or coalesce(v_kind,'') not in ('barrier','condition')
    or jsonb_typeof(p_input->'text') is distinct from 'string' then perform private.dw_fail('INVALID_INPUT'); end if;
  v_board:=case when p_input ? 'board' then p_input->>'board' else 'parenthood' end;
  v_key:=p_input->>'factorKey';
  if v_board is null or v_board not in ('parenthood','objective')
    or (v_board='parenthood' and p_input ?| array['factorKey','territoryKey','territorySelected'])
    or (v_board='objective' and (jsonb_typeof(p_input->'factorKey') is distinct from 'string'
      or v_key !~ '^[a-z0-9][a-z0-9_-]{0,79}$')) then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_input ? 'territoryKey' and (jsonb_typeof(p_input->'territoryKey') is distinct from 'string'
    or v_territory !~ '^[a-z0-9][a-z0-9_-]{0,79}$') then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_input ? 'territorySelected' then
    if v_territory is null or jsonb_typeof(p_input->'territorySelected') is distinct from 'boolean'
      then perform private.dw_fail('INVALID_INPUT'); end if;
    v_selected:=(p_input->>'territorySelected')::boolean;
  end if;

  v_text:=p_input->>'text';
  if char_length(v_text)>4096 or v_text ~ '[\x01-\x08\x0E-\x1F\x7F]' then perform private.dw_fail('INVALID_INPUT'); end if;
  v_text:=btrim(regexp_replace(normalize(v_text,NFC),
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g'));
  if char_length(v_text) not between 1 and 180 then perform private.dw_fail('INVALID_INPUT'); end if;

  if v_board='objective' then
    select * into v_added from private.dw_flipchart_notes
      where session_id=p_session_id and board='objective' and factor_key=v_key;
    if v_territory is not null and v_added.kind<>v_kind then perform private.dw_fail('INVALID_INPUT'); end if;
  end if;

  if not v_selected then
    v_id:=v_added.id;
    if v_id is not null then
      delete from private.dw_flipchart_factor_territories
        where session_id=p_session_id and note_id=v_id and territory_key=v_territory;
      if found then
        update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
        if v_added.status='active' and not exists (select 1 from private.dw_flipchart_factor_territories
          where session_id=p_session_id and note_id=v_id) then
          update private.dw_flipchart_notes set status='withdrawn',territory_deselected=true,revision=revision+1,updated_cursor=v_cursor
            where session_id=p_session_id and id=v_id;
        else
          update private.dw_flipchart_notes set updated_cursor=v_cursor where session_id=p_session_id and id=v_id;
        end if;
      end if;
    end if;
  elsif v_added.id is null then
    if (select count(*) from private.dw_flipchart_notes where session_id=p_session_id and board=v_board)>=20000 then
      perform private.dw_fail('LIMIT_EXCEEDED'); end if;
    update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
    insert into private.dw_flipchart_notes(session_id,author_id,kind,text,board,factor_key,updated_cursor)
      values(p_session_id,v_uid,v_kind,v_text,v_board,v_key,v_cursor) returning id into v_id;
  else
    v_id:=v_added.id;
    if v_added.status='withdrawn' then
      if v_added.territory_deselected then
        if v_territory is null then perform private.dw_fail('NOTE_WITHDRAWN'); end if;
      elsif v_added.author_id<>v_uid and private.dw_member_role(p_session_id) is distinct from 'host' then
        perform private.dw_fail('NOTE_WITHDRAWN');
      end if;
      update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
      update private.dw_flipchart_notes set status='active',territory_deselected=false,revision=revision+1,updated_cursor=v_cursor
        where session_id=p_session_id and id=v_id;
    end if;
  end if;

  if v_selected and v_territory is not null then
    insert into private.dw_flipchart_factor_territories(session_id,note_id,territory_key)
      values(p_session_id,v_id,v_territory) on conflict do nothing;
    if found and v_cursor is null then
      update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
      update private.dw_flipchart_notes set updated_cursor=v_cursor where session_id=p_session_id and id=v_id;
    end if;
  end if;
  perform private.dw_finish_operation(p_operation_id,'flipchart_add',v_payload,jsonb_build_object('noteId',v_id));
  return private.dw_flipchart_add_result(p_session_id,v_id,v_uid,v_territory is not null);
end $$;

-- Restoring a sticker with no contributions is an explicit territorial choice.
-- The existing status endpoint still handles manual withdrawal and restoration.
create or replace function private.dw_flipchart_status(p_operation_id uuid,p_session_id uuid,p_note_id uuid,
  p_expected_revision bigint,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_note private.dw_flipchart_notes; v_cursor bigint; v_replay jsonb;
  v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'noteId',p_note_id,'revision',p_expected_revision,'input',p_input);
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  v_replay:=private.dw_begin_operation(p_operation_id,'flipchart_status',v_payload);
  perform private.dw_flipchart_lock(p_session_id);
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_note from private.dw_flipchart_notes where session_id=p_session_id and id=p_note_id;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_note.author_id<>v_uid and private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_replay is not null then return private.dw_flipchart_result_json(p_session_id,p_note_id,v_uid); end if;
  if p_input is null or not private.dw_keys(p_input,array['status']) or not(p_input ? 'status')
    or coalesce(p_input->>'status','') not in ('active','withdrawn') then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_expected_revision is null or p_expected_revision<>v_note.revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  if v_note.territory_deselected and p_input->>'status'='active' then perform private.dw_fail('NOTE_WITHDRAWN'); end if;
  if v_note.status is distinct from p_input->>'status' then
    update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
    update private.dw_flipchart_notes set status=p_input->>'status',revision=revision+1,updated_cursor=v_cursor
      where session_id=p_session_id and id=p_note_id;
  end if;
  perform private.dw_finish_operation(p_operation_id,'flipchart_status',v_payload,jsonb_build_object('noteId',p_note_id));
  return private.dw_flipchart_result_json(p_session_id,p_note_id,v_uid);
end $$;
