import {it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createTestDatabase,projectRoot} from './harness.mjs';

const id=()=>randomUUID();
const TEACHER='omnistat@yandex.ru';
const MIGRATION='20261109142520_stage8_email_first_profile.sql';
const fail=(promise,code)=>assert.rejects(promise,e=>e.code==='P0001'&&e.message===code);
async function anon(db,sql,args=[]){return db.transaction(async tx=>{
  await tx.exec('set local role anon');
  await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
  return (await tx.query(sql,args)).rows[0]?.result;
});}
const identify=(db,email,name)=>name===undefined
  ?anon(db,'select public.dw_identify($1) result',[email])
  :anon(db,'select public.dw_identify($1,$2) result',[email,name]);
const rpc=(db,s,method,args={})=>anon(db,'select public.dw_entry_rpc($1,$2,$3::jsonb) result',[s.access_token,method,JSON.stringify(args)]);
const create=(db,s)=>rpc(db,s,'dw_create_session',{p_operation_id:id(),p_title:'Сохранённое занятие',p_scope:'federal',p_region_id:null});
const upgrade=db=>readFile(resolve(projectRoot,'supabase/migrations',MIGRATION),'utf8').then(sql=>db.exec(sql));
async function priorDatabase(){
  const db=new PGlite();
  try{
    await db.exec(await readFile(resolve(projectRoot,'tests/database/bootstrap.sql'),'utf8'));
    const dir=resolve(projectRoot,'supabase/migrations');
    for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')&&x<MIGRATION).sort())await db.exec(await readFile(resolve(dir,file),'utf8'));
    return db;
  }catch(error){await db.close();throw error;}
}
const totals=async db=>(await db.query(`select
 (select count(*) from private.dw_actors) actors,
 (select count(*) from private.dw_declared_identities) identities,
 (select count(*) from private.dw_entry_sessions) sessions,
 (select count(*) from public.dw_profiles) profiles,
 (select count(*) from private.facilitators) facilitators,
 (select count(*) from private.audit_events) audit,
 (select count(*) from auth.users) auth`)).rows[0];
const savedProfile=async(db,actor)=>(await db.query('select row_to_json(p)::text row from public.dw_profiles p where user_id=$1',[actor])).rows[0]?.row;

it('asks an unknown email for a name without creating any identity, profile, facilitator or transport session',async()=>{
  const db=await createTestDatabase({seedCorpus:false});
  try{
    const original=await totals(db),mail=id()+'@EXAMPLE.TEST';
    for(const value of [' \u00a0'+mail+'\u00a0 ',mail.toLowerCase(),TEACHER]){
      const response=await identify(db,value);
      assert.deepEqual(response,{profileRequired:true,email:value.trim().toLowerCase()});
      assert.deepEqual(await totals(db),original);
    }
    assert.deepEqual(await identify(db,mail,null),{profileRequired:true,email:mail.toLowerCase()});
    for(const invalid of [null,'bad','a@b',' a b@example.test '])await fail(identify(db,invalid),'INVALID_INPUT');
    for(const name of ['', 'Я', '\u0001a', ' '.repeat(3)])await fail(identify(db,mail,name),'INVALID_INPUT');
    assert.deepEqual(await totals(db),original);
  }finally{await db.close();}
});

it('completes a first profile once and enters returning visitors by email alone without accepting a login-time name overwrite',async()=>{
  const db=await createTestDatabase({seedCorpus:false});
  try{
    const email=id()+'@example.test';
    assert.equal((await identify(db,email)).profileRequired,true);
    const first=(await identify(db,email,'  Иванов Иван Иванович  ')).session;
    assert.equal(first.user.user_metadata.full_name,'Иванов Иван Иванович');
    const original=await savedProfile(db,first.user.id);
    const audit=(await totals(db)).audit;
    for(const submitted of [undefined,null,'Другое Имя','', '\u0001', 'x'.repeat(1000)]){
      const next=(await identify(db,email.toUpperCase(),submitted)).session;
      assert.equal(next.user.id,first.user.id);
      assert.equal(next.user.user_metadata.full_name,'Иванов Иван Иванович');
      assert.notEqual(next.access_token,first.access_token);
      assert.equal(await savedProfile(db,first.user.id),original);
      assert.equal((await totals(db)).audit,audit);
    }
    await anon(db,'select public.dw_entry_logout($1) result',[first.access_token]);
    await fail(anon(db,'select public.dw_entry_session($1) result',[first.access_token]),'AUTH_REQUIRED');
    assert.equal((await identify(db,email)).session.user.id,first.user.id);
    assert.equal((await totals(db)).actors,1);
    assert.equal((await totals(db)).auth,0);
  }finally{await db.close();}
});

it('keeps the first completed name when a delayed first-profile form arrives, then reads deliberate profile edits on email-only entry',async()=>{
  const db=await createTestDatabase({seedCorpus:false});
  try{
    const email=id()+'@example.test';
    assert.equal((await identify(db,email)).profileRequired,true);
    assert.equal((await identify(db,email)).profileRequired,true);
    const first=(await identify(db,email,'Первое Сохранённое Имя')).session;
    const delayed=(await identify(db,email,'Устаревшая Форма Другой Вкладки')).session;
    assert.equal(delayed.user.id,first.user.id);
    assert.equal(delayed.user.user_metadata.full_name,'Первое Сохранённое Имя');
    const profile=(await rpc(db,first,'dw_bootstrap')).profile;
    await rpc(db,first,'dw_save_profile',{p_operation_id:id(),p_expected_revision:profile.revision,p_full_name:'Отредактированное Имя'});
    const next=(await identify(db,email)).session;
    assert.equal(next.user.id,first.user.id);
    assert.equal(next.user.user_metadata.full_name,'Отредактированное Имя');
    assert.equal((await rpc(db,next,'dw_bootstrap')).profile.revision,profile.revision+1);
  }finally{await db.close();}
});

it('requests a missing profile for an existing actor and completes it without replacing its identity',async()=>{
  const db=await createTestDatabase({seedCorpus:false});
  try{
    const email=id()+'@example.test';
    const actor=(await db.query("insert into private.dw_actors(kind) values('declared') returning id")).rows[0].id;
    await db.query('insert into private.dw_declared_identities(email,actor_id) values($1,$2)',[email,actor]);
    const original=await totals(db);
    assert.deepEqual(await identify(db,email),{profileRequired:true,email});
    assert.deepEqual(await totals(db),original);
    const completed=(await identify(db,email,'Ранее Не Заполненный Профиль')).session;
    assert.equal(completed.user.id,actor);
    assert.equal((await identify(db,email)).session.user.user_metadata.full_name,'Ранее Не Заполненный Профиль');
    assert.equal((await totals(db)).actors,original.actors);
  }finally{await db.close();}
});

it('upgrades a populated 0.8.1 database while preserving teacher and learner UUIDs, names, memberships, ownership and existing sessions',async()=>{
  const db=await priorDatabase();
  try{
    const teacher=(await identify(db,TEACHER,'Ситковский Арсений Михайлович')).session;
    const email=id()+'@example.test',student=(await identify(db,email,'Сохранённое ФИО Слушателя')).session;
    const lesson=await create(db,teacher);
    await rpc(db,student,'dw_join_open_session',{p_operation_id:id(),p_session_id:lesson.session.id});
    const beforeProfiles=(await db.query('select row_to_json(p)::text row from public.dw_profiles p order by user_id')).rows;
    const beforeMembers=(await db.query('select row_to_json(m)::text row from public.dw_memberships m order by user_id')).rows;
    const owner=(await db.query('select owner_id from public.dw_sessions where id=$1',[lesson.session.id])).rows[0].owner_id;
    await upgrade(db);
    const returnedTeacher=(await identify(db,'  OMNISTAT@YANDEX.RU  ')).session;
    const returnedStudent=(await identify(db,email)).session;
    assert.equal(returnedTeacher.user.id,teacher.user.id);
    assert.equal(returnedStudent.user.id,student.user.id);
    assert.equal((await rpc(db,returnedTeacher,'dw_bootstrap')).canCreateSession,true);
    assert.equal((await rpc(db,returnedStudent,'dw_bootstrap')).canCreateSession,false);
    assert.equal((await rpc(db,returnedTeacher,'dw_bootstrap')).sessions[0].role,'host');
    assert.equal((await rpc(db,returnedStudent,'dw_bootstrap')).sessions[0].role,'participant');
    await identify(db,email,'Случайное ФИО Из Старого Клиента');
    assert.deepEqual((await db.query('select row_to_json(p)::text row from public.dw_profiles p order by user_id')).rows,beforeProfiles);
    assert.deepEqual((await db.query('select row_to_json(m)::text row from public.dw_memberships m order by user_id')).rows,beforeMembers);
    assert.equal((await db.query('select owner_id from public.dw_sessions where id=$1',[lesson.session.id])).rows[0].owner_id,owner);
    assert.equal((await anon(db,'select public.dw_entry_session($1) result',[teacher.access_token])).session.user.id,teacher.user.id);
    assert.equal((await anon(db,'select public.dw_entry_session($1) result',[student.access_token])).session.user.id,student.user.id);
  }finally{await db.close();}
});

it('opens a previous operator cabinet by teacher email alone using its saved name and retains disabled/revoked boundaries',async()=>{
  const db=await priorDatabase();
  try{
    const host=(await db.query("select private.dw_issue_operator_session('Сохранённое Имя Преподавателя') result")).rows[0].result.session;
    const lesson=await create(db,host);
    const profile=await savedProfile(db,host.user.id);
    await upgrade(db);
    const teacher=(await identify(db,TEACHER)).session;
    assert.equal(teacher.user.id,host.user.id);
    assert.equal(teacher.user.user_metadata.full_name,'Сохранённое Имя Преподавателя');
    assert.equal(await savedProfile(db,host.user.id),profile);
    assert.equal((await rpc(db,teacher,'dw_bootstrap')).sessions[0].id,lesson.session.id);
    await db.query('update private.facilitators set revoked_at=now() where user_id=$1',[teacher.user.id]);
    await fail(identify(db,TEACHER),'FORBIDDEN');
    await db.query('update private.facilitators set revoked_at=null where user_id=$1',[teacher.user.id]);
    await db.query('update private.dw_actors set disabled_at=now() where id=$1',[teacher.user.id]);
    await fail(identify(db,TEACHER),'FORBIDDEN');
  }finally{await db.close();}
});
