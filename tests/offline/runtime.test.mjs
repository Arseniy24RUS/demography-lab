import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { openRuntime, backupRuntime, restoreBackup, sha256 } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';
import { loadRoadmapDataset, seedRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';
import { seedCanonicalDocument } from '../../scripts/seed-supabase.mjs';

process.env.NODE_ENV='test';
const id=()=>randomUUID();
const privateSecret=()=>randomBytes(32).toString('base64url');
let work,dataDir,app,base,surveyBase,host,alice,bob,aliceRecovery,hostSession,aliceSession,dataset,sessionId,roomId,backup;
const silent={log(){},error(...args){throw new Error(args.join(' '));}};
const seed=async db=>{
  const doc=JSON.parse(await readFile(new URL('../../public/data/corpus/documents/regional-respublika-mordoviia.json',import.meta.url),'utf8'));
  await seedCanonicalDocument(db,doc);
  dataset??=await loadRoadmapDataset({regionIds:['respublika-mordoviia'],fixture:true});
  await seedRoadmapDataset(db,dataset,{allowFixture:true});
  return {fixture:true,documents:1,blocks:doc.version.blocks.length,territories:dataset.territories.length,series:dataset.series.length};
};
function sdk(url){return createClient(url,'sb_publishable_offline_test',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});}
async function request(path,{target=base,token,origin,json:input={},method='POST',headers={}}={}) {
  const response=await fetch(target+path,{method,headers:{...(method==='POST'?{'Content-Type':'application/json'}:{}),
    ...(token?{Authorization:`Bearer ${token}`} :{}),...(origin?{Origin:origin}:{}),...headers},
    ...(method==='POST'?{body:JSON.stringify(input)}:{})});
  return {status:response.status,body:await response.json(),headers:response.headers};
}
async function rpc(client,name,input={}){const {data,error}=await client.rpc(name,input);assert.equal(error,null,JSON.stringify(error));return data;}
const mut=(client,name,input)=>rpc(client,name,{p_operation_id:id(),p_session_id:sessionId,p_input:input});

before(async()=>{
  work=await mkdtemp(join(tmpdir(),'demography-offline-'));dataDir=join(work,'state');
  await mkdir(join(work,'site/dist/assets'),{recursive:true});
  await mkdir(join(work,'site/public/data/originals'),{recursive:true});
  await mkdir(join(work,'site/public/fonts'),{recursive:true});
  for(const file of['DejaVuSans.ttf','DejaVuSans-Bold.ttf','LICENSE-DejaVu.txt'])
    await writeFile(join(work,'site/public/fonts',file),await readFile(new URL('../../public/fonts/'+file,import.meta.url)));
  await writeFile(join(work,'site/dist/index.html'),'<html><body>Classroom fixture</body></html>');
  await writeFile(join(work,'site/dist/survey.html'),'<html><body>Survey fixture</body></html>');
  await writeFile(join(work,'site/public/data/originals/test.pdf'),'%PDF-test-fixture-only');
  app=await startServer({runtime:await openRuntime({dataDir,testSeed:seed}),host:'127.0.0.1',port:0,surveyPort:0,
    root:join(work,'site'),backupIntervalMs:0,logger:silent});
  base=`http://127.0.0.1:${app.port}`;surveyBase=`http://127.0.0.1:${app.surveyPort}`;
});
after(async()=>{if(app)await app.stop();for(const c of[host,alice,bob])await c?.auth.stopAutoRefresh();await rm(work,{recursive:true,force:true});});

describe('Production offline runtime: identities, domain RPC, isolation and durable recovery',{concurrency:false},()=>{
  it('exposes distinct local config and refuses cross-origin, DNS rebinding, raw SQL and secret files',async()=>{
    const config=await request('/workshop-config.json',{method:'GET'});
    assert.equal(config.body.offline,true);assert.equal(config.body.supabaseUrl,base);assert.equal(config.body.surveyUrl,surveyBase+'/survey.html');
    const anon=await request('/workshop-config.json',{target:surveyBase,method:'GET'});
    assert.equal(anon.body.supabaseUrl,surveyBase);assert.equal('offlineAuthUrl'in anon.body,false);
    assert.equal((await request('/offline/status',{method:'GET',origin:'https://evil.example'})).status,403);
    const forgedHost=await new Promise((resolve,reject)=>{
      const req=httpRequest(base+'/offline/status',{headers:{Host:`evil.example:${app.port}`}},res=>{res.resume();resolve(res.statusCode);});
      req.on('error',reject);req.end();
    });
    assert.equal(forgedHost,403);
    for(const path of['/rest/v1/offline.sessions','/rest/v1/rpc/pg_read_file','/operator.json','/scripts/offline/storage.mjs'])
      assert.ok([401,404].includes((await request(path,{method:path.includes('/rpc/')?'POST':'GET'})).status));
    const status=await request('/offline/status',{method:'GET'});
    assert.equal(JSON.stringify(status.body).includes(app.runtime.operator.joinCode),false);
    assert.equal(JSON.stringify(config.body).includes(app.runtime.operator.hostKey),false);
    assert.equal((await request('/offline/auth/host-bootstrap')).status,403);
    assert.equal((await request('/offline/auth/host-bootstrap',{origin:base})).status,403);
    assert.equal((await request('/offline/auth/host-bootstrap',{origin:'null',headers:{'X-Offline-Host-Bootstrap':'1'}})).status,403);
    assert.equal((await stat(dataDir)).mode&0o777,0o700);
    assert.equal((await stat(join(dataDir,'operator.json'))).mode&0o777,0o600);
  });

  it('creates host only on explicit same-origin loopback bootstrap and supports the real Supabase SDK',async()=>{
    const result=await request('/offline/auth/host-bootstrap',{origin:base,headers:{'X-Offline-Host-Bootstrap':'1'}});
    assert.equal(result.status,200);hostSession=result.body.session;
    assert.equal(hostSession.user.email_confirmed_at,null);assert.equal(hostSession.user.app_metadata.email_verified,false);
    host=sdk(base);assert.equal((await host.auth.setSession(hostSession)).error,null);
    const boot=await rpc(host,'dw_bootstrap');assert.equal(boot.canCreateSession,true);assert.equal(boot.profile,null);
    await rpc(host,'dw_save_profile',{p_operation_id:id(),p_expected_revision:0,p_full_name:'Преподаватель испытания'});
    assert.equal((await request('/offline/admin/status',{method:'GET',token:hostSession.access_token})).status,200);
  });

  it('binds participants to recovery secrets, never treats email text as mailbox ownership or account recovery',async()=>{
    aliceRecovery=privateSecret();
    const input={email:'claimed@example.test',fullName:'Участник А',joinCode:app.runtime.operator.joinCode,recoverySecret:aliceRecovery};
    assert.equal((await request('/offline/auth/register',{json:{...input,joinCode:'wrong'}})).status,403);
    const a=await request('/offline/auth/register',{json:input});assert.equal(a.status,200);aliceSession=a.body.session;
    const duplicate=await request('/offline/auth/register',{json:{...input,fullName:'Подмена имени'}});
    assert.equal(duplicate.body.session.user.id,aliceSession.user.id);
    alice=sdk(base);assert.equal((await alice.auth.setSession(aliceSession)).error,null);
    const b=await request('/offline/auth/register',{json:{...input,recoverySecret:privateSecret(),fullName:'Участник Б'}});
    assert.equal(b.status,200);assert.notEqual(b.body.session.user.id,aliceSession.user.id);
    bob=sdk(base);assert.equal((await bob.auth.setSession(b.body.session)).error,null);
    const boot=await rpc(alice,'dw_bootstrap');assert.equal(boot.canCreateSession,false);assert.equal(boot.profile.fullName,'Участник А');
    assert.equal((await request('/offline/admin/status',{method:'GET',token:aliceSession.access_token})).status,403);
    assert.equal((await request('/offline/auth/recover',{json:{email:'claimed@example.test'}})).status,400);
    const denied=await alice.rpc('dw_create_session',{p_operation_id:id(),p_title:'Unauthorized',p_scope:'federal',p_region_id:null});
    assert.ok(denied.error);
    const confirmed=(await app.runtime.db.query('select count(*)::int as n from auth.users where email_confirmed_at is not null')).rows[0].n;
    assert.equal(confirmed,0);
  });

  it('preserves one shared municipal roadmap, rejects conflicting statistics and rolls back failed operations',async()=>{
    const snapshot=await rpc(host,'dw_create_session',{p_operation_id:id(),p_title:'Офлайн-семинар',p_scope:'municipality',p_region_id:'respublika-mordoviia'});
    sessionId=snapshot.session.id;
    const invitation=await rpc(host,'dw_invitation',{p_session_id:sessionId});
    for(const client of[alice,bob])await rpc(client,'dw_join_session',{p_operation_id:id(),p_code:invitation.code});
    const territory=dataset.territories.find(t=>t.record.level==='municipality'&&dataset.series.some(s=>s.territoryKey===t.record.territoryKey&&s.metricId==='births_total'));
    const room=await mut(alice,'dw_join_roadmap',{territoryKey:territory.record.territoryKey,dataEditionId:dataset.id,expectedAssignmentRevision:0});
    roomId=room.roadmapId;
    assert.equal((await mut(bob,'dw_join_roadmap',{territoryKey:territory.record.territoryKey,dataEditionId:dataset.id,expectedAssignmentRevision:0})).roadmapId,roomId);
    const input={roadmapId:roomId,metricId:'births_total',expectedRevision:0,changes:[{year:2025,action:'set',value:123}],
      sourceReference:'Уточнение администрации',sourceDate:'2026-11-01',reason:'Ведомственный учёт',comparabilityNote:'Границы сопоставлены командой'};
    const outcomes=await Promise.all([alice,bob].map((c,i)=>c.rpc('dw_roadmap_statistics_save',{
      p_operation_id:id(),p_session_id:sessionId,p_input:{...input,changes:[{year:2025,action:'set',value:123+i}]}})));
    assert.equal(outcomes.filter(x=>x.error===null).length,1);
    assert.equal(outcomes.find(x=>x.error)?.error.message,'REVISION_CONFLICT');
    const roomState=await rpc(alice,'dw_roadmap_snapshot',{p_session_id:sessionId,p_roadmap_id:roomId});
    assert.equal(roomState.statistics[0].revision,1);
    const before=(await rpc(alice,'dw_roadmaps_cursor',{p_session_id:sessionId}));
    const invalid=await alice.rpc('dw_roadmap_statistics_save',{p_operation_id:id(),p_session_id:sessionId,
      p_input:{...input,expectedRevision:1,changes:[{year:2026,action:'set',value:-1}]}});
    assert.ok(invalid.error);
    assert.deepEqual(await rpc(alice,'dw_roadmaps_cursor',{p_session_id:sessionId}),before);
    const projection=await rpc(host,'dw_roadmaps_projector_snapshot',{p_session_id:sessionId,p_roadmap_id:roomId});
    assert.equal(JSON.stringify(projection).includes('claimed@example.test'),false);
  });

  it('serves originals locally with ranges and isolates anonymous survey transport from classroom auth',async()=>{
    const response=await fetch(base+'/data/originals/test.pdf',{headers:{Range:'bytes=0-3'}});
    assert.equal(response.status,206);assert.equal(await response.text(),'%PDF');
    for(const file of['DejaVuSans.ttf','DejaVuSans-Bold.ttf','LICENSE-DejaVu.txt']){
      const font=await fetch(base+'/fonts/'+file);assert.equal(font.status,200);
      assert.deepEqual(Buffer.from(await font.arrayBuffer()),await readFile(new URL('../../public/fonts/'+file,import.meta.url)));
    }
    assert.equal((await fetch(base+'/fonts/operator.json')).status,404);
    assert.equal((await fetch(surveyBase+'/data/originals/test.pdf')).status,404);
    assert.equal((await fetch(surveyBase+'/index.html')).status,404);
    assert.equal((await fetch(base+'/survey.html')).status,404);
    assert.equal((await request('/auth/v1/user',{target:surveyBase,method:'GET',token:aliceSession.access_token})).status,404);
    assert.equal((await request('/rest/v1/rpc/dw_bootstrap',{target:surveyBase})).status,404);
    assert.equal((await request('/rest/v1/rpc/dw_survey_public_manifest',{target:surveyBase,token:aliceSession.access_token,
      json:{p_survey_id:id(),p_invitation_token:privateSecret()}})).status,403);
    const manifest=await request('/rest/v1/rpc/dw_survey_public_manifest',{target:surveyBase,
      json:{p_survey_id:id(),p_invitation_token:privateSecret()}});
    assert.equal(manifest.status,400);assert.notEqual(manifest.body.code,'AUTH_REQUIRED');
  });

  it('collects, reads and withdraws an actual anonymous answer on the isolated origin without an account bearer',async()=>{
    const invitation=randomBytes(32).toString('hex'),responseSecret=randomBytes(32).toString('hex');
    const saved=await mut(host,'dw_save_survey',{surveyId:null,expectedRevision:0,title:'Офлайн-опрос',
      purpose:'Учебное обсуждение условий родительства.',organizerContact:'teacher@example.test',
      retentionUntil:new Date(Date.now()+7*86400000).toISOString().slice(0,10),
      questionBarrier:'Что препятствует рождению ребёнка?',questionSupport:'Какое изменение помогло бы?',invitationToken:invitation});
    const survey=(await mut(host,'dw_manage_survey',{surveyId:saved.survey.id,expectedRevision:saved.survey.revision,action:'open'})).survey;
    const answer={expectedRevision:0,questionVersion:survey.questionVersion,perspective:'self',intention12m:null,
      intention36m:'unsure',answerBarrier:'Недоступность услуг ухода.',answerSupport:null,priorityChange:null,
      priorityConditionId:null,horizon:null,conditionalChange:null,additionalConditions:null,
      consentEducational:true,consentResearch:false,consentQuote:false,adultConfirmed:true};
    const response=await request('/rest/v1/rpc/dw_survey_save_response',{target:surveyBase,origin:surveyBase,
      json:{p_operation_id:id(),p_survey_id:survey.id,p_invitation_token:invitation,p_response_secret:responseSecret,p_input:answer}});
    assert.equal(response.status,200);assert.equal(response.body.revision,1);
    const own=await request('/rest/v1/rpc/dw_survey_own_response',{target:surveyBase,
      json:{p_survey_id:survey.id,p_response_secret:responseSecret}});
    assert.equal(own.status,200);assert.equal(own.body.revision,1);
    assert.equal(JSON.stringify(own.body).includes(aliceSession.user.id),false);
    assert.equal(JSON.stringify(own.body).includes('claimed@example.test'),false);
    const withdraw=await request('/rest/v1/rpc/dw_survey_withdraw_response',{target:surveyBase,
      json:{p_operation_id:id(),p_survey_id:survey.id,p_response_secret:responseSecret,p_expected_revision:1}});
    assert.equal(withdraw.status,200);assert.equal(withdraw.body.status,'withdrawn');
  });

  it('rotates refresh tokens, revokes old tokens and keeps device recovery independent from email',async()=>{
    const result=await alice.auth.refreshSession();assert.equal(result.error,null);
    const old=aliceSession;aliceSession=result.data.session;
    assert.notEqual(old.refresh_token,aliceSession.refresh_token);
    assert.equal((await request('/auth/v1/user',{method:'GET',token:old.access_token})).status,200);
    const concurrent=await Promise.all([1,2,3].map(()=>request('/auth/v1/token?grant_type=refresh_token',{json:{refresh_token:old.refresh_token}})));
    for(const r of concurrent){assert.equal(r.status,200);assert.equal(r.body.refresh_token,aliceSession.refresh_token);assert.equal(r.body.access_token,aliceSession.access_token);}
    await app.runtime.db.query('update offline.refresh_receipts set expires_at=now()-interval \'1 second\' where old_refresh_hash=$1',[sha256(old.refresh_token)]);
    assert.equal((await request('/auth/v1/user',{method:'GET',token:old.access_token})).status,401);
    assert.equal((await request('/auth/v1/token?grant_type=refresh_token',{json:{refresh_token:old.refresh_token}})).status,400);
    assert.equal((await alice.auth.signOut({scope:'local'})).error,null);
    assert.equal((await request('/auth/v1/user',{method:'GET',token:aliceSession.access_token})).status,401);
    const recovered=await request('/offline/auth/recover',{json:{recoverySecret:aliceRecovery}});assert.equal(recovered.status,200);
    assert.equal(recovered.body.session.user.id,old.user.id);aliceSession=recovered.body.session;
    assert.equal((await alice.auth.setSession(aliceSession)).error,null);
    assert.equal((await rpc(alice,'dw_bootstrap')).sessions[0].id,sessionId);
  });

  it('writes a consistent checked backup, prevents a second writer and resumes accounts/roadmaps after restart',async()=>{
    await assert.rejects(openRuntime({dataDir,testSeed:seed}),/OFFLINE_DATABASE_IN_USE/);
    const response=await request('/offline/admin/backup',{token:hostSession.access_token});assert.equal(response.status,200);
    backup=response.body.backup;
    const manifest=JSON.parse(await readFile(backup.path,'utf8'));
    assert.equal(manifest.files.some(f=>f.name.includes('lock')),false);
    for(const f of manifest.files)assert.equal(sha256(await readFile(resolve(backup.path,'..',f.name))),f.sha256);
    const malformed=join(dataDir,'backups','backup-2099-01-01T00-00-00-000Z-aaaaaaaa');
    await mkdir(malformed);await writeFile(join(malformed,'manifest.json'),JSON.stringify({schemaVersion:1,createdAt:'2099-01-01T00:00:00.000Z'}));
    await app.stop();app=null;
    const runtime=await openRuntime({dataDir,testSeed:seed});
    assert.ok(runtime.lastBackup);assert.notEqual(runtime.lastBackup.path,join(malformed,'manifest.json'));
    assert.ok((await stat(malformed)).isDirectory());
    app=await startServer({runtime,host:'127.0.0.1',port:0,surveyPort:0,root:join(work,'site'),backupIntervalMs:0,logger:silent});
    base=`http://127.0.0.1:${app.port}`;surveyBase=`http://127.0.0.1:${app.surveyPort}`;
    alice=sdk(base);assert.equal((await alice.auth.setSession(aliceSession)).error,null);
    const state=await rpc(alice,'dw_roadmap_snapshot',{p_session_id:sessionId,p_roadmap_id:roomId});
    assert.equal(state.statistics[0].revision,1);
    await app.stop();app=null;
  });

  it('survives SIGKILL with committed data intact and an interrupted transaction absent',async()=>{
    const worker=fork(new URL('./crash-worker.mjs',import.meta.url),[dataDir],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,NODE_ENV:'test'}});
    let errors='';worker.stderr.on('data',x=>{errors+=x;});
    const done=new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',resolve);worker.once('exit',code=>{if(code!==null&&code!==0)reject(new Error('Crash worker failed: '+errors));});});
    await done;
    const exited=new Promise(resolve=>worker.once('exit',resolve));worker.kill('SIGKILL');await exited;
    const runtime=await openRuntime({dataDir,testSeed:seed});
    try {
      assert.equal((await runtime.db.query("select value from offline.settings where key='crash-committed'")).rows[0].value,true);
      assert.equal((await runtime.db.query("select value from offline.settings where key='crash-uncommitted'")).rows.length,0);
    }finally{await runtime.close();}
  });

  it('restores validated backup only into an empty stopped directory and rejects tampering',async()=>{
    const restored=join(work,'restored');
    await restoreBackup(backup.path,restored);
    const runtime=await openRuntime({dataDir:restored,testSeed:seed});
    try {
      assert.equal((await runtime.db.query('select count(*)::int n from public.dw_sessions')).rows[0].n,1);
      assert.equal((await runtime.db.query('select count(*)::int n from private.dw_roadmap_statistical_revisions')).rows[0].n,1);
    }finally{await runtime.close();}
    await assert.rejects(restoreBackup(backup.path,restored),/EMPTY_DIRECTORY/);
    const manifest=JSON.parse(await readFile(backup.path,'utf8'));manifest.files[0].sha256='0'.repeat(64);
    const bad=resolve(backup.path,'../tampered.json');await writeFile(bad,JSON.stringify(manifest));
    await assert.rejects(restoreBackup(bad,join(work,'bad-restore')),/INTEGRITY_FAILURE/);
    // Exact interruption boundary: metadata is committed, restored data directory is not.
    const interrupted=join(work,'interrupted-restore');await mkdir(interrupted);
    await writeFile(join(interrupted,'operator.json'),await readFile(resolve(backup.path,'../operator.json')));
    await writeFile(join(interrupted,'ready.json'),JSON.stringify(manifest.ready));
    await writeFile(join(interrupted,'restore.pending.json'),JSON.stringify({instanceId:manifest.instanceId}));
    await assert.rejects(openRuntime({dataDir:interrupted,testSeed:seed}),/RESTORE_INCOMPLETE/);
    await assert.rejects(stat(join(interrupted,'database')),e=>e.code==='ENOENT');
    // Even removing a damaged marker cannot turn prepared metadata into a fresh database.
    await rm(join(interrupted,'restore.pending.json'));
    await assert.rejects(openRuntime({dataDir:interrupted,testSeed:seed}),/PREPARED_DATABASE_MISSING/);
    await assert.rejects(stat(join(interrupted,'database')),e=>e.code==='ENOENT');
  });
});
