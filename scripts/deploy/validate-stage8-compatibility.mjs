/** Local-only reconstruction of the documented partial cloud schema; no network or keys. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';

const root=fileURLToPath(new URL('../../',import.meta.url));
const migrations=resolve(root,'supabase/migrations');
// Fixed audited pre-Stage-8 fixture: later cloud manifest updates must not change
// which historical partial schema this regression test reconstructs.
const names=['20261108131424_stage2_collaborative_sessions.sql',
  '20261108172311_stage3_regions_families_voting.sql','20261108220024_stage4_barriers_evidence_surveys.sql',
  '20261108225303_stage5_territorial_roadmaps.sql','20261109002211_stage6_team_statistics.sql'];
const stage8Name='20261109104701_stage8_simple_identity.sql';
const stage8=await readFile(resolve(migrations,stage8Name),'utf8');
const pending=await readFile(resolve(root,'scripts/deploy/pending-stage3-completion.sql'),'utf8');
const sha=text=>createHash('sha256').update(text).digest('hex');
const guarded=['dw_entry_logout','dw_entry_rpc','dw_entry_session','dw_identify',
  'dw_survey_own_response','dw_survey_public_manifest','dw_survey_save_response','dw_survey_withdraw_response'];
const recordedMissing=['private.dw_delete_family','private.dw_save_family',
  'public.dw_cast_vote','public.dw_cast_vote_updates','public.dw_close_voting_round','public.dw_delete_family',
  'public.dw_open_voting_round','public.dw_region_work','public.dw_save_family',
  'public.dw_workshop_projector_updates','public.dw_workshop_updates'].sort();

async function reconstruct(){
  const db=new PGlite();
  try{
    await db.exec(await readFile(resolve(root,'tests/database/bootstrap.sql'),'utf8'));
    for(const name of names)await db.exec(await readFile(resolve(migrations,name),'utf8'));
    const fn=await db.query("select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.proname like 'dw_%'");
    assert.equal(fn.rows.length,204);
    // No CASCADE: remove exactly the eleven function definitions absent in the audited
    // cloud schema. The shipped prior migrations reproduce its tables and guarded ACLs.
    for(const name of recordedMissing.sort((a,b)=>Number(b.startsWith('public.'))-Number(a.startsWith('public.')))){
      const [schema,method]=name.split('.');
      assert(/^(public|private)$/.test(schema)&&/^dw_[a-z0-9_]+$/.test(method));
      const matches=fn.rows.filter(x=>x.nspname===schema&&x.proname===method);assert.equal(matches.length,1);
      await db.exec(`drop function ${schema}.${method}(${matches[0].args})`);
    }
    assert.equal((await db.query("select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.proname like 'dw_%'")).rows[0].n,193);
    return db;
  }catch(error){await db.close();throw error;}
}
async function anon(db,sql,args=[]){return db.transaction(async tx=>{
  await tx.exec('set local role anon');
  await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
  return(await tx.query(sql,args)).rows[0].result;
});}
const identify=(db,email,name='Участник совместимости')=>anon(db,'select public.dw_identify($1,$2) result',[email,name]).then(x=>x.session);
const rpc=(db,token,method,args={})=>anon(db,'select public.dw_entry_rpc($1,$2,$3::jsonb) result',[token,method,JSON.stringify(args)]);
async function privileges(db){
  const rows=(await db.query("select n.nspname,p.proname,has_function_privilege('anon',p.oid,'EXECUTE') anon_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.proname like 'dw_%' order by n.nspname,p.proname")).rows;
  for(const schema of ['private','public'])assert.deepEqual(rows.filter(x=>x.nspname===schema&&x.anon_exec).map(x=>x.proname),guarded);
  const helper=(await db.query("select has_function_privilege('anon','private.dw_issue_operator_session(text,uuid)','EXECUTE') anon_exec,has_function_privilege('authenticated','private.dw_issue_operator_session(text,uuid)','EXECUTE') authenticated_exec")).rows[0];
  assert.deepEqual(helper,{anon_exec:false,authenticated_exec:false});
  return{anonymousPublicRpc:rows.filter(x=>x.nspname==='public'&&x.anon_exec).map(x=>x.proname),operatorIssuerPublic:false};
}
async function assertMissing(db){
  const rows=(await db.query("select n.nspname||'.'||p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.proname like 'dw_%'")).rows;
  const present=new Set(rows.map(x=>x.name));
  assert(recordedMissing.every(x=>!present.has(x)));
  return recordedMissing;
}
const report={checkedAt:new Date().toISOString(),engine:'PGlite',cloudApplied:false,
  reconstruction:'Five shipped migrations, then removal without CASCADE of the eleven function definitions recorded as missing in the audited cloud manifest.',
  stage8:{file:`supabase/migrations/${stage8Name}`,bytes:Buffer.byteLength(stage8),sha256:sha(stage8)},
  pending:{file:'scripts/deploy/pending-stage3-completion.sql',bytes:Buffer.byteLength(pending),sha256:sha(pending)},cases:[]};

const db=await reconstruct();
try{
  await db.exec(stage8);
  const mail=randomUUID()+'@compatibility.example',a=await identify(db,mail);
  const b=await identify(db,mail.toUpperCase());assert.equal(a.user.id,b.user.id);
  const host=(await db.query("select private.dw_issue_operator_session('Ведущий совместимости') result")).rows[0].result.session;
  const created=await rpc(db,host.access_token,'dw_create_session',{p_operation_id:randomUUID(),p_title:'Проверка partial-схемы',p_scope:'region',p_region_id:'respublika-mordoviia'});
  const sid=created.session.id;
  const choices=await rpc(db,a.access_token,'dw_available_sessions');assert(choices.some(x=>x.id===sid));
  await rpc(db,a.access_token,'dw_join_open_session',{p_session_id:sid,p_operation_id:randomUUID()});
  assert.equal((await rpc(db,b.access_token,'dw_bootstrap')).sessions[0].id,sid);
  await rpc(db,a.access_token,'dw_session_snapshot',{p_session_id:sid});
  await rpc(db,a.access_token,'dw_workshop_snapshot',{p_session_id:sid});
  await rpc(db,a.access_token,'dw_barriers_snapshot',{p_session_id:sid});
  for(const method of ['dw_region_work','dw_workshop_updates'])await assert.rejects(rpc(db,a.access_token,method,{}),e=>e.code==='P0001'&&e.message==='SCHEMA_MISSING');
  report.cases.push({name:'stage8-alone-on-partial-cloud',status:'pass',identityStable:true,createListJoinAndRead:true,
    missingFunctionsRemainAbsent:await assertMissing(db),privileges:await privileges(db)});

  const before=(await db.query('select row_to_json(m)::text value from public.dw_memberships m order by user_id')).rows;
  await db.exec(pending);
  assert.deepEqual((await db.query('select row_to_json(m)::text value from public.dw_memberships m order by user_id')).rows,before);
  assert.equal((await anon(db,'select public.dw_entry_session($1) result',[a.access_token])).session.user.id,a.user.id);
  assert.equal((await rpc(db,a.access_token,'dw_bootstrap')).sessions[0].id,sid);
  await rpc(db,a.access_token,'dw_workshop_updates',{p_session_id:sid,p_known_round_id:null});
  const voting=(await db.query("select pg_get_functiondef('private.dw_open_voting_round(uuid,uuid,text,text,bigint,jsonb)'::regprocedure) source")).rows[0].source;
  assert(voting.includes('private.dw_actor_eligible(m.user_id)'));
  assert.equal((await db.query('select private.dw_actor_eligible($1) learner,private.dw_actor_eligible($2) operator',[a.user.id,host.user.id])).rows[0].learner,true);
  const present=new Set((await db.query("select n.nspname||'.'||p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and p.proname like 'dw_%'")).rows.map(x=>x.name));
  assert(recordedMissing.every(x=>present.has(x)));
  report.cases.push({name:'pending-stage3-after-stage8',status:'pass',membershipsPreserved:true,existingEntryTokensWork:true,
    missingFunctionsCompleted:true,declaredVotingEligibilityPreserved:true,privileges:await privileges(db)});
}finally{await db.close();}

const beforeStage8=await reconstruct();
try{
  await beforeStage8.exec(pending);
  await beforeStage8.exec(stage8);
  await identify(beforeStage8,randomUUID()+'@compatibility.example');
  report.cases.push({name:'pending-stage3-before-stage8',status:'pass',privileges:await privileges(beforeStage8)});
}finally{await beforeStage8.close();}
report.status='pass';
await writeFile(resolve(root,'scripts/deploy/stage8-compatibility-validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
