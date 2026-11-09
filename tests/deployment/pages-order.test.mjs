import {it} from 'node:test';
import assert from 'node:assert/strict';
import {waitForLegacyPages} from '../../scripts/wait-for-legacy-pages.mjs';

const sha='a'.repeat(40),repository='Arseniy24RUS/demography-lab',token='test-token-never-log';
const legacy=(status,id=7)=>({id,head_sha:sha,path:'dynamic/pages/pages-build-deployment',status});
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});
function harness(reply){
  let clock=0;
  const calls=[],waits=[],logs=[];
  return{calls,waits,logs,options:{repository,sha,token,now:()=>clock,
    wait:async ms=>{assert(ms<=10_000);waits.push(ms);clock+=ms;},
    log:message=>logs.push(message),timeoutMs:30_000,pollIntervalMs:5_000,
    fetchImpl:async(url,init)=>{calls.push({url:new URL(url),init});assert.equal(init.method,'GET');return reply(new URL(url),calls.length);}}};
}

it('waits for legacy indexing, then running to completed, and ignores similarly named workflows',async()=>{
  const lists=[[],[legacy('in_progress')],[legacy('completed')]];
  const h=harness(url=>url.pathname.endsWith('/pages')?response({build_type:'legacy'}):response({total_count:1,
    workflow_runs:[{id:91,head_sha:sha,path:'.github/workflows/pages.yml',status:'completed'},...lists.shift()]}));
  // Each response reports the exact list length, including the unrelated custom run.
  const original=h.options.fetchImpl;
  h.options.fetchImpl=async(...args)=>{
    const r=await original(...args);
    const body=await r.json();if(body.workflow_runs)body.total_count=body.workflow_runs.length;
    return response(body);
  };
  const result=await waitForLegacyPages(h.options);
  assert.equal(result.polls,3);assert.equal(result.legacyRuns,1);assert.deepEqual(h.waits,[5000,5000]);
  for(const {url,init} of h.calls){assert.equal(url.origin,'https://api.github.com');assert.equal(init.headers.Authorization,`Bearer ${token}`);
    assert(!url.href.includes(token));if(url.pathname.endsWith('/runs')){assert.equal(url.searchParams.get('head_sha'),sha);assert.equal(url.searchParams.get('per_page'),'100');}}
  assert(!h.logs.join('\n').includes(token));
});

it('allows workflow Pages source without looking for legacy runs',async()=>{
  const h=harness(()=>response({build_type:'workflow'}));
  assert.deepEqual(await waitForLegacyPages(h.options),{buildType:'workflow',legacyRuns:0,polls:0,waitedMs:0});
  assert.equal(h.calls.length,1);assert.deepEqual(h.waits,[]);
});

it('fails closed on API 403 or an unsupported source, without logging the response body or token',async()=>{
  for(const location of ['pages','runs','unsupported']){
    const h=harness(url=>location==='unsupported'?response({build_type:'unknown'}):
      (location==='pages'||url.pathname.endsWith('/runs'))?response({message:token},403):response({build_type:'legacy'}));
    await assert.rejects(waitForLegacyPages(h.options),error=>{
      assert(!error.message.includes(token));return location==='unsupported'?/Unsupported/.test(error.message):/HTTP 403/.test(error.message);
    });
    assert.deepEqual(h.waits,[]);assert(!h.logs.join('\n').includes(token));
  }
});

it('times out within the overall bound when a legacy source has no completed run',async()=>{
  for(const runs of [[],[legacy('queued')]]){
    const h=harness(url=>url.pathname.endsWith('/pages')?response({build_type:'legacy'}):response({total_count:runs.length,workflow_runs:runs}));
    await assert.rejects(waitForLegacyPages({...h.options,timeoutMs:12_000}),/Timed out waiting for legacy Pages/);
    assert.deepEqual(h.waits,[5000,5000,2000]);
  }
});

it('finds the exact legacy path on later pages and permits a completed failed legacy run',async()=>{
  const custom=Array.from({length:100},(_,i)=>({id:i+1,head_sha:sha,path:'dynamic/pages/pages-build-deployment@main',status:'completed'}));
  const h=harness(url=>{
    if(url.pathname.endsWith('/pages'))return response({build_type:'legacy'});
    if(url.searchParams.get('page')==='1')return response({total_count:101,workflow_runs:custom},200,
      {Link:'<https://api.github.com/repos/ignored/actions/runs?page=2>; rel="next"'});
    assert.equal(url.pathname,`/repos/${repository}/actions/runs`);
    assert.equal(url.searchParams.get('page'),'2');
    return response({total_count:101,workflow_runs:[{...legacy('completed',101),conclusion:'failure'}]});
  });
  const result=await waitForLegacyPages(h.options);
  assert.equal(result.legacyRuns,1);assert.equal(result.polls,1);assert.equal(h.calls.length,3);assert.deepEqual(h.waits,[]);
});
