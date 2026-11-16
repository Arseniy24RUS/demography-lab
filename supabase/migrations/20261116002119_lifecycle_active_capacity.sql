-- Keep the archive addressable while allowing a class to develop several active
-- proposals per participant. The board's existing byte budget remains in place.
create index dw_barriers_active_capacity on private.dw_barriers(session_id) where status='active';
create index dw_solutions_active_capacity on private.dw_solutions(session_id) where status='active';
create index dw_barrier_links_active_capacity on private.dw_barrier_links(session_id) where status='active';

create function private.dw_lifecycle_capacity()
returns trigger language plpgsql set search_path='' as $$
declare
  v_current boolean := private.dw_is_current_workspace(new.session_id);
  v_limit integer;
  v_count bigint;
begin
  if v_current then
    if new.status<>'active' or (tg_op='UPDATE' and old.status='active') then return new; end if;
    v_limit := case when tg_table_name='dw_barrier_links' then 1500 else 500 end;
  else
    if tg_op='UPDATE' then return new; end if;
    v_limit := case when tg_table_name='dw_barrier_links' then 600 else 200 end;
  end if;

  -- The shared session row is also locked by existing lifecycle write RPCs.
  perform 1 from public.dw_sessions where id=new.session_id for update;
  execute format('select count(*) from %s where session_id=$1%s', tg_relid::regclass,
    case when v_current then ' and status=''active''' else '' end)
    into v_count using new.session_id;
  if v_count>=v_limit then perform private.dw_fail('BOARD_LIMIT'); end if;
  return new;
end $$;
revoke all on function private.dw_lifecycle_capacity() from public,anon,authenticated;

create trigger dw_barriers_capacity before insert or update of status on private.dw_barriers
for each row execute function private.dw_lifecycle_capacity();
create trigger dw_solutions_capacity before insert or update of status on private.dw_solutions
for each row execute function private.dw_lifecycle_capacity();
create trigger dw_barrier_links_capacity before insert or update of status on private.dw_barrier_links
for each row execute function private.dw_lifecycle_capacity();

-- Remove the superseded insertion-only checks from the installed function
-- definitions while retaining evidence validation, idempotency and all grants.
do $migration$
declare v_row record; v_definition text; v_guard text;
begin
  for v_row in select * from (values
    ('dw_save_barrier', 'dw_barriers', 200),
    ('dw_import_flipchart_barrier', 'dw_barriers', 200),
    ('dw_save_solution', 'dw_solutions', 200),
    ('dw_save_barrier_link', 'dw_barrier_links', 600)
  ) as old_limits(rpc_name, relation, row_limit) loop
    v_definition := pg_get_functiondef(to_regprocedure(format('private.%I(uuid,uuid,jsonb)',v_row.rpc_name)));
    v_guard := format('if (select count(*) from private.%I where session_id=p_session_id)>=%s then perform private.dw_fail(''BOARD_LIMIT''); end if;',
      v_row.relation,v_row.row_limit);
    if v_definition is null or strpos(v_definition,v_guard)=0 then
      raise exception 'Missing lifecycle limit in %', v_row.rpc_name;
    end if;
    execute replace(v_definition,v_guard,'');
  end loop;
end
$migration$;
