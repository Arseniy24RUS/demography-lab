import {setTimeout as sleep} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const LEGACY_PATH='dynamic/pages/pages-build-deployment';
const API='https://api.github.com';
const PER_PAGE=100;
const MAX_PAGES=10;
const MAX_WAIT_MS=300_000;

/** Only GET requests; no Pages configuration, cancellation or deployment mutation. */
export async function waitForLegacyPages({
  repository=process.env.GITHUB_REPOSITORY,
  sha=process.env.GITHUB_SHA,
  token=process.env.GH_TOKEN,
  fetchImpl=globalThis.fetch,
  wait=sleep,
  now=()=>performance.now(),
  log=message=>console.log(message),
  timeoutMs=MAX_WAIT_MS,
  pollIntervalMs=5_000,
}={}) {
  if(typeof repository!=='string'||!/^[-A-Za-z0-9]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    ||['.','..'].includes(repository.split('/')[1]))throw new Error('Invalid GITHUB_REPOSITORY.');
  if(typeof sha!=='string'||!/^([a-f\d]{40}|[a-f\d]{64})$/iu.test(sha))throw new Error('Invalid GITHUB_SHA.');
  if(typeof token!=='string'||!token.trim())throw new Error('GH_TOKEN is required for the read-only Pages guard.');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_WAIT_MS
    ||!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>10_000)
    throw new Error('Invalid Pages guard timing bounds.');
  const started=now(),deadline=started+timeoutMs;
  const base=`${API}/repos/${repository.split('/').map(encodeURIComponent).join('/')}`;
  function remaining(){
    const left=deadline-now();
    if(left<=0)throw new Error('Timed out waiting for legacy Pages; compiled deployment was not started.');
    return Math.ceil(left);
  }
  async function get(url){
    let response,body;
    try {
      response=await fetchImpl(url,{method:'GET',redirect:'error',credentials:'omit',
        headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,
          'X-GitHub-Api-Version':'2022-11-28','User-Agent':'demography-lab-pages-order-guard'},
        signal:AbortSignal.timeout(Math.min(10_000,remaining()))});
    }catch {
      remaining();
      throw new Error('GitHub GET request failed; compiled deployment was not started.');
    }
    remaining();
    if(!response.ok)throw new Error(`GitHub GET returned HTTP ${response.status}; compiled deployment was not started.`);
    try {body=await response.json();}catch {throw new Error('GitHub returned invalid JSON; compiled deployment was not started.');}
    remaining();
    return{body,link:response.headers.get('link')??''};
  }
  // GET /pages requires Pages read, already included by this deployment's Pages write.
  const {body:site}=await get(`${base}/pages`);
  if(site?.build_type==='workflow') {
    log('Pages uses workflow source; no legacy publication needs to be awaited.');
    return{buildType:'workflow',legacyRuns:0,polls:0,waitedMs:now()-started};
  }
  if(site?.build_type!=='legacy')throw new Error('Unsupported GitHub Pages build_type; compiled deployment was not started.');

  let polls=0;
  for(;;) {
    remaining();
    polls+=1;
    const legacy=[];
    let seen=0;
    for(let page=1;;page+=1) {
      if(page>MAX_PAGES)throw new Error('Actions pagination limit reached; compiled deployment was not started.');
      const url=new URL(`${base}/actions/runs`);
      url.searchParams.set('head_sha',sha);
      url.searchParams.set('per_page',String(PER_PAGE));
      url.searchParams.set('page',String(page));
      const {body,link}=await get(url.href);
      if(!Number.isSafeInteger(body?.total_count)||body.total_count<0||!Array.isArray(body.workflow_runs)
        ||body.workflow_runs.length>PER_PAGE||body.workflow_runs.some(run=>!run||!Number.isSafeInteger(run.id)
          ||run.id<1||typeof run.path!=='string'||typeof run.head_sha!=='string'||typeof run.status!=='string'))
        throw new Error('GitHub returned an invalid workflow list; compiled deployment was not started.');
      if(body.total_count>=MAX_PAGES*PER_PAGE)
        throw new Error('Actions result limit reached; compiled deployment was not started.');
      seen+=body.workflow_runs.length;
      legacy.push(...body.workflow_runs.filter(run=>run.path===LEGACY_PATH&&run.head_sha.toLowerCase()===sha.toLowerCase()));
      const hasNext=/;\s*rel="next"/iu.test(link);
      if(!hasNext&&seen>=body.total_count)break;
      if(body.workflow_runs.length===0)throw new Error('GitHub returned incomplete pagination; compiled deployment was not started.');
      // Construct page URLs ourselves. Never forward the token to a URL from Link.
    }
    remaining();
    if(legacy.length>0&&legacy.every(run=>run.status==='completed')) {
      log(`Observed ${legacy.length} completed legacy Pages run(s); compiled publication may proceed.`);
      return{buildType:'legacy',legacyRuns:legacy.length,polls,waitedMs:now()-started};
    }
    log(legacy.length===0
      ?'Legacy Pages run is not indexed yet; waiting before compiled publication.'
      :'Legacy Pages publication is still active; waiting before compiled publication.');
    await wait(Math.min(pollIntervalMs,remaining()));
  }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  try {await waitForLegacyPages();}
  catch(error){console.error(`Pages publication guard: ${error instanceof Error?error.message:'failed'}`);process.exitCode=1;}
}
