-- Stage 3: expiring regional assignments, reversible grouping, frozen teaching votes.
-- Stage 2 tables, source editions, APIs and identity rules are preserved.
-- All substantive workshop data is private; only minimal invalidation events are public.
create table private.dw_workshop_state (
  session_id uuid primary key references public.dw_sessions(id),
  board_revision bigint not null default 0 check(board_revision >= 0),
  event_cursor bigint not null default 0 check(event_cursor >= 0)
);
insert into private.dw_workshop_state(session_id) select id from public.dw_sessions;
create table private.dw_region_work (
  session_id uuid not null references public.dw_sessions(id),
  region_id text not null check(char_length(region_id) between 1 and 160),
  owner_id uuid references public.dw_profiles(user_id),
  status text not null check(status in ('available','in_progress','completed')),
  lease_expires_at timestamptz,
  completion_note text not null default '' check(char_length(completion_note)<=4000),
  revision bigint not null default 1 check(revision>0),
  updated_at timestamptz not null default now(),
  primary key(session_id,region_id),
  check((status='available' and owner_id is null and lease_expires_at is null)
    or (status='in_progress' and owner_id is not null and lease_expires_at is not null)
    or (status='completed' and owner_id is not null and lease_expires_at is null))
);
create index dw_region_work_owner on private.dw_region_work(owner_id,session_id);
create table private.dw_practice_families (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.dw_sessions(id),
  title text not null check(char_length(btrim(title)) between 1 and 300),
  mechanism text not null check(char_length(btrim(mechanism)) between 1 and 4000),
  rationale text not null check(char_length(btrim(rationale)) between 1 and 4000),
  revision bigint not null default 1 check(revision>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id,id)
);
create table private.dw_family_members (
  session_id uuid not null,
  family_id uuid not null,
  submission_id uuid not null,
  primary key(session_id,submission_id),
  foreign key(session_id,family_id) references private.dw_practice_families(session_id,id) on delete cascade,
  foreign key(session_id,submission_id) references public.dw_submissions(session_id,id)
);
create index dw_family_members_family on private.dw_family_members(session_id,family_id);
create table private.dw_family_history (
  session_id uuid not null references public.dw_sessions(id),
  board_revision bigint not null,
  actor_id uuid not null references public.dw_profiles(user_id),
  operation_id uuid not null,
  families jsonb not null,
  created_at timestamptz not null default now(),
  primary key(session_id,board_revision)
);
create index dw_family_history_actor on private.dw_family_history(actor_id);
create table private.dw_voting_rounds (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.dw_sessions(id),
  title text not null check(char_length(btrim(title)) between 1 and 200),
  status text not null default 'open' check(status in ('open','closed')),
  results_visibility text not null check(results_visibility in ('live','after_close')),
  prompt_text text not null check(char_length(btrim(prompt_text)) between 1 and 1000),
  context_scope text not null check(context_scope in ('municipality','region','federal')),
  context_region_id text,
  evaluation_dimension text not null default 'priority_for_adaptation' check(evaluation_dimension='priority_for_adaptation'),
  min_coverage numeric not null check(min_coverage between 0 and 1),
  min_substantive_votes integer not null check(min_substantive_votes between 1 and 1000),
  eligible_count integer not null check(eligible_count between 1 and 1000),
  family_count integer not null check(family_count between 1 and 200),
  sealed boolean not null default false,
  revision bigint not null default 1 check(revision>0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  unique(session_id,id),
  check((status='open' and closed_at is null) or (status='closed' and closed_at is not null)),
  check(min_substantive_votes<=eligible_count)
);
create unique index dw_one_open_round on private.dw_voting_rounds(session_id) where status='open';
create index dw_voting_rounds_session on private.dw_voting_rounds(session_id,opened_at,id);
create table private.dw_round_families (
  round_id uuid not null references private.dw_voting_rounds(id),
  family_id uuid not null,
  source_family_revision bigint not null,
  title text not null,
  mechanism text not null,
  rationale text not null,
  ordinal integer not null,
  primary key(round_id,family_id)
);
create table private.dw_round_variants (
  round_id uuid not null,
  family_id uuid not null,
  submission_id uuid not null,
  submission_revision bigint not null,
  bundle jsonb not null,
  primary key(round_id,submission_id),
  foreign key(round_id,family_id) references private.dw_round_families(round_id,family_id)
);
create index dw_round_variants_family on private.dw_round_variants(round_id,family_id);
create index dw_round_variants_submission on private.dw_round_variants(submission_id,round_id);
create table private.dw_round_roster (
  round_id uuid not null references private.dw_voting_rounds(id),
  user_id uuid not null references public.dw_profiles(user_id),
  order_seed uuid not null default gen_random_uuid(),
  primary key(round_id,user_id)
);
create index dw_round_roster_user on private.dw_round_roster(user_id,round_id);
create table private.dw_ballots (
  round_id uuid not null,
  family_id uuid not null,
  user_id uuid not null,
  value smallint check(value in (-1,0,1)),
  revision bigint not null default 1 check(revision>0),
  updated_at timestamptz not null default now(),
  primary key(round_id,family_id,user_id),
  foreign key(round_id,family_id) references private.dw_round_families(round_id,family_id),
  foreign key(round_id,user_id) references private.dw_round_roster(round_id,user_id)
);
create index dw_ballots_user on private.dw_ballots(round_id,user_id);
create table public.dw_workshop_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.dw_sessions(id),
  cursor bigint not null check(cursor>0),
  event_type text not null,
  created_at timestamptz not null default now(),
  unique(session_id,cursor)
);

alter table private.dw_workshop_state enable row level security;
alter table private.dw_region_work enable row level security;
alter table private.dw_practice_families enable row level security;
alter table private.dw_family_members enable row level security;
alter table private.dw_family_history enable row level security;
alter table private.dw_voting_rounds enable row level security;
alter table private.dw_round_families enable row level security;
alter table private.dw_round_variants enable row level security;
alter table private.dw_round_roster enable row level security;
alter table private.dw_ballots enable row level security;
alter table public.dw_workshop_events enable row level security;
revoke all on private.dw_workshop_state,private.dw_region_work,private.dw_practice_families,
  private.dw_family_members,private.dw_family_history,private.dw_voting_rounds,private.dw_round_families,
  private.dw_round_variants,private.dw_round_roster,private.dw_ballots from public,anon,authenticated;
revoke all on public.dw_workshop_events from public,anon,authenticated;
grant select on public.dw_workshop_events to authenticated;
create policy dw_workshop_event_read on public.dw_workshop_events for select to authenticated
  using(private.dw_member_role(session_id) is not null);

create function private.dw_workshop_touch(p_session_id uuid,p_type text,p_board_change boolean default false)
returns void language plpgsql set search_path='' as $$
declare v_cursor bigint;
begin
  insert into private.dw_workshop_state(session_id) values(p_session_id) on conflict do nothing;
  update private.dw_workshop_state set event_cursor=event_cursor+1,
    board_revision=board_revision+case when p_board_change then 1 else 0 end
    where session_id=p_session_id returning event_cursor into v_cursor;
  insert into public.dw_workshop_events(session_id,cursor,event_type) values(p_session_id,v_cursor,p_type);
end $$;

-- Compatibility hooks invalidate Stage 3 data when the existing session APIs write relevant data.
-- These hooks never increment dw_sessions.event_cursor, so a vote does not redownload the old board.
create function private.dw_workshop_source_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.dw_workshop_touch(new.session_id,'sources.changed',true);
  return new;
end $$;
create trigger dw_workshop_source_changed after insert or update of bundle,status on public.dw_submissions
  for each row execute function private.dw_workshop_source_changed();
create function private.dw_workshop_session_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    insert into private.dw_workshop_state(session_id) values(new.id) on conflict do nothing;
  elsif (new.title,new.status,new.phase,new.scope,new.region_id) is distinct from
    (old.title,old.status,old.phase,old.scope,old.region_id) then
    perform private.dw_workshop_touch(new.id,'session.changed');
  end if;
  return new;
end $$;
create trigger dw_workshop_session_changed after insert or update of title,status,phase,scope,region_id on public.dw_sessions
  for each row execute function private.dw_workshop_session_changed();
create function private.dw_workshop_member_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.dw_workshop_touch(new.session_id,'membership.changed');
  return new;
end $$;
create trigger dw_workshop_member_changed after insert or update of role,revoked_at on public.dw_memberships
  for each row execute function private.dw_workshop_member_changed();
create function private.dw_workshop_profile_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare v_session uuid;
begin
  if new.full_name is distinct from old.full_name then
    for v_session in select session_id from public.dw_memberships where user_id=new.user_id and revoked_at is null order by session_id loop
      perform private.dw_workshop_touch(v_session,'profile.changed');
    end loop;
  end if;
  return new;
end $$;
create trigger dw_workshop_profile_changed after update of full_name on public.dw_profiles
  for each row execute function private.dw_workshop_profile_changed();

create function private.dw_round_material_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='INSERT' and exists(select 1 from private.dw_voting_rounds where id=new.round_id and not sealed and status='open') then
    return new;
  end if;
  perform private.dw_fail('ROUND_IMMUTABLE'); return old;
end $$;
create trigger dw_round_families_immutable before insert or update or delete on private.dw_round_families
  for each row execute function private.dw_round_material_immutable();
create trigger dw_round_variants_immutable before insert or update or delete on private.dw_round_variants
  for each row execute function private.dw_round_material_immutable();
create trigger dw_round_roster_immutable before insert or update or delete on private.dw_round_roster
  for each row execute function private.dw_round_material_immutable();
create function private.dw_round_metadata_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and not old.sealed and new.sealed and old.status='open'
    and (to_jsonb(old)-'sealed')=(to_jsonb(new)-'sealed') then return new; end if;
  if tg_op='DELETE' or not old.sealed or not new.sealed or old.status<>'open' or new.status<>'closed' or new.closed_at is null
    or new.revision<>old.revision+1
    or (to_jsonb(old)-array['status','revision','closed_at']) is distinct from
       (to_jsonb(new)-array['status','revision','closed_at']) then
    perform private.dw_fail('ROUND_IMMUTABLE');
  end if;
  return new;
end $$;
create trigger dw_round_metadata_immutable before update or delete on private.dw_voting_rounds
  for each row execute function private.dw_round_metadata_immutable();
create function private.dw_ballot_period_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then perform private.dw_fail('ROUND_IMMUTABLE'); end if;
  if not exists(select 1 from private.dw_voting_rounds where id=new.round_id and sealed and status='open') then
    perform private.dw_fail('ROUND_CLOSED'); end if;
  if tg_op='UPDATE' and ((new.round_id,new.family_id,new.user_id) is distinct from (old.round_id,old.family_id,old.user_id)
    or new.revision<>old.revision+1) then perform private.dw_fail('ROUND_IMMUTABLE'); end if;
  return new;
end $$;
create trigger dw_ballot_period_guard before insert or update or delete on private.dw_ballots
  for each row execute function private.dw_ballot_period_guard();
create function private.dw_round_source_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (tg_op='DELETE' or new.bundle is distinct from old.bundle or new.status is distinct from old.status)
    and exists(select 1 from private.dw_round_variants v join private.dw_voting_rounds r on r.id=v.round_id
      where v.submission_id=old.id and r.status='open') then
    perform private.dw_fail('ROUND_OPEN');
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger dw_round_source_guard before update or delete on public.dw_submissions
  for each row execute function private.dw_round_source_guard();

create function private.dw_family_list(p_session_id uuid) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'title',f.title,'mechanism',f.mechanism,
    'rationale',f.rationale,'revision',f.revision,'createdAt',f.created_at,'updatedAt',f.updated_at,
    'submissionIds',coalesce((select jsonb_agg(m.submission_id order by s.created_at,s.id)
      from private.dw_family_members m join public.dw_submissions s on s.id=m.submission_id
      where m.family_id=f.id and s.status='shared'),'[]'::jsonb)) order by f.created_at,f.id),'[]'::jsonb)
  from private.dw_practice_families f where f.session_id=p_session_id
$$;
create function private.dw_round_summary(p_round_id uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',r.id,'title',r.title,'status',r.status,'resultsVisibility',r.results_visibility,
    'promptText',r.prompt_text,'contextScope',r.context_scope,'contextRegionId',r.context_region_id,
    'evaluationDimension',r.evaluation_dimension,'minCoverage',r.min_coverage,'minSubstantiveVotes',r.min_substantive_votes,
    'revision',r.revision,'eligibleCount',r.eligible_count,'familyCount',r.family_count,'openedAt',r.opened_at,'closedAt',r.closed_at)
  from private.dw_voting_rounds r where r.id=p_round_id
$$;
create function private.dw_round_json(p_round_id uuid,p_projector boolean default false) returns jsonb language sql stable set search_path='' as $$
  select private.dw_round_summary(r.id)
    || jsonb_build_object('totalsVisible',r.status='closed' or r.results_visibility='live',
      'participatingCount',(select count(distinct user_id) from private.dw_ballots where round_id=r.id and value is not null),
      'families',coalesce((select jsonb_agg(
        jsonb_build_object('id',f.family_id,'title',f.title,'mechanism',f.mechanism,'rationale',f.rationale,
          'variants',coalesce((select jsonb_agg(jsonb_build_object('submissionId',v.submission_id,
            'submissionRevision',v.submission_revision,'bundle',v.bundle) order by v.submission_id)
            from private.dw_round_variants v where v.round_id=f.round_id and v.family_id=f.family_id),'[]'::jsonb),
          'totals',case when r.status='closed' or r.results_visibility='live' then
            jsonb_build_object('support',b.a,'oppose',b.d,'neutral',b.z,'unanswered',r.eligible_count-b.c,
              'cast',b.c,'score',b.a-b.d,'substantive',b.a+b.d,
              'coverage',b.c::numeric/nullif(r.eligible_count,0),
              'supportRatio',b.a::numeric/nullif(b.a+b.d,0),
              'net',(b.a-b.d)::numeric/nullif(b.a+b.d,0),
              'qualifies',b.c::numeric/nullif(r.eligible_count,0)>=r.min_coverage and b.a+b.d>=r.min_substantive_votes)
            else null end)
        || case when p_projector then '{}'::jsonb else jsonb_build_object('myVote',mine.value,
          'myVoteRevision',coalesce(mine.revision,0)) end
        order by case when p_projector then lpad(f.ordinal::text,8,'0')
          else md5(coalesce(roster.order_seed::text,r.id::text)||':'||f.family_id::text) end, f.family_id)
        from private.dw_round_families f
        cross join lateral (select count(*) filter(where value=1) a,count(*) filter(where value=-1) d,
          count(*) filter(where value=0) z,count(*) filter(where value is not null) c
          from private.dw_ballots where round_id=r.id and family_id=f.family_id) b
        left join private.dw_ballots mine on mine.round_id=r.id and mine.family_id=f.family_id and mine.user_id=auth.uid()
        where f.round_id=r.id),'[]'::jsonb))
    || case when p_projector then '{}'::jsonb else jsonb_build_object('canVote',
      r.status='open' and s.status='open' and s.phase='discussion'
      and private.dw_member_role(s.id) in ('host','participant') and roster.user_id is not null) end
  from private.dw_voting_rounds r join public.dw_sessions s on s.id=r.session_id
  left join private.dw_round_roster roster on roster.round_id=r.id and roster.user_id=auth.uid()
  where r.id=p_round_id
$$;

create function private.dw_workshop_snapshot(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if private.dw_member_role(p_session_id) is null then perform private.dw_fail('FORBIDDEN'); end if;
  select jsonb_build_object('sessionId',s.id,'cursor',w.event_cursor,'boardRevision',w.board_revision,
    'regionWork',coalesce((select jsonb_agg(jsonb_build_object('regionId',x.region_id,'ownerId',x.owner_id,
      'ownerName',p.full_name,'status',x.status,'leaseExpiresAt',x.lease_expires_at,
      'completionNote',x.completion_note,'revision',x.revision,'updatedAt',x.updated_at) order by x.region_id)
      from private.dw_region_work x left join public.dw_profiles p on p.user_id=x.owner_id
      where x.session_id=s.id),'[]'::jsonb),
    'families',private.dw_family_list(s.id),
    'rounds',coalesce((select jsonb_agg(private.dw_round_summary(r.id) order by r.opened_at desc,r.id desc)
      from private.dw_voting_rounds r where r.session_id=s.id),'[]'::jsonb),
    'round',(select private.dw_round_json(r.id,false) from private.dw_voting_rounds r
      where r.session_id=s.id order by r.opened_at desc,r.id desc limit 1)) into v_result
    from public.dw_sessions s join private.dw_workshop_state w on w.session_id=s.id
    where s.id=p_session_id and private.dw_member_role(s.id) is not null;
  if v_result is null then perform private.dw_fail('FORBIDDEN'); end if;
  return v_result;
end $$;
create function private.dw_workshop_cursor(p_session_id uuid) returns bigint language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_cursor bigint;
begin
  select w.event_cursor into v_cursor from private.dw_workshop_state w
    where w.session_id=p_session_id and private.dw_member_role(w.session_id) is not null;
  if not found then perform private.dw_fail('FORBIDDEN'); end if;
  return v_cursor;
end $$;
create function private.dw_workshop_round_snapshot(p_session_id uuid,p_round_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if private.dw_member_role(p_session_id) is null then perform private.dw_fail('FORBIDDEN'); end if;
  select private.dw_round_json(r.id,false) into v_result from private.dw_voting_rounds r
    where r.id=p_round_id and r.session_id=p_session_id and private.dw_member_role(r.session_id) is not null;
  if v_result is null then perform private.dw_fail('NOT_FOUND'); end if;
  return v_result;
end $$;
create function private.dw_workshop_projector_snapshot(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select jsonb_build_object('sessionId',s.id,'title',s.title,'phase',s.phase,'status',s.status,'cursor',w.event_cursor,
    'regionWork',coalesce((select jsonb_agg(jsonb_build_object('regionId',region_id,'status',status,
      'revision',revision,'leaseExpiresAt',lease_expires_at) order by region_id) from private.dw_region_work where session_id=s.id),'[]'::jsonb),
    'familyCount',(select count(*) from private.dw_practice_families where session_id=s.id),
    'groupedSubmissionCount',(select count(*) from private.dw_family_members m join public.dw_submissions x on x.id=m.submission_id
      where m.session_id=s.id and x.status='shared'),
    'round',(select private.dw_round_json(r.id,true) from private.dw_voting_rounds r
      where r.session_id=s.id order by r.opened_at desc,r.id desc limit 1)) into v_result
    from public.dw_sessions s join private.dw_workshop_state w on w.session_id=s.id
    where s.id=p_session_id and private.dw_member_role(s.id)='host';
  if v_result is null then perform private.dw_fail('FORBIDDEN'); end if;
  return v_result;
end $$;

create function private.dw_region_work(p_operation_id uuid,p_session_id uuid,p_region_id text,p_action text,
  p_expected_revision bigint,p_note text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_role text; v_payload jsonb; v_replay jsonb;
  v_session public.dw_sessions; v_work private.dw_region_work; v_exists boolean; v_now timestamptz;
begin
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'regionId',p_region_id,'action',p_action,
    'revision',p_expected_revision,'note',p_note);
  v_replay:=private.dw_begin_operation(p_operation_id,'region_work',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
  if not private.dw_id(to_jsonb(p_region_id)) or coalesce(p_action,'') not in ('claim','release','complete','reopen','renew')
    or p_expected_revision is null or p_expected_revision<0 or not private.dw_text(to_jsonb(p_note),0,4000) then
    perform private.dw_fail('INVALID_INPUT');
  end if;
  if not exists(select 1 from private.source_versions where region_id=p_region_id and sealed) then
    perform private.dw_fail('REGION_UNAVAILABLE');
  end if;
  select * into v_work from private.dw_region_work where session_id=p_session_id and region_id=p_region_id for update;
  v_exists:=found; v_now:=clock_timestamp();
  if p_expected_revision<>(case when v_exists then v_work.revision else 0 end) then
    perform private.dw_fail('REVISION_CONFLICT');
  end if;
  if p_action='claim' then
    if v_exists and (v_work.status='completed'
      or (v_work.status='in_progress' and v_work.lease_expires_at>v_now and v_work.owner_id<>v_uid and v_role<>'host')) then
      perform private.dw_fail('REGION_TAKEN');
    end if;
    insert into private.dw_region_work(session_id,region_id,owner_id,status,lease_expires_at,revision)
      values(p_session_id,p_region_id,v_uid,'in_progress',v_now+interval '30 minutes',1)
      on conflict(session_id,region_id) do update set owner_id=v_uid,status='in_progress',
        lease_expires_at=v_now+interval '30 minutes',completion_note='',revision=private.dw_region_work.revision+1,updated_at=v_now
      returning * into v_work;
  else
    if not v_exists then perform private.dw_fail('NOT_FOUND'); end if;
    if v_work.owner_id is distinct from v_uid and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    if p_action='release' then
      update private.dw_region_work set status='available',owner_id=null,lease_expires_at=null,completion_note='',
        revision=revision+1,updated_at=v_now where session_id=p_session_id and region_id=p_region_id returning * into v_work;
    elsif p_action='reopen' then
      if v_work.status<>'completed' then perform private.dw_fail('INVALID_INPUT'); end if;
      update private.dw_region_work set status='in_progress',owner_id=v_uid,lease_expires_at=v_now+interval '30 minutes',
        completion_note='',revision=revision+1,updated_at=v_now
        where session_id=p_session_id and region_id=p_region_id returning * into v_work;
    else
      if v_work.status<>'in_progress' then perform private.dw_fail('INVALID_INPUT'); end if;
      if v_work.lease_expires_at<=v_now then perform private.dw_fail('LEASE_EXPIRED'); end if;
      if p_action='renew' then
        update private.dw_region_work set lease_expires_at=v_now+interval '30 minutes',revision=revision+1,updated_at=v_now
          where session_id=p_session_id and region_id=p_region_id returning * into v_work;
      else
        if not exists(select 1 from public.dw_submissions where session_id=p_session_id and status='shared'
          and bundle#>>'{practice,regionId}'=p_region_id) and char_length(btrim(p_note))<10 then
          perform private.dw_fail('COMPLETION_NOTE_REQUIRED');
        end if;
        update private.dw_region_work set status='completed',lease_expires_at=null,completion_note=btrim(p_note),
          revision=revision+1,updated_at=v_now where session_id=p_session_id and region_id=p_region_id returning * into v_work;
      end if;
    end if;
  end if;
  perform private.dw_workshop_touch(p_session_id,'region.'||p_action);
  perform private.dw_finish_operation(p_operation_id,'region_work',v_payload,jsonb_build_object('sessionId',p_session_id,'revision',v_work.revision));
  return private.dw_workshop_snapshot(p_session_id);
end $$;

create function private.dw_record_family_history(p_session_id uuid,p_operation_id uuid) returns void language sql set search_path='' as $$
  insert into private.dw_family_history(session_id,board_revision,actor_id,operation_id,families)
    select p_session_id,board_revision,auth.uid(),p_operation_id,private.dw_family_list(p_session_id)
    from private.dw_workshop_state where session_id=p_session_id on conflict do nothing
$$;
create function private.dw_save_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint,
  p_title text,p_mechanism text,p_rationale text,p_submission_ids uuid[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb;
  v_session public.dw_sessions; v_state private.dw_workshop_state; v_family uuid; v_revision bigint;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id,'boardRevision',p_expected_board_revision,
    'title',p_title,'mechanism',p_mechanism,'rationale',p_rationale,'submissionIds',to_jsonb(p_submission_ids));
  v_replay:=private.dw_begin_operation(p_operation_id,'save_family',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if exists(select 1 from private.dw_voting_rounds where session_id=p_session_id and status='open') then
    perform private.dw_fail('ROUND_OPEN'); end if;
  if v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
  select * into v_state from private.dw_workshop_state where session_id=p_session_id for update;
  if p_expected_board_revision is null or p_expected_board_revision<>v_state.board_revision then
    perform private.dw_fail('REVISION_CONFLICT'); end if;
  if not private.dw_text(to_jsonb(p_title),1,300) or btrim(p_title)=''
    or not private.dw_text(to_jsonb(p_mechanism),1,4000) or btrim(p_mechanism)=''
    or not private.dw_text(to_jsonb(p_rationale),1,4000) or btrim(p_rationale)=''
    or p_submission_ids is null or coalesce(array_ndims(p_submission_ids),1)<>1 or cardinality(p_submission_ids)>5000
    or exists(select 1 from unnest(p_submission_ids) x where x is null)
    or (select count(distinct x) from unnest(p_submission_ids) x)<>cardinality(p_submission_ids) then
    perform private.dw_fail('INVALID_INPUT'); end if;
  if (select count(*) from public.dw_submissions where session_id=p_session_id and id=any(p_submission_ids) and status='shared')
    <>cardinality(p_submission_ids) then perform private.dw_fail('FORBIDDEN'); end if;
  if p_family_id is not null and not exists(select 1 from private.dw_practice_families where session_id=p_session_id and id=p_family_id) then
    perform private.dw_fail('NOT_FOUND'); end if;
  if p_family_id is null and (select count(*) from private.dw_practice_families where session_id=p_session_id)>=200 then
    perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  perform private.dw_record_family_history(p_session_id,p_operation_id);
  v_family:=coalesce(p_family_id,gen_random_uuid());
  if p_family_id is null then
    insert into private.dw_practice_families(id,session_id,title,mechanism,rationale)
      values(v_family,p_session_id,btrim(p_title),btrim(p_mechanism),btrim(p_rationale)) returning revision into v_revision;
  else
    update private.dw_practice_families set title=btrim(p_title),mechanism=btrim(p_mechanism),rationale=btrim(p_rationale),
      revision=revision+1,updated_at=clock_timestamp() where id=v_family returning revision into v_revision;
  end if;
  update private.dw_practice_families set revision=revision+1,updated_at=clock_timestamp()
    where session_id=p_session_id and id<>v_family and id in
      (select family_id from private.dw_family_members where session_id=p_session_id and submission_id=any(p_submission_ids));
  delete from private.dw_family_members where session_id=p_session_id and (family_id=v_family or submission_id=any(p_submission_ids));
  insert into private.dw_family_members(session_id,family_id,submission_id)
    select p_session_id,v_family,x from unnest(p_submission_ids) x;
  perform private.dw_workshop_touch(p_session_id,'family.saved',true);
  perform private.dw_record_family_history(p_session_id,p_operation_id);
  insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
    values(p_session_id,v_uid,p_operation_id,'workshop.family.saved',v_family,v_revision);
  perform private.dw_finish_operation(p_operation_id,'save_family',v_payload,jsonb_build_object('sessionId',p_session_id,'familyId',v_family));
  return private.dw_workshop_snapshot(p_session_id);
end $$;
create function private.dw_delete_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb;
  v_session public.dw_sessions; v_state private.dw_workshop_state; v_revision bigint;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id,'boardRevision',p_expected_board_revision);
  v_replay:=private.dw_begin_operation(p_operation_id,'delete_family',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if exists(select 1 from private.dw_voting_rounds where session_id=p_session_id and status='open') then
    perform private.dw_fail('ROUND_OPEN'); end if;
  if v_session.phase not in ('reading','review') then perform private.dw_fail('PHASE_CLOSED'); end if;
  select * into v_state from private.dw_workshop_state where session_id=p_session_id for update;
  if p_expected_board_revision is null or p_expected_board_revision<>v_state.board_revision then
    perform private.dw_fail('REVISION_CONFLICT'); end if;
  select revision into v_revision from private.dw_practice_families where id=p_family_id and session_id=p_session_id;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  perform private.dw_record_family_history(p_session_id,p_operation_id);
  delete from private.dw_practice_families where id=p_family_id and session_id=p_session_id;
  perform private.dw_workshop_touch(p_session_id,'family.deleted',true);
  perform private.dw_record_family_history(p_session_id,p_operation_id);
  insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
    values(p_session_id,v_uid,p_operation_id,'workshop.family.deleted',p_family_id,v_revision);
  perform private.dw_finish_operation(p_operation_id,'delete_family',v_payload,jsonb_build_object('sessionId',p_session_id,'familyId',p_family_id));
  return private.dw_workshop_snapshot(p_session_id);
end $$;

create function private.dw_open_voting_round(p_operation_id uuid,p_session_id uuid,p_title text,p_results_visibility text,
  p_expected_board_revision bigint,p_settings jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb; v_session public.dw_sessions;
  v_state private.dw_workshop_state; v_round uuid:=gen_random_uuid(); v_eligible integer; v_families integer;
  v_settings jsonb:=coalesce(p_settings,'{}'::jsonb); v_prompt text; v_min_coverage numeric:=0.7; v_min_votes numeric;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'title',p_title,'visibility',p_results_visibility,
    'boardRevision',p_expected_board_revision,'settings',v_settings);
  v_replay:=private.dw_begin_operation(p_operation_id,'open_voting_round',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if v_session.phase<>'discussion' then perform private.dw_fail('PHASE_CLOSED'); end if;
  if exists(select 1 from private.dw_voting_rounds where session_id=p_session_id and status='open') then
    perform private.dw_fail('ROUND_OPEN'); end if;
  select * into v_state from private.dw_workshop_state where session_id=p_session_id for update;
  if p_expected_board_revision is null or p_expected_board_revision<>v_state.board_revision then
    perform private.dw_fail('REVISION_CONFLICT'); end if;
  if not private.dw_text(to_jsonb(p_title),1,200) or btrim(p_title)=''
    or coalesce(p_results_visibility,'') not in ('live','after_close')
    or not private.dw_keys(v_settings,array['promptText','minCoverage','minSubstantiveVotes'])
    or octet_length(v_settings::text)>4096 then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_results_visibility='live' and not exists(select 1 from private.dw_voting_rounds where session_id=p_session_id) then
    perform private.dw_fail('FIRST_ROUND_BLIND'); end if;
  if (select count(*) from private.dw_voting_rounds where session_id=p_session_id)>=100 then perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  select count(*) into v_eligible from public.dw_memberships m join auth.users u on u.id=m.user_id
    where m.session_id=p_session_id and m.revoked_at is null and m.role in ('host','participant')
      and u.email_confirmed_at is not null and coalesce(u.is_anonymous,true)=false and coalesce(u.email,'')<>'';
  select count(*) into v_families from private.dw_practice_families f where f.session_id=p_session_id
    and exists(select 1 from private.dw_family_members m join public.dw_submissions s on s.id=m.submission_id
      where m.family_id=f.id and s.status='shared');
  if v_eligible<1 or v_families<1 then perform private.dw_fail('ROUND_NOT_READY'); end if;
  if v_eligible>1000 or v_families>200 then perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  v_prompt:='Считаете ли Вы эту практику приоритетной для адаптации в выбранном контексте?';
  if v_settings?'promptText' then
    if not private.dw_text(v_settings->'promptText',1,1000) or btrim(v_settings->>'promptText')='' then
      perform private.dw_fail('INVALID_INPUT'); end if;
    v_prompt:=btrim(v_settings->>'promptText');
  end if;
  if v_settings?'minCoverage' then
    if jsonb_typeof(v_settings->'minCoverage') is distinct from 'number' then perform private.dw_fail('INVALID_INPUT'); end if;
    v_min_coverage:=(v_settings->>'minCoverage')::numeric;
    if v_min_coverage<0 or v_min_coverage>1 then perform private.dw_fail('INVALID_INPUT'); end if;
  end if;
  v_min_votes:=least(3,v_eligible);
  if v_settings?'minSubstantiveVotes' then
    if jsonb_typeof(v_settings->'minSubstantiveVotes') is distinct from 'number' then perform private.dw_fail('INVALID_INPUT'); end if;
    v_min_votes:=(v_settings->>'minSubstantiveVotes')::numeric;
    if v_min_votes<1 or v_min_votes>v_eligible or trunc(v_min_votes)<>v_min_votes then perform private.dw_fail('INVALID_INPUT'); end if;
  end if;
  insert into private.dw_voting_rounds(id,session_id,title,results_visibility,prompt_text,context_scope,context_region_id,
    min_coverage,min_substantive_votes,eligible_count,family_count,opened_at)
    values(v_round,p_session_id,btrim(p_title),p_results_visibility,v_prompt,v_session.scope,v_session.region_id,
      v_min_coverage,v_min_votes::integer,v_eligible,v_families,clock_timestamp());
  insert into private.dw_round_families(round_id,family_id,source_family_revision,title,mechanism,rationale,ordinal)
    select v_round,f.id,f.revision,f.title,f.mechanism,f.rationale,(row_number() over(order by f.created_at,f.id))::integer
    from private.dw_practice_families f where f.session_id=p_session_id
      and exists(select 1 from private.dw_family_members m join public.dw_submissions s on s.id=m.submission_id
        where m.family_id=f.id and s.status='shared');
  insert into private.dw_round_variants(round_id,family_id,submission_id,submission_revision,bundle)
    select v_round,f.family_id,s.id,s.revision,s.bundle from private.dw_round_families f
      join private.dw_family_members m on m.family_id=f.family_id and m.session_id=p_session_id
      join public.dw_submissions s on s.id=m.submission_id where f.round_id=v_round and s.status='shared';
  insert into private.dw_round_roster(round_id,user_id)
    select v_round,m.user_id from public.dw_memberships m join auth.users u on u.id=m.user_id
    where m.session_id=p_session_id and m.revoked_at is null and m.role in ('host','participant')
      and u.email_confirmed_at is not null and coalesce(u.is_anonymous,true)=false and coalesce(u.email,'')<>'';
  if (select coalesce(sum(octet_length(bundle::text)),0) from private.dw_round_variants where round_id=v_round)>8388608
    or (select coalesce(sum(octet_length(v.bundle::text)),0) from private.dw_round_variants v
      join private.dw_voting_rounds r on r.id=v.round_id where r.session_id=p_session_id)>67108864 then
    perform private.dw_fail('LIMIT_EXCEEDED'); end if;
  update private.dw_voting_rounds set sealed=true where id=v_round;
  perform private.dw_workshop_touch(p_session_id,'round.opened');
  insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
    values(p_session_id,v_uid,p_operation_id,'workshop.round.opened',v_round,1);
  perform private.dw_finish_operation(p_operation_id,'open_voting_round',v_payload,jsonb_build_object('sessionId',p_session_id,'roundId',v_round));
  return private.dw_workshop_snapshot(p_session_id);
end $$;

create function private.dw_close_voting_round(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb; v_round private.dw_voting_rounds;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'roundId',p_round_id,'revision',p_expected_revision);
  v_replay:=private.dw_begin_operation(p_operation_id,'close_voting_round',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  perform 1 from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_round from private.dw_voting_rounds where id=p_round_id and session_id=p_session_id for update;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_round.status<>'open' then perform private.dw_fail('ROUND_CLOSED'); end if;
  if p_expected_revision is null or p_expected_revision<>v_round.revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  update private.dw_voting_rounds set status='closed',closed_at=clock_timestamp(),revision=revision+1 where id=p_round_id
    returning * into v_round;
  perform private.dw_workshop_touch(p_session_id,'round.closed');
  insert into private.audit_events(session_id,actor_id,operation_id,event_type,entity_id,entity_revision)
    values(p_session_id,v_uid,p_operation_id,'workshop.round.closed',p_round_id,v_round.revision);
  perform private.dw_finish_operation(p_operation_id,'close_voting_round',v_payload,jsonb_build_object('sessionId',p_session_id,'roundId',p_round_id));
  return private.dw_workshop_snapshot(p_session_id);
end $$;

create function private.dw_cast_vote(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_family_id uuid,p_value integer,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_replay jsonb; v_role text;
  v_session public.dw_sessions; v_round private.dw_voting_rounds; v_ballot private.dw_ballots; v_exists boolean;
begin
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'roundId',p_round_id,'familyId',p_family_id,'value',p_value,'revision',p_expected_revision);
  v_replay:=private.dw_begin_operation(p_operation_id,'cast_vote',v_payload);
  if v_replay is not null then return private.dw_workshop_snapshot(p_session_id); end if;
  select * into v_session from public.dw_sessions where id=p_session_id for update;
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' then perform private.dw_fail('FORBIDDEN'); end if;
  if v_session.status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if v_session.phase<>'discussion' then perform private.dw_fail('PHASE_CLOSED'); end if;
  select * into v_round from private.dw_voting_rounds where id=p_round_id and session_id=p_session_id for update;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_round.status<>'open' then perform private.dw_fail('ROUND_CLOSED'); end if;
  if not exists(select 1 from private.dw_round_roster where round_id=p_round_id and user_id=v_uid) then
    perform private.dw_fail('NOT_ELIGIBLE'); end if;
  if not exists(select 1 from private.dw_round_families where round_id=p_round_id and family_id=p_family_id) then
    perform private.dw_fail('NOT_FOUND'); end if;
  if p_value is not null and p_value not in (-1,0,1) then perform private.dw_fail('INVALID_INPUT'); end if;
  select * into v_ballot from private.dw_ballots where round_id=p_round_id and family_id=p_family_id and user_id=v_uid for update;
  v_exists:=found;
  if p_expected_revision is null or p_expected_revision<>(case when v_exists then v_ballot.revision else 0 end) then
    perform private.dw_fail('REVISION_CONFLICT'); end if;
  insert into private.dw_ballots(round_id,family_id,user_id,value) values(p_round_id,p_family_id,v_uid,p_value)
    on conflict(round_id,family_id,user_id) do update set value=excluded.value,
      revision=private.dw_ballots.revision+1,updated_at=clock_timestamp() returning * into v_ballot;
  perform private.dw_workshop_touch(p_session_id,'ballot.changed');
  perform private.dw_finish_operation(p_operation_id,'cast_vote',v_payload,
    jsonb_build_object('sessionId',p_session_id,'roundId',p_round_id,'revision',v_ballot.revision));
  return private.dw_workshop_snapshot(p_session_id);
end $$;

-- A caller may identify an already cached immutable round. Only its static material is omitted;
-- current ballots, totals, thresholds, permissions and cursors still come from the same snapshot.
create function private.dw_compact_workshop(p_snapshot jsonb,p_known_round_id uuid) returns jsonb
language sql immutable set search_path='' as $$
  select case when p_known_round_id is not null and p_snapshot#>>'{round,id}'=p_known_round_id::text
    then jsonb_set(p_snapshot,'{round,families}',coalesce((select jsonb_agg(jsonb_set(value,'{variants}','null'::jsonb) order by ordinal)
      from jsonb_array_elements(p_snapshot#>'{round,families}') with ordinality x(value,ordinal)),'[]'::jsonb))
    else p_snapshot end
$$;
create function private.dw_workshop_updates(p_session_id uuid,p_known_round_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid();
begin return private.dw_compact_workshop(private.dw_workshop_snapshot(p_session_id),p_known_round_id); end $$;
create function private.dw_workshop_projector_updates(p_session_id uuid,p_known_round_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid();
begin return private.dw_compact_workshop(private.dw_workshop_projector_snapshot(p_session_id),p_known_round_id); end $$;
create function private.dw_cast_vote_updates(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_family_id uuid,
  p_value integer,p_expected_revision bigint,p_known_round_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid();
begin return private.dw_compact_workshop(private.dw_cast_vote(p_operation_id,p_session_id,p_round_id,p_family_id,p_value,p_expected_revision),p_known_round_id); end $$;

-- Public wrappers are invoker functions; only guarded private entrypoints are granted.
create function public.dw_workshop_snapshot(p_session_id uuid) returns jsonb language sql security invoker set search_path=''
  as $$ select private.dw_workshop_snapshot($1) $$;
create function public.dw_workshop_cursor(p_session_id uuid) returns bigint language sql security invoker set search_path=''
  as $$ select private.dw_workshop_cursor($1) $$;
create function public.dw_workshop_projector_snapshot(p_session_id uuid) returns jsonb language sql security invoker set search_path=''
  as $$ select private.dw_workshop_projector_snapshot($1) $$;
create function public.dw_workshop_round_snapshot(p_session_id uuid,p_round_id uuid) returns jsonb language sql security invoker set search_path=''
  as $$ select private.dw_workshop_round_snapshot($1,$2) $$;
create function public.dw_region_work(p_operation_id uuid,p_session_id uuid,p_region_id text,p_action text,p_expected_revision bigint,p_note text)
  returns jsonb language sql security invoker set search_path='' as $$ select private.dw_region_work($1,$2,$3,$4,$5,$6) $$;
create function public.dw_save_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint,
  p_title text,p_mechanism text,p_rationale text,p_submission_ids uuid[]) returns jsonb language sql security invoker set search_path=''
  as $$ select private.dw_save_family($1,$2,$3,$4,$5,$6,$7,$8) $$;
create function public.dw_delete_family(p_operation_id uuid,p_session_id uuid,p_family_id uuid,p_expected_board_revision bigint)
  returns jsonb language sql security invoker set search_path='' as $$ select private.dw_delete_family($1,$2,$3,$4) $$;
create function public.dw_open_voting_round(p_operation_id uuid,p_session_id uuid,p_title text,p_results_visibility text,
  p_expected_board_revision bigint,p_settings jsonb default '{}') returns jsonb language sql security invoker set search_path=''
  as $$ select private.dw_open_voting_round($1,$2,$3,$4,$5,$6) $$;
create function public.dw_close_voting_round(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_expected_revision bigint)
  returns jsonb language sql security invoker set search_path='' as $$ select private.dw_close_voting_round($1,$2,$3,$4) $$;
create function public.dw_cast_vote(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_family_id uuid,p_value integer,p_expected_revision bigint)
  returns jsonb language sql security invoker set search_path='' as $$ select private.dw_cast_vote($1,$2,$3,$4,$5,$6) $$;
create function public.dw_workshop_updates(p_session_id uuid,p_known_round_id uuid default null) returns jsonb
  language sql security invoker set search_path='' as $$ select private.dw_workshop_updates($1,$2) $$;
create function public.dw_workshop_projector_updates(p_session_id uuid,p_known_round_id uuid default null) returns jsonb
  language sql security invoker set search_path='' as $$ select private.dw_workshop_projector_updates($1,$2) $$;
create function public.dw_cast_vote_updates(p_operation_id uuid,p_session_id uuid,p_round_id uuid,p_family_id uuid,
  p_value integer,p_expected_revision bigint,p_known_round_id uuid default null) returns jsonb
  language sql security invoker set search_path='' as $$ select private.dw_cast_vote_updates($1,$2,$3,$4,$5,$6,$7) $$;

-- Do not revoke the existing Stage 2 authenticated grants when locking down new helpers.
revoke all on all functions in schema private from public,anon;
revoke all on function public.dw_workshop_snapshot(uuid),public.dw_workshop_cursor(uuid),public.dw_workshop_projector_snapshot(uuid),
  public.dw_workshop_round_snapshot(uuid,uuid),public.dw_region_work(uuid,uuid,text,text,bigint,text),
  public.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[]),public.dw_delete_family(uuid,uuid,uuid,bigint),
  public.dw_open_voting_round(uuid,uuid,text,text,bigint,jsonb),public.dw_close_voting_round(uuid,uuid,uuid,bigint),
  public.dw_cast_vote(uuid,uuid,uuid,uuid,integer,bigint),public.dw_workshop_updates(uuid,uuid),
  public.dw_workshop_projector_updates(uuid,uuid),public.dw_cast_vote_updates(uuid,uuid,uuid,uuid,integer,bigint,uuid)
  from public,anon,authenticated;
grant execute on function public.dw_workshop_snapshot(uuid),private.dw_workshop_snapshot(uuid),
  public.dw_workshop_cursor(uuid),private.dw_workshop_cursor(uuid),
  public.dw_workshop_projector_snapshot(uuid),private.dw_workshop_projector_snapshot(uuid),
  public.dw_workshop_round_snapshot(uuid,uuid),private.dw_workshop_round_snapshot(uuid,uuid),
  public.dw_region_work(uuid,uuid,text,text,bigint,text),private.dw_region_work(uuid,uuid,text,text,bigint,text),
  public.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[]),private.dw_save_family(uuid,uuid,uuid,bigint,text,text,text,uuid[]),
  public.dw_delete_family(uuid,uuid,uuid,bigint),private.dw_delete_family(uuid,uuid,uuid,bigint),
  public.dw_open_voting_round(uuid,uuid,text,text,bigint,jsonb),private.dw_open_voting_round(uuid,uuid,text,text,bigint,jsonb),
  public.dw_close_voting_round(uuid,uuid,uuid,bigint),private.dw_close_voting_round(uuid,uuid,uuid,bigint),
  public.dw_cast_vote(uuid,uuid,uuid,uuid,integer,bigint),private.dw_cast_vote(uuid,uuid,uuid,uuid,integer,bigint),
  public.dw_workshop_updates(uuid,uuid),private.dw_workshop_updates(uuid,uuid),
  public.dw_workshop_projector_updates(uuid,uuid),private.dw_workshop_projector_updates(uuid,uuid),
  public.dw_cast_vote_updates(uuid,uuid,uuid,uuid,integer,bigint,uuid),private.dw_cast_vote_updates(uuid,uuid,uuid,uuid,integer,bigint,uuid) to authenticated;

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='dw_workshop_events') then
    alter publication supabase_realtime add table public.dw_workshop_events;
  end if;
end $$;
