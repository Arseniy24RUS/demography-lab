import {it} from 'node:test';
import assert from 'node:assert/strict';
import {assertPagesSource} from '../../scripts/assert-pages-source.mjs';

const repository='Arseniy24RUS/demography-lab',token='test-token-never-log';
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
function harness(reply){
  const calls=[],logs=[];
  return{calls,logs,options:{repository,token,log:message=>logs.push(message),
    fetchImpl:async(url,init)=>{calls.push({url:new URL(url),init});return reply(url,init);}}};
}

it('permits only workflow source after a single read-only Pages GET',async()=>{
  const h=harness(()=>response({build_type:'workflow'}));
  assert.deepEqual(await assertPagesSource(h.options),{buildType:'workflow'});
  assert.equal(h.calls.length,1);
  const {url,init}=h.calls[0];
  assert.equal(url.href,`https://api.github.com/repos/${repository}/pages`);
  assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
  assert.equal(init.headers.Authorization,`Bearer ${token}`);assert.equal(init.body,undefined);
  assert(!h.logs.join('\n').includes(token));
});

it('blocks legacy source and names the single owner setting required before deployment',async()=>{
  const h=harness(()=>response({build_type:'legacy'}));
  await assert.rejects(assertPagesSource(h.options),error=>{
    assert.match(error.message,/Settings → Pages → Source → GitHub Actions/u);
    assert.match(error.message,/Deployment was not started/u);return true;
  });
  assert.equal(h.calls.length,1);assert.deepEqual(h.logs,[]);
});

it('fails closed on API 403 without exposing the response body or token',async()=>{
  const h=harness(()=>response({message:token},403));
  await assert.rejects(assertPagesSource(h.options),error=>{
    assert.match(error.message,/HTTP 403/u);assert(!error.message.includes(token));return true;
  });
  assert.equal(h.calls.length,1);assert.deepEqual(h.logs,[]);
});

it('fails closed on invalid JSON or unknown Pages source',async()=>{
  for(const payload of [()=>new Response(token),()=>response({build_type:token})]){
    const h=harness(payload);
    await assert.rejects(assertPagesSource(h.options),error=>{
      assert.match(error.message,/invalid JSON|unsupported Source/u);assert(!error.message.includes(token));return true;
    });
    assert.equal(h.calls.length,1);assert.deepEqual(h.logs,[]);
  }
});

it('enforces the timeout even when a stalled fetch does not acknowledge abort',async()=>{
  const h=harness(()=>new Promise(()=>{}));
  await assert.rejects(assertPagesSource({...h.options,timeoutMs:10}),/timed out/u);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].init.signal.aborted,true);assert.deepEqual(h.logs,[]);
});
