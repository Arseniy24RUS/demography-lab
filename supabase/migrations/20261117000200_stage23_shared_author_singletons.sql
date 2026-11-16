-- Every shared author publication in the current workspace is immediately assessable.
-- The marker is internal provenance, not a new public field or a replacement for memberships.
alter table private.dw_practice_families add column automatic_submission_id uuid;
alter table private.dw_practice_families add constraint dw_family_automatic_publication
  foreign key(session_id,automatic_submission_id) references public.dw_submissions(session_id,id);
create index dw_family_automatic_publication on private.dw_practice_families(session_id,automatic_submission_id)
  where automatic_submission_id is not null;

create function private.dw_s23_ensure_author_family(p_session uuid,p_submission uuid,p_operation uuid) returns uuid
language plpgsql set search_path='' as $$
declare source public.dw_submissions%rowtype; family private.dw_practice_families%rowtype;
  v_title text; v_mechanism text; actor uuid; session_status text; changed boolean:=false;
begin
  if not private.dw_is_current_workspace(p_session) then return null; end if;
  select status into session_status from public.dw_sessions where id=p_session for update;
  if not found or session_status is distinct from 'open' or not private.dw_is_current_workspace(p_session) then return null; end if;
  select * into source from public.dw_submissions where session_id=p_session and id=p_submission;
  if not found or source.status<>'shared' or source.bundle ? 'catalogSource' then return null; end if;
  if exists(select 1 from private.dw_voting_rounds where session_id=p_session and status='open') then
    return null;
  end if;
  select f.* into family from private.dw_family_members m join private.dw_practice_families f
    on f.session_id=m.session_id and f.id=m.family_id
    where m.session_id=p_session and m.submission_id=p_submission;
  if found and (family.automatic_submission_id is distinct from p_submission
    or (select count(*) from private.dw_family_members where session_id=p_session and family_id=family.id)<>1) then
    return family.id;
  end if;
  -- Family labels are bounded summaries. The full authored card and its exact sources
  -- remain unchanged even when an older publication exceeds today's editor limits.
  v_title:=coalesce(nullif(btrim(source.bundle#>>'{practice,title}'),''),'Авторская карточка');
  v_mechanism:=coalesce(nullif(btrim(source.bundle#>>'{practice,mechanism}'),''),'Авторское описание меры; полное содержание и источники сохранены в карточке.');
  if char_length(v_title)>300 then v_title:=left(v_title,299)||'…'; end if;
  if char_length(v_mechanism)>4000 then v_mechanism:=left(v_mechanism,3999)||'…'; end if;
  actor:=coalesce(auth.uid(),source.author_id);
  if family.id is null then
    if (select count(*) from private.dw_practice_families where session_id=p_session)>=5000 then
      perform private.dw_fail('LIMIT_EXCEEDED');
    end if;
    changed:=true;
  elsif (family.title,family.mechanism) is distinct from (v_title,v_mechanism) then
    changed:=true;
  end if;
  if not changed then return family.id; end if;
  insert into private.dw_family_history(session_id,board_revision,actor_id,operation_id,families)
    select p_session,board_revision,actor,p_operation,private.dw_family_list(p_session)
      from private.dw_workshop_state where session_id=p_session on conflict do nothing;
  if family.id is null then
    insert into private.dw_practice_families(session_id,title,mechanism,rationale,automatic_submission_id)
      values(p_session,v_title,v_mechanism,'Отдельная авторская карточка; группа создана автоматически при публикации.',p_submission)
      returning * into family;
    insert into private.dw_family_members(session_id,family_id,submission_id) values(p_session,family.id,p_submission);
  else
    update private.dw_practice_families set title=v_title,mechanism=v_mechanism,revision=revision+1,updated_at=clock_timestamp()
      where id=family.id;
  end if;
  perform private.dw_workshop_touch(p_session,'family.saved',true);
  insert into private.dw_family_history(session_id,board_revision,actor_id,operation_id,families)
    select p_session,board_revision,actor,p_operation,private.dw_family_list(p_session)
      from private.dw_workshop_state where session_id=p_session on conflict do nothing;
  insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
    select p_session,actor,p_operation,'workshop.family.automatic',id,revision from private.dw_practice_families where id=family.id;
  return family.id;
end $$;
revoke all on function private.dw_s23_ensure_author_family(uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- Existing guards, payload validation, revision checks and operation receipts stay in
-- the original handlers. Family creation is inside their transaction before the receipt.
do $migration$
declare definition text; anchor text;
begin
  definition:=pg_get_functiondef('private.dw_publish_submission(uuid,uuid,text,bigint,jsonb)'::regprocedure);
  anchor:='perform private.dw_event(p_session_id,p_operation_id,''submission.published'',v_submission.id,v_submission.revision);';
  if strpos(definition,anchor)=0 then raise exception 'Expected guarded publication event'; end if;
  execute replace(definition,anchor,
    'perform private.dw_s23_ensure_author_family(p_session_id,v_submission.id,p_operation_id);'||E'\n  '||anchor);

  definition:=pg_get_functiondef('private.dw_moderate_submission(uuid,uuid,uuid,bigint,text)'::regprocedure);
  anchor:='perform private.dw_event(p_session_id,p_operation_id,''submission.moderated'',p_submission_id,v_submission.revision);';
  if strpos(definition,anchor)=0 then raise exception 'Expected guarded moderation event'; end if;
  execute replace(definition,anchor,
    'perform private.dw_s23_ensure_author_family(p_session_id,p_submission_id,p_operation_id);'||E'\n  '||anchor);

  -- Any explicit curation makes the selected target and affected source families
  -- manual. Republishing an author card can never undo that person's grouping.
  definition:=pg_get_functiondef('private.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[])'::regprocedure);
  anchor:='update private.dw_practice_families set revision=revision+1,updated_at=clock_timestamp()';
  if strpos(definition,anchor)=0 then raise exception 'Expected atomic family transfer'; end if;
  execute replace(definition,anchor,
    'update private.dw_practice_families set automatic_submission_id=null where session_id=p_session_id and (id=v_family or id in'||
      ' (select family_id from private.dw_family_members where session_id=p_session_id and submission_id=any(p_submission_ids)));'||E'\n  '||anchor);
end
$migration$;

-- Reconcile only shared, ungrouped author cards of the current live workspace.
-- Historical sessions, catalogue auto-groups, existing groups and withdrawn cards
-- are left untouched. Frozen rounds are never altered or reopened.
do $backfill$
declare source record; operation uuid:=gen_random_uuid();
begin
  for source in
    select s.session_id,s.id from public.dw_submissions s
    join private.dw_current_workspace current_workspace on current_workspace.session_id=s.session_id
    join public.dw_sessions live_session on live_session.id=s.session_id
    where live_session.status='open' and s.status='shared' and not(s.bundle ? 'catalogSource')
      and not exists(select 1 from private.dw_family_members m where m.session_id=s.session_id and m.submission_id=s.id)
      and not exists(select 1 from private.dw_voting_rounds r where r.session_id=s.session_id and r.status='open')
    order by s.session_id,s.created_at,s.id
  loop
    perform private.dw_s23_ensure_author_family(source.session_id,source.id,operation);
  end loop;
end
$backfill$;
