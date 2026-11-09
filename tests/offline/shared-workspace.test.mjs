import {it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openRuntime} from '../../scripts/offline/storage.mjs';
import {startServer} from '../../scripts/offline/server.mjs';
import {seedCanonicalDocument,loadMordovia} from '../database/harness.mjs';
import {realPracticeBundle} from '../collaboration/workshop-test-support.mjs';

process.env.NODE_ENV='test';
const op=()=>randomUUID();
it('shares one board, anonymous survey entry and live votes over production offline HTTP; all survive restart',async()=>{
 const work=await mkdtemp(join(tmpdir(),'dw-shared-http-')),dataDir=join(work,'state');
 let runtime,server,base,survey;
 const request=async(path,input={},token,target=base)=>{
  const response=await fetch(target+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:target,
   ...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(input)});
  return {status:response.status,body:await response.json()};
 };
 const rpc=async(name,args,session)=>{
  const response=await request('/rest/v1/rpc/'+name,args,session.access_token);
  assert.equal(response.status,200,`${name}: ${JSON.stringify(response.body)}`);return response.body;
 };
 const start=async()=>{
  runtime=await openRuntime({dataDir,testSeed:async db=>{
   await seedCanonicalDocument(db,await loadMordovia());return {fixture:true};
  }});
  server=await startServer({runtime,host:'127.0.0.1',port:0,surveyPort:0,root:join(work,'site'),backupIntervalMs:0,logger:{log(){},error(){}}});
  base=`http://127.0.0.1:${server.port}`;survey=`http://127.0.0.1:${server.surveyPort}`;
 };
 try{
  await mkdir(join(work,'site/dist'),{recursive:true});
  for(const name of ['index.html','survey.html'])await writeFile(join(work,'site/dist',name),'<html><body>Shared workspace fixture</body></html>');
  await start();
  const a=(await request('/offline/auth/identify',{email:'first@example.test',fullName:'Первый участник'})).body.session;
  const b=(await request('/offline/auth/identify',{email:'second@example.test',fullName:'Второй участник'})).body.session;
  const entered=await Promise.all([a,b].map(s=>rpc('dw_enter_workspace',{p_operation_id:op()},s)));
  const sid=entered[0].session.id;
  assert.equal(entered[1].session.id,sid);assert(entered.every(x=>x.session.role==='participant'));
  const surveys=await Promise.all([a,b].map(s=>rpc('dw_workshop_survey',{p_session_id:sid},s)));
  assert.equal(surveys[0].survey.id,surveys[1].survey.id);assert.equal(surveys[0].invitationToken,surveys[1].invitationToken);
  const manifest=await request('/rest/v1/rpc/dw_survey_public_manifest',{p_survey_id:surveys[0].survey.id,p_invitation_token:surveys[0].invitationToken},undefined,survey);
  assert.equal(manifest.status,200);assert.equal(manifest.body.canRespond,true);
  assert.equal((await request('/rest/v1/rpc/dw_workshop_survey',{p_session_id:sid},undefined,survey)).status,404);
  assert.equal((await request('/rest/v1/rpc/dw_enter_workspace',{p_operation_id:op()})).status,401);
  const bundle=await realPracticeBundle('mordovia-kindergarten-compensation');
  const published=await rpc('dw_publish_submission',{p_operation_id:op(),p_session_id:sid,p_local_key:bundle.practice.id,p_expected_revision:null,p_bundle:bundle},a);
  const board=await rpc('dw_workshop_snapshot',{p_session_id:sid},a);
  const grouped=await rpc('dw_save_family',{p_operation_id:op(),p_session_id:sid,p_family_id:null,p_expected_board_revision:board.boardRevision,
   p_title:'Поддержка семей',p_mechanism:'Совместно обсуждаемый механизм',p_rationale:'Группа сопоставляет предложения',p_submission_ids:[published.submissions[0].id]},a);
  const fid=grouped.families[0].id;
  const before=await rpc('dw_workspace_votes',{p_session_id:sid},a),fingerprint=before.families[0].fingerprint;
  await rpc('dw_workspace_vote',{p_operation_id:op(),p_session_id:sid,p_family_id:fid,p_value:1,p_expected_revision:0,p_expected_fingerprint:fingerprint},a);
  const voted=await rpc('dw_workspace_vote',{p_operation_id:op(),p_session_id:sid,p_family_id:fid,p_value:-1,p_expected_revision:0,p_expected_fingerprint:fingerprint},b);
  assert.equal(voted.families[0].support,1);assert.equal(voted.families[0].oppose,1);
  const projection=await rpc('dw_workspace_votes_projection',{p_session_id:sid},b);
  assert.equal(projection.families[0].score,0);assert.equal('myVote' in projection.families[0],false);
  await server.stop();server=null;runtime=null;
  await start();
  const returned=(await request('/offline/auth/identify',{email:'first@example.test'})).body.session;
  assert.equal(returned.user.id,a.user.id);
  const restored=await rpc('dw_enter_workspace',{p_operation_id:op()},returned);
  assert.equal(restored.session.id,sid);assert.equal(restored.submissions[0].id,published.submissions[0].id);
  const restoredVotes=await rpc('dw_workspace_votes',{p_session_id:sid},returned);
  assert.equal(restoredVotes.families[0].support,1);assert.equal(restoredVotes.families[0].oppose,1);assert.equal(restoredVotes.families[0].myVote,1);
  const restoredSurvey=await rpc('dw_workshop_survey',{p_session_id:sid},returned);
  assert.equal(restoredSurvey.survey.id,surveys[0].survey.id);assert.equal(restoredSurvey.invitationToken,surveys[0].invitationToken);
 }finally{await server?.stop();await runtime?.close();await rm(work,{recursive:true,force:true});}
});
