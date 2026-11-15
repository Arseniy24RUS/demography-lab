-- A second board in the existing workshop shares the locking and voting rules.
alter table private.dw_flipchart_notes
  add column board text not null default 'parenthood',
  add column factor_key text,
  add constraint dw_flipchart_note_board check (
    (board='parenthood' and factor_key is null)
    or (board='objective' and factor_key is not null and factor_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$')
  );

create unique index dw_flipchart_objective_factor
  on private.dw_flipchart_notes(session_id,factor_key) where board='objective';
create index dw_flipchart_board_delta
  on private.dw_flipchart_notes(session_id,board,updated_cursor);

create or replace function private.dw_flipchart_note_json(p_session_id uuid,p_note_id uuid,p_viewer uuid,p_projector boolean)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',n.id,'kind',n.kind,'text',n.text,'status',n.status,
    'createdAt',n.created_at,'revision',n.revision,'support',n.support,'oppose',n.oppose,'score',n.support-n.oppose)
    || case when n.factor_key is null then '{}'::jsonb else jsonb_build_object('factorKey',n.factor_key) end
    || case when p_projector then '{}'::jsonb else jsonb_build_object(
      'myVote',v.value,'myVoteRevision',coalesce(v.revision,0),
      'canWithdraw',n.author_id=p_viewer or private.dw_member_role(p_session_id)='host') end
  from private.dw_flipchart_notes n
  left join private.dw_flipchart_votes v on not p_projector and v.session_id=n.session_id
    and v.note_id=n.id and v.actor_id=p_viewer
  where n.session_id=p_session_id and n.id=p_note_id
$$;

-- The declared-email and offline gateways require one public signature per name.
-- Replace the signature; the default preserves calls by older clients.
drop function public.dw_flipchart_updates(uuid,bigint,boolean);
drop function private.dw_flipchart_updates(uuid,bigint,boolean);

create function private.dw_flipchart_updates(p_session_id uuid,p_after_cursor bigint,p_projector boolean,p_board text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  if p_board is null or p_board not in ('parenthood','objective') or p_projector is null
    or p_after_cursor<0 or p_after_cursor>9007199254740991 then perform private.dw_fail('INVALID_INPUT'); end if;

  with state as materialized (
    select coalesce((select cursor from private.dw_flipchart_state where session_id=p_session_id),0) as cursor
  ), mode as materialized (
    select cursor,(p_after_cursor is null or p_after_cursor>cursor) as reset from state
  ), changed as materialized (
    select n.id,n.status,n.created_at from private.dw_flipchart_notes n cross join mode m
    where n.session_id=p_session_id and n.board=p_board and (m.reset and n.status='active'
      or not m.reset and n.updated_cursor>p_after_cursor and n.updated_cursor<=m.cursor)
  )
  select jsonb_build_object('sessionId',p_session_id,'cursor',m.cursor,'reset',m.reset,
    'notes',case when not m.reset and m.cursor=p_after_cursor then '[]'::jsonb else
      coalesce((select jsonb_agg(private.dw_flipchart_note_json(p_session_id,n.id,v_uid,p_projector)
        order by n.created_at,n.id) from changed n where n.status='active'),'[]'::jsonb) end,
    'removedIds',case when m.reset or m.cursor=p_after_cursor then '[]'::jsonb else coalesce((select jsonb_agg(n.id order by n.id)
      from changed n where n.status='withdrawn'),'[]'::jsonb) end)
    into v_result from mode m;
  return v_result;
end $$;

create function public.dw_flipchart_updates(p_session_id uuid,p_after_cursor bigint default null,
  p_projector boolean default false,p_board text default 'parenthood')
returns jsonb language sql stable security invoker set search_path='' as $$
  select private.dw_flipchart_updates($1,$2,$3,$4)
$$;
revoke all on function private.dw_flipchart_updates(uuid,bigint,boolean,text),
  public.dw_flipchart_updates(uuid,bigint,boolean,text) from public,anon,authenticated;
grant execute on function private.dw_flipchart_updates(uuid,bigint,boolean,text),
  public.dw_flipchart_updates(uuid,bigint,boolean,text) to authenticated;

create or replace function private.dw_flipchart_add(p_operation_id uuid,p_session_id uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_text text; v_cursor bigint; v_id uuid; v_replay jsonb;
  v_board text; v_key text; v_added private.dw_flipchart_notes;
  v_payload jsonb:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  v_replay:=private.dw_begin_operation(p_operation_id,'flipchart_add',v_payload);
  perform private.dw_flipchart_lock(p_session_id);
  if not coalesce(private.dw_can_project_workspace(p_session_id),false) then perform private.dw_fail('FORBIDDEN'); end if;
  if v_replay is not null then return private.dw_flipchart_result_json(p_session_id,(v_replay->>'noteId')::uuid,v_uid); end if;

  if p_input is null or not private.dw_keys(p_input,array['kind','text','board','factorKey']) or not(p_input ?& array['kind','text'])
    or coalesce(p_input->>'kind','') not in ('barrier','condition')
    or jsonb_typeof(p_input->'text') is distinct from 'string' then perform private.dw_fail('INVALID_INPUT'); end if;
  v_board:=case when p_input ? 'board' then p_input->>'board' else 'parenthood' end;
  v_key:=p_input->>'factorKey';
  if v_board is null or v_board not in ('parenthood','objective')
    or (v_board='parenthood' and p_input ? 'factorKey')
    or (v_board='objective' and (jsonb_typeof(p_input->'factorKey') is distinct from 'string'
      or v_key !~ '^[a-z0-9][a-z0-9_-]{0,79}$')) then perform private.dw_fail('INVALID_INPUT'); end if;

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
      values(p_session_id,v_uid,p_input->>'kind',v_text,v_board,v_key,v_cursor) returning id into v_id;
  else
    v_id:=v_added.id;
    if v_added.status='withdrawn' then
      if v_added.author_id<>v_uid and private.dw_member_role(p_session_id) is distinct from 'host' then
        perform private.dw_fail('NOTE_WITHDRAWN'); end if;
      update private.dw_flipchart_state set cursor=cursor+1 where session_id=p_session_id returning cursor into v_cursor;
      update private.dw_flipchart_notes set status='active',revision=revision+1,updated_cursor=v_cursor
        where session_id=p_session_id and id=v_id;
    end if;
  end if;

  perform private.dw_finish_operation(p_operation_id,'flipchart_add',v_payload,jsonb_build_object('noteId',v_id));
  return private.dw_flipchart_result_json(p_session_id,v_id,v_uid);
end $$;
