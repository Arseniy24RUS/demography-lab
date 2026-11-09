import {it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createTestDatabase,projectRoot,seedAuthUser,callRpc,loadMordovia,seedCanonicalDocument} from './harness.mjs';

const id=()=>randomUUID();
const TEACHER='omnistat@yandex.ru';
const MIGRATION='20261109134923_stage8_teacher_email.sql';
const fail=(promise,code)=>assert.rejects(promise,e=>e.code==='P0001'&&e.message===code);
async function anon(db,sql,args=[]){return db.transaction(async tx=>{
  await tx.exec('set local role anon');
  await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
  return (await tx.query(sql,args)).rows[0]?.result;
});}
const identify=(db,email=TEACHER,name='Ситковский Арсений Михайлович')=>anon(db,'select public.dw_identify($1,$2) result',[email,name]).then(x=>x.session);
const restore=(db,s)=>anon(db,'select public.dw_entry_session($1) result',[s.access_token]).then(x=>x.session);
const rpc=(db,s,method,args={})=>anon(db,'select public.dw_entry_rpc($1,$2,$3::jsonb) result',[s.access_token,method,JSON.stringify(args)]);
const operator=async db=>(await db.query("select private.dw_issue_operator_session('Ситковский Арсений Михайлович') result")).rows[0].result.session;
const create=(db,s,title='Проверка преподавательского входа')=>rpc(db,s,'dw_create_session',{p_operation_id:id(),p_title:title,p_scope:'municipality',p_region_id:'respublika-mordoviia'});
const join=(db,s,sid)=>rpc(db,s,'dw_join_open_session',{p_operation_id:id(),p_session_id:sid});
const upgrade=db=>readFile(resolve(projectRoot,'supabase/migrations',MIGRATION),'utf8').then(sql=>db.exec(sql));
async function priorDatabase(){
  const db=new PGlite();
  try{
    await db.exec(await readFile(resolve(projectRoot,'tests/database/bootstrap.sql'),'utf8'));
    const dir=resolve(projectRoot,'supabase/migrations');
    for(const f of (await readdir(dir)).filter(x=>x.endsWith('.sql')&&x<MIGRATION).sort())await db.exec(await readFile(resolve(dir,f),'utf8'));
    await seedCanonicalDocument(db,await loadMordovia());
    return db;
  }catch(error){await db.close();throw error;}
}
async function evidenceBundle(){
  const doc=await loadMordovia();
  const corpus=JSON.parse(await readFile(resolve(projectRoot,'public/data/corpus/practices.json'),'utf8'));
  const raw=corpus.variants.find(x=>x.id==='mordovia-kindergarten-compensation');
  const fields=['id','familyId','regionId','title','mechanism','eligibility','amount','conditions','occurrenceIds','evidence','reviewStatus'];
  const occurrence=['id','documentId','versionId','anchor','reviewStatus','note'];
  return {schemaVersion:1,practice:Object.fromEntries(fields.filter(k=>k in raw).map(k=>[k,raw[k]])),
    occurrences:corpus.occurrences.filter(o=>raw.occurrenceIds.includes(o.id)).map(o=>Object.fromEntries(occurrence.filter(k=>k in o).map(k=>[k,o[k]]))),
    sources:[{sourceId:doc.meta.id,editionId:doc.version.id,title:doc.meta.title,sha256:doc.version.sourceSha256,normalizationVersion:doc.version.normalizationVersion,sourceUrl:doc.version.sourceUrl,regionId:doc.meta.regionId}],
    note:'Сохраняем документальные основания при обновлении преподавательского входа.'};
}
async function material(db){
  const result={};
  for(const table of ['dw_submissions','dw_voting_rounds','dw_round_families','dw_round_variants','dw_round_roster','dw_ballots']){
    const schema=table==='dw_submissions'?'public':'private';
    result[table]=(await db.query(`select row_to_json(x)::text as row from ${schema}.${table} x order by row_to_json(x)::text`)).rows;
  }
  return result;
}

it('uses the ordinary two-field form for the exact teacher email, normalizes it and retains logout and return behavior',async()=>{
  const db=await createTestDatabase();
  try{
    const teacher=await identify(db,' \u00a0OMNISTAT@YANDEX.RU\u00a0 ');
    assert.equal(teacher.user.email,TEACHER);
    assert.equal(teacher.user.email_confirmed_at,null);
    assert.equal(teacher.user.app_metadata.provider,'operator');
    assert.equal(teacher.user.app_metadata.email_verified,false);
    assert.equal((await rpc(db,teacher,'dw_bootstrap')).canCreateSession,true);
    const lesson=await create(db,teacher);
    assert.equal(lesson.session.role,'host');
    await rpc(db,teacher,'dw_update_session',{p_operation_id:id(),p_session_id:lesson.session.id,p_expected_revision:lesson.session.revision,p_patch:{title:'Переименовано преподавателем'}});
    assert.equal((await rpc(db,teacher,'dw_projector_snapshot',{p_session_id:lesson.session.id})).title,'Переименовано преподавателем');
    assert.equal((await db.query('select count(*) n from auth.users')).rows[0].n,0);
    await anon(db,'select public.dw_entry_logout($1) result',[teacher.access_token]);
    await fail(restore(db,teacher),'AUTH_REQUIRED');
    const again=await identify(db,TEACHER,'Ситковский Арсений Михайлович');
    assert.equal(again.user.id,teacher.user.id);
    assert.equal((await rpc(db,again,'dw_bootstrap')).sessions[0].id,lesson.session.id);
    for(const email of ['omnistat+course@yandex.ru','omnistat@yandex.com','other@yandex.ru']){
      const student=await identify(db,email,'Обычный участник');
      assert.equal((await rpc(db,student,'dw_bootstrap')).canCreateSession,false);
      await fail(create(db,student),'FORBIDDEN');
    }
    assert.equal((await db.query("select has_table_privilege('anon','private.facilitators','SELECT') permitted")).rows[0].permitted,false);
  }finally{await db.close();}
});

it('binds the sole former operator to the teacher email when that email has no existing identity',async()=>{
  const db=await priorDatabase();
  try{
    const host=await operator(db),lesson=await create(db,host);
    const memberships=(await db.query('select row_to_json(m)::text row from public.dw_memberships m order by user_id')).rows;
    await upgrade(db);
    const teacher=await identify(db);
    assert.equal(teacher.user.id,host.user.id);
    assert.deepEqual((await db.query('select row_to_json(m)::text row from public.dw_memberships m order by user_id')).rows,memberships);
    assert.equal((await rpc(db,teacher,'dw_bootstrap')).sessions[0].id,lesson.session.id);
    assert.equal((await restore(db,host)).user.id,host.user.id);
  }finally{await db.close();}
});

it('upgrades an already-used teacher email without replacing its actor, old owner, publications or fixed voting material',async()=>{
  const db=await priorDatabase();
  try{
    const host=await operator(db),formerLearner=await identify(db),student=await identify(db,id()+'@example.test','Участник');
    const lesson=await create(db,host),sid=lesson.session.id;
    await join(db,formerLearner,sid);await join(db,student,sid);
    const bundle=await evidenceBundle();
    const publication=await rpc(db,formerLearner,'dw_publish_submission',{p_operation_id:id(),p_session_id:sid,p_local_key:bundle.practice.id,p_expected_revision:null,p_bundle:bundle});
    const board=await rpc(db,host,'dw_workshop_snapshot',{p_session_id:sid});
    const family=await rpc(db,host,'dw_save_family',{p_operation_id:id(),p_session_id:sid,p_family_id:null,p_expected_board_revision:board.boardRevision,p_title:'Дошкольная поддержка',p_mechanism:'Компенсация расходов родителей',p_rationale:'Сопоставимый механизм',p_submission_ids:[publication.submissions[0].id]});
    await rpc(db,host,'dw_update_session',{p_operation_id:id(),p_session_id:sid,p_expected_revision:lesson.session.revision,p_patch:{phase:'discussion'}});
    const opened=await rpc(db,host,'dw_open_voting_round',{p_operation_id:id(),p_session_id:sid,p_title:'Приоритеты поддержки',p_results_visibility:'after_close',p_expected_board_revision:family.boardRevision,p_settings:{}});
    await rpc(db,formerLearner,'dw_cast_vote',{p_operation_id:id(),p_session_id:sid,p_round_id:opened.round.id,p_family_id:family.families[0].id,p_value:1,p_expected_revision:0});
    await rpc(db,student,'dw_cast_vote',{p_operation_id:id(),p_session_id:sid,p_round_id:opened.round.id,p_family_id:family.families[0].id,p_value:-1,p_expected_revision:0});
    await rpc(db,host,'dw_close_voting_round',{p_operation_id:id(),p_session_id:sid,p_round_id:opened.round.id,p_expected_revision:opened.round.revision});
    const second=await create(db,host,'Ранее созданное занятие без членства по email');
    const originalMaterial=await material(db);
    const originalOwner=(await db.query('select id,owner_id from public.dw_sessions order by id')).rows;
    const originalOtherMembers=(await db.query('select row_to_json(m)::text row from public.dw_memberships m where user_id<>$1 order by session_id,user_id',[formerLearner.user.id])).rows;
    const initialCursor=(await rpc(db,host,'dw_session_snapshot',{p_session_id:sid})).cursor;
    await upgrade(db);
    assert.deepEqual(await material(db),originalMaterial);
    const teacher=await identify(db);
    assert.equal(teacher.user.id,formerLearner.user.id);
    assert.equal((await rpc(db,teacher,'dw_bootstrap')).canCreateSession,true);
    assert.equal((await rpc(db,teacher,'dw_session_snapshot',{p_session_id:sid})).session.role,'host');
    assert.equal((await rpc(db,teacher,'dw_session_snapshot',{p_session_id:second.session.id})).session.role,'host');
    const memberships=(await db.query('select session_id,role,revision from public.dw_memberships where user_id=$1 order by session_id',[teacher.user.id])).rows;
    assert.equal(memberships.find(x=>x.session_id===sid).revision,2);
    assert.equal(memberships.find(x=>x.session_id===second.session.id).revision,1);
    assert.deepEqual((await db.query('select id,owner_id from public.dw_sessions order by id')).rows,originalOwner);
    assert.deepEqual((await db.query('select row_to_json(m)::text row from public.dw_memberships m where user_id<>$1 order by session_id,user_id',[teacher.user.id])).rows,originalOtherMembers);
    assert.deepEqual(await material(db),originalMaterial);
    const round=await rpc(db,teacher,'dw_workshop_round_snapshot',{p_session_id:sid,p_round_id:opened.round.id});
    assert.equal(round.families[0].myVote,1);
    assert.equal(round.eligibleCount,3);
    const currentCursor=(await rpc(db,teacher,'dw_session_snapshot',{p_session_id:sid})).cursor;
    assert(currentCursor>initialCursor);
    await fail(restore(db,formerLearner),'AUTH_REQUIRED');
    const again=await identify(db);
    assert.equal(again.user.id,teacher.user.id);
    assert.equal((await rpc(db,again,'dw_session_snapshot',{p_session_id:sid})).cursor,currentCursor);
    assert.deepEqual((await db.query('select session_id,role,revision from public.dw_memberships where user_id=$1 order by session_id',[teacher.user.id])).rows,memberships);
    assert.equal((await rpc(db,student,'dw_bootstrap')).canCreateSession,false);
    await fail(create(db,student),'FORBIDDEN');
    assert.equal((await rpc(db,host,'dw_session_snapshot',{p_session_id:sid})).session.role,'host');
  }finally{await db.close();}
});

it('preserves an exact-email Auth-era teacher and never adopts an unrelated operator from an ambiguous installation',async()=>{
  const db=await priorDatabase();
  try{
    const authId=id();
    await seedAuthUser(db,{id:authId,email:'OMNISTAT@YANDEX.RU'});
    await callRpc(db,authId,'dw_save_profile',{p_operation_id:id(),p_expected_revision:0,p_full_name:'Ситковский Арсений Михайлович'});
    await db.query('insert into private.facilitators(user_id) values($1)',[authId]);
    const lesson=await callRpc(db,authId,'dw_create_session',{p_operation_id:id(),p_title:'Прежний преподаватель',p_scope:'federal',p_region_id:null});
    await operator(db);await operator(db);
    await upgrade(db);
    const teacher=await identify(db);
    assert.equal(teacher.user.id,authId);
    assert.equal((await rpc(db,teacher,'dw_bootstrap')).sessions[0].id,lesson.session.id);
    assert.equal((await db.query('select count(*) n from private.dw_declared_identities where actor_id=$1',[authId])).rows[0].n,1);
  }finally{await db.close();}
});

it('keeps multiple legacy operators separate and does not revive explicitly revoked teacher membership',async()=>{
  const db=await priorDatabase();
  try{
    const a=await operator(db),b=await operator(db),lesson=await create(db,a);
    const emailActor=await identify(db);
    await join(db,emailActor,lesson.session.id);
    await db.query('update public.dw_memberships set revoked_at=now(),revision=revision+1 where session_id=$1 and user_id=$2',[lesson.session.id,emailActor.user.id]);
    const original=(await db.query('select row_to_json(m)::text row from public.dw_memberships m order by user_id')).rows;
    await upgrade(db);
    const teacher=await identify(db);
    assert.equal(teacher.user.id,emailActor.user.id);
    assert.notEqual(teacher.user.id,a.user.id);assert.notEqual(teacher.user.id,b.user.id);
    assert.equal((await rpc(db,teacher,'dw_bootstrap')).canCreateSession,true);
    assert.equal((await rpc(db,teacher,'dw_bootstrap')).sessions.length,0);
    assert.deepEqual((await db.query('select row_to_json(m)::text row from public.dw_memberships m order by user_id')).rows,original);
    await fail(rpc(db,teacher,'dw_session_snapshot',{p_session_id:lesson.session.id}),'FORBIDDEN');
  }finally{await db.close();}
});

it('honors explicit actor disable and facilitator revocation after introducing teacher email entry',async()=>{
  const db=await createTestDatabase();
  try{
    const teacher=await identify(db);
    await db.query('update private.facilitators set revoked_at=now() where user_id=$1',[teacher.user.id]);
    await fail(identify(db),'FORBIDDEN');await fail(restore(db,teacher),'AUTH_REQUIRED');
    await db.query('update private.facilitators set revoked_at=null where user_id=$1',[teacher.user.id]);
    await db.query('update private.dw_actors set disabled_at=now() where id=$1',[teacher.user.id]);
    await fail(identify(db),'FORBIDDEN');await fail(restore(db,teacher),'AUTH_REQUIRED');
    assert.equal((await db.query('select count(*) n from private.dw_declared_identities where email=$1',[TEACHER])).rows[0].n,1);
  }finally{await db.close();}
});
