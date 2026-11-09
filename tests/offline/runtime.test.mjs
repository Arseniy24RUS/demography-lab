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
let work,dataDir,app,base,surveyBase,host,alice,bob,hostSession,aliceSession,dataset,sessionId,roomId,backup;
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
async function preparedMordoviaBundle() {
  const prepared=JSON.parse(await readFile(new URL('../../public/data/corpus/practices.json',import.meta.url),'utf8'));
  const raw=prepared.variants.find(v=>v.id==='mordovia-kindergarten-compensation');assert.ok(raw);
  const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>key in value).map(key=>[key,value[key]]));
  const doc=JSON.parse(await readFile(new URL('../../public/data/corpus/documents/regional-respublika-mordoviia.json',import.meta.url),'utf8'));
  return {schemaVersion:1,
    practice:pick(raw,['id','familyId','regionId','title','mechanism','eligibility','amount','conditions','occurrenceIds','evidence','reviewStatus']),
    occurrences:prepared.occurrences.filter(o=>raw.occurrenceIds.includes(o.id)).map(o=>pick(o,['id','documentId','versionId','anchor','reviewStatus','note'])),
    sources:[{sourceId:doc.meta.id,editionId:doc.version.id,title:doc.meta.title,sha256:doc.version.sourceSha256,
      normalizationVersion:doc.version.normalizationVersion,sourceUrl:doc.version.sourceUrl,regionId:doc.meta.regionId}],
    note:'Проверка локального голосования: точная цитата исходной программы.'};
}

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

describe('Production offline runtime: simple identities, domain RPC, isolation and durability',{concurrency:false},()=>{
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
    const boot=await rpc(host,'dw_bootstrap');assert.equal(boot.canCreateSession,true);assert.equal(boot.profile.fullName,'Преподаватель');
    await rpc(host,'dw_save_profile',{p_operation_id:id(),p_expected_revision:boot.profile.revision,p_full_name:'Преподаватель испытания'});
    const repeated=await request('/offline/auth/host-bootstrap',{origin:base,headers:{'X-Offline-Host-Bootstrap':'1'},json:{fullName:'Не менять прежнее имя'}});
    assert.equal(repeated.status,200);assert.equal(repeated.body.session.user.id,hostSession.user.id);
    assert.equal((await rpc(host,'dw_bootstrap')).profile.fullName,'Преподаватель испытания');
    assert.equal((await request('/offline/admin/status',{method:'GET',token:hostSession.access_token})).status,200);
  });

  it('identifies through two fields and reuses one participant across case variants, devices and retries',async()=>{
    const input={email:'  CLAIMED@Example.Test  ',fullName:'  Участник   А  '};
    for(const invalid of[{...input,email:'invalid'}, {...input,fullName:' '}, {...input,role:'host'}, {...input,recoverySecret:privateSecret()}])
      assert.equal((await request('/offline/auth/identify',{json:invalid})).status,400);
    const a=await request('/offline/auth/identify',{json:input});assert.equal(a.status,200);aliceSession=a.body.session;
    assert.deepEqual(Object.keys(a.body),['session']);
    assert.equal(aliceSession.user.email,'claimed@example.test');
    assert.equal(aliceSession.user.email_confirmed_at,null);assert.equal(aliceSession.user.user_metadata.email_verified,false);
    const duplicates=await Promise.all([1,2,3].map(()=>request('/offline/auth/identify',{json:{email:'claimed@EXAMPLE.test',fullName:'Участник А'}})));
    for(const duplicate of duplicates){assert.equal(duplicate.status,200);assert.equal(duplicate.body.session.user.id,aliceSession.user.id);}
    assert.equal((await app.runtime.db.query("select count(*)::int as n from auth.users where email='claimed@example.test'")).rows[0].n,1);
    assert.equal((await request('/auth/v1/user',{method:'GET',token:aliceSession.access_token})).status,200);
    alice=sdk(base);assert.equal((await alice.auth.setSession(aliceSession)).error,null);
    const b=await request('/offline/auth/identify',{json:{email:'other@example.test',fullName:'Участник Б'}});
    assert.equal(b.status,200);assert.notEqual(b.body.session.user.id,aliceSession.user.id);
    bob=sdk(base);assert.equal((await bob.auth.setSession(b.body.session)).error,null);
    const boot=await rpc(alice,'dw_bootstrap');assert.equal(boot.canCreateSession,false);assert.equal(boot.profile.fullName,'Участник А');
    assert.equal((await request('/offline/admin/status',{method:'GET',token:aliceSession.access_token})).status,403);
    for(const path of['/offline/auth/register','/offline/auth/recover']) {
      const obsolete=await request(path,{json:input});assert.equal(obsolete.status,410);assert.equal(obsolete.body.message,'Введите email и ФИО');
    }
    const denied=await alice.rpc('dw_create_session',{p_operation_id:id(),p_title:'Unauthorized',p_scope:'federal',p_region_id:null});
    assert.ok(denied.error);
    const confirmed=(await app.runtime.db.query('select count(*)::int as n from auth.users where email_confirmed_at is not null')).rows[0].n;
    assert.equal(confirmed,0);
  });

  it('never obtains a host or facilitator identity by entering its email',async()=>{
    const result=await request('/offline/auth/identify',{json:{email:hostSession.user.email,fullName:'Обычный слушатель'}});
    assert.equal(result.status,200);assert.notEqual(result.body.session.user.id,hostSession.user.id);
    const token=result.body.session.access_token;
    const boot=await request('/rest/v1/rpc/dw_bootstrap',{token});assert.equal(boot.body.canCreateSession,false);
    assert.equal((await request('/offline/admin/status',{method:'GET',token})).status,403);
    const promoted=await request('/offline/auth/identify',{json:{email:'promoted@example.test',fullName:'Отдельный оператор'}});
    await app.runtime.db.query('insert into private.facilitators(user_id) values($1)',[promoted.body.session.user.id]);
    assert.equal((await request('/auth/v1/user',{method:'GET',token:promoted.body.session.access_token})).status,401);
    assert.equal((await request('/auth/v1/token?grant_type=refresh_token',{json:{refresh_token:promoted.body.session.refresh_token}})).status,400);
    assert.equal((await request('/offline/auth/identify',{json:{email:'promoted@example.test',fullName:'Попытка оператора'}})).status,403);
    assert.equal((await rpc(host,'dw_bootstrap')).profile.fullName,'Преподаватель испытания');
  });

  it('honors the shared actor disable flag on access, refresh and repeat identification',async()=>{
    const entered=await request('/offline/auth/identify',{json:{email:'disabled@example.test',fullName:'Отключаемая запись'}});
    assert.equal(entered.status,200);
    const session=entered.body.session;
    await app.runtime.db.query('update private.dw_actors set disabled_at=now() where id=$1',[session.user.id]);
    assert.equal((await request('/auth/v1/user',{method:'GET',token:session.access_token})).status,401);
    assert.equal((await request('/auth/v1/token?grant_type=refresh_token',{json:{refresh_token:session.refresh_token}})).status,400);
    assert.equal((await request('/offline/auth/identify',{json:{email:'disabled@example.test',fullName:'Попытка изменения'}})).status,403);
    assert.equal((await app.runtime.db.query('select private.dw_actor_eligible($1) as eligible',[session.user.id])).rows[0].eligible,false);
    assert.equal((await app.runtime.db.query('select full_name from public.dw_profiles where user_id=$1',[session.user.id])).rows[0].full_name,'Отключаемая запись');
  });

  it('selects the earliest eligible legacy participant without deleting duplicate identities or their history',async()=>{
    const ids=[id(),id(),id()];
    for(let i=0;i<ids.length;i++) {
      await app.runtime.db.query(`insert into auth.users(id,email,raw_app_meta_data,created_at)
        values($1,$2,'{"offline":true,"email_verified":false}',now()-make_interval(days=>$3))`,[ids[i],' Legacy@Example.test ',3-i]);
      await app.runtime.db.query(`insert into offline.accounts(user_id,recovery_hash,kind,created_at)
        values($1,$2,'participant',now()-make_interval(days=>$3))`,[ids[i],sha256(privateSecret()),3-i]);
      await app.runtime.db.query('insert into public.dw_profiles(user_id,full_name) values($1,$2)',[ids[i],`Прежнее имя ${i}`]);
    }
    // The oldest address match is deliberately an operator and must be excluded.
    await app.runtime.db.query('insert into private.facilitators(user_id) values($1)',[ids[0]]);
    const result=await request('/offline/auth/identify',{json:{email:'legacy@example.test',fullName:'Уточнённое имя'}});
    assert.equal(result.status,200);assert.equal(result.body.session.user.id,ids[1]);
    const repeat=await request('/offline/auth/identify',{json:{email:' LEGACY@example.TEST ',fullName:'Уточнённое имя'}});
    assert.equal(repeat.body.session.user.id,ids[1]);
    const profiles=(await app.runtime.db.query('select user_id,full_name,revision from public.dw_profiles where user_id=any($1::uuid[])',[ids])).rows;
    assert.equal(profiles.length,3);assert.equal(profiles.find(x=>x.user_id===ids[2]).full_name,'Прежнее имя 2');
    assert.equal(profiles.find(x=>x.user_id===ids[1]).revision,2);
  });

  it('uses identical Unicode canonicalization for new entries and old device identities',async()=>{
    for(const [legacyEmail,enteredEmail]of[
      ['İ@Example.Test','i\u0307@example.test'],
      ['ΟΣ@Example.Test','ος@example.test'],
      ['CAFE\u0301@Example.Test','café@example.test'],
    ]) {
      const userId=id();
      await app.runtime.db.query(`insert into auth.users(id,email,raw_app_meta_data)
        values($1,$2,'{"offline":true,"email_verified":false}')`,[userId,legacyEmail]);
      await app.runtime.db.query("insert into offline.accounts(user_id,recovery_hash,kind) values($1,$2,'participant')",[userId,sha256(privateSecret())]);
      const result=await request('/offline/auth/identify',{json:{email:enteredEmail,fullName:'  Семён   Семёнович  '}});
      assert.equal(result.status,200);assert.equal(result.body.session.user.id,userId);
      const repeated=await request('/offline/auth/identify',{json:{email:legacyEmail,fullName:'Семён Семёнович'}});
      assert.equal(repeated.status,200);assert.equal(repeated.body.session.user.id,userId);
      assert.equal(repeated.body.session.user.user_metadata.full_name,'Семён Семёнович');
    }
  });

  it('preserves one shared municipal roadmap, rejects conflicting statistics and rolls back failed operations',async()=>{
    const snapshot=await rpc(host,'dw_create_session',{p_operation_id:id(),p_title:'Офлайн-семинар',p_scope:'municipality',p_region_id:'respublika-mordoviia'});
    sessionId=snapshot.session.id;
    for(const client of[alice,bob]) {
      const available=await rpc(client,'dw_available_sessions');
      assert.ok(available.some(s=>s.id===sessionId));
      assert.deepEqual(Object.keys(available.find(s=>s.id===sessionId)).sort(),['id','regionId','scope','title']);
      const args={p_operation_id:id(),p_session_id:sessionId};
      const joined=await rpc(client,'dw_join_open_session',args);
      const repeated=await rpc(client,'dw_join_open_session',args);
      assert.equal(joined.session.id,sessionId);assert.equal(repeated.cursor,joined.cursor);
      assert.equal(repeated.members.length,joined.members.length);
    }
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

  it('allows entry from an open session link while preserving closed and revoked membership rules',async()=>{
    const entered=await request('/offline/auth/identify',{json:{email:'newcomer@example.test',fullName:'Новый слушатель'}});
    assert.equal(entered.status,200);
    const token=entered.body.session.access_token,userId=entered.body.session.user.id;
    const call=(name,args={})=>request('/rest/v1/rpc/'+name,{token,json:args});
    const patch=async joinOpen=>{
      const current=await rpc(host,'dw_session_snapshot',{p_session_id:sessionId});
      return rpc(host,'dw_update_session',{p_operation_id:id(),p_session_id:sessionId,p_expected_revision:current.session.revision,p_patch:{joinOpen}});
    };
    await patch(false);
    const available=await call('dw_available_sessions');assert.equal(available.status,200);assert.equal(available.body.some(s=>s.id===sessionId),false);
    const closed=await call('dw_join_open_session',{p_operation_id:id(),p_session_id:sessionId});
    assert.equal(closed.status,400);assert.equal(closed.body.code,'JOIN_CLOSED');
    await patch(true);
    const joined=await call('dw_join_open_session',{p_operation_id:id(),p_session_id:sessionId});
    assert.equal(joined.status,200);assert.equal(joined.body.session.id,sessionId);
    const member=joined.body.members.find(m=>m.userId===userId);assert.equal(member.role,'participant');
    await rpc(host,'dw_revoke_member',{p_operation_id:id(),p_session_id:sessionId,p_member_id:userId,p_expected_revision:member.revision});
    const revoked=await call('dw_join_open_session',{p_operation_id:id(),p_session_id:sessionId});
    assert.equal(revoked.status,400);assert.equal(revoked.body.code,'FORBIDDEN');
    assert.equal((await call('dw_barriers_snapshot',{p_session_id:sessionId})).status,400);
    assert.equal((await call('dw_entry_rpc',{p_token:'arbitrary',p_method:'dw_bootstrap',p_args:{}})).status,404);
    assert.equal((await request('/rest/v1/rpc/dw_available_sessions')).status,401);
    assert.equal((await request('/rest/v1/rpc/dw_available_sessions',{target:surveyBase})).status,404);
  });

  it('also separates a host membership that has no facilitator registry entry',async()=>{
    const entered=await request('/offline/auth/identify',{json:{email:'membership-host@example.test',fullName:'Другой преподаватель'}});
    assert.equal(entered.status,200);
    const session=entered.body.session;
    await app.runtime.db.query("insert into public.dw_memberships(session_id,user_id,role) values($1,$2,'host')",[sessionId,session.user.id]);
    assert.equal((await request('/auth/v1/user',{method:'GET',token:session.access_token})).status,401);
    assert.equal((await request('/offline/auth/identify',{json:{email:'membership-host@example.test',fullName:'Попытка преподавателя'}})).status,403);
    assert.equal((await request('/offline/admin/status',{method:'GET',token:hostSession.access_token})).status,200);
  });

  it('admits unverified local identities into a real frozen voting round and preserves its privacy',async()=>{
    const bundle=await preparedMordoviaBundle();
    const published=await rpc(alice,'dw_publish_submission',{p_operation_id:id(),p_session_id:sessionId,
      p_local_key:'offline-voting-regression',p_expected_revision:null,p_bundle:bundle});
    const submission=published.submissions.find(s=>s.localKey==='offline-voting-regression');assert.ok(submission);
    const before=await rpc(host,'dw_workshop_snapshot',{p_session_id:sessionId});
    const grouped=await rpc(host,'dw_save_family',{p_operation_id:id(),p_session_id:sessionId,p_family_id:null,
      p_expected_board_revision:before.boardRevision,p_title:'Компенсация родительской платы',
      p_mechanism:'Возмещение расходов на дошкольное образование',p_rationale:'Сохраняем исходную цитату и региональные условия.',p_submission_ids:[submission.id]});
    const state=await rpc(host,'dw_session_snapshot',{p_session_id:sessionId});
    await rpc(host,'dw_update_session',{p_operation_id:id(),p_session_id:sessionId,p_expected_revision:state.session.revision,p_patch:{phase:'discussion'}});
    const opened=await rpc(host,'dw_open_voting_round',{p_operation_id:id(),p_session_id:sessionId,p_title:'Приоритеты адаптации',
      p_results_visibility:'after_close',p_expected_board_revision:grouped.boardRevision,p_settings:{minCoverage:0.5,minSubstantiveVotes:2}});
    assert.equal(opened.round.eligibleCount,3); // Actual local host, Alice and Bob; the forged host-member is excluded.
    const familyId=opened.round.families[0].id;
    const args={p_session_id:sessionId,p_round_id:opened.round.id,p_family_id:familyId,p_expected_revision:0};
    const first=await rpc(alice,'dw_cast_vote',{...args,p_operation_id:id(),p_value:1});
    assert.equal(first.round.families[0].myVote,1);assert.equal(first.round.families[0].totals,null);
    await rpc(bob,'dw_cast_vote',{...args,p_operation_id:id(),p_value:-1});
    const projection=await rpc(host,'dw_workshop_projector_snapshot',{p_session_id:sessionId});
    assert.equal(projection.round.families[0].totals,null);assert.equal('myVote'in projection.round.families[0],false);
    const closed=await rpc(host,'dw_close_voting_round',{p_operation_id:id(),p_session_id:sessionId,
      p_round_id:opened.round.id,p_expected_revision:opened.round.revision});
    assert.equal(closed.round.families[0].totals.support,1);assert.equal(closed.round.families[0].totals.oppose,1);
    assert.equal(closed.round.families[0].totals.coverage,2/3);
    assert.equal((await app.runtime.db.query('select count(*)::int as n from auth.users where email_confirmed_at is not null')).rows[0].n,0);
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

  it('rotates refresh tokens, logs out, then resumes the same work through email/name without a key',async()=>{
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
    const recovered=await request('/offline/auth/identify',{json:{email:'claimed@example.test',fullName:'Участник А'}});assert.equal(recovered.status,200);
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
    const resumed=await request('/offline/auth/identify',{json:{email:' CLAIMED@example.test ',fullName:'Участник А'}});
    assert.equal(resumed.status,200);assert.equal(resumed.body.session.user.id,aliceSession.user.id);aliceSession=resumed.body.session;
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
