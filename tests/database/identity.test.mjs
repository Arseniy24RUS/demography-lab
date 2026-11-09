import {after,before,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createTestDatabase,projectRoot,seedAuthUser,callRpc,loadMordovia} from './harness.mjs';

let db,bundle;
const id=()=>randomUUID();
const fail=(promise,code)=>assert.rejects(promise,e=>e.code==='P0001'&&e.message===code);
const denied=promise=>assert.rejects(promise,e=>e.code==='42501');
async function anon(sql,args=[],database=db){return database.transaction(async tx=>{
  await tx.exec('set local role anon');
  await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
  return (await tx.query(sql,args)).rows[0]?.result;
});}
const identify=(email,name='Участник семинара',database=db)=>anon('select public.dw_identify($1,$2) result',[email,name],database).then(x=>x.session);
const restore=(session,database=db)=>anon('select public.dw_entry_session($1) result',[session.access_token],database).then(x=>x.session);
const rpc=(session,method,args={},database=db)=>anon('select public.dw_entry_rpc($1,$2,$3::jsonb) result',[session.access_token,method,JSON.stringify(args)],database);
const owner=async(database=db)=>(await database.query("select private.dw_issue_operator_session('Ведущий семинара') result")).rows[0].result.session;
const create=(host,database=db)=>rpc(host,'dw_create_session',{p_operation_id:id(),p_title:'Учебная мастерская',p_scope:'municipality',p_region_id:'respublika-mordoviia'},database);
const join=(session,sid,operation=id(),database=db)=>rpc(session,'dw_join_open_session',{p_session_id:sid,p_operation_id:operation},database);
async function patch(host,sid,value,database=db){const current=await rpc(host,'dw_session_snapshot',{p_session_id:sid},database);return rpc(host,'dw_update_session',{p_operation_id:id(),p_session_id:sid,p_expected_revision:current.session.revision,p_patch:value},database);}

before(async()=>{
  db=await createTestDatabase();
  const doc=await loadMordovia();
  const corpus=JSON.parse(await readFile(resolve(projectRoot,'public/data/corpus/practices.json'),'utf8'));
  const raw=corpus.variants.find(x=>x.id==='mordovia-kindergarten-compensation');
  const fields=['id','familyId','regionId','title','mechanism','eligibility','amount','conditions','occurrenceIds','evidence','reviewStatus'];
  const occurrence=['id','documentId','versionId','anchor','reviewStatus','note'];
  bundle={schemaVersion:1,practice:Object.fromEntries(fields.filter(k=>k in raw).map(k=>[k,raw[k]])),
    occurrences:corpus.occurrences.filter(o=>raw.occurrenceIds.includes(o.id)).map(o=>Object.fromEntries(occurrence.filter(k=>k in o).map(k=>[k,o[k]]))),
    sources:[{sourceId:doc.meta.id,editionId:doc.version.id,title:doc.meta.title,sha256:doc.version.sourceSha256,normalizationVersion:doc.version.normalizationVersion,sourceUrl:doc.version.sourceUrl,regionId:doc.meta.regionId}],note:'Реальное документальное основание учебной карточки.'};
});
after(async()=>{await db?.close();});

it('identifies with two fields, normalizes Unicode, preserves actor across devices, and never creates Auth accounts',async()=>{
  const before=(await db.query('select count(*) n from auth.users')).rows[0].n;
  const email=`${id()}@EXAMPLE.TEST`;
  const a=await identify(' \u00a0'+email+'\u00a0 '),b=await identify(email.toLowerCase());
  assert.equal(a.user.id,b.user.id);assert.notEqual(a.access_token,b.access_token);
  assert.match(a.access_token,/^[a-f0-9]{64}$/);assert.equal(a.user.email_confirmed_at,null);
  assert.equal(a.user.app_metadata.email_verified,false);assert.equal(a.user.email,email.toLowerCase());
  const stored=(await db.query('select token_hash from private.dw_entry_sessions where actor_id=$1 order by created_at,id',[a.user.id])).rows;
  assert(stored.some(r=>r.token_hash===createHash('sha256').update(a.access_token).digest('hex')));
  assert(stored.every(r=>r.token_hash!==a.access_token));
  assert.equal((await db.query('select count(*) n from auth.users')).rows[0].n,before);
  assert.equal((await restore(a)).user.id,a.user.id);assert.equal((await restore(b)).user.id,a.user.id);
  for(const [upper,lower] of [['İ','i\u0307'],['ΟΣ','ος'],['TE\u0301ST','tést']]){
    const prefix=id()+'-';assert.equal((await identify(prefix+upper+'@example.test')).user.id,(await identify(prefix+lower+'@example.test')).user.id);
  }
  for(const [mail,name] of [['bad','Иванов Иван'],['ok@example.test','Я'],['ok@example.test','\u00a0'],['ok@example.test','\u0001a']])await fail(identify(mail,name),'INVALID_INPUT');
});

it('restores independently, logs out only one device, and rejects expired or forged tokens',async()=>{
  const email=id()+'@example.test',a=await identify(email),b=await identify(email);
  assert.deepEqual(await anon('select public.dw_entry_logout($1) result',[a.access_token]),{signedOut:true});
  await fail(restore(a),'AUTH_REQUIRED');assert.equal((await restore(b)).user.id,b.user.id);
  await fail(rpc({...b,access_token:'f'.repeat(64)},'dw_bootstrap'),'AUTH_REQUIRED');
  await db.query("update private.dw_entry_sessions set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where token_hash=private.dw_entry_hash($1)",[b.access_token]);
  await fail(restore(b),'AUTH_REQUIRED');
});

it('keeps non-reserved operator emails separate and expires a promoted participant token',async()=>{
  const teacher=id(),mail='teacher-'+id()+'@example.test';
  await seedAuthUser(db,{id:teacher,email:mail});
  await callRpc(db,teacher,'dw_save_profile',{p_operation_id:id(),p_expected_revision:0,p_full_name:'Настоящий преподаватель'});
  await db.query('insert into private.facilitators(user_id) values($1)',[teacher]);
  const claimant=await identify(mail);
  assert.notEqual(claimant.user.id,teacher);assert.equal((await rpc(claimant,'dw_bootstrap')).canCreateSession,false);
  await fail(create(claimant),'FORBIDDEN');
  await denied(anon("select private.dw_issue_operator_session('Незаконный ведущий') result"));
  for(const method of ['dw_issue_operator_session','dw_entry_rpc','dw_survey_save_response','set_config','dw_bootstrap); select 1; --'])await fail(rpc(claimant,method),'FORBIDDEN');
  await fail(rpc(claimant,'dw_bootstrap',{p_role:'host'}),'INVALID_INPUT');
  const host=await owner();assert.equal((await rpc(host,'dw_bootstrap')).canCreateSession,true);
  await db.query('insert into private.facilitators(user_id) values($1)',[claimant.user.id]);
  await fail(restore(claimant),'AUTH_REQUIRED');await fail(identify(mail),'FORBIDDEN');
});

it('joins idempotently, keeps a saved name during login, and broadcasts explicit profile edits',async()=>{
  const host=await owner(),a=await identify(id()+'@example.test','Прежнее Имя'),s=await create(host),sid=s.session.id;
  const choices=await rpc(a,'dw_available_sessions');assert(choices.some(x=>x.id===sid));
  assert.deepEqual(Object.keys(choices.find(x=>x.id===sid)).sort(),['id','regionId','scope','title']);
  const op=id();await join(a,sid,op);await join(a,sid,op);
  assert.equal((await db.query('select count(*) n from public.dw_memberships where session_id=$1 and user_id=$2',[sid,a.user.id])).rows[0].n,1);
  const before=await rpc(host,'dw_session_snapshot',{p_session_id:sid});
  const b=await identify(a.user.email,'Неявная замена при входе');assert.equal(a.user.id,b.user.id);
  const profile=(await rpc(b,'dw_bootstrap')).profile;
  assert.equal(profile.fullName,'Прежнее Имя');
  await rpc(b,'dw_save_profile',{p_operation_id:id(),p_expected_revision:profile.revision,p_full_name:'Новое Имя'});
  const after=await rpc(host,'dw_session_snapshot',{p_session_id:sid});
  assert(after.cursor>before.cursor);assert.equal(after.members.find(m=>m.userId===a.user.id).fullName,'Новое Имя');
  assert.equal((await rpc(b,'dw_bootstrap')).sessions.find(x=>x.id===sid).role,'participant');
  for(const patchValue of [{joinOpen:false},{joinOpen:true,status:'paused'},{status:'closed'}]){
    await patch(host,sid,patchValue);await fail(join(b,sid),'JOIN_CLOSED');
    assert(!(await rpc(b,'dw_available_sessions')).some(x=>x.id===sid));
  }
  await patch(host,sid,{status:'open',joinOpen:true});
  const now=await rpc(host,'dw_session_snapshot',{p_session_id:sid});
  await rpc(host,'dw_revoke_member',{p_operation_id:id(),p_session_id:sid,p_member_id:a.user.id,p_expected_revision:now.members.find(m=>m.userId===a.user.id).revision});
  const c=await identify(a.user.email,'Новое Имя');await fail(join(c,sid),'FORBIDDEN');
});

it('gateway restores SQL identity context after success and failure; direct access and survey linkage stay closed',async()=>{
  const a=await identify(id()+'@example.test');
  await db.transaction(async tx=>{
    await tx.exec('set local role anon');
    await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
    await tx.query("select public.dw_entry_rpc($1,'dw_bootstrap','{}')",[a.access_token]);
    assert.equal((await tx.query('select auth.uid() uid')).rows[0].uid,null);
    assert.equal((await tx.query("select current_setting('demography.entry_hash',true) h")).rows[0].h,'');
  });
  await fail(rpc(a,'dw_session_snapshot',{p_session_id:id()}),'FORBIDDEN');
  await fail(anon("select public.dw_survey_public_manifest($1,$2) result",[id(),'0'.repeat(64)]),'SURVEY_INVITATION_INVALID');
  await denied(anon('select token_hash result from private.dw_entry_sessions limit 1'));
  await denied(anon('select public.dw_bootstrap() result'));
  await fail(callRpc(db,a.user.id,'dw_bootstrap',{}),'EMAIL_NOT_VERIFIED');
});

it('includes declared learners and protected operators in a real frozen voting roster and preserves their ballot on re-entry',async()=>{
  const host=await owner(),a=await identify(id()+'@example.test'),s=await create(host),sid=s.session.id;
  await join(a,sid);
  const published=await rpc(a,'dw_publish_submission',{p_operation_id:id(),p_session_id:sid,p_local_key:bundle.practice.id,p_expected_revision:null,p_bundle:bundle});
  const submission=published.submissions.find(x=>x.authorId===a.user.id);
  const board=await rpc(host,'dw_workshop_snapshot',{p_session_id:sid});
  const grouped=await rpc(host,'dw_save_family',{p_operation_id:id(),p_session_id:sid,p_family_id:null,p_expected_board_revision:board.boardRevision,p_title:'Дошкольная поддержка',p_mechanism:'Компенсация расходов родителей',p_rationale:'Изучаем сопоставимый региональный механизм',p_submission_ids:[submission.id]});
  const familyId=grouped.families[0].id;
  await patch(host,sid,{phase:'discussion'});
  const before=await rpc(host,'dw_workshop_snapshot',{p_session_id:sid});
  const opened=await rpc(host,'dw_open_voting_round',{p_operation_id:id(),p_session_id:sid,p_title:'Выбор приоритета',p_results_visibility:'after_close',p_expected_board_revision:before.boardRevision,p_settings:{}});
  assert.equal(opened.round.eligibleCount,2);
  await rpc(a,'dw_cast_vote',{p_operation_id:id(),p_session_id:sid,p_round_id:opened.round.id,p_family_id:familyId,p_value:1,p_expected_revision:0});
  const again=await identify(a.user.email);
  const round=await rpc(again,'dw_workshop_round_snapshot',{p_session_id:sid,p_round_id:opened.round.id});
  assert.equal(round.families[0].myVote,1);assert.equal(round.families[0].myVoteRevision,1);
  assert.equal((await db.query('select count(*) n from auth.users where id=any($1::uuid[])',[[a.user.id,host.user.id]])).rows[0].n,0);
});

it('upgrades populated Auth-era data preserving UUIDs, memberships, non-reserved teacher exclusion and earliest learner entry',async()=>{
  const old=new PGlite();
  try{
    await old.exec(await readFile(resolve(projectRoot,'tests/database/bootstrap.sql'),'utf8'));
    const dir=resolve(projectRoot,'supabase/migrations'),files=(await readdir(dir)).filter(x=>x.endsWith('.sql')).sort();
    for(const file of files.filter(x=>!x.includes('stage8_')))await old.exec(await readFile(resolve(dir,file),'utf8'));
    const teacher=id(),student=id(),mail=id()+'@example.test',teacherMail=id()+'@example.test';
    for(const [uid,email,name] of [[teacher,teacherMail,'Преподаватель'],[student,mail,'Прежний участник']]){
      await seedAuthUser(old,{id:uid,email});
      await callRpc(old,uid,'dw_save_profile',{p_operation_id:id(),p_expected_revision:0,p_full_name:name});
    }
    await old.query('insert into private.facilitators(user_id) values($1)',[teacher]);
    const s=await callRpc(old,teacher,'dw_create_session',{p_operation_id:id(),p_title:'Сохранённое занятие',p_scope:'federal',p_region_id:null});
    const inv=await callRpc(old,teacher,'dw_invitation',{p_session_id:s.session.id});
    await callRpc(old,student,'dw_join_session',{p_operation_id:id(),p_code:inv.code});
    const stored=(await old.query('select row_to_json(m)::text row from public.dw_memberships m order by user_id')).rows;
    await old.exec(await readFile(resolve(dir,files.find(x=>x.includes('stage8_'))),'utf8'));
    assert.deepEqual((await old.query('select row_to_json(m)::text row from public.dw_memberships m order by user_id')).rows,stored);
    const login=await identify(mail,'Прежний участник',old);assert.equal(login.user.id,student);
    assert.equal((await rpc(login,'dw_bootstrap',{},old)).sessions[0].id,s.session.id);
    assert.notEqual((await identify(teacherMail,'Участник с таким же email',old)).user.id,teacher);
    await seedAuthUser(old,{id:id(),email:id()+'@example.test'});
    assert.equal((await old.query("select count(*) n from private.dw_actors where kind='auth'")).rows[0].n,3);
  }finally{await old.close();}
});
