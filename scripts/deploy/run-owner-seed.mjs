#!/usr/bin/env node
/** Explicit owner campaign runner. Argument 1 is a private state file, never the key itself.
 * Modes: corpus | territories | verify. Reads pinned local indices; the function independently
 * fetches and validates the same immutable GitHub release before every mutation.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const state=JSON.parse(await readFile(process.argv[2],'utf8'));
const mode=process.argv[3];
if(!/^[A-Za-z0-9_-]{43}$/.test(state.secret)||state.expiresAt<=Date.now()||!['corpus','territories','verify'].includes(mode))throw new Error('INVALID_PRIVATE_CAMPAIGN_INPUT');
async function checkedIndex(path,digest){const bytes=await readFile(resolve(root,path));if(createHash('sha256').update(bytes).digest('hex')!==digest)throw new Error('LOCAL_INDEX_CHANGED');return JSON.parse(bytes);}
async function invoke(input){
  for(let attempt=0;attempt<3;attempt++){
    try{
      const r=await fetch('https://alyrowehwzypgtrqnvdi.supabase.co/functions/v1/dw-owner-seed',{
        method:'POST',redirect:'error',headers:{'content-type':'application/json','x-demography-owner-import':state.secret},
        body:JSON.stringify(input),signal:AbortSignal.timeout(100000),
      });
      const result=await r.json();
      if(!r.ok||!result.ok){
        if(attempt<2&&['SOURCE_FETCH_FAILED','IMPORT_FAILED'].includes(result.code)){await new Promise(r=>setTimeout(r,1000));continue;}
        throw new Error('REMOTE_'+r.status+'_'+(result.code??'FAILED'));
      }
      return result.result;
    }catch(error){
      if(attempt<2&&['TypeError','TimeoutError'].includes(error.name)){await new Promise(r=>setTimeout(r,1000));continue;}
      throw error;
    }
  }
  throw new Error('RETRY_EXHAUSTED');
}
const report={schemaVersion:1,startedAt:new Date().toISOString(),mode,sourceCommit:'ce65b09d4e800061948e9037e71f15410be42d90',results:[]};
try{
  if(mode==='corpus'){
    const index=await checkedIndex('public/data/corpus/index.json','86c6bf55df05a03931246cc4a092f31b66fd0a3d73d24e53de4923e626f0fd95');
    for(const entry of index.documents.filter(x=>x.versionId)){
      const result=await invoke({mode:'corpus',documentId:entry.id});report.results.push(result);
      console.log(JSON.stringify({completed:report.results.length,documentId:entry.id,blocks:result.blocks,inserted:result.inserted}));
    }
  }else if(mode==='territories'){
    const index=await checkedIndex('public/data/territories/index.json','02eaef7003e77fe059a94a6a6f9dd8edeff841e0d697f77579a91ce30c9148fa');
    const registry=await invoke({mode:'territory-registry'});report.results.push(registry);console.log(JSON.stringify({registry}));
    for(const region of index.regions){
      const result=await invoke({mode:'territory-region',regionId:region.regionId});report.results.push(result);
      console.log(JSON.stringify({completed:report.results.length-1,regionId:region.regionId,series:result.series,inserted:result.inserted}));
    }
    const sealed=await invoke({mode:'territory-seal'});report.results.push(sealed);console.log(JSON.stringify({sealed}));
  }
  report.final=await invoke({mode:'status'});report.finishedAt=new Date().toISOString();report.ok=true;
  if(process.argv[4])await writeFile(resolve(process.argv[4]),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({complete:true,final:report.final}));
}catch(error){
  report.ok=false;report.error=String(error.message).replace(/[^A-Z0-9_]/g,'').slice(0,100);report.finishedAt=new Date().toISOString();
  if(process.argv[4])await writeFile(resolve(process.argv[4]),JSON.stringify(report,null,2)+'\n');
  console.error(JSON.stringify({complete:false,completed:report.results.length,code:report.error}));process.exitCode=1;
}
