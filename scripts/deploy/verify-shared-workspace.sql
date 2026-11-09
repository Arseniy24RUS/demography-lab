-- One-time hosted verification after the two stage-9 migrations.
-- Execute this ENTIRE file as one SQL request. No account IDs, addresses, tokens,
-- research answers or respondent secrets are returned. Never run selected pieces.
-- Writes use the declared-entry gateway and are rolled back twice: a controlled
-- inner subtransaction first, then the outer transaction. A repeatable snapshot
-- avoids confusing concurrent legitimate edits with this probe's own writes.
-- A failed assertion produces a safe stage name and SQLSTATE only.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL statement_timeout='45s';
SET LOCAL lock_timeout='5s';
DO $qa$
DECLARE
 v_stage text:='schema';
 v_checks integer:=0;
 v_tables text[]:=ARRAY[
  'public.dw_profiles','public.dw_sessions','public.dw_memberships','public.dw_submissions',
  'public.dw_session_events','public.dw_workshop_events','public.dw_barrier_events',
  'private.dw_current_workspace','private.dw_workshop_state','private.dw_region_work',
  'private.dw_practice_families','private.dw_family_members','private.dw_family_history',
  'private.dw_voting_rounds','private.dw_round_families','private.dw_round_variants',
  'private.dw_round_roster','private.dw_ballots','private.dw_workspace_votes',
  'private.dw_barrier_state','private.dw_barriers','private.dw_barrier_votes',
  'private.dw_barrier_links','private.dw_solutions','private.dw_roadmap_state',
  'private.dw_roadmaps','private.dw_roadmap_items','private.dw_roadmap_assignments',
  'private.dw_roadmap_versions','private.dw_workspaces','private.source_versions',
  'private.audit_events','private.command_receipts'
 ];
 v_table text; v_digest text;
 v_before jsonb:='{}'::jsonb; v_after jsonb:='{}'::jsonb;
 v_counts_before jsonb; v_counts_after jsonb; v_actor_count bigint;
 v_run text:=replace(gen_random_uuid()::text,'-','');
 v_email_a text; v_email_b text;
 v_a jsonb; v_b jsonb; v_boot jsonb; v_one jsonb; v_two jsonb; v_repeat jsonb;
 v_session uuid; v_family uuid; v_operation uuid;
 v_board jsonb; v_publication jsonb; v_votes jsonb; v_projection jsonb;
 v_vote_args jsonb; v_fingerprint text;
 v_survey_a jsonb; v_survey_b jsonb; v_survey_cursor bigint;
 v_denied boolean; v_error_state text;
 v_bundle jsonb:=$qa_bundle${"schemaVersion":1,"practice":{"id":"mordovia-kindergarten-compensation","familyId":"kindergarten-fee-compensation","regionId":"respublika-mordoviia","title":"Компенсация родительской платы за детский сад","mechanism":"Возмещение части среднего размера родительской платы, ограниченное фактически внесённой платой.","eligibility":"Родители детей в государственных и муниципальных дошкольных образовательных организациях Республики Мордовия.","amount":"Первый ребёнок: 20–29%; второй: 50–72%; третий и последующие: 70–100% среднего размера платы; не выше фактической платы.","conditions":["Проценты различаются по очередности рождения; условия выбора конкретного процента в приведённом фрагменте не раскрыты."],"occurrenceIds":["occ-mordovia-kindergarten-compensation-title","occ-mordovia-kindergarten-compensation-mechanism","occ-mordovia-kindergarten-compensation-eligibility","occ-mordovia-kindergarten-compensation-amount"],"evidence":[{"kind":"fragment","field":"title","occurrenceId":"occ-mordovia-kindergarten-compensation-title","relation":"supports","reviewStatus":"candidate","reviewedValue":"Компенсация родительской платы за детский сад","note":"Редакционная кандидатура; статус verified устанавливается только после явного подтверждения человеком."},{"kind":"fragment","field":"mechanism","occurrenceId":"occ-mordovia-kindergarten-compensation-mechanism","relation":"supports","reviewStatus":"candidate","reviewedValue":"Возмещение части среднего размера родительской платы, ограниченное фактически внесённой платой.","note":"Редакционная кандидатура; статус verified устанавливается только после явного подтверждения человеком."},{"kind":"fragment","field":"eligibility","occurrenceId":"occ-mordovia-kindergarten-compensation-eligibility","relation":"supports","reviewStatus":"candidate","reviewedValue":"Родители детей в государственных и муниципальных дошкольных образовательных организациях Республики Мордовия.","note":"Редакционная кандидатура; статус verified устанавливается только после явного подтверждения человеком."},{"kind":"fragment","field":"amount","occurrenceId":"occ-mordovia-kindergarten-compensation-amount","relation":"supports","reviewStatus":"candidate","reviewedValue":"Первый ребёнок: 20–29%; второй: 50–72%; третий и последующие: 70–100% среднего размера платы; не выше фактической платы.","note":"Редакционная кандидатура; статус verified устанавливается только после явного подтверждения человеком."}],"reviewStatus":"candidate"},"occurrences":[{"id":"occ-mordovia-kindergarten-compensation-title","documentId":"regional-respublika-mordoviia","versionId":"regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5","anchor":{"id":"anchor-occ-mordovia-kindergarten-compensation-title","documentId":"regional-respublika-mordoviia","versionId":"regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5","normalizationVersion":"unicode-nfc-lf-v1","spans":[{"blockId":"regional-respublika-mordoviia-p059-b003","start":6,"end":295,"exact":"1) компенсация платы, взимаемой с родителей за присмотр и уход за детьми, осваивающими образовательные\n  программы дошкольного образования в государственных и муниципальных образовательных организациях,\n  находящихся на территории Республики Мордовии, предоставляется в следующих размерах:","prefix":"      ","suffix":""}]},"reviewStatus":"candidate","note":"Точный фрагмент сохранённой редакции. Семантическое соответствие полю ожидает проверки преподавателем."},{"id":"occ-mordovia-kindergarten-compensation-mechanism","documentId":"regional-respublika-mordoviia","versionId":"regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5","anchor":{"id":"anchor-occ-mordovia-kindergarten-compensation-mechanism","documentId":"regional-respublika-mordoviia","versionId":"regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5","normalizationVersion":"unicode-nfc-lf-v1","spans":[{"blockId":"regional-respublika-mordoviia-p059-b003","start":6,"end":295,"exact":"1) компенсация платы, взимаемой с родителей за присмотр и уход за детьми, осваивающими образовательные\n  программы дошкольного образования в государственных и муниципальных образовательных организациях,\n  находящихся на территории Республики Мордовии, предоставляется в следующих размерах:","prefix":"      ","suffix":""},{"blockId":"regional-respublika-mordoviia-p059-b004","start":5,"end":199,"exact":"на первого ребенка - в размере 20 - 29% среднего размера родительской платы в государственных и\n  муниципальных образовательных организациях, но не более фактически внесенной родительской платы;","prefix":"     ","suffix":""},{"blockId":"regional-respublika-mordoviia-p059-b005","start":5,"end":199,"exact":"на второго ребенка - в размере 50 - 72% среднего размера родительской платы в государственных и\n  муниципальных образовательных организациях, но не более фактически внесенной родительской платы;","prefix":"     ","suffix":""},{"blockId":"regional-respublika-mordoviia-p059-b006","start":6,"end":224,"exact":"на третьего ребенка и последующих детей - в размере 70 - 100% среднего размера родительской платы в\n  государственных и муниципальных образовательных организациях, но не более фактически внесенной родительской\n  платы;","prefix":"      ","suffix":""}]},"reviewStatus":"candidate","note":"Точный фрагмент сохранённой редакции. Семантическое соответствие полю ожидает проверки преподавателем."},{"id":"occ-mordovia-kindergarten-compensation-eligibility","documentId":"regional-respublika-mordoviia","versionId":"regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5","anchor":{"id":"anchor-occ-mordovia-kindergarten-compensation-eligibility","documentId":"regional-respublika-mordoviia","versionId":"regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5","normalizationVersion":"unicode-nfc-lf-v1","spans":[{"blockId":"regional-respublika-mordoviia-p059-b003","start":6,"end":295,"exact":"1) компенсация платы, взимаемой с родителей за присмотр и уход за детьми, осваивающими образовательные\n  программы дошкольного образования в государственных и муниципальных образовательных организациях,\n  находящихся на территории Республики Мордовии, предоставляется в следующих размерах:","prefix":"      ","suffix":""}]},"reviewStatus":"candidate","note":"Точный фрагмент сохранённой редакции. Семантическое соответствие полю ожидает проверки преподавателем."},{"id":"occ-mordovia-kindergarten-compensation-amount","documentId":"regional-respublika-mordoviia","versionId":"regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5","anchor":{"id":"anchor-occ-mordovia-kindergarten-compensation-amount","documentId":"regional-respublika-mordoviia","versionId":"regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5","normalizationVersion":"unicode-nfc-lf-v1","spans":[{"blockId":"regional-respublika-mordoviia-p059-b004","start":5,"end":199,"exact":"на первого ребенка - в размере 20 - 29% среднего размера родительской платы в государственных и\n  муниципальных образовательных организациях, но не более фактически внесенной родительской платы;","prefix":"     ","suffix":""},{"blockId":"regional-respublika-mordoviia-p059-b005","start":5,"end":199,"exact":"на второго ребенка - в размере 50 - 72% среднего размера родительской платы в государственных и\n  муниципальных образовательных организациях, но не более фактически внесенной родительской платы;","prefix":"     ","suffix":""},{"blockId":"regional-respublika-mordoviia-p059-b006","start":6,"end":224,"exact":"на третьего ребенка и последующих детей - в размере 70 - 100% среднего размера родительской платы в\n  государственных и муниципальных образовательных организациях, но не более фактически внесенной родительской\n  платы;","prefix":"      ","suffix":""}]},"reviewStatus":"candidate","note":"Точный фрагмент сохранённой редакции. Семантическое соответствие полю ожидает проверки преподавателем."}],"note":"Проверка транзакционного отката общей мастерской.","sources":[{"sourceId":"regional-respublika-mordoviia","editionId":"regional-respublika-mordoviia@layout-canonical-v2-991b6eaaaac8-2654bfb570f5","title":"Региональная программа по повышению рождаемости: Республика Мордовия","sha256":"991b6eaaaac8d5680c683cbabbe4eff732fd526d1c17bce595bc28ceaea87885","normalizationVersion":"unicode-nfc-lf-v1","sourceUrl":"https://raw.githubusercontent.com/Arseniy24RUS/family-support/5dde46ae663b7652a448ec982585e64d61a26a61/site/documents/strategies/regional/regional-respublika-mordoviia.pdf","regionId":"respublika-mordoviia"}]}$qa_bundle$::jsonb;
BEGIN
 -- Check existence and narrow public/private grants before creating any probe data.
 IF to_regprocedure('public.dw_enter_workspace(uuid)') IS NULL
   OR to_regprocedure('public.dw_workspace_vote(uuid,uuid,uuid,integer,bigint,text)') IS NULL
   OR to_regprocedure('public.dw_workshop_survey(uuid)') IS NULL
   OR NOT has_function_privilege('authenticated','public.dw_enter_workspace(uuid)','EXECUTE')
   OR has_function_privilege('anon','public.dw_enter_workspace(uuid)','EXECUTE')
   OR has_table_privilege('authenticated','private.dw_current_workspace','SELECT')
   OR has_table_privilege('authenticated','private.dw_workspace_votes','SELECT')
   OR has_table_privilege('authenticated','research.responses','SELECT')
   OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='private' AND c.relname IN ('dw_current_workspace','dw_workspace_votes','dw_workshop_survey_access')
       AND NOT c.relrowsecurity)
   THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE='schema'; END IF;
 v_checks:=v_checks+1;

 -- These history digests are internal variables and never become output rows.
 -- Anonymous response contents are deliberately excluded; only their counts are read.
 FOREACH v_table IN ARRAY v_tables LOOP
   EXECUTE format('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,''[]'')) from %I.%I t',
     split_part(v_table,'.',1),split_part(v_table,'.',2)) INTO v_digest;
   v_before:=v_before||jsonb_build_object(v_table,v_digest);
 END LOOP;
 SELECT jsonb_build_object(
  'actors',(SELECT count(*) FROM private.dw_actors),
  'identities',(SELECT count(*) FROM private.dw_declared_identities),
  'entry_sessions',(SELECT count(*) FROM private.dw_entry_sessions),
  'surveys',(SELECT count(*) FROM research.surveys),
  'responses',(SELECT count(*) FROM research.responses),
  'response_receipts',(SELECT count(*) FROM research.response_receipts),
  'survey_access',(SELECT count(*) FROM private.dw_workshop_survey_access)
 ) INTO v_counts_before;

 BEGIN
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  v_email_a:='qa-workspace-a-'||v_run||'@example.invalid';
  v_email_b:='qa-workspace-b-'||v_run||'@example.invalid';

  v_stage:='email_first_and_participant_roles';
  SELECT count(*) INTO v_actor_count FROM private.dw_actors;
  v_one:=public.dw_identify(v_email_a,NULL);
  IF v_one->'profileRequired' IS DISTINCT FROM 'true'::jsonb
    OR (SELECT count(*) FROM private.dw_actors)<>v_actor_count
    THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_a:=public.dw_identify(v_email_a,'QA Участник А')->'session';
  v_b:=public.dw_identify(v_email_b,'QA Участник Б')->'session';
  v_boot:=public.dw_entry_rpc(v_a->>'access_token','dw_bootstrap','{}'::jsonb);
  IF v_a#>>'{user,id}' IS NOT DISTINCT FROM v_b#>>'{user,id}'
    OR v_boot->'canCreateSession' IS DISTINCT FROM 'false'::jsonb
    THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_checks:=v_checks+1;

  v_stage:='shared_entry_and_stable_membership';
  v_one:=public.dw_entry_rpc(v_a->>'access_token','dw_enter_workspace',jsonb_build_object('p_operation_id',gen_random_uuid()));
  v_two:=public.dw_entry_rpc(v_b->>'access_token','dw_enter_workspace',jsonb_build_object('p_operation_id',gen_random_uuid()));
  v_session:=(v_one#>>'{session,id}')::uuid;
  v_repeat:=public.dw_entry_rpc(v_b->>'access_token','dw_enter_workspace',jsonb_build_object('p_operation_id',gen_random_uuid()));
  IF v_two#>>'{session,id}' IS DISTINCT FROM v_one#>>'{session,id}'
    OR v_two#>>'{session,role}'<>'participant' OR v_one#>>'{session,role}'<>'participant'
    OR v_two#>>'{session,status}'<>'open' OR v_two#>'{session,joinOpen}' IS DISTINCT FROM 'true'::jsonb
    OR v_repeat->'cursor' IS DISTINCT FROM v_two->'cursor'
    OR (SELECT count(*) FROM private.dw_current_workspace)<>1
    THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_checks:=v_checks+1;

  v_stage:='source_publication_and_collective_grouping';
  v_publication:=public.dw_entry_rpc(v_a->>'access_token','dw_publish_submission',jsonb_build_object(
    'p_operation_id',gen_random_uuid(),'p_session_id',v_session,'p_local_key','qa-'||v_run,
    'p_expected_revision',NULL,'p_bundle',v_bundle));
  v_board:=public.dw_entry_rpc(v_a->>'access_token','dw_workshop_snapshot',jsonb_build_object('p_session_id',v_session));
  v_board:=public.dw_entry_rpc(v_a->>'access_token','dw_save_family',jsonb_build_object(
    'p_operation_id',gen_random_uuid(),'p_session_id',v_session,'p_family_id',NULL,
    'p_expected_board_revision',(v_board->>'boardRevision')::bigint,
    'p_title','Транзакционная проверка '||v_run,'p_mechanism','Проверка совместной оценки практики',
    'p_rationale','Временный материал полностью удаляется откатом транзакции',
    'p_submission_ids',jsonb_build_array((SELECT x->>'id' FROM jsonb_array_elements(v_publication->'submissions') x
      WHERE x->>'localKey'='qa-'||v_run AND x->>'authorId'=v_a#>>'{user,id}'))));
  SELECT (x->>'id')::uuid INTO v_family FROM jsonb_array_elements(v_board->'families') x
    WHERE x->>'title'='Транзакционная проверка '||v_run;
  IF v_family IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_checks:=v_checks+1;

  v_stage:='live_votes_replay_and_withdrawal';
  v_votes:=public.dw_entry_rpc(v_a->>'access_token','dw_workspace_votes',jsonb_build_object('p_session_id',v_session));
  SELECT x->>'fingerprint' INTO v_fingerprint FROM jsonb_array_elements(v_votes->'families') x WHERE x->>'familyId'=v_family::text;
  v_operation:=gen_random_uuid();
  v_vote_args:=jsonb_build_object('p_operation_id',v_operation,'p_session_id',v_session,'p_family_id',v_family,
    'p_value',1,'p_expected_revision',0,'p_expected_fingerprint',v_fingerprint);
  v_votes:=public.dw_entry_rpc(v_a->>'access_token','dw_workspace_vote',v_vote_args);
  v_repeat:=public.dw_entry_rpc(v_a->>'access_token','dw_workspace_vote',v_vote_args);
  SELECT x INTO v_one FROM jsonb_array_elements(v_repeat->'families') x WHERE x->>'familyId'=v_family::text;
  IF (v_one->>'support')::integer<>1 OR (v_one->>'myVoteRevision')::integer<>1
    THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_votes:=public.dw_entry_rpc(v_b->>'access_token','dw_workspace_vote',v_vote_args||jsonb_build_object('p_operation_id',gen_random_uuid(),'p_value',-1));
  SELECT x INTO v_one FROM jsonb_array_elements(v_votes->'families') x WHERE x->>'familyId'=v_family::text;
  IF (v_one->>'support')::integer<>1 OR (v_one->>'oppose')::integer<>1 OR (v_one->>'score')::integer<>0
    THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_votes:=public.dw_entry_rpc(v_b->>'access_token','dw_workspace_vote',v_vote_args||jsonb_build_object('p_operation_id',gen_random_uuid(),'p_value',NULL,'p_expected_revision',1));
  SELECT x INTO v_one FROM jsonb_array_elements(v_votes->'families') x WHERE x->>'familyId'=v_family::text;
  IF (v_one->>'support')::integer<>1 OR (v_one->>'oppose')::integer<>0 OR v_one->'myVote' IS DISTINCT FROM 'null'::jsonb
    OR (v_one->>'myVoteRevision')::integer<>2 THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_checks:=v_checks+1;

  v_stage:='vote_cas_and_projector_privacy';
  v_denied:=false;
  BEGIN
   PERFORM public.dw_entry_rpc(v_b->>'access_token','dw_workspace_vote',v_vote_args||jsonb_build_object('p_operation_id',gen_random_uuid()));
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
   v_denied:=SQLERRM='REVISION_CONFLICT';
  END;
  IF NOT v_denied THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_projection:=public.dw_entry_rpc(v_b->>'access_token','dw_workspace_votes_projection',jsonb_build_object('p_session_id',v_session));
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_projection->'families') x
    WHERE x ?| ARRAY['myVote','myVoteRevision','needsReview','actorId','userId'])
    THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_checks:=v_checks+1;

  v_stage:='teacher_only_configuration';
  v_denied:=false;
  BEGIN
   PERFORM public.dw_entry_rpc(v_a->>'access_token','dw_configure_workspace',jsonb_build_object(
     'p_operation_id',gen_random_uuid(),'p_session_id',v_session,'p_expected_revision',(v_two#>>'{session,revision}')::bigint,
     'p_input',jsonb_build_object('title','Временные параметры','scope','federal','regionId',NULL)));
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_denied:=SQLERRM='FORBIDDEN'; END;
  IF NOT v_denied THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_checks:=v_checks+1;

  v_stage:='shared_survey_metadata_and_cursor';
  v_survey_a:=public.dw_entry_rpc(v_a->>'access_token','dw_workshop_survey',jsonb_build_object('p_session_id',v_session));
  v_one:=public.dw_entry_rpc(v_a->>'access_token','dw_barriers_cursor',jsonb_build_object('p_session_id',v_session));
  v_survey_cursor:=(v_one#>>'{}')::bigint;
  v_survey_b:=public.dw_entry_rpc(v_b->>'access_token','dw_workshop_survey',jsonb_build_object('p_session_id',v_session));
  v_two:=public.dw_entry_rpc(v_b->>'access_token','dw_barriers_cursor',jsonb_build_object('p_session_id',v_session));
  IF v_survey_a#>>'{survey,id}' IS DISTINCT FROM v_survey_b#>>'{survey,id}'
    OR v_survey_a->'invitationToken' IS DISTINCT FROM v_survey_b->'invitationToken'
    OR (v_two#>>'{}')::bigint<>v_survey_cursor
    OR v_survey_a ?| ARRAY['responses','answers','actorId','userId','email','responseSecret']
    THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_checks:=v_checks+1;

  v_stage:='research_response_boundary';
  v_denied:=false;
  BEGIN
   PERFORM public.dw_entry_rpc(v_a->>'access_token','dw_survey_host_state',jsonb_build_object(
     'p_session_id',v_session,'p_survey_id',v_survey_a#>>'{survey,id}'));
  EXCEPTION WHEN SQLSTATE 'P0001' THEN v_denied:=SQLERRM='FORBIDDEN'; END;
  IF NOT v_denied THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
  v_checks:=v_checks+1;

  -- This exception is deliberately caught below. It rolls back every probe row,
  -- event, profile, receipt, survey capability and singleton creation in this block.
  RAISE EXCEPTION USING ERRCODE='P0999',MESSAGE='rollback_probe';
 EXCEPTION WHEN SQLSTATE 'P0999' THEN NULL;
 END;

 v_stage:='rollback_preserves_original_history_and_absent_singleton';
 FOREACH v_table IN ARRAY v_tables LOOP
   EXECUTE format('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,''[]'')) from %I.%I t',
     split_part(v_table,'.',1),split_part(v_table,'.',2)) INTO v_digest;
   v_after:=v_after||jsonb_build_object(v_table,v_digest);
 END LOOP;
 SELECT jsonb_build_object(
  'actors',(SELECT count(*) FROM private.dw_actors),
  'identities',(SELECT count(*) FROM private.dw_declared_identities),
  'entry_sessions',(SELECT count(*) FROM private.dw_entry_sessions),
  'surveys',(SELECT count(*) FROM research.surveys),
  'responses',(SELECT count(*) FROM research.responses),
  'response_receipts',(SELECT count(*) FROM research.response_receipts),
  'survey_access',(SELECT count(*) FROM private.dw_workshop_survey_access)
 ) INTO v_counts_after;
 IF v_before IS DISTINCT FROM v_after OR v_counts_before IS DISTINCT FROM v_counts_after
   OR v_checks<>9 THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE=v_stage; END IF;
 v_checks:=v_checks+1;
 IF v_checks<>10 THEN RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE='incomplete_verification'; END IF;
EXCEPTION WHEN OTHERS THEN
 GET STACKED DIAGNOSTICS v_error_state=RETURNED_SQLSTATE;
 RAISE EXCEPTION USING ERRCODE='P0901',MESSAGE='shared-workspace QA failed at '||v_stage||' (SQLSTATE '||v_error_state||')';
END
$qa$;
ROLLBACK;
-- Reached only if all ten groups succeeded and the outer transaction was rolled back.
SELECT true AS passed,10 AS assertion_groups,true AS rolled_back,
 'shared-workspace-0.9'::text AS verification;
