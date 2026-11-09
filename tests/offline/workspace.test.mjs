import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';

process.env.NODE_ENV='test';
const id=()=>randomUUID();
const seed=async()=>({fixture:true});

async function notebook() {
  const doc=JSON.parse(await readFile(new URL('../../public/data/corpus/documents/regional-respublika-mordoviia.json',import.meta.url),'utf8'));
  const block=doc.version.blocks.find(block=>Array.from(block.text).length>80);
  const points=Array.from(block.text),exact=points.slice(0,64).join(''),now=new Date().toISOString();
  const annotation={id:'saved-annotation',anchor:{id:'saved-anchor',documentId:doc.meta.id,versionId:doc.version.id,
    normalizationVersion:doc.version.normalizationVersion,
    spans:[{blockId:block.id,start:0,end:64,exact,prefix:'',suffix:points.slice(64,84).join('')}]},
    note:'Сохранённый комментарий к точному фрагменту',createdAt:now,updatedAt:now};
  return {schemaVersion:1,id:'personal-workspace',title:'Моя рабочая тетрадь',profile:null,
    sourceReferences:[{sourceId:doc.meta.id,editionId:doc.version.id,title:doc.meta.title,
      normalizationVersion:doc.version.normalizationVersion,sha256:doc.version.sourceSha256,
      sourceUrl:doc.version.sourceUrl,regionId:doc.meta.regionId}],
    annotations:[annotation],practiceProposals:[],linkDecisions:[],
    customCards:[{id:'saved-card',familyId:'saved-family',regionId:doc.meta.regionId,title:'Авторская карточка',
      mechanism:'Описание предложенного механизма',occurrenceIds:[annotation.id],reviewStatus:'candidate',createdAt:now,updatedAt:now}],
    readingTasks:[],preferences:{selectedRegionId:doc.meta.regionId,selectedSourceEditionId:doc.version.id,
      selectedPracticeId:null,activePanel:'my-work',readerFontScale:1}};
}

it('persists source-linked personal work through real offline HTTP, isolates actors and restores the saved state after restart without an archive',async()=>{
  const work=await mkdtemp(join(tmpdir(),'dw-workspace-http-')),dataDir=join(work,'state');
  let runtime,server,base,survey;
  const request=async(path,input={},token,target=base)=>{
    const response=await fetch(target+path,{method:'POST',headers:{'Content-Type':'application/json',
      ...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(input)});
    return {status:response.status,body:await response.json()};
  };
  const rpc=(name,args,token)=>request('/rest/v1/rpc/'+name,args,token);
  const start=async()=>{
    runtime=await openRuntime({dataDir,testSeed:seed});
    server=await startServer({runtime,host:'127.0.0.1',port:0,surveyPort:0,root:join(work,'site'),
      backupIntervalMs:0,logger:{log(){},error(){}}});
    base=`http://127.0.0.1:${server.port}`;survey=`http://127.0.0.1:${server.surveyPort}`;
  };
  try {
    await mkdir(join(work,'site/dist'),{recursive:true});
    for(const page of['index.html','survey.html'])await writeFile(join(work,'site/dist',page),'<html><body>Workspace fixture</body></html>');
    await start();
    assert.deepEqual((await request('/offline/auth/identify',{email:'writer@example.test'})).body,
      {profileRequired:true,email:'writer@example.test'});
    const first=(await request('/offline/auth/identify',{email:'writer@example.test',fullName:'Автор тетради'})).body.session;
    const second=(await request('/offline/auth/identify',{email:'other@example.test',fullName:'Другой автор'})).body.session;
    assert.deepEqual((await rpc('dw_workspace_read',{},first.access_token)).body,{snapshot:null});
    const state=await notebook(),operation=id();
    const committed=await rpc('dw_workspace_commit',{p_operation_id:operation,p_expected_revision:0,p_state:state},first.access_token);
    assert.equal(committed.status,200);assert.equal(committed.body.kind,'committed');
    assert.equal(committed.body.revision,1);assert.deepEqual(committed.body.snapshot.state,state);
    assert.equal(committed.body.replayed,false);
    assert.deepEqual((await rpc('dw_workspace_read',{},second.access_token)).body,{snapshot:null});
    assert.equal((await rpc('dw_workspace_read',{p_user_id:first.user.id},second.access_token)).status,400);
    assert.equal((await rpc('dw_workspace_read',{})).status,401);
    assert.equal((await request('/rest/v1/rpc/dw_workspace_read',{},undefined,survey)).status,404);

    // Exercise the SQL contract beyond the ordinary 1 MiB RPC body limit without raising
    // the limit for other methods or exposing an unbounded upload route.
    const larger=structuredClone(state);
    larger.annotations=Array.from({length:450},(_,i)=>({...structuredClone(state.annotations[0]),
      id:i===0?'saved-annotation':`saved-annotation-${i}`,note:'ах'.repeat(1000)}));
    larger.customCards[0].title='Авторская карточка после уточнения';
    assert.ok(Buffer.byteLength(JSON.stringify(larger))>1024*1024);
    const secondCommit=await rpc('dw_workspace_commit',{p_operation_id:id(),p_expected_revision:1,p_state:larger},first.access_token);
    assert.equal(secondCommit.status,200);assert.equal(secondCommit.body.kind,'committed');assert.equal(secondCommit.body.revision,2);
    assert.deepEqual((await rpc('dw_workspace_read',{p_known_revision:2},first.access_token)).body,{unchanged:true,revision:2});
    const conflict=await rpc('dw_workspace_commit',{p_operation_id:id(),p_expected_revision:0,p_state:state},first.access_token);
    assert.equal(conflict.status,200);assert.equal(conflict.body.kind,'conflict');assert.equal(conflict.body.actualRevision,2);
    assert.deepEqual(conflict.body.snapshot.state,larger);
    const replay=await rpc('dw_workspace_commit',{p_operation_id:operation,p_expected_revision:0,p_state:state},first.access_token);
    assert.equal(replay.body.kind,'committed');assert.equal(replay.body.revision,1);assert.equal(replay.body.replayed,true);
    assert.equal(replay.body.snapshot.revision,2);
    assert.equal((await request('/auth/v1/logout?scope=local',{},first.access_token)).status,200);
    assert.equal((await rpc('dw_workspace_read',{},first.access_token)).status,401);
    await server.stop();server=null;runtime=null;
    await start();
    const returned=await request('/offline/auth/identify',{email:'WRITER@EXAMPLE.TEST'});
    assert.equal(returned.status,200);assert.equal(returned.body.session.user.id,first.user.id);
    const restored=await rpc('dw_workspace_read',{},returned.body.session.access_token);
    assert.equal(restored.body.snapshot.revision,2);assert.deepEqual(restored.body.snapshot.state,larger);
    assert.equal(restored.body.snapshot.state.annotations[0].anchor.spans[0].exact,state.annotations[0].anchor.spans[0].exact);
    assert.equal(restored.body.snapshot.state.customCards[0].occurrenceIds[0],state.annotations[0].id);
  } finally {await server?.stop();await runtime?.close();await rm(work,{recursive:true,force:true});}
});
