-- Stage 9: the first shared-workshop screen always has a usable anonymous form.
-- This table stores the shared form capability, never a respondent's personal secret.
create table private.dw_workshop_survey_access (
  survey_id uuid primary key references research.surveys(id),
  invitation_token text not null check(invitation_token ~ '^[a-f0-9]{64}$')
);
alter table private.dw_workshop_survey_access enable row level security;
revoke all on private.dw_workshop_survey_access from public, anon, authenticated;

create function private.dw_workshop_survey(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_survey research.surveys;
  v_token text;
  v_questions jsonb;
  v_today date := (now() at time zone 'UTC')::date;
begin
  perform private.dw_verified_uid();
  if not private.dw_is_current_workspace(p_session_id)
    or private.dw_member_role(p_session_id) not in ('host','participant')
    or private.dw_member_role(p_session_id) is null then
    perform private.dw_fail('FORBIDDEN');
  end if;
  -- The same lock used by existing survey configuration serializes first arrivals.
  perform 1 from public.dw_sessions where id=p_session_id for update;
  if not private.dw_is_current_workspace(p_session_id)
    or private.dw_member_role(p_session_id) not in ('host','participant')
    or private.dw_member_role(p_session_id) is null then
    perform private.dw_fail('FORBIDDEN');
  end if;
  select * into v_survey from research.surveys
    where session_id=p_session_id and status<>'purged' for update;
  if not found then
    v_token := replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
    v_questions := jsonb_build_object(
      'q00','С какой позиции Вы отвечаете?',
      'q05_12m','Планируете ли Вы рождение ребёнка в ближайшие 12 месяцев?',
      'q05_36m','Планируете ли Вы рождение ребёнка в ближайшие 36 месяцев?',
      'q01','Что сейчас мешает Вам или Вашим совершеннолетним детям решиться на рождение ещё одного ребёнка в ближайшие 12 месяцев? Можно описать ситуацию семей, с которыми Вы работаете.',
      'q02','Что должно измениться прямо сейчас, чтобы вероятность рождения ребёнка в ближайшие 12 месяцев стала выше? Опишите необходимые условия своими словами.',
      'q03','Какое одно изменение условий Вы считаете для себя или описываемой семьи наиболее важным?',
      'q04','В какой срок такое изменение могло бы иметь значение?',
      'q06','Если описанное Вами приоритетное условие будет выполнено, изменится ли Ваше намерение относительно рождения ребёнка?',
      'q07','Какие дополнительные условия или обстоятельства необходимо учитывать?',
      'q08','Участие добровольно. Использование в исследовании и цитирование выбираются отдельно.'
    );
    insert into research.surveys(session_id,title,purpose,organizer_contact,retention_until,status,invitation_digest,questions)
      values(p_session_id,'Что мешает родительству?',
        'Обсудим препятствия к родительству и изменения, которые могли бы помочь семьям. Можно ответить о себе, о совершеннолетних детях или о профессиональном опыте.',
        -- Only new forms receive this term; existing participant agreements are never extended.
        'omnistat@yandex.ru',v_today+365,'open',private.dw_s4_digest('dw-survey-invite',v_token),v_questions)
      returning * into v_survey;
    insert into private.dw_workshop_survey_access(survey_id,invitation_token) values(v_survey.id,v_token);
    perform private.dw_barrier_touch(p_session_id,'survey.ready');
  elsif v_survey.status in ('draft','open') and v_survey.retention_until>=v_today then
    select invitation_token into v_token from private.dw_workshop_survey_access where survey_id=v_survey.id;
    if v_token is null or private.dw_s4_digest('dw-survey-invite',v_token)<>v_survey.invitation_digest then
      -- Recover only the shared entry capability; personal response secrets remain untouched.
      v_token := replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
      insert into private.dw_workshop_survey_access(survey_id,invitation_token) values(v_survey.id,v_token)
        on conflict(survey_id) do update set invitation_token=excluded.invitation_token;
      update research.surveys set invitation_digest=private.dw_s4_digest('dw-survey-invite',v_token),revision=revision+1
        where id=v_survey.id returning * into v_survey;
      perform private.dw_barrier_touch(p_session_id,'survey.entry');
    end if;
    if v_survey.status='draft' then
      update research.surveys set status='open',revision=revision+1 where id=v_survey.id returning * into v_survey;
      perform private.dw_barrier_touch(p_session_id,'survey.ready');
    end if;
  end if;
  return jsonb_build_object('sessionId',p_session_id,'survey',private.dw_survey_summary_json(v_survey.id),
    'invitationToken',case when v_survey.status='open' and v_survey.retention_until>=v_today then v_token else null end);
end $$;
revoke all on function private.dw_workshop_survey(uuid) from public,anon,authenticated;
create function public.dw_workshop_survey(p_session_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select private.dw_workshop_survey($1) $$;
revoke all on function public.dw_workshop_survey(uuid) from public,anon,authenticated;
grant execute on function public.dw_workshop_survey(uuid),private.dw_workshop_survey(uuid) to authenticated;
