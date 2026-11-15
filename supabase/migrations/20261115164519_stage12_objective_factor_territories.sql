-- A signed relationship has one shared note and one contribution per territory.
create table private.dw_flipchart_factor_territories (
  session_id uuid not null,
  note_id uuid not null,
  territory_key text not null check(territory_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  primary key(session_id,note_id,territory_key),
  foreign key(session_id,note_id) references private.dw_flipchart_notes(session_id,id) on delete cascade
);
alter table private.dw_flipchart_factor_territories enable row level security;
revoke all on private.dw_flipchart_factor_territories from public,anon,authenticated;

-- Participant updates include the public catalogue keys so a card shows whether
-- the currently selected territory has been added. Projection only needs totals.
create function private.dw_flipchart_territory_json(p_session_id uuid,p_note_id uuid,p_projector boolean)
returns jsonb language sql stable set search_path='' as $$
  select case when count(*)=0 then '{}'::jsonb else
    jsonb_build_object('territoryCount',count(*)) ||
      case when p_projector then '{}'::jsonb
        else jsonb_build_object('territoryKeys',jsonb_agg(t.territory_key order by t.territory_key)) end
  end
  from private.dw_flipchart_factor_territories t
  where t.session_id=p_session_id and t.note_id=p_note_id
$$;

create function private.dw_flipchart_add_result(p_session_id uuid,p_note_id uuid,p_viewer uuid,p_include_territories boolean)
returns jsonb language sql stable set search_path='' as $$
  select case when p_include_territories then jsonb_set(r.result,'{note}',
    (r.result->'note') || private.dw_flipchart_territory_json(p_session_id,p_note_id,false),false)
    else r.result end
  from (select private.dw_flipchart_result_json(p_session_id,p_note_id,p_viewer) as result) r
$$;

revoke all on function private.dw_flipchart_territory_json(uuid,uuid,boolean),
  private.dw_flipchart_add_result(uuid,uuid,uuid,boolean) from public,anon,authenticated;

-- The old 'objective' read still renders the same board with the original DTO.
create or replace function private.dw_flipchart_updates(p_session_id uuid,p_after_cursor bigint,p_projector boolean,p_board text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
  v_board text:=case when p_board='objective-v2' then 'objective' else p_board end;
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  if v_board is null or v_board not in ('parenthood','objective') or p_projector is null
    or p_after_cursor<0 or p_after_cursor>9007199254740991 then perform private.dw_fail('INVALID_INPUT'); end if;

  with state as materialized (
    select coalesce((select cursor from private.dw_flipchart_state where session_id=p_session_id),0) as cursor
  ), mode as materialized (
    select cursor,(p_after_cursor is null or p_after_cursor>cursor) as reset from state
  ), changed as materialized (
    select n.id,n.status,n.created_at from private.dw_flipchart_notes n cross join mode m
    where n.session_id=p_session_id and n.board=v_board and (m.reset and n.status='active'
      or not m.reset and n.updated_cursor>p_after_cursor and n.updated_cursor<=m.cursor)
  )
  select jsonb_build_object('sessionId',p_session_id,'cursor',m.cursor,'reset',m.reset,
    'notes',case when not m.reset and m.cursor=p_after_cursor then '[]'::jsonb else
      coalesce((select jsonb_agg(private.dw_flipchart_note_json(p_session_id,n.id,v_uid,p_projector) ||
        case when p_board='objective-v2' then private.dw_flipchart_territory_json(p_session_id,n.id,p_projector)
          else '{}'::jsonb end order by n.created_at,n.id) from changed n where n.status='active'),'[]'::jsonb) end,
    'removedIds',case when m.reset or m.cursor=p_after_cursor then '[]'::jsonb else coalesce((select jsonb_agg(n.id order by n.id)
      from changed n where n.status='withdrawn'),'[]'::jsonb) end)
    into v_result from mode m;
  return v_result;
end $$;

create or replace function private.dw_flipchart_add(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_text text; v_cursor bigint; v_id uuid; v_replay jsonb;
  v_board text; v_key text; v_kind text; v_added private.dw_flipchart_notes;
  v_territory text:=p_input->>'territoryKey';
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
  if p_input is null or not private.dw_keys(p_input,array['kind','text','board','factorKey','territoryKey'])
    or not(p_input ?& array['kind','text']) or coalesce(v_kind,'') not in ('barrier','condition')
    or jsonb_typeof(p_input->'text') is distinct from 'string' then perform private.dw_fail('INVALID_INPUT'); end if;
  v_board:=case when p_input ? 'board' then p_input->>'board' else 'parenthood' end;
  v_key:=p_input->>'factorKey';
  if v_board is null or v_board not in ('parenthood','objective')
    or (v_board='parenthood' and p_input ?| array['factorKey','territoryKey'])
    or (v_board='objective' and (jsonb_typeof(p_input->'factorKey') is distinct from 'string'
      or v_key !~ '^[a-z0-9][a-z0-9_-]{0,79}$')) then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_input ? 'territoryKey' and (jsonb_typeof(p_input->'territoryKey') is distinct from 'string'
    or v_territory !~ '^[a-z0-9][a-z0-9_-]{0,79}$') then perform private.dw_fail('INVALID_INPUT'); end if;

  v_text:=p_input->>'text';
  if char_length(v_text)>4096 or v_text ~ '[\x01-\x08\x0E-\x1F\x7F]' then perform private.dw_fail('INVALID_INPUT'); end if;
  v_text:=btrim(regexp_replace(normalize(v_text,NFC),
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g'));
  if char_length(v_text) not between 1 and 180 then perform private.dw_fail('INVALID_INPUT'); end if;

  if v_board='objective' then
    select * into v_added from private.dw_flipchart_notes
      where session_id=p_session_id and board='objective' and factor_key=v_key;
  end if;

  if v_added.id is null then
    if (select count(*) from private.dw_flipchart_notes where session_id=p_session_id and board=v_board)>=20000 then
      perform private.dw_fail('LIMIT_EXCEEDED'); end if;
    update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
    insert into private.dw_flipchart_notes(session_id,author_id,kind,text,board,factor_key,updated_cursor)
      values(p_session_id,v_uid,v_kind,v_text,v_board,v_key,v_cursor) returning id into v_id;
  else
    v_id:=v_added.id;
    if v_territory is not null and v_added.kind<>v_kind then perform private.dw_fail('INVALID_INPUT'); end if;
    if v_added.status='withdrawn' then
      if v_added.author_id<>v_uid and private.dw_member_role(p_session_id) is distinct from 'host' then
        perform private.dw_fail('NOTE_WITHDRAWN'); end if;
      update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
      update private.dw_flipchart_notes set status='active',revision=revision+1,updated_cursor=v_cursor
        where session_id=p_session_id and id=v_id;
    end if;
  end if;

  if v_territory is not null then
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
