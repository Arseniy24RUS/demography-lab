import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { identify, authenticate, hostLogin, TEACHER_EMAIL } from '../../scripts/offline/auth.mjs';
import { invokeRpc } from '../../scripts/offline/rpc.mjs';
import { startServer } from '../../scripts/offline/server.mjs';

process.env.NODE_ENV='test';
const seed=async()=>({fixture:true});
const id=()=>randomUUID();
const call=(runtime,identity,name,args={})=>runtime.enqueue(()=>invokeRpc(runtime.db,runtime.catalogue,name,args,identity,false));

it('uses the ordinary LAN entry for the reserved teacher email, retains sessions after logout/restart and keeps other emails participants',async()=>{
  const work=await mkdtemp(join(tmpdir(),'dw-teacher-entry-')),dataDir=join(work,'state');
  let runtime,server;
  try {
    await mkdir(join(work,'site/dist'),{recursive:true});
    for(const page of['index.html','survey.html'])await writeFile(join(work,'site/dist',page),'<html><body>Offline entry fixture</body></html>');
    runtime=await openRuntime({dataDir,testSeed:seed});
    server=await startServer({runtime,host:'127.0.0.1',port:0,surveyPort:0,publicHost:'192.168.50.10',
      root:join(work,'site'),backupIntervalMs:0,logger:{log(){},error(){}}});
    const request=(path,input,token)=>new Promise((resolve,reject)=>{
      const payload=JSON.stringify(input);
      const req=httpRequest(`http://127.0.0.1:${server.port}${path}`,{method:'POST',headers:{
        Host:`192.168.50.10:${server.port}`,Origin:`http://192.168.50.10:${server.port}`,
        'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),
        ...(token?{Authorization:`Bearer ${token}`}:{})}},res=>{
          let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
        });
      req.on('error',reject);req.end(payload);
    });
    const entered=await request('/offline/auth/identify',{email:'  OMNISTAT@YANDEX.RU  ',fullName:'  Арсений   Михайлович  '});
    assert.equal(entered.status,200);assert.deepEqual(Object.keys(entered.body),['session']);
    const session=entered.body.session,teacherId=session.user.id;
    assert.equal(session.user.email,TEACHER_EMAIL);assert.equal(session.user.email_confirmed_at,null);
    const boot=await request('/rest/v1/rpc/dw_bootstrap',{},session.access_token);
    assert.equal(boot.status,200);assert.equal(boot.body.canCreateSession,true);
    assert.equal(boot.body.profile.fullName,'Арсений Михайлович');
    const lesson=await request('/rest/v1/rpc/dw_create_session',{
      p_operation_id:id(),p_title:'Обычный вход преподавателя из локальной сети',p_scope:'federal',p_region_id:null},session.access_token);
    assert.equal(lesson.status,200);assert.equal(lesson.body.session.role,'host');
    for(const email of['other@example.test','omnistat+other@yandex.ru','omnistat@yandex.ru.example']) {
      const participant=await request('/offline/auth/identify',{email,fullName:'Обычный слушатель'});
      assert.equal(participant.status,200);assert.notEqual(participant.body.session.user.id,teacherId);
      const participantBoot=await request('/rest/v1/rpc/dw_bootstrap',{},participant.body.session.access_token);
      assert.equal(participantBoot.body.canCreateSession,false);
      const denied=await request('/rest/v1/rpc/dw_create_session',{
        p_operation_id:id(),p_title:'Недоступно слушателю',p_scope:'federal',p_region_id:null},participant.body.session.access_token);
      assert.equal(denied.status,400);assert.equal(denied.body.message,'FORBIDDEN');
    }
    assert.equal((await request('/offline/auth/identify',{email:'other@example.test',fullName:'Участник',role:'host'})).status,400);
    assert.equal((await request('/auth/v1/logout?scope=local',{},session.access_token)).status,200);
    assert.equal((await request('/rest/v1/rpc/dw_bootstrap',{},session.access_token)).status,401);
    const returned=await request('/offline/auth/identify',{email:TEACHER_EMAIL,fullName:'Арсений Михайлович'});
    assert.equal(returned.body.session.user.id,teacherId);
    assert.equal((await request('/rest/v1/rpc/dw_bootstrap',{},returned.body.session.access_token)).body.sessions[0].id,lesson.body.session.id);
    await server.stop();server=null;runtime=null;
    runtime=await openRuntime({dataDir,testSeed:seed});
    const afterRestart=await runtime.enqueue(()=>identify(runtime,{email:'OmniStat@Yandex.ru',fullName:'Арсений Михайлович'}));
    assert.equal(afterRestart.session.user.id,teacherId);
    const identity=await runtime.enqueue(()=>authenticate(runtime,afterRestart.session.access_token));
    assert.equal((await call(runtime,identity,'dw_bootstrap')).sessions[0].id,lesson.body.session.id);
  } finally {await server?.stop();await runtime?.close();await rm(work,{recursive:true,force:true});}
});

it('promotes the pre-existing reserved-email participant without replacing its UUID, and respects explicit disable/revocation',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'dw-teacher-existing-'));
  let runtime;
  try {
    runtime=await openRuntime({dataDir,testSeed:seed});
    const userId=id();
    await runtime.db.query(`insert into auth.users(id,email,raw_app_meta_data)
      values($1,$2,'{"offline":true,"provider":"offline","email_verified":false}')`,[userId,TEACHER_EMAIL]);
    await runtime.db.query("insert into offline.accounts(user_id,kind) values($1,'participant')",[userId]);
    await runtime.db.query('insert into public.dw_profiles(user_id,full_name) values($1,$2)',[userId,'Прежний профиль']);
    await runtime.db.query('insert into offline.email_identities(normalized_email,user_id) values($1,$2)',[TEACHER_EMAIL,userId]);
    const entered=await runtime.enqueue(()=>identify(runtime,{email:TEACHER_EMAIL,fullName:'Преподаватель'}));
    assert.equal(entered.session.user.id,userId);
    const identity=await runtime.enqueue(()=>authenticate(runtime,entered.session.access_token));
    const boot=await call(runtime,identity,'dw_bootstrap');
    assert.equal(boot.canCreateSession,true);assert.equal(boot.profile.revision,1);
    assert.equal(boot.profile.fullName,'Прежний профиль');
    assert.equal((await runtime.db.query('select count(*)::int as n from offline.accounts')).rows[0].n,1);
    await runtime.db.query('update private.facilitators set revoked_at=now() where user_id=$1',[userId]);
    await assert.rejects(runtime.enqueue(()=>identify(runtime,{email:TEACHER_EMAIL,fullName:'Не записывать'})),{code:'TEACHER_IDENTITY_UNAVAILABLE'});
    assert.equal((await runtime.db.query('select full_name from public.dw_profiles where user_id=$1',[userId])).rows[0].full_name,'Прежний профиль');
    await runtime.db.query('update private.facilitators set revoked_at=null where user_id=$1',[userId]);
    await runtime.db.query('update private.dw_actors set disabled_at=now() where id=$1',[userId]);
    await assert.rejects(runtime.enqueue(()=>identify(runtime,{email:TEACHER_EMAIL,fullName:'Не записывать'})),{code:'TEACHER_IDENTITY_UNAVAILABLE'});
    await assert.rejects(runtime.enqueue(()=>authenticate(runtime,entered.session.access_token)),{code:'TOKEN_EXPIRED_OR_REVOKED'});
  } finally {await runtime?.close();await rm(dataDir,{recursive:true,force:true});}
});

it('keeps the reserved email actor, prior authorship and the old host when both identities already exist',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'dw-teacher-both-'));
  let runtime;
  try {
    runtime=await openRuntime({dataDir,testSeed:seed});
    const oldHost=(await runtime.enqueue(()=>hostLogin(runtime,{hostKey:runtime.operator.hostKey,fullName:'Прежний кабинет'}))).session;
    const oldHostIdentity=await runtime.enqueue(()=>authenticate(runtime,oldHost.access_token));
    const lesson=await call(runtime,oldHostIdentity,'dw_create_session',{
      p_operation_id:id(),p_title:'Историческое занятие',p_scope:'federal',p_region_id:null});
    const prior=await runtime.enqueue(()=>identify(runtime,{email:'before-teacher@example.test',fullName:'Прежний профиль по email'}));
    const userId=prior.session.user.id;
    // Reconstruct the filled 0.8 state: this reserved email was previously an ordinary participant.
    await runtime.db.query('update offline.email_identities set normalized_email=$2 where user_id=$1',[userId,TEACHER_EMAIL]);
    await runtime.db.query('update auth.users set email=$2 where id=$1',[userId,TEACHER_EMAIL]);
    const priorIdentity=await runtime.enqueue(()=>authenticate(runtime,prior.session.access_token));
    await call(runtime,priorIdentity,'dw_join_open_session',{p_operation_id:id(),p_session_id:lesson.session.id});
    const saved=await call(runtime,priorIdentity,'dw_save_barrier',{
      p_operation_id:id(),p_session_id:lesson.session.id,p_input:{barrierId:null,expectedRevision:0,
        title:'Ранее сохранённая проблема',description:'Исходное авторство остаётся прежним.',
        primaryStage:'first_child',stageIds:['first_child'],evidenceKind:'observation',status:'active',priority:false}});
    const author=await runtime.db.query('select user_id from offline.email_identities where normalized_email=$1',[TEACHER_EMAIL]);
    assert.equal(author.rows[0].user_id,userId);
    const oldMembership=(await runtime.db.query('select revision from public.dw_memberships where session_id=$1 and user_id=$2',
      [lesson.session.id,userId])).rows[0];
    const teacher=await runtime.enqueue(()=>identify(runtime,{email:' OMNISTAT@YANDEX.RU ',fullName:'Арсений Михайлович'}));
    assert.equal(teacher.session.user.id,userId);assert.notEqual(userId,oldHost.user.id);
    const identity=await runtime.enqueue(()=>authenticate(runtime,teacher.session.access_token));
    const boot=await call(runtime,identity,'dw_bootstrap');
    assert.equal(boot.canCreateSession,true);assert.equal(boot.sessions[0].id,lesson.session.id);
    assert.equal(boot.sessions[0].role,'host');
    const restored=await call(runtime,identity,'dw_barriers_snapshot',{p_session_id:lesson.session.id});
    assert.equal(restored.barriers[0].id,saved.barriers[0].id);
    assert.equal(restored.barriers[0].authorId,userId);
    assert.equal((await runtime.db.query('select owner_id from public.dw_sessions where id=$1',[lesson.session.id])).rows[0].owner_id,oldHost.user.id);
    assert.deepEqual((await runtime.db.query('select kind,count(*)::int as n from offline.accounts group by kind order by kind')).rows,
      [{kind:'host',n:1},{kind:'teacher',n:1}]);
    const membership=(await runtime.db.query('select revision,role from public.dw_memberships where session_id=$1 and user_id=$2',
      [lesson.session.id,userId])).rows[0];
    assert.equal(membership.role,'host');assert.equal(membership.revision,oldMembership.revision+1);
    await runtime.enqueue(()=>identify(runtime,{email:TEACHER_EMAIL,fullName:'Арсений Михайлович'}));
    assert.equal((await runtime.db.query('select revision from public.dw_memberships where session_id=$1 and user_id=$2',
      [lesson.session.id,userId])).rows[0].revision,membership.revision);
    // The compatibility cabinet remains usable; no legacy identity or work was merged/deleted.
    assert.equal((await call(runtime,oldHostIdentity,'dw_bootstrap')).sessions[0].id,lesson.session.id);
    await runtime.close();runtime=null;
    runtime=await openRuntime({dataDir,testSeed:seed});
    assert.equal((await runtime.enqueue(()=>identify(runtime,{email:TEACHER_EMAIL,fullName:'Арсений Михайлович'}))).session.user.id,userId);
  } finally {await runtime?.close();await rm(dataDir,{recursive:true,force:true});}
});
