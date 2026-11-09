-- Stage 4: named deliberation, immutable source evidence, and a logically separate survey.
-- Previous migrations and sealed Stage 3 rounds are not rewritten.
create schema research;
revoke all on schema research from public, anon, authenticated;

create table private.dw_barrier_state (
  session_id uuid primary key references public.dw_sessions(id),
  event_cursor bigint not null default 0 check(event_cursor between 0 and 9007199254740991)
);
insert into private.dw_barrier_state(session_id) select id from public.dw_sessions;
create table private.dw_barriers (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.dw_sessions(id),
  author_id uuid not null references public.dw_profiles(user_id),
  title text not null check(char_length(btrim(title)) between 5 and 240),
  description text not null check(char_length(description)<=4000), primary_stage text not null,
  stage_ids text[] not null, evidence_kind text not null check(evidence_kind in ('observation','hypothesis','survey_summary')),
  status text not null check(status in ('active','archived')), priority boolean not null default false,
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  content_revision bigint not null default 1 check(content_revision between 1 and revision),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(session_id,id),
  check(cardinality(stage_ids) between 1 and 8 and primary_stage=any(stage_ids)
    and stage_ids <@ array['life_plans','first_child','preparation_pregnancy','infancy','early_childhood','preschool','school','next_child'])
);
create index dw_barriers_author on private.dw_barriers(author_id);
create table private.dw_barrier_votes (
  session_id uuid not null, barrier_id uuid not null, user_id uuid not null references public.dw_profiles(user_id),
  value smallint check(value in (-1,0,1)), revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  primary key(barrier_id,user_id), foreign key(session_id,barrier_id) references private.dw_barriers(session_id,id)
);
create index dw_barrier_votes_user on private.dw_barrier_votes(user_id,session_id);
create index dw_barrier_votes_session on private.dw_barrier_votes(session_id,barrier_id);
create table private.dw_barrier_evidence (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.dw_sessions(id),
  family_id uuid not null, fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
  material jsonb not null check(jsonb_typeof(material)='object' and octet_length(material::text)<=8388608),
  unique(session_id,family_id,fingerprint), unique(session_id,id)
);
create table private.dw_barrier_links (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.dw_sessions(id),
  barrier_id uuid not null, family_id uuid not null, author_id uuid not null references public.dw_profiles(user_id),
  relationship text not null check(relationship in ('potential','partial','needs_adaptation')),
  explanation text not null check(char_length(btrim(explanation)) between 10 and 4000),
  prerequisites text not null check(char_length(prerequisites)<=4000),
  status text not null check(status in ('active','archived')), revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  barrier_content_revision bigint not null check(barrier_content_revision>0), evidence_id uuid not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(session_id,barrier_id) references private.dw_barriers(session_id,id),
  foreign key(session_id,evidence_id) references private.dw_barrier_evidence(session_id,id)
);
create index dw_barrier_links_session on private.dw_barrier_links(session_id,barrier_id);
create index dw_barrier_links_evidence on private.dw_barrier_links(session_id,evidence_id);
create index dw_barrier_links_author on private.dw_barrier_links(author_id);
create table private.dw_solutions (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.dw_sessions(id),
  author_id uuid not null references public.dw_profiles(user_id), barrier_ids uuid[] not null check(cardinality(barrier_ids) between 1 and 20),
  title text not null check(char_length(btrim(title)) between 5 and 240),
  target_group text not null check(char_length(btrim(target_group)) between 3 and 1000),
  mechanism text not null check(char_length(btrim(mechanism)) between 10 and 4000),
  first_step text not null check(char_length(btrim(first_step)) between 3 and 2000),
  responsible text not null check(char_length(btrim(responsible)) between 3 and 2000),
  resources text not null check(char_length(btrim(resources)) between 3 and 2000),
  success_indicator text not null check(char_length(btrim(success_indicator)) between 3 and 2000),
  risks text not null check(char_length(risks)<=2000), status text not null check(status in ('active','archived')),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index dw_solutions_session on private.dw_solutions(session_id);
create index dw_solutions_author on private.dw_solutions(author_id);
create table public.dw_barrier_events (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.dw_sessions(id),
  cursor bigint not null check(cursor>0), event_type text not null, created_at timestamptz not null default now(),
  unique(session_id,cursor)
);

-- Survey answers have no identity foreign key, precise response timestamp, or actor ledger.
create table research.surveys (
  id uuid primary key default gen_random_uuid(), session_id uuid not null references public.dw_sessions(id),
  title text not null, purpose text not null, organizer_contact text not null, retention_until date not null,
  status text not null default 'draft' check(status in ('draft','open','closed','purged')),
  invitation_digest text not null check(invitation_digest ~ '^[a-f0-9]{64}$'),
  questions jsonb not null, question_version bigint not null default 1 check(question_version between 1 and 9007199254740991),
  revision bigint not null default 1 check(revision between 1 and 9007199254740991)
);
create unique index dw_survey_one_current on research.surveys(session_id) where status<>'purged';
create index dw_survey_session on research.surveys(session_id);
create table research.responses (
  id uuid primary key default gen_random_uuid(), survey_id uuid not null references research.surveys(id),
  secret_digest text not null check(secret_digest ~ '^[a-f0-9]{64}$'),
  status text not null check(status in ('submitted','withdrawn')), revision bigint not null check(revision between 1 and 9007199254740991),
  question_version bigint not null check(question_version>0), response_date date not null,
  answers jsonb, unique(survey_id,secret_digest),
  check((status='withdrawn' and answers is null) or (status='submitted' and jsonb_typeof(answers)='object'))
);
create table research.response_receipts (
  survey_id uuid not null references research.surveys(id), secret_digest text not null,
  operation_id uuid not null, operation_type text not null check(operation_type in ('save','withdraw')),
  request_hash text not null, result_revision bigint not null,
  primary key(survey_id,secret_digest,operation_id)
);

alter table private.dw_barrier_state enable row level security;
alter table private.dw_barriers enable row level security;
alter table private.dw_barrier_votes enable row level security;
alter table private.dw_barrier_evidence enable row level security;
alter table private.dw_barrier_links enable row level security;
alter table private.dw_solutions enable row level security;
alter table research.surveys enable row level security;
alter table research.responses enable row level security;
alter table research.response_receipts enable row level security;
alter table public.dw_barrier_events enable row level security;
revoke all on private.dw_barrier_state,private.dw_barriers,private.dw_barrier_votes,private.dw_barrier_evidence,
  private.dw_barrier_links,private.dw_solutions,research.surveys,research.responses,research.response_receipts,
  public.dw_barrier_events from public,anon,authenticated;
grant select on public.dw_barrier_events to authenticated;
create policy dw_barrier_event_read on public.dw_barrier_events for select to authenticated
  using(private.dw_member_role(session_id) is not null);

create function private.dw_s4_integer(p_value jsonb,p_min bigint default 0) returns boolean language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_value)='number' and (p_value#>>'{}') ~ '^[0-9]{1,16}$'
    then (p_value#>>'{}')::numeric between p_min and 9007199254740991 else false end
$$;
create function private.dw_s4_uuid(p_value jsonb) returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='string' and (p_value#>>'{}') ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false)
$$;
create function private.dw_s4_required(p_value jsonb,p_keys text[]) returns boolean language sql immutable set search_path='' as $$
  select coalesce(private.dw_keys(p_value,p_keys) and p_value ?& p_keys,false)
$$;
create function private.dw_s4_text(p_value jsonb,p_min integer,p_max integer) returns boolean language sql immutable set search_path='' as $$
  select private.dw_text(p_value,p_min,p_max) and char_length(btrim(p_value#>>'{}'))>=p_min
$$;
create function private.dw_s4_digest(p_domain text,p_secret text) returns text language sql immutable set search_path='' as $$
  select encode(sha256(convert_to(p_domain||':'||p_secret,'UTF8')),'hex')
$$;
create function private.dw_barrier_touch(p_session_id uuid,p_type text) returns void language plpgsql set search_path='' as $$
declare v_cursor bigint;
begin
  insert into private.dw_barrier_state(session_id) values(p_session_id) on conflict do nothing;
  update private.dw_barrier_state set event_cursor=event_cursor+1 where session_id=p_session_id returning event_cursor into v_cursor;
  insert into public.dw_barrier_events(session_id,cursor,event_type) values(p_session_id,v_cursor,p_type);
end $$;

-- Invitation reconciliation is metadata-only; it must never auto-fetch raw survey answers.
create function private.dw_survey_invitation_state(p_session_id uuid,p_survey_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select jsonb_build_object('surveyId',s.id,'invitationDigest',s.invitation_digest) into v_result
    from research.surveys s where s.session_id=p_session_id and s.id=p_survey_id;
  if v_result is null then perform private.dw_fail('NOT_FOUND'); end if;
  return v_result;
end $$;
revoke all on function private.dw_survey_invitation_state(uuid,uuid) from public,anon,authenticated;
create function public.dw_survey_invitation_state(p_session_id uuid,p_survey_id uuid) returns jsonb language sql security invoker set search_path=''
  as $$ select private.dw_survey_invitation_state($1,$2) $$;
revoke all on function public.dw_survey_invitation_state(uuid,uuid) from public,anon,authenticated;
grant execute on function public.dw_survey_invitation_state(uuid,uuid),private.dw_survey_invitation_state(uuid,uuid) to authenticated;
-- Bridge existing notifications once per committed Stage 3 source/family/member/session change.
-- Ballots, voting rounds and lease changes deliberately do not invalidate Stage 4 material.
create function private.dw_barrier_workshop_bridge() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.event_type in ('sources.changed','session.changed','membership.changed','profile.changed','family.saved','family.deleted') then
    perform private.dw_barrier_touch(new.session_id,new.event_type);
  end if;
  return new;
end $$;
create trigger dw_barrier_workshop_bridge after insert on public.dw_workshop_events for each row execute function private.dw_barrier_workshop_bridge();
create function private.dw_barrier_session_created() returns trigger language plpgsql security definer set search_path='' as $$
begin insert into private.dw_barrier_state(session_id) values(new.id) on conflict do nothing; return new; end $$;
create trigger dw_barrier_session_created after insert on public.dw_sessions for each row execute function private.dw_barrier_session_created();
create function private.dw_barrier_evidence_immutable() returns trigger language plpgsql set search_path='' as $$
begin perform private.dw_fail('EVIDENCE_IMMUTABLE'); return old; end $$;
create trigger dw_barrier_evidence_immutable before update or delete on private.dw_barrier_evidence
  for each row execute function private.dw_barrier_evidence_immutable();

create function private.dw_barrier_write_guard(p_session_id uuid,p_host boolean default false) returns text
language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_role text; v_status text;
begin
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' or (p_host and v_role<>'host') then perform private.dw_fail('FORBIDDEN'); end if;
  select status into v_status from public.dw_sessions where id=p_session_id for update;
  v_role:=private.dw_member_role(p_session_id);
  if v_role is null or v_role='observer' or (p_host and v_role<>'host') then perform private.dw_fail('FORBIDDEN'); end if;
  if v_status is distinct from 'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  return v_role;
end $$;
create function private.dw_barrier_family_material(p_session_id uuid,p_family_id uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('familyId',f.id,'familyRevision',f.revision,'title',f.title,'mechanism',f.mechanism,'rationale',f.rationale,
    'variants',(select jsonb_agg(jsonb_build_object('submissionId',s.id,'submissionRevision',s.revision,'bundle',s.bundle) order by s.id)
      from private.dw_family_members m join public.dw_submissions s on s.id=m.submission_id and s.session_id=m.session_id
      where m.session_id=f.session_id and m.family_id=f.id and s.status='shared'))
  from private.dw_practice_families f where f.session_id=p_session_id and f.id=p_family_id
    and exists(select 1 from private.dw_family_members m join public.dw_submissions s on s.id=m.submission_id
      where m.family_id=f.id and s.status='shared')
$$;
create function private.dw_barrier_family_options(p_session_id uuid) returns jsonb language sql stable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'title',f.title,'mechanism',f.mechanism,'revision',f.revision,
    'fingerprint',encode(sha256(convert_to(m.material::text,'UTF8')),'hex'),
    'variantCount',jsonb_array_length(m.material->'variants'),
    'regionNames',(select jsonb_agg(n.name order by n.name) from (select distinct
      coalesce((select regexp_replace(v.title,'^Региональная программа по повышению рождаемости: ','')
        from private.source_versions v where v.version_id=x->'bundle'->'sources'->0->>'editionId'),x->'bundle'->'practice'->>'regionId') as name
        from jsonb_array_elements(m.material->'variants') x) n)) order by f.created_at,f.id),'[]'::jsonb)
  from private.dw_practice_families f cross join lateral (select private.dw_barrier_family_material(p_session_id,f.id) as material) m
  where f.session_id=p_session_id and m.material is not null
$$;

create function private.dw_survey_manifest_json(p_survey_id uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',s.id,'title',s.title,'purpose',s.purpose,'organizerContact',s.organizer_contact,
    'retentionUntil',s.retention_until,'status',s.status,'expired',s.retention_until<(now() at time zone 'UTC')::date,
    'canRespond',s.status='open' and s.retention_until>=(now() at time zone 'UTC')::date
      and exists(select 1 from public.dw_sessions x where x.id=s.session_id and x.status='open'),
    'questionVersion',s.question_version,'questionnaireVersion','demography-open-1','procedureVersion','classroom-open-link-1','questions',s.questions)
  from research.surveys s where s.id=p_survey_id
$$;
create function private.dw_survey_summary_json(p_survey_id uuid) returns jsonb language sql stable set search_path='' as $$
  select private.dw_survey_manifest_json(s.id)||jsonb_build_object('revision',s.revision,'responseCount',
    case when s.retention_until>=(now() at time zone 'UTC')::date and s.status<>'purged'
      then (select case when count(*)>=5 then count(*) else null end from research.responses r where r.survey_id=s.id and r.status='submitted') else null end)
  from research.surveys s where s.id=p_survey_id
$$;
create function private.dw_barriers_json(p_session_id uuid,p_projector boolean default false) returns jsonb language sql stable set search_path='' as $$
  with family_options as materialized (select private.dw_barrier_family_options(p_session_id) as items)
  select jsonb_build_object('sessionId',s.id,'cursor',bs.event_cursor,
    'barriers',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'title',b.title,'description',b.description,'primaryStage',b.primary_stage,
      'stageIds',b.stage_ids,'evidenceKind',b.evidence_kind,'status',b.status,'priority',b.priority,'revision',b.revision,'contentRevision',b.content_revision,
      'createdAt',b.created_at,'updatedAt',b.updated_at,'authorName',case when not p_projector or s.projector_show_authors then p.full_name else null end,
      'totals',(select jsonb_build_object('support',count(*) filter(where v.value=1),'oppose',count(*) filter(where v.value=-1),
        'neutral',count(*) filter(where v.value=0),'cast',count(*) filter(where v.value is not null))
        from private.dw_barrier_votes v join public.dw_memberships mm on mm.session_id=v.session_id and mm.user_id=v.user_id
        where v.barrier_id=b.id and mm.revoked_at is null and mm.role in ('host','participant')))
      ||case when p_projector then '{}'::jsonb else jsonb_build_object('authorId',b.author_id,
        'myVote',(select value from private.dw_barrier_votes where barrier_id=b.id and user_id=auth.uid()),
        'myVoteRevision',coalesce((select revision from private.dw_barrier_votes where barrier_id=b.id and user_id=auth.uid()),0)) end
      order by b.created_at,b.id) from private.dw_barriers b join public.dw_profiles p on p.user_id=b.author_id where b.session_id=s.id),'[]'::jsonb),
    'families',fo.items,
    'links',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'barrierId',l.barrier_id,'familyId',l.family_id,'relationship',l.relationship,
      'explanation',l.explanation,'prerequisites',l.prerequisites,'status',l.status,'revision',l.revision,'barrierContentRevision',l.barrier_content_revision,
      'evidenceId',l.evidence_id,'familyFingerprint',e.fingerprint,'familyTitle',e.material->>'title','createdAt',l.created_at,'updatedAt',l.updated_at,
      'authorName',case when not p_projector or s.projector_show_authors then p.full_name else null end,
      'staleReasons',to_jsonb(array_remove(array[
        case when b.content_revision<>l.barrier_content_revision then 'barrier_changed' end,
        case when b.status<>'active' then 'barrier_archived' end,
        case when cf.fingerprint is null then 'family_missing'
          when cf.fingerprint<>e.fingerprint then 'family_changed' end],null)))
      ||case when p_projector then '{}'::jsonb else jsonb_build_object('authorId',l.author_id) end order by l.created_at,l.id)
      from private.dw_barrier_links l join private.dw_barriers b on b.id=l.barrier_id join private.dw_barrier_evidence e on e.id=l.evidence_id
      left join lateral (select x->>'fingerprint' as fingerprint from jsonb_array_elements(fo.items) x where x->>'id'=l.family_id::text) cf on true
      join public.dw_profiles p on p.user_id=l.author_id where l.session_id=s.id),'[]'::jsonb),
    'solutions',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'barrierIds',a.barrier_ids,'title',a.title,'targetGroup',a.target_group,
      'mechanism',a.mechanism,'firstStep',a.first_step,'responsible',a.responsible,'resources',a.resources,'successIndicator',a.success_indicator,
      'risks',a.risks,'status',a.status,'revision',a.revision,'createdAt',a.created_at,'updatedAt',a.updated_at,
      'authorName',case when not p_projector or s.projector_show_authors then p.full_name else null end)
      ||case when p_projector then '{}'::jsonb else jsonb_build_object('authorId',a.author_id) end order by a.created_at,a.id)
      from private.dw_solutions a join public.dw_profiles p on p.user_id=a.author_id where a.session_id=s.id),'[]'::jsonb),
    'survey',(select case when p_projector then jsonb_build_object('title',q.title,'status',q.status,'responseCount',private.dw_survey_summary_json(q.id)->'responseCount')
      else private.dw_survey_summary_json(q.id) end from research.surveys q where q.session_id=s.id and q.status<>'purged'))
    ||case when p_projector then jsonb_build_object('title',s.title,'scope',s.scope,'regionId',s.region_id,'phase',s.phase,'status',s.status) else '{}'::jsonb end
  from public.dw_sessions s join private.dw_barrier_state bs on bs.session_id=s.id cross join family_options fo where s.id=p_session_id
$$;
create function private.dw_barriers_snapshot(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_result jsonb;
begin
  if private.dw_member_role(p_session_id) is null then perform private.dw_fail('FORBIDDEN'); end if;
  v_result:=private.dw_barriers_json(p_session_id,false);
  if octet_length(v_result::text)>8388608 then perform private.dw_fail('BOARD_LIMIT'); end if;
  return v_result;
end $$;
create function private.dw_barriers_cursor(p_session_id uuid) returns bigint language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_cursor bigint;
begin
  if private.dw_member_role(p_session_id) is null then perform private.dw_fail('FORBIDDEN'); end if;
  select event_cursor into v_cursor from private.dw_barrier_state where session_id=p_session_id; return v_cursor;
end $$;
create function private.dw_barriers_projector_snapshot(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid();
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  return private.dw_barriers_json(p_session_id,true);
end $$;
create function private.dw_barrier_evidence(p_session_id uuid,p_evidence_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_e private.dw_barrier_evidence;
begin
  if private.dw_member_role(p_session_id) is null then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_e from private.dw_barrier_evidence where session_id=p_session_id and id=p_evidence_id;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  return v_e.material||jsonb_build_object('id',v_e.id,'sessionId',v_e.session_id,'fingerprint',v_e.fingerprint);
end $$;

create function private.dw_save_barrier(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_payload jsonb; v_old private.dw_barriers; v_id uuid; v_stages text[]; v_changed boolean;
begin
  v_role:=private.dw_barrier_write_guard(p_session_id);
  v_payload:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  if private.dw_begin_operation(p_operation_id,'barrier.save',v_payload) is not null then return private.dw_barriers_snapshot(p_session_id); end if;
  if not private.dw_s4_required(p_input,array['barrierId','expectedRevision','title','description','primaryStage','stageIds','evidenceKind','status','priority'])
    or not (p_input->'barrierId'='null'::jsonb or private.dw_s4_uuid(p_input->'barrierId'))
    or not private.dw_s4_integer(p_input->'expectedRevision') or not private.dw_s4_text(p_input->'title',5,240)
    or not private.dw_text(p_input->'description',0,4000) or jsonb_typeof(p_input->'stageIds')<>'array'
    or not private.dw_text(p_input->'primaryStage',1,40) or jsonb_typeof(p_input->'priority')<>'boolean'
    or coalesce(p_input->>'evidenceKind','') not in ('observation','hypothesis','survey_summary')
    or coalesce(p_input->>'status','') not in ('active','archived') then perform private.dw_fail('INVALID_INPUT'); end if;
  if exists(select 1 from jsonb_array_elements(p_input->'stageIds') x where jsonb_typeof(x)<>'string') then perform private.dw_fail('INVALID_INPUT'); end if;
  select array_agg(x) into v_stages from jsonb_array_elements_text(p_input->'stageIds') x;
  if coalesce(cardinality(v_stages),0) not between 1 and 8
    or not v_stages <@ array['life_plans','first_child','preparation_pregnancy','infancy','early_childhood','preschool','school','next_child']
    or not (p_input->>'primaryStage'=any(v_stages))
    or cardinality(v_stages)<>(select count(distinct x) from unnest(v_stages) x) then perform private.dw_fail('INVALID_INPUT'); end if;
  v_id:=(p_input->>'barrierId')::uuid;
  if v_id is null then
    if (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if (p_input->>'priority')::boolean and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    if (select count(*) from private.dw_barriers where session_id=p_session_id)>=200 then perform private.dw_fail('BOARD_LIMIT'); end if;
    insert into private.dw_barriers(session_id,author_id,title,description,primary_stage,stage_ids,evidence_kind,status,priority)
      values(p_session_id,auth.uid(),p_input->>'title',p_input->>'description',p_input->>'primaryStage',v_stages,
        p_input->>'evidenceKind',p_input->>'status',(p_input->>'priority')::boolean) returning id into v_id;
  else
    select * into v_old from private.dw_barriers where session_id=p_session_id and id=v_id;
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if v_old.author_id<>auth.uid() and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    if v_old.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if v_old.priority is distinct from (p_input->>'priority')::boolean and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    v_changed:=(v_old.title,v_old.description,v_old.primary_stage,v_old.stage_ids,v_old.evidence_kind,v_old.status)
      is distinct from (p_input->>'title',p_input->>'description',p_input->>'primaryStage',v_stages,p_input->>'evidenceKind',p_input->>'status');
    update private.dw_barriers set title=p_input->>'title',description=p_input->>'description',primary_stage=p_input->>'primaryStage',stage_ids=v_stages,
      evidence_kind=p_input->>'evidenceKind',status=p_input->>'status',priority=(p_input->>'priority')::boolean,
      revision=revision+1,content_revision=content_revision+case when v_changed then 1 else 0 end,updated_at=now() where id=v_id;
  end if;
  perform private.dw_barrier_touch(p_session_id,'barrier.saved');
  perform private.dw_finish_operation(p_operation_id,'barrier.save',v_payload,jsonb_build_object('id',v_id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;
create function private.dw_barrier_vote(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_payload jsonb; v_id uuid; v_value smallint; v_revision bigint;
begin
  perform private.dw_barrier_write_guard(p_session_id);
  v_payload:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  if private.dw_begin_operation(p_operation_id,'barrier.vote',v_payload) is not null then return private.dw_barriers_snapshot(p_session_id); end if;
  if not private.dw_s4_required(p_input,array['barrierId','expectedRevision','value']) or not private.dw_s4_uuid(p_input->'barrierId')
    or not private.dw_s4_integer(p_input->'expectedRevision') or p_input->'value' not in ('null'::jsonb,'-1'::jsonb,'0'::jsonb,'1'::jsonb)
    then perform private.dw_fail('INVALID_INPUT'); end if;
  v_id:=(p_input->>'barrierId')::uuid; v_value:=(p_input->>'value')::smallint;
  if not exists(select 1 from private.dw_barriers where session_id=p_session_id and id=v_id and status='active') then perform private.dw_fail('NOT_FOUND'); end if;
  select revision into v_revision from private.dw_barrier_votes where barrier_id=v_id and user_id=auth.uid();
  if coalesce(v_revision,0)<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
  insert into private.dw_barrier_votes(session_id,barrier_id,user_id,value) values(p_session_id,v_id,auth.uid(),v_value)
    on conflict(barrier_id,user_id) do update set value=excluded.value,revision=private.dw_barrier_votes.revision+1;
  perform private.dw_barrier_touch(p_session_id,'barrier.vote');
  perform private.dw_finish_operation(p_operation_id,'barrier.vote',v_payload,jsonb_build_object('id',v_id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;
create function private.dw_save_barrier_link(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_payload jsonb; v_old private.dw_barrier_links; v_id uuid; v_barrier private.dw_barriers;
  v_material jsonb; v_fingerprint text; v_evidence uuid; v_family uuid;
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
    or not private.dw_s4_text(p_input->'explanation',10,4000) or not private.dw_text(p_input->'prerequisites',0,4000)
    or coalesce(p_input->>'status','') not in ('active','archived') then perform private.dw_fail('INVALID_INPUT'); end if;
  v_id:=(p_input->>'linkId')::uuid; v_family:=(p_input->>'familyId')::uuid;
  if v_id is not null then
    select * into v_old from private.dw_barrier_links where session_id=p_session_id and id=v_id;
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if v_old.author_id<>auth.uid() and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    if v_old.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if (v_old.barrier_id,v_old.family_id) is distinct from ((p_input->>'barrierId')::uuid,v_family) then perform private.dw_fail('INVALID_INPUT'); end if;
  elsif (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT');
  elsif (select count(*) from private.dw_barrier_links where session_id=p_session_id)>=600 then perform private.dw_fail('BOARD_LIMIT'); end if;
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
    select id into v_evidence from private.dw_barrier_evidence where session_id=p_session_id and family_id=v_family and fingerprint=v_fingerprint;
    if v_evidence is null then
      if octet_length(v_material::text)>8388608 or coalesce((select sum(octet_length(material::text)) from private.dw_barrier_evidence where session_id=p_session_id),0)
        +octet_length(v_material::text)>67108864 then perform private.dw_fail('EVIDENCE_LIMIT'); end if;
      insert into private.dw_barrier_evidence(session_id,family_id,fingerprint,material) values(p_session_id,v_family,v_fingerprint,v_material) returning id into v_evidence;
    end if;
    if v_id is null then
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
create function private.dw_save_solution(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_payload jsonb; v_old private.dw_solutions; v_id uuid; v_barriers uuid[]; v_field text;
begin
  v_role:=private.dw_barrier_write_guard(p_session_id);
  v_payload:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  if private.dw_begin_operation(p_operation_id,'barrier.solution',v_payload) is not null then return private.dw_barriers_snapshot(p_session_id); end if;
  if not private.dw_s4_required(p_input,array['solutionId','expectedRevision','barrierIds','title','targetGroup','mechanism','firstStep','responsible','resources','successIndicator','risks','status'])
    or not (p_input->'solutionId'='null'::jsonb or private.dw_s4_uuid(p_input->'solutionId'))
    or not private.dw_s4_integer(p_input->'expectedRevision') or jsonb_typeof(p_input->'barrierIds')<>'array'
    or not private.dw_s4_text(p_input->'title',5,240) or not private.dw_s4_text(p_input->'targetGroup',3,1000)
    or not private.dw_s4_text(p_input->'mechanism',10,4000) or not private.dw_text(p_input->'risks',0,2000)
    or coalesce(p_input->>'status','') not in ('active','archived') then perform private.dw_fail('INVALID_INPUT'); end if;
  foreach v_field in array array['firstStep','responsible','resources','successIndicator'] loop
    if not private.dw_s4_text(p_input->v_field,3,2000) then perform private.dw_fail('INVALID_INPUT'); end if;
  end loop;
  if jsonb_array_length(p_input->'barrierIds') not between 1 and 20
    or exists(select 1 from jsonb_array_elements(p_input->'barrierIds') x where not private.dw_s4_uuid(x)) then perform private.dw_fail('INVALID_INPUT'); end if;
  select array_agg(x::uuid) into v_barriers from jsonb_array_elements_text(p_input->'barrierIds') x;
  if cardinality(v_barriers)<>(select count(distinct x) from unnest(v_barriers) x)
    or cardinality(v_barriers)<>(select count(*) from private.dw_barriers where session_id=p_session_id and id=any(v_barriers)) then perform private.dw_fail('INVALID_INPUT'); end if;
  v_id:=(p_input->>'solutionId')::uuid;
  if v_id is null then
    if (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if (select count(*) from private.dw_solutions where session_id=p_session_id)>=200 then perform private.dw_fail('BOARD_LIMIT'); end if;
    insert into private.dw_solutions(session_id,author_id,barrier_ids,title,target_group,mechanism,first_step,responsible,resources,success_indicator,risks,status)
      values(p_session_id,auth.uid(),v_barriers,p_input->>'title',p_input->>'targetGroup',p_input->>'mechanism',p_input->>'firstStep',p_input->>'responsible',
        p_input->>'resources',p_input->>'successIndicator',p_input->>'risks',p_input->>'status') returning id into v_id;
  else
    select * into v_old from private.dw_solutions where session_id=p_session_id and id=v_id;
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if v_old.author_id<>auth.uid() and v_role<>'host' then perform private.dw_fail('FORBIDDEN'); end if;
    if v_old.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    update private.dw_solutions set barrier_ids=v_barriers,title=p_input->>'title',target_group=p_input->>'targetGroup',mechanism=p_input->>'mechanism',
      first_step=p_input->>'firstStep',responsible=p_input->>'responsible',resources=p_input->>'resources',success_indicator=p_input->>'successIndicator',risks=p_input->>'risks',
      status=p_input->>'status',revision=revision+1,updated_at=now() where id=v_id;
  end if;
  perform private.dw_barrier_touch(p_session_id,'solution.saved');
  perform private.dw_finish_operation(p_operation_id,'barrier.solution',v_payload,jsonb_build_object('id',v_id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;

create function private.dw_save_survey(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_payload jsonb; v_id uuid; v_old research.surveys; v_retention date; v_questions jsonb;
begin
  perform private.dw_barrier_write_guard(p_session_id,true);
  v_payload:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  if private.dw_begin_operation(p_operation_id,'survey.config',v_payload) is not null then return private.dw_barriers_snapshot(p_session_id); end if;
  if not private.dw_keys(p_input,array['surveyId','expectedRevision','title','purpose','organizerContact','retentionUntil','questionBarrier','questionSupport','invitationToken'])
    or not coalesce(p_input ?& array['surveyId','expectedRevision','title','purpose','organizerContact','retentionUntil','questionBarrier','questionSupport'],false)
    or not (p_input->'surveyId'='null'::jsonb or private.dw_s4_uuid(p_input->'surveyId'))
    or not private.dw_s4_integer(p_input->'expectedRevision') or not private.dw_s4_text(p_input->'title',5,240)
    or not private.dw_s4_text(p_input->'purpose',20,4000) or not private.dw_s4_text(p_input->'organizerContact',5,1000)
    or not private.dw_s4_text(p_input->'questionBarrier',10,1000) or not private.dw_s4_text(p_input->'questionSupport',10,1000)
    or not coalesce(jsonb_typeof(p_input->'retentionUntil')='string' and (p_input->>'retentionUntil') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',false)
    then perform private.dw_fail('INVALID_INPUT'); end if;
  begin v_retention:=(p_input->>'retentionUntil')::date;
    exception when invalid_datetime_format or datetime_field_overflow then perform private.dw_fail('INVALID_INPUT'); end;
  if v_retention<=(now() at time zone 'UTC')::date or v_retention>(now() at time zone 'UTC')::date+365 then perform private.dw_fail('INVALID_INPUT'); end if;
  v_id:=(p_input->>'surveyId')::uuid;
  if v_id is null then
    if not private.dw_text(p_input->'invitationToken',64,64) or (p_input->>'invitationToken') !~ '^[a-f0-9]{64}$' then perform private.dw_fail('INVALID_INPUT'); end if;
    if (p_input->>'expectedRevision')::bigint<>0 then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if exists(select 1 from research.surveys where session_id=p_session_id and status<>'purged') then perform private.dw_fail('SURVEY_EXISTS'); end if;
    v_questions:=jsonb_build_object(
      'q00','От чьего имени Вы отвечаете? Ответ о ребёнке — отдельная перспективa, а не самоотчёт ребёнка.',
      'q05_12m','Планируете ли Вы рождение ребёнка в ближайшие 12 месяцев?',
      'q05_36m','Планируете ли Вы рождение ребёнка в ближайшие 36 месяцев?',
      'q01',p_input->>'questionBarrier','q02',p_input->>'questionSupport',
      'q03','Какое одно изменение условий Вы считаете для себя или описываемой семьи наиболее важным?',
      'q04','В какой срок такое изменение могло бы иметь значение?',
      'q06','Если описанное Вами приоритетное условие будет выполнено, изменится ли Ваше намерение относительно рождения ребёнка?',
      'q07','Какие дополнительные условия или обстоятельства необходимо учитывать?',
      'q08','Участие добровольно. Подтвердите совершеннолетие и согласие на учебное использование; исследовательское использование и цитирование выбираются отдельно.');
    insert into research.surveys(session_id,title,purpose,organizer_contact,retention_until,invitation_digest,questions)
      values(p_session_id,p_input->>'title',p_input->>'purpose',p_input->>'organizerContact',v_retention,
        private.dw_s4_digest('dw-survey-invite',p_input->>'invitationToken'),v_questions) returning id into v_id;
  else
    if p_input ? 'invitationToken' then perform private.dw_fail('INVALID_INPUT'); end if;
    select * into v_old from research.surveys where session_id=p_session_id and id=v_id for update;
    if not found then perform private.dw_fail('NOT_FOUND'); end if;
    if v_old.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
    if v_old.status<>'draft' then perform private.dw_fail('SURVEY_FROZEN'); end if;
    v_questions:=v_old.questions||jsonb_build_object('q01',p_input->>'questionBarrier','q02',p_input->>'questionSupport');
    update research.surveys set title=p_input->>'title',purpose=p_input->>'purpose',organizer_contact=p_input->>'organizerContact',retention_until=v_retention,
      questions=v_questions,question_version=question_version+1,revision=revision+1 where id=v_id;
  end if;
  perform private.dw_barrier_touch(p_session_id,'survey.configured');
  perform private.dw_finish_operation(p_operation_id,'survey.config',v_payload,jsonb_build_object('id',v_id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;
create function private.dw_manage_survey(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_payload jsonb; v_survey research.surveys; v_session_status text; v_action text;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select status into v_session_status from public.dw_sessions where id=p_session_id for update;
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  v_payload:=jsonb_build_object('sessionId',p_session_id,'input',p_input);
  if private.dw_begin_operation(p_operation_id,'survey.manage',v_payload) is not null then return private.dw_barriers_snapshot(p_session_id); end if;
  if not private.dw_keys(p_input,array['surveyId','expectedRevision','action','invitationToken'])
    or not coalesce(p_input ?& array['surveyId','expectedRevision','action'],false) or not private.dw_s4_uuid(p_input->'surveyId')
    or not private.dw_s4_integer(p_input->'expectedRevision',1) or coalesce(p_input->>'action','') not in ('open','close','purge','rotate') then perform private.dw_fail('INVALID_INPUT'); end if;
  v_action:=p_input->>'action';
  if v_action='rotate' then
    if not private.dw_text(p_input->'invitationToken',64,64) or (p_input->>'invitationToken') !~ '^[a-f0-9]{64}$' then perform private.dw_fail('INVALID_INPUT'); end if;
  elsif p_input ? 'invitationToken' then perform private.dw_fail('INVALID_INPUT'); end if;
  select * into v_survey from research.surveys where session_id=p_session_id and id=(p_input->>'surveyId')::uuid for update;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_survey.revision<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
  if v_survey.status='purged' then perform private.dw_fail('SURVEY_PURGED'); end if;
  if v_action in ('open','rotate') and v_session_status<>'open' then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  if v_action in ('open','rotate') and v_survey.retention_until<(now() at time zone 'UTC')::date then perform private.dw_fail('SURVEY_EXPIRED'); end if;
  if v_action='open' then
    if v_survey.status<>'draft' then perform private.dw_fail('SURVEY_FROZEN'); end if;
    update research.surveys set status='open',revision=revision+1 where id=v_survey.id;
  elsif v_action='close' then
    if v_survey.status<>'open' then perform private.dw_fail('SURVEY_NOT_OPEN'); end if;
    update research.surveys set status='closed',revision=revision+1 where id=v_survey.id;
  elsif v_action='rotate' then
    if v_survey.status not in ('draft','open') then perform private.dw_fail('SURVEY_NOT_OPEN'); end if;
    update research.surveys set invitation_digest=private.dw_s4_digest('dw-survey-invite',p_input->>'invitationToken'),revision=revision+1 where id=v_survey.id;
  else
    update research.responses set answers=null,status='withdrawn',revision=revision+1 where survey_id=v_survey.id and status='submitted';
    update research.surveys set status='purged',revision=revision+1 where id=v_survey.id;
  end if;
  perform private.dw_barrier_touch(p_session_id,'survey.'||v_action);
  perform private.dw_finish_operation(p_operation_id,'survey.manage',v_payload,jsonb_build_object('id',v_survey.id));
  return private.dw_barriers_snapshot(p_session_id);
end $$;

create function private.dw_survey_anon_guard() returns void language plpgsql set search_path='' as $$
begin
  if auth.uid() is not null or coalesce(auth.jwt()->>'role','anon')<>'anon' then perform private.dw_fail('SURVEY_ANON_ONLY'); end if;
end $$;
create function private.dw_survey_check_secret(p_secret text) returns void language plpgsql set search_path='' as $$
begin
  if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then perform private.dw_fail('INVALID_INPUT'); end if;
end $$;
create function private.dw_survey_blank_answers() returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('perspective','decline','intention12m',null,'intention36m',null,'answerBarrier',null,'answerSupport',null,
    'priorityChange',null,'priorityConditionId',null,'horizon',null,'conditionalChange',null,'additionalConditions',null,
    'consentEducational',false,'consentResearch',false,'consentQuote',false,'adultConfirmed',false)
$$;
create function private.dw_survey_own_json(p_survey_id uuid,p_digest text) returns jsonb language sql stable set search_path='' as $$
  select case when r.status='submitted' and s.status<>'purged' and s.retention_until>=(now() at time zone 'UTC')::date then r.answers
      else private.dw_survey_blank_answers() end ||jsonb_build_object('status',coalesce(r.status,'none'),'revision',coalesce(r.revision,0),
      'questionVersion',coalesce(r.question_version,s.question_version),'availability',case when s.status='purged' then 'purged'
        when s.retention_until<(now() at time zone 'UTC')::date then 'expired'
        when s.status='open' and exists(select 1 from public.dw_sessions x where x.id=s.session_id and x.status='open') then 'open' else 'closed' end)
  from research.surveys s left join research.responses r on r.survey_id=s.id and r.secret_digest=p_digest where s.id=p_survey_id
$$;
create function private.dw_survey_public_manifest(p_survey_id uuid,p_invitation_token text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_survey research.surveys;
begin
  perform private.dw_survey_anon_guard(); perform private.dw_survey_check_secret(p_invitation_token);
  select * into v_survey from research.surveys where id=p_survey_id and invitation_digest=private.dw_s4_digest('dw-survey-invite',p_invitation_token);
  if not found then perform private.dw_fail('SURVEY_INVITATION_INVALID'); end if;
  return private.dw_survey_manifest_json(v_survey.id);
end $$;
create function private.dw_survey_own_response(p_survey_id uuid,p_response_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform private.dw_survey_anon_guard(); perform private.dw_survey_check_secret(p_response_secret);
  v_result:=private.dw_survey_own_json(p_survey_id,private.dw_s4_digest('dw-survey-response',p_response_secret));
  if v_result is null then perform private.dw_fail('NOT_FOUND'); end if;
  return v_result;
end $$;
create function private.dw_survey_validate_answers(p_input jsonb) returns jsonb language plpgsql set search_path='' as $$
declare v_field text; v_text text;
begin
  if not private.dw_s4_required(p_input,array['expectedRevision','questionVersion','perspective','intention12m','intention36m','answerBarrier','answerSupport',
      'priorityChange','priorityConditionId','horizon','conditionalChange','additionalConditions','consentEducational','consentResearch','consentQuote','adultConfirmed'])
    or not private.dw_s4_integer(p_input->'expectedRevision') or not private.dw_s4_integer(p_input->'questionVersion',1)
    or coalesce(p_input->>'perspective','') not in ('self','adult_child_reported','adult_child_inferred','professional','decline') then perform private.dw_fail('INVALID_INPUT'); end if;
  foreach v_field in array array['consentEducational','consentResearch','consentQuote','adultConfirmed'] loop
    if jsonb_typeof(p_input->v_field)<>'boolean' then perform private.dw_fail('INVALID_INPUT'); end if;
  end loop;
  if not (p_input->>'consentEducational')::boolean or not (p_input->>'adultConfirmed')::boolean
    or ((p_input->>'consentQuote')::boolean and not (p_input->>'consentResearch')::boolean) then perform private.dw_fail('SURVEY_CONSENT_REQUIRED'); end if;
  foreach v_field in array array['answerBarrier','answerSupport','priorityChange','additionalConditions'] loop
    if p_input->v_field<>'null'::jsonb and not private.dw_s4_text(p_input->v_field,1,4000) then perform private.dw_fail('INVALID_INPUT'); end if;
  end loop;
  foreach v_field in array array['intention12m','intention36m'] loop
    if p_input->v_field<>'null'::jsonb and (jsonb_typeof(p_input->v_field)<>'string'
      or p_input->>v_field not in ('definitely_yes','probably_yes','probably_no','definitely_no','unsure','not_applicable','decline')) then perform private.dw_fail('INVALID_INPUT'); end if;
  end loop;
  if p_input->'horizon'<>'null'::jsonb and (jsonb_typeof(p_input->'horizon')<>'string'
    or p_input->>'horizon' not in ('within_12m','13_36m','after_36m','no_change','unsure','decline')) then perform private.dw_fail('INVALID_INPUT'); end if;
  if p_input->'conditionalChange'<>'null'::jsonb and (jsonb_typeof(p_input->'conditionalChange')<>'string'
    or p_input->>'conditionalChange' not in ('definitely_change','probably_change','probably_no_change','definitely_no_change','unsure','decline')) then perform private.dw_fail('INVALID_INPUT'); end if;
  if (p_input->'priorityChange'='null'::jsonb)<>(p_input->'priorityConditionId'='null'::jsonb)
    or (p_input->'priorityConditionId'<>'null'::jsonb and not private.dw_s4_uuid(p_input->'priorityConditionId'))
    or (p_input->'conditionalChange'<>'null'::jsonb and p_input->'priorityChange'='null'::jsonb)
    or (p_input->>'perspective'<>'self' and (p_input->'intention12m'<>'null'::jsonb or p_input->'intention36m'<>'null'::jsonb or p_input->'conditionalChange'<>'null'::jsonb))
    then perform private.dw_fail('SURVEY_BRANCH_INVALID'); end if;
  if p_input->>'perspective'='decline' then
    foreach v_field in array array['answerBarrier','answerSupport','priorityChange','horizon','additionalConditions'] loop
      if p_input->v_field<>'null'::jsonb then perform private.dw_fail('SURVEY_BRANCH_INVALID'); end if;
    end loop;
  elsif p_input->'answerBarrier'='null'::jsonb and p_input->'answerSupport'='null'::jsonb then
    perform private.dw_fail('SURVEY_BRANCH_INVALID');
  end if;
  return p_input-array['expectedRevision','questionVersion'];
end $$;
create function private.dw_survey_save_response(p_operation_id uuid,p_survey_id uuid,p_invitation_token text,p_response_secret text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_survey research.surveys; v_old research.responses; v_receipt research.response_receipts;
  v_digest text; v_request_hash text; v_answers jsonb; v_revision bigint;
begin
  perform private.dw_survey_anon_guard(); perform private.dw_survey_check_secret(p_invitation_token); perform private.dw_survey_check_secret(p_response_secret);
  if p_operation_id is null then perform private.dw_fail('INVALID_INPUT'); end if;
  v_digest:=private.dw_s4_digest('dw-survey-response',p_response_secret);
  -- Survey row serializes capacity, withdrawal and purge with submission, without account identity.
  select * into v_survey from research.surveys where id=p_survey_id for update;
  if not found or v_survey.invitation_digest<>private.dw_s4_digest('dw-survey-invite',p_invitation_token) then perform private.dw_fail('SURVEY_INVITATION_INVALID'); end if;
  v_request_hash:=private.dw_s4_digest('dw-survey-save',p_response_secret||':'||coalesce(p_input::text,'null'));
  select * into v_receipt from research.response_receipts where survey_id=p_survey_id and secret_digest=v_digest and operation_id=p_operation_id;
  if found then
    if v_receipt.operation_type<>'save' or v_receipt.request_hash<>v_request_hash then perform private.dw_fail('IDEMPOTENCY_CONFLICT'); end if;
    return private.dw_survey_own_json(p_survey_id,v_digest);
  end if;
  if v_survey.status='purged' then perform private.dw_fail('SURVEY_PURGED'); end if;
  if v_survey.retention_until<(now() at time zone 'UTC')::date then perform private.dw_fail('SURVEY_EXPIRED'); end if;
  if v_survey.status<>'open' then perform private.dw_fail('SURVEY_NOT_OPEN'); end if;
  if not exists(select 1 from public.dw_sessions where id=v_survey.session_id and status='open') then perform private.dw_fail('SESSION_NOT_OPEN'); end if;
  select * into v_old from research.responses where survey_id=p_survey_id and secret_digest=v_digest;
  if found and v_old.status='withdrawn' then perform private.dw_fail('RESPONSE_WITHDRAWN'); end if;
  v_answers:=private.dw_survey_validate_answers(p_input);
  if coalesce(v_old.revision,0)<>(p_input->>'expectedRevision')::bigint then perform private.dw_fail('REVISION_CONFLICT'); end if;
  if v_survey.question_version<>(p_input->>'questionVersion')::bigint then perform private.dw_fail('QUESTION_VERSION_CONFLICT'); end if;
  if v_old.id is not null and v_old.answers->>'priorityChange' is distinct from v_answers->>'priorityChange'
    and v_answers->'priorityChange'<>'null'::jsonb and v_old.answers->>'priorityConditionId'=v_answers->>'priorityConditionId' then perform private.dw_fail('SURVEY_CONDITION_CHANGED'); end if;
  if v_old.id is null then
    if (select count(*) from research.responses where survey_id=p_survey_id)>=250 then perform private.dw_fail('SURVEY_LIMIT'); end if;
    insert into research.responses(survey_id,secret_digest,status,revision,question_version,response_date,answers)
      values(p_survey_id,v_digest,'submitted',1,v_survey.question_version,(now() at time zone 'UTC')::date,v_answers) returning revision into v_revision;
  else
    update research.responses set answers=v_answers,revision=revision+1,response_date=(now() at time zone 'UTC')::date
      where id=v_old.id returning revision into v_revision;
  end if;
  insert into research.response_receipts(survey_id,secret_digest,operation_id,operation_type,request_hash,result_revision)
    values(p_survey_id,v_digest,p_operation_id,'save',v_request_hash,v_revision);
  return private.dw_survey_own_json(p_survey_id,v_digest);
end $$;
create function private.dw_survey_withdraw_response(p_operation_id uuid,p_survey_id uuid,p_response_secret text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_digest text; v_request_hash text; v_old research.responses; v_receipt research.response_receipts; v_revision bigint;
begin
  perform private.dw_survey_anon_guard(); perform private.dw_survey_check_secret(p_response_secret);
  if p_operation_id is null or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991 then perform private.dw_fail('INVALID_INPUT'); end if;
  v_digest:=private.dw_s4_digest('dw-survey-response',p_response_secret);
  perform 1 from research.surveys where id=p_survey_id for update;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  v_request_hash:=private.dw_s4_digest('dw-survey-withdraw',p_response_secret||':'||p_expected_revision::text);
  select * into v_receipt from research.response_receipts where survey_id=p_survey_id and secret_digest=v_digest and operation_id=p_operation_id;
  if found then
    if v_receipt.operation_type<>'withdraw' or v_receipt.request_hash<>v_request_hash then perform private.dw_fail('IDEMPOTENCY_CONFLICT'); end if;
    return private.dw_survey_own_json(p_survey_id,v_digest);
  end if;
  select * into v_old from research.responses where survey_id=p_survey_id and secret_digest=v_digest;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_old.revision<>p_expected_revision then perform private.dw_fail('REVISION_CONFLICT'); end if;
  v_revision:=v_old.revision;
  if v_old.status='submitted' then
    update research.responses set status='withdrawn',answers=null,revision=revision+1 where id=v_old.id returning revision into v_revision;
  end if;
  insert into research.response_receipts(survey_id,secret_digest,operation_id,operation_type,request_hash,result_revision)
    values(p_survey_id,v_digest,p_operation_id,'withdraw',v_request_hash,v_revision);
  return private.dw_survey_own_json(p_survey_id,v_digest);
end $$;

create function private.dw_survey_host_state(p_session_id uuid,p_survey_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_survey research.surveys; v_rows jsonb;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_survey from research.surveys where session_id=p_session_id and id=p_survey_id;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  select coalesce(jsonb_agg(r.answers||jsonb_build_object('rowKey',r.id,'questionVersion',r.question_version,'revision',r.revision,'responseDate',r.response_date) order by r.id),'[]'::jsonb)
    into v_rows from research.responses r where r.survey_id=p_survey_id and r.status='submitted'
      and v_survey.status<>'purged' and v_survey.retention_until>=(now() at time zone 'UTC')::date;
  return jsonb_build_object('survey',private.dw_survey_summary_json(p_survey_id),'invitationDigest',v_survey.invitation_digest,
    'responseCount',jsonb_array_length(v_rows),'researchCount',(select count(*) from jsonb_array_elements(v_rows) x where (x->>'consentResearch')::boolean),
    'quoteCount',(select count(*) from jsonb_array_elements(v_rows) x where (x->>'consentQuote')::boolean),'responses',v_rows);
end $$;
create function private.dw_survey_export_missing(p_answers jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare v_result jsonb:='{}'::jsonb; v_field text; v_reason text;
begin
  foreach v_field in array array['intention12m','intention36m','answerBarrier','answerSupport','priorityChange','horizon','conditionalChange','additionalConditions'] loop
    if p_answers->v_field='null'::jsonb then
      v_reason:=case when p_answers->>'perspective'='decline'
        or (v_field in ('intention12m','intention36m','conditionalChange') and p_answers->>'perspective'<>'self')
        or (v_field='conditionalChange' and p_answers->'priorityChange'='null'::jsonb) then 'not_asked' else 'skipped' end;
      v_result:=v_result||jsonb_build_object(v_field,v_reason);
    end if;
  end loop; return v_result;
end $$;
create function private.dw_survey_research_export(p_session_id uuid,p_survey_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=private.dw_verified_uid(); v_survey research.surveys; v_records jsonb;
begin
  if private.dw_member_role(p_session_id) is distinct from 'host' then perform private.dw_fail('FORBIDDEN'); end if;
  select * into v_survey from research.surveys where session_id=p_session_id and id=p_survey_id;
  if not found then perform private.dw_fail('NOT_FOUND'); end if;
  if v_survey.status='purged' then perform private.dw_fail('SURVEY_PURGED'); end if;
  if v_survey.retention_until<(now() at time zone 'UTC')::date then perform private.dw_fail('SURVEY_EXPIRED'); end if;
  select coalesce(jsonb_agg((r.answers-array['priorityConditionId','consentEducational','adultConfirmed'])
    ||jsonb_build_object('questionVersion',r.question_version,'responseDate',r.response_date,'missingReasons',private.dw_survey_export_missing(r.answers)) order by r.id),'[]'::jsonb)
    into v_records from research.responses r where r.survey_id=p_survey_id and r.status='submitted' and (r.answers->>'consentResearch')::boolean;
  return jsonb_build_object('datasetVersion','demography-research-export-1','procedureVersion','classroom-open-link-1','exportDate',(now() at time zone 'UTC')::date,
    'samplingNote','Открытая ссылка для добровольного участия слушателей занятия; самоотбор. Браузерная квитанция не удостоверяет уникальность человека. Выборка не репрезентативна; самоотчёты, сообщения о детях, предположения о детях и профессиональные оценки анализируются раздельно. Заявленное условное намерение не является оценкой причинного эффекта меры.',
    'questionnaire',private.dw_survey_manifest_json(p_survey_id),
    'missingCodes',jsonb_build_object('skipped','null','notAsked','not_asked','notApplicable','not_applicable','declined','decline'),'records',v_records);
end $$;

-- No private helper is executable directly by an API role. Exposed wrappers are invokers.
revoke all on function private.dw_s4_integer(jsonb,bigint) from public,anon,authenticated;
revoke all on function private.dw_s4_uuid(jsonb) from public,anon,authenticated;
revoke all on function private.dw_s4_required(jsonb,text[]) from public,anon,authenticated;
revoke all on function private.dw_s4_text(jsonb,integer,integer) from public,anon,authenticated;
revoke all on function private.dw_s4_digest(text,text) from public,anon,authenticated;
revoke all on function private.dw_barrier_touch(uuid,text) from public,anon,authenticated;
revoke all on function private.dw_barrier_workshop_bridge() from public,anon,authenticated;
revoke all on function private.dw_barrier_session_created() from public,anon,authenticated;
revoke all on function private.dw_barrier_evidence_immutable() from public,anon,authenticated;
revoke all on function private.dw_barrier_write_guard(uuid,boolean) from public,anon,authenticated;
revoke all on function private.dw_barrier_family_material(uuid,uuid) from public,anon,authenticated;
revoke all on function private.dw_barrier_family_options(uuid) from public,anon,authenticated;
revoke all on function private.dw_survey_manifest_json(uuid) from public,anon,authenticated;
revoke all on function private.dw_survey_summary_json(uuid) from public,anon,authenticated;
revoke all on function private.dw_barriers_json(uuid,boolean) from public,anon,authenticated;
revoke all on function private.dw_barriers_snapshot(uuid) from public,anon,authenticated;
revoke all on function private.dw_barriers_cursor(uuid) from public,anon,authenticated;
revoke all on function private.dw_barriers_projector_snapshot(uuid) from public,anon,authenticated;
revoke all on function private.dw_barrier_evidence(uuid,uuid) from public,anon,authenticated;
revoke all on function private.dw_save_barrier(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function private.dw_barrier_vote(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function private.dw_save_barrier_link(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function private.dw_save_solution(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function private.dw_save_survey(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function private.dw_manage_survey(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function private.dw_survey_anon_guard() from public,anon,authenticated;
revoke all on function private.dw_survey_check_secret(text) from public,anon,authenticated;
revoke all on function private.dw_survey_blank_answers() from public,anon,authenticated;
revoke all on function private.dw_survey_own_json(uuid,text) from public,anon,authenticated;
revoke all on function private.dw_survey_public_manifest(uuid,text) from public,anon,authenticated;
revoke all on function private.dw_survey_own_response(uuid,text) from public,anon,authenticated;
revoke all on function private.dw_survey_validate_answers(jsonb) from public,anon,authenticated;
revoke all on function private.dw_survey_save_response(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function private.dw_survey_withdraw_response(uuid,uuid,text,bigint) from public,anon,authenticated;
revoke all on function private.dw_survey_host_state(uuid,uuid) from public,anon,authenticated;
revoke all on function private.dw_survey_export_missing(jsonb) from public,anon,authenticated;
revoke all on function private.dw_survey_research_export(uuid,uuid) from public,anon,authenticated;
grant usage on schema private to anon;
create function public.dw_barriers_snapshot(p_session_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_barriers_snapshot($1) $$;
revoke all on function public.dw_barriers_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.dw_barriers_snapshot(uuid),private.dw_barriers_snapshot(uuid) to authenticated;
create function public.dw_barriers_cursor(p_session_id uuid) returns bigint language sql security invoker set search_path='' as $$ select private.dw_barriers_cursor($1) $$;
revoke all on function public.dw_barriers_cursor(uuid) from public,anon,authenticated;
grant execute on function public.dw_barriers_cursor(uuid),private.dw_barriers_cursor(uuid) to authenticated;
create function public.dw_barriers_projector_snapshot(p_session_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_barriers_projector_snapshot($1) $$;
revoke all on function public.dw_barriers_projector_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.dw_barriers_projector_snapshot(uuid),private.dw_barriers_projector_snapshot(uuid) to authenticated;
create function public.dw_save_barrier(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_save_barrier($1,$2,$3) $$;
revoke all on function public.dw_save_barrier(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.dw_save_barrier(uuid,uuid,jsonb),private.dw_save_barrier(uuid,uuid,jsonb) to authenticated;
create function public.dw_barrier_vote(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_barrier_vote($1,$2,$3) $$;
revoke all on function public.dw_barrier_vote(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.dw_barrier_vote(uuid,uuid,jsonb),private.dw_barrier_vote(uuid,uuid,jsonb) to authenticated;
create function public.dw_save_barrier_link(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_save_barrier_link($1,$2,$3) $$;
revoke all on function public.dw_save_barrier_link(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.dw_save_barrier_link(uuid,uuid,jsonb),private.dw_save_barrier_link(uuid,uuid,jsonb) to authenticated;
create function public.dw_save_solution(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_save_solution($1,$2,$3) $$;
revoke all on function public.dw_save_solution(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.dw_save_solution(uuid,uuid,jsonb),private.dw_save_solution(uuid,uuid,jsonb) to authenticated;
create function public.dw_barrier_evidence(p_session_id uuid,p_evidence_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_barrier_evidence($1,$2) $$;
revoke all on function public.dw_barrier_evidence(uuid,uuid) from public,anon,authenticated;
grant execute on function public.dw_barrier_evidence(uuid,uuid),private.dw_barrier_evidence(uuid,uuid) to authenticated;
create function public.dw_save_survey(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_save_survey($1,$2,$3) $$;
revoke all on function public.dw_save_survey(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.dw_save_survey(uuid,uuid,jsonb),private.dw_save_survey(uuid,uuid,jsonb) to authenticated;
create function public.dw_manage_survey(p_operation_id uuid,p_session_id uuid,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_manage_survey($1,$2,$3) $$;
revoke all on function public.dw_manage_survey(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.dw_manage_survey(uuid,uuid,jsonb),private.dw_manage_survey(uuid,uuid,jsonb) to authenticated;
create function public.dw_survey_host_state(p_session_id uuid,p_survey_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_survey_host_state($1,$2) $$;
revoke all on function public.dw_survey_host_state(uuid,uuid) from public,anon,authenticated;
grant execute on function public.dw_survey_host_state(uuid,uuid),private.dw_survey_host_state(uuid,uuid) to authenticated;
create function public.dw_survey_research_export(p_session_id uuid,p_survey_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_survey_research_export($1,$2) $$;
revoke all on function public.dw_survey_research_export(uuid,uuid) from public,anon,authenticated;
grant execute on function public.dw_survey_research_export(uuid,uuid),private.dw_survey_research_export(uuid,uuid) to authenticated;
create function public.dw_survey_public_manifest(p_survey_id uuid,p_invitation_token text) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_survey_public_manifest($1,$2) $$;
revoke all on function public.dw_survey_public_manifest(uuid,text) from public,anon,authenticated;
grant execute on function public.dw_survey_public_manifest(uuid,text),private.dw_survey_public_manifest(uuid,text) to anon,authenticated;
create function public.dw_survey_own_response(p_survey_id uuid,p_response_secret text) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_survey_own_response($1,$2) $$;
revoke all on function public.dw_survey_own_response(uuid,text) from public,anon,authenticated;
grant execute on function public.dw_survey_own_response(uuid,text),private.dw_survey_own_response(uuid,text) to anon,authenticated;
create function public.dw_survey_save_response(p_operation_id uuid,p_survey_id uuid,p_invitation_token text,p_response_secret text,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_survey_save_response($1,$2,$3,$4,$5) $$;
revoke all on function public.dw_survey_save_response(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.dw_survey_save_response(uuid,uuid,text,text,jsonb),private.dw_survey_save_response(uuid,uuid,text,text,jsonb) to anon,authenticated;
create function public.dw_survey_withdraw_response(p_operation_id uuid,p_survey_id uuid,p_response_secret text,p_expected_revision bigint) returns jsonb language sql security invoker set search_path='' as $$ select private.dw_survey_withdraw_response($1,$2,$3,$4) $$;
revoke all on function public.dw_survey_withdraw_response(uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.dw_survey_withdraw_response(uuid,uuid,text,bigint),private.dw_survey_withdraw_response(uuid,uuid,text,bigint) to anon,authenticated;

-- Managed Supabase installs the publication; PGlite deliberately has no Realtime service.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.dw_barrier_events;
  end if;
end $$;
