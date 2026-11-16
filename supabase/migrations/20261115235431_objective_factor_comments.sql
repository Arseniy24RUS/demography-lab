create table private.dw_objective_factor_comments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.dw_sessions(id) on delete cascade,
  factor_key text not null check (factor_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  territory_key text not null check (territory_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  author_id uuid not null references public.dw_profiles(user_id) on delete cascade,
  text text check (char_length(text) between 1 and 1000),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  unique (session_id, factor_key, territory_key, author_id)
);

alter table private.dw_objective_factor_comments enable row level security;
revoke all on table private.dw_objective_factor_comments from public, anon, authenticated;

create function private.dw_objective_factor_comments(p_session_id uuid, p_factor_key text, p_territory_key text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid := private.dw_verified_uid();
  v_key_pattern constant text := '^[a-z0-9][a-z0-9_-]{0,79}$';
  v_data jsonb;
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id), false) then
    perform private.dw_fail('FORBIDDEN');
  end if;
  if p_factor_key is null or p_factor_key !~ v_key_pattern
    or p_territory_key is null or p_territory_key !~ v_key_pattern then
    perform private.dw_fail('INVALID_INPUT');
  end if;
  select jsonb_build_object(
    'sessionId', p_session_id, 'factorKey', p_factor_key, 'territoryKey', p_territory_key,
    'myRevision', coalesce(max(c.revision) filter (where c.author_id=v_uid), 0),
    'comments', coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'text', c.text, 'mine', c.author_id=v_uid)
       order by c.created_at, c.id) filter (where c.text is not null), '[]'::jsonb)
  ) into v_data
  from private.dw_objective_factor_comments c
  where c.session_id=p_session_id and c.factor_key=p_factor_key and c.territory_key=p_territory_key;
  return v_data;
end $$;

create function private.dw_save_objective_factor_comment(p_operation_id uuid, p_session_id uuid,
    p_factor_key text, p_territory_key text, p_expected_revision bigint, p_text text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid := private.dw_verified_uid();
  v_key_pattern constant text := '^[a-z0-9][a-z0-9_-]{0,79}$';
  v_text text;
  v_previous private.dw_objective_factor_comments;
  v_payload jsonb;
begin
  if not coalesce(private.dw_can_project_workspace(p_session_id), false) then
    perform private.dw_fail('FORBIDDEN');
  end if;
  if p_factor_key is null or p_factor_key !~ v_key_pattern
    or p_territory_key is null or p_territory_key !~ v_key_pattern
    or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740991 then
    perform private.dw_fail('INVALID_INPUT');
  end if;
  if p_text is not null then
    if char_length(p_text)>4096 or p_text ~ '[\x01-\x08\x0E-\x1F\x7F]' then
      perform private.dw_fail('INVALID_INPUT');
    end if;
    v_text := normalize(replace(replace(p_text, E'\r\n', E'\n'), E'\r', E'\n'), NFC);
    v_text := regexp_replace(v_text, U&'^[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+|[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+$', '', 'g');
    if char_length(v_text) not between 1 and 1000 then perform private.dw_fail('INVALID_INPUT'); end if;
  end if;
  v_payload := jsonb_build_array(p_session_id, p_factor_key, p_territory_key, p_expected_revision, v_text);
  if private.dw_begin_operation(p_operation_id, 'objective_factor_comment', v_payload) is not null then
    return private.dw_objective_factor_comments(p_session_id, p_factor_key, p_territory_key);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'dw:objective-comment:'||p_session_id::text||':'||p_factor_key||':'||p_territory_key||':'||v_uid::text, 0));
  if not coalesce(private.dw_can_project_workspace(p_session_id), false) then
    perform private.dw_fail('FORBIDDEN');
  end if;
  select * into v_previous from private.dw_objective_factor_comments
  where session_id=p_session_id and factor_key=p_factor_key and territory_key=p_territory_key and author_id=v_uid;
  if coalesce(v_previous.revision, 0)<>p_expected_revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  if v_previous.text is distinct from v_text then
    if v_previous.id is null then
      insert into private.dw_objective_factor_comments(session_id, factor_key, territory_key, author_id, text)
      values (p_session_id, p_factor_key, p_territory_key, v_uid, v_text);
    else
      update private.dw_objective_factor_comments set text=v_text, revision=revision+1 where id=v_previous.id;
    end if;
  end if;

  perform private.dw_finish_operation(p_operation_id, 'objective_factor_comment', v_payload, '{}'::jsonb);
  return private.dw_objective_factor_comments(p_session_id, p_factor_key, p_territory_key);
end $$;

create function public.dw_objective_factor_comments(p_session_id uuid, p_factor_key text, p_territory_key text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select private.dw_objective_factor_comments($1, $2, $3)
$$;
create function public.dw_save_objective_factor_comment(p_operation_id uuid, p_session_id uuid,
    p_factor_key text, p_territory_key text, p_expected_revision bigint, p_text text)
returns jsonb language sql security invoker set search_path='' as $$
  select private.dw_save_objective_factor_comment($1, $2, $3, $4, $5, $6)
$$;

revoke all on function private.dw_objective_factor_comments(uuid,text,text),
  public.dw_objective_factor_comments(uuid,text,text),
  private.dw_save_objective_factor_comment(uuid,uuid,text,text,bigint,text),
  public.dw_save_objective_factor_comment(uuid,uuid,text,text,bigint,text) from public, anon, authenticated;
grant execute on function private.dw_objective_factor_comments(uuid,text,text),
  public.dw_objective_factor_comments(uuid,text,text),
  private.dw_save_objective_factor_comment(uuid,uuid,text,text,bigint,text),
  public.dw_save_objective_factor_comment(uuid,uuid,text,text,bigint,text) to authenticated;

-- Extend the declared-email gateway's existing method allowlist.
do $migration$
declare v_gateway text := pg_get_functiondef('private.dw_entry_rpc(text,text,jsonb)'::regprocedure);
  v_anchor constant text := '''dw_flipchart_updates''';
begin
  if strpos(v_gateway, v_anchor)=0 then raise exception 'Expected entry RPC allowlist'; end if;
  execute replace(v_gateway, v_anchor, v_anchor||',''dw_objective_factor_comments'',''dw_save_objective_factor_comment''');
end
$migration$;
