/** Explicit production-path load check. Real full corpus, durable DB and HTTP, no test identity gateway.
 * Run: node tests/offline/load.mjs [output.json]. Uses and removes its own temporary database.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { openRuntime, atomicJson } from '../../scripts/offline/storage.mjs';
import { startServer } from '../../scripts/offline/server.mjs';

const dir=await mkdtemp(join(tmpdir(),'dw-offline-load-'));
let runtime,app;
const started=performance.now(),metrics=new Map();let highWater=0;
try {
  await mkdir(join(dir,'site/dist'),{recursive:true});
  for(const file of['index.html','survey.html'])await writeFile(join(dir,'site/dist',file),'<html><body>HTTP load fixture only</body></html>');
  runtime=await openRuntime({dataDir:join(dir,'database')});
  app=await startServer({runtime,host:'127.0.0.1',port:0,surveyPort:0,root:join(dir,'site'),backupIntervalMs:0,
    logger:{log(){},error(...args){console.error(...args);}}});
  const base=`http://127.0.0.1:${app.port}`;
  const monitor=setInterval(()=>{highWater=Math.max(highWater,runtime.pending);},1);monitor.unref();
  async function send(path,input,token,category,headers={}) {
    const start=performance.now();
    const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,
      ...(token?{Authorization:`Bearer ${token}`} :{}),...headers},body:JSON.stringify(input)});
    const value=await response.json();
    assert.equal(response.status,200,`${path}: ${JSON.stringify(value)}`);
    if(category){if(!metrics.has(category))metrics.set(category,[]);metrics.get(category).push(performance.now()-start);}
    return value;
  }
  const host=(await send('/offline/auth/host-bootstrap',{},null,'host-auth',{'X-Offline-Host-Bootstrap':'1'})).session;
  const rpc=(token,name,input={},category)=>send('/rest/v1/rpc/'+name,input,token,category);
  const bootstrap=await rpc(host.access_token,'dw_bootstrap');
  await rpc(host.access_token,'dw_save_profile',{p_operation_id:randomUUID(),p_expected_revision:bootstrap.profile.revision,p_full_name:'Load test instructor'});
  const session=(await rpc(host.access_token,'dw_create_session',{p_operation_id:randomUUID(),p_title:'Load test temporary classroom',p_scope:'municipality',p_region_id:'respublika-mordoviia'})).session;
  const participants=await Promise.all(Array.from({length:50},async(_,i)=>{
    const auth=await send('/offline/auth/identify',{email:`synthetic-${i}@load.example.test`,fullName:`Synthetic participant ${i}`},null,'identify');
    await rpc(auth.session.access_token,'dw_join_open_session',{p_operation_id:randomUUID(),p_session_id:session.id},'join');
    return auth.session;
  }));
  const uniqueAccounts=new Set(participants.map(p=>p.user.id)).size;
  const sessionMembers=(await rpc(host.access_token,'dw_session_snapshot',{p_session_id:session.id})).members.length;
  assert.equal(uniqueAccounts,50);assert.equal(sessionMembers,51);
  const setupMs=performance.now()-started;
  const concurrentStart=performance.now();
  for(let round=0;round<10;round++) {
    const commands=participants.map(p=>rpc(p.access_token,'dw_barriers_cursor',{p_session_id:session.id},'cursor'));
    if(round===0)commands.push(...participants.map((p,i)=>rpc(p.access_token,'dw_save_barrier',{
      p_operation_id:randomUUID(),p_session_id:session.id,p_input:{barrierId:null,expectedRevision:0,
        title:`Synthetic barrier ${i}`,description:'Synthetic load check; not a research response.',primaryStage:'first_child',
        stageIds:['first_child'],evidenceKind:'observation',status:'active',priority:false}},'mutation')));
    await Promise.all(commands);
  }
  const concurrentMs=performance.now()-concurrentStart;
  const snapshot=await rpc(host.access_token,'dw_barriers_snapshot',{p_session_id:session.id},'snapshot');
  assert.equal(snapshot.barriers.length,50);
  const backups=await send('/offline/admin/backup',{},host.access_token,'backup');
  clearInterval(monitor);
  const groups={};
  for(const[name,values]of metrics){values.sort((a,b)=>a-b);const at=q=>Number(values[Math.min(values.length-1,Math.ceil(q*values.length)-1)].toFixed(2));
    groups[name]={requests:values.length,p50Ms:at(.5),p95Ms:at(.95),maxMs:at(1)};}
  const report={schemaVersion:1,createdAt:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,
    pglite:'0.5.15',participants:50,identification:'email-and-full-name',joining:'open-session',canonical:runtime.ready.seed,setupMs:Number(setupMs.toFixed(2)),
    concurrentBatchMs:Number(concurrentMs.toFixed(2)),observedMaxQueueDepth:highWater,groups,
    backupBytes:backups.backup.bytes,verified:{uniqueAccounts,sessionMembers,barriers:snapshot.barriers.length,allRequestsSucceeded:true},
    scope:'Single Linux container, local HTTP loopback, production PGlite and complete corpus. Not Mac, Wi-Fi, battery or audience device validation.'};
  if(process.argv[2])await atomicJson(resolve(process.argv[2]),report);
  console.log(JSON.stringify(report,null,2));
}finally{if(app)await app.stop();else if(runtime)await runtime.close();await rm(dir,{recursive:true,force:true});}
