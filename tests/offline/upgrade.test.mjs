import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { atomicJson, openRuntime, secret, sha256 } from '../../scripts/offline/storage.mjs';
import { hostLogin, identify, authenticate } from '../../scripts/offline/auth.mjs';
import { invokeRpc } from '../../scripts/offline/rpc.mjs';

process.env.NODE_ENV='test';
const oldMigrations=[
  '20261108131424_stage2_collaborative_sessions.sql',
  '20261108172311_stage3_regions_families_voting.sql',
  '20261108220024_stage4_barriers_evidence_surveys.sql',
  '20261108225303_stage5_territorial_roadmaps.sql',
  '20261109002211_stage6_team_statistics.sql',
];
const read=path=>readFile(new URL('../../'+path,import.meta.url),'utf8');

it('upgrades the actual five-migration 0.7 schema with existing memberships, authorship and duplicate emails',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'dw-offline-upgrade-'));
  let db,runtime;
  try {
    const operator={schemaVersion:1,instanceId:randomUUID(),hostKey:secret(),tokenSigningSecret:secret(),
      joinCode:randomBytes(9).toString('base64url'),createdAt:new Date().toISOString()};
    await atomicJson(join(dataDir,'operator.json'),operator);
    db=await PGlite.create(join(dataDir,'database'),{relaxedDurability:false});
    await db.exec(await read('scripts/offline/bootstrap.sql'));
    await db.query("insert into offline.settings(key,value) values('instance-id',$1::jsonb)",[JSON.stringify(operator.instanceId)]);
    for(const name of oldMigrations) {
      const sql=await read('supabase/migrations/'+name);
      await db.exec(sql);
      await db.query('insert into offline.migrations(name,sha256) values($1,$2)',[name,sha256(sql)]);
    }
    await db.exec(await read('tests/offline/fixtures/identity-v07.sql'));
    const host=(await hostLogin({db,operator},{hostKey:operator.hostKey,fullName:'Преподаватель прежнего выпуска'})).session;
    const ids=[randomUUID(),randomUUID()];
    for(let i=0;i<ids.length;i++) {
      await db.query(`insert into auth.users(id,email,raw_app_meta_data,created_at)
        values($1,'Legacy@Example.Test','{"offline":true,"email_verified":false}',now()-make_interval(days=>$2))`,[ids[i],2-i]);
      await db.query(`insert into offline.accounts(user_id,recovery_hash,kind,created_at)
        values($1,$2,'participant',now()-make_interval(days=>$3))`,[ids[i],sha256(secret()),2-i]);
      await db.query('insert into public.dw_profiles(user_id,full_name) values($1,$2)',[ids[i],`Прежний слушатель ${i}`]);
    }
    const legacyCall=(user,sql,params)=>db.transaction(async tx=>{
      await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
        [user,JSON.stringify({sub:user,role:'authenticated',app_metadata:{offline:true}})]);
      return (await tx.query(sql,params)).rows[0].result;
    });
    const lesson=(await legacyCall(host.user.id,'select public.dw_create_session($1,$2,$3,$4) as result',
      [randomUUID(),'Сохранённое занятие 0.7','federal',null])).session;
    const invitation=(await db.query('select code from private.invitations where session_id=$1',[lesson.id])).rows[0].code;
    await legacyCall(ids[0],'select public.dw_join_session($1,$2) as result',[randomUUID(),invitation]);
    const barrier=await legacyCall(ids[0],'select public.dw_save_barrier($1,$2,$3::jsonb) as result',
      [randomUUID(),lesson.id,JSON.stringify({barrierId:null,expectedRevision:0,title:'Ранее сохранённая проблема',
        description:'Авторство и дата должны пережить обновление входа.',primaryStage:'first_child',stageIds:['first_child'],
        evidenceKind:'observation',status:'active',priority:false})]);
    const previous=await legacyCall(ids[0],'select public.dw_barriers_snapshot($1) as result',[lesson.id]);
    assert.equal(previous.barriers.length,1);assert.equal(previous.barriers[0].id,barrier.barriers[0].id);
    await db.close();db=null;

    runtime=await openRuntime({dataDir,testSeed:async()=>({fixture:true})});
    const entered=await runtime.enqueue(()=>identify(runtime,{email:' legacy@example.test ',fullName:'Уточнённое ФИО'}));
    assert.equal(entered.session.user.id,ids[0]);
    const identity=await runtime.enqueue(()=>authenticate(runtime,entered.session.access_token));
    const rpc=(name,args={})=>runtime.enqueue(()=>invokeRpc(runtime.db,runtime.catalogue,name,args,identity,false));
    const boot=await rpc('dw_bootstrap');
    assert.equal(boot.sessions[0].id,lesson.id);assert.equal(boot.profile.fullName,'Уточнённое ФИО');
    const restored=await rpc('dw_barriers_snapshot',{p_session_id:lesson.id});
    assert.equal(restored.barriers[0].id,previous.barriers[0].id);
    assert.equal(restored.barriers[0].authorId,previous.barriers[0].authorId);
    assert.equal(restored.barriers[0].createdAt,previous.barriers[0].createdAt);
    assert.equal((await runtime.db.query('select full_name from public.dw_profiles where user_id=$1',[ids[1]])).rows[0].full_name,'Прежний слушатель 1');
    await runtime.close();runtime=null;
    runtime=await openRuntime({dataDir,testSeed:async()=>({fixture:true})});
    const repeated=await runtime.enqueue(()=>identify(runtime,{email:'LEGACY@EXAMPLE.TEST',fullName:'Уточнённое ФИО'}));
    assert.equal(repeated.session.user.id,ids[0]);
  } finally {
    await runtime?.close();await db?.close();await rm(dataDir,{recursive:true,force:true});
  }
});
