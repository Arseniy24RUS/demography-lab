-- Readable release gate for the hosted database. All fixture identities, notes,
-- votes and receipts are rolled back; no existing workshop identifiers needed.
begin isolation level repeatable read;
set local statement_timeout='45s';
set local lock_timeout='5s';
create temporary table flipchart_release_check(check_name text primary key,result text) on commit drop;
do $$
declare a jsonb; b jsonb; sid uuid; post jsonb; second jsonb; rated jsonb; projected jsonb;
  snapshot jsonb; delta jsonb; hidden jsonb; restored jsonb; command uuid:=gen_random_uuid();
  vote_command uuid:=gen_random_uuid(); prior_cursor bigint; private_before text; private_after text;
  fixture_suffix text:=gen_random_uuid()::text;
begin
  select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'[]')) into private_before from research.responses r;
  a:=public.dw_identify('flipchart-release-a-'||fixture_suffix||'@example.test','Проверка флипчарта А')->'session';
  b:=public.dw_identify('flipchart-release-b-'||fixture_suffix||'@example.test','Проверка флипчарта Б')->'session';
  snapshot:=public.dw_entry_rpc(a->>'access_token','dw_enter_workspace',jsonb_build_object('p_operation_id',gen_random_uuid()));
  sid:=(snapshot#>>'{session,id}')::uuid;
  if snapshot#>>'{session,role}'<>'participant' then raise exception 'flipchart gate: first role'; end if;
  begin
    perform public.dw_entry_rpc(b->>'access_token','dw_flipchart_updates',jsonb_build_object('p_session_id',sid));
    raise exception 'flipchart gate: nonmember was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'FORBIDDEN' then raise; end if;
  end;
  snapshot:=public.dw_entry_rpc(b->>'access_token','dw_enter_workspace',jsonb_build_object('p_operation_id',gen_random_uuid()));
  if (snapshot#>>'{session,id}')::uuid<>sid then raise exception 'flipchart gate: shared workspace'; end if;
  snapshot:=public.dw_entry_rpc(a->>'access_token','dw_flipchart_updates',jsonb_build_object('p_session_id',sid));
  prior_cursor:=(snapshot->>'cursor')::bigint;
  post:=public.dw_entry_rpc(a->>'access_token','dw_flipchart_add',jsonb_build_object(
    'p_operation_id',command,'p_session_id',sid,'p_input',jsonb_build_object('kind','barrier','text','Техническая проверка жилья')));
  second:=public.dw_entry_rpc(a->>'access_token','dw_flipchart_add',jsonb_build_object(
    'p_operation_id',gen_random_uuid(),'p_session_id',sid,'p_input',jsonb_build_object('kind','condition','text','Техническая проверка условий')));
  if post#>>'{note,id}'=second#>>'{note,id}' then raise exception 'flipchart gate: multiple posts'; end if;
  delta:=public.dw_entry_rpc(b->>'access_token','dw_flipchart_updates',jsonb_build_object('p_session_id',sid,'p_after_cursor',prior_cursor));
  if jsonb_array_length(delta->'notes')<>2 or delta->>'reset'<>'false' then raise exception 'flipchart gate: delta'; end if;
  rated:=public.dw_entry_rpc(b->>'access_token','dw_flipchart_vote',jsonb_build_object(
    'p_operation_id',vote_command,'p_session_id',sid,'p_note_id',post#>>'{note,id}',
    'p_expected_revision',0,'p_input',jsonb_build_object('value',1)));
  if rated#>>'{note,support}'<>'1' or rated#>>'{note,myVoteRevision}'<>'1' then raise exception 'flipchart gate: vote'; end if;
  snapshot:=public.dw_entry_rpc(b->>'access_token','dw_flipchart_vote',jsonb_build_object(
    'p_operation_id',vote_command,'p_session_id',sid,'p_note_id',post#>>'{note,id}',
    'p_expected_revision',0,'p_input',jsonb_build_object('value',1)));
  if snapshot<>rated then raise exception 'flipchart gate: receipt'; end if;
  begin
    perform public.dw_entry_rpc(b->>'access_token','dw_flipchart_vote',jsonb_build_object(
      'p_operation_id',gen_random_uuid(),'p_session_id',sid,'p_note_id',post#>>'{note,id}',
      'p_expected_revision',0,'p_input',jsonb_build_object('value',-1)));
    raise exception 'flipchart gate: stale vote was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'REVISION_CONFLICT' then raise; end if;
  end;
  projected:=public.dw_entry_rpc(b->>'access_token','dw_flipchart_updates',jsonb_build_object(
    'p_session_id',sid,'p_after_cursor',prior_cursor,'p_projector',true));
  if exists(select 1 from jsonb_array_elements(projected->'notes') n where n ?| array[
    'authorId','authorName','actorId','actor_id','email','fullName','myVote','myVoteRevision','canWithdraw'])
    or position(a#>>'{user,id}' in projected::text)>0 or position(b#>>'{user,id}' in projected::text)>0 then
    raise exception 'flipchart gate: private metadata in projection'; end if;
  begin
    perform public.dw_entry_rpc(b->>'access_token','dw_flipchart_status',jsonb_build_object(
      'p_operation_id',gen_random_uuid(),'p_session_id',sid,'p_note_id',post#>>'{note,id}',
      'p_expected_revision',1,'p_input',jsonb_build_object('status','withdrawn')));
    raise exception 'flipchart gate: foreign withdrawal was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'FORBIDDEN' then raise; end if;
  end;
  hidden:=public.dw_entry_rpc(a->>'access_token','dw_flipchart_status',jsonb_build_object(
    'p_operation_id',gen_random_uuid(),'p_session_id',sid,'p_note_id',post#>>'{note,id}',
    'p_expected_revision',1,'p_input',jsonb_build_object('status','withdrawn')));
  delta:=public.dw_entry_rpc(b->>'access_token','dw_flipchart_updates',jsonb_build_object(
    'p_session_id',sid,'p_after_cursor',(rated->>'cursor')::bigint));
  if delta->'removedIds'<>jsonb_build_array(post#>>'{note,id}') or jsonb_array_length(delta->'notes')<>0 then
    raise exception 'flipchart gate: withdrawal delta'; end if;
  snapshot:=public.dw_entry_rpc(a->>'access_token','dw_flipchart_add',jsonb_build_object(
    'p_operation_id',command,'p_session_id',sid,'p_input',jsonb_build_object('kind','barrier','text','Техническая проверка жилья')));
  if snapshot#>>'{note,status}'<>'withdrawn' then raise exception 'flipchart gate: stale add revived note'; end if;
  restored:=public.dw_entry_rpc(a->>'access_token','dw_flipchart_status',jsonb_build_object(
    'p_operation_id',gen_random_uuid(),'p_session_id',sid,'p_note_id',post#>>'{note,id}',
    'p_expected_revision',(hidden#>>'{note,revision}')::bigint,'p_input',jsonb_build_object('status','active')));
  if restored#>>'{note,status}'<>'active' or restored#>>'{note,support}'<>'1' then
    raise exception 'flipchart gate: restoration'; end if;
  delta:=public.dw_entry_rpc(b->>'access_token','dw_flipchart_updates',jsonb_build_object(
    'p_session_id',sid,'p_after_cursor',(restored->>'cursor')::bigint));
  if delta->'notes'<>'[]'::jsonb or delta->'removedIds'<>'[]'::jsonb or delta->>'reset'<>'false' then
    raise exception 'flipchart gate: empty polling'; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relname in ('dw_flipchart_state','dw_flipchart_notes','dw_flipchart_votes')
    and (not c.relrowsecurity or has_table_privilege('anon',c.oid,'SELECT') or has_table_privilege('authenticated',c.oid,'SELECT'))) then
    raise exception 'flipchart gate: raw table privileges'; end if;
  select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'[]')) into private_after from research.responses r;
  if private_before is distinct from private_after then raise exception 'flipchart gate: legacy research changed'; end if;
  insert into flipchart_release_check values
    ('ordinary members and unlimited-per-person posts','passed'),
    ('snapshot, delta and empty polling','passed'),
    ('vote CAS and operation replay','passed'),
    ('anonymous projector shape','passed'),
    ('ownership, withdrawal, restoration and stale retry','passed'),
    ('RLS and private table privileges','passed'),
    ('legacy research unchanged','passed');
end $$;
select check_name,result from flipchart_release_check order by check_name;
rollback;
-- The connector returns the last result set. Reached only after every assertion
-- passed and all temporary participants, stickers and votes were rolled back.
select true as passed,7 as assertion_groups,true as rolled_back,'live-flipchart-0.10.0'::text as verification;
