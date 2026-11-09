import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const MAX_TIMEOUT_MS=10_000;

/** Checks one prerequisite with GET only; never changes GitHub Pages settings. */
export async function assertPagesSource({
  repository=process.env.GITHUB_REPOSITORY,
  token=process.env.GH_TOKEN,
  fetchImpl=globalThis.fetch,
  log=message=>console.log(message),
  timeoutMs=MAX_TIMEOUT_MS,
}={}) {
  if(typeof repository!=='string'||!/^[-A-Za-z0-9]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    ||['.','..'].includes(repository.split('/')[1]))throw new Error('Invalid GITHUB_REPOSITORY.');
  if(typeof token!=='string'||!token.trim())throw new Error('GH_TOKEN is required for the read-only Pages source check.');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_TIMEOUT_MS)
    throw new Error('Invalid Pages source check timeout.');
  const url=`https://api.github.com/repos/${repository.split('/').map(encodeURIComponent).join('/')}/pages`;
  const controller=new AbortController();
  const timedOutMessage='GitHub Pages source check timed out; deployment was not started.';
  let timer,timedOut=false;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      timedOut=true;controller.abort();reject(new Error(timedOutMessage));
    },timeoutMs);
  });
  try {
    return await Promise.race([deadline,(async()=>{
      let response,site;
      try {
        response=await fetchImpl(url,{method:'GET',redirect:'error',credentials:'omit',signal:controller.signal,
          headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,
            'X-GitHub-Api-Version':'2022-11-28','User-Agent':'demography-lab-pages-source-check'}});
      }catch {
        throw new Error(timedOut?timedOutMessage:'GitHub Pages GET failed; deployment was not started.');
      }
      if(!response.ok)throw new Error(`GitHub Pages GET returned HTTP ${response.status}; deployment was not started.`);
      try {site=await response.json();}
      catch {throw new Error(timedOut?timedOutMessage:'GitHub Pages returned invalid JSON; deployment was not started.');}
      if(timedOut)throw new Error(timedOutMessage);
      if(site?.build_type==='legacy')throw new Error(
        'GitHub Pages Source is Deploy from a branch (legacy). Repository owner: open Settings → Pages → Source → GitHub Actions, then rerun this workflow. Deployment was not started.');
      if(site?.build_type!=='workflow')throw new Error(
        'GitHub Pages returned an unsupported Source; expected GitHub Actions (build_type=workflow). Deployment was not started.');
      log('Verified GitHub Pages Source: GitHub Actions.');
      return{buildType:'workflow'};
    })()]);
  }finally{clearTimeout(timer);controller.abort();}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  try {await assertPagesSource();}
  catch(error){console.error(`Pages source check: ${error instanceof Error?error.message:'failed'}`);process.exitCode=1;}
}
