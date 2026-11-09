#!/usr/bin/env node
/** Fully local production classroom runtime; never imports the test authentication gateway. */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ROOT, openRuntime, backupRuntime, restoreBackup, defaultDataDirectory, counts, atomicJson } from './storage.mjs';
import { HttpError, invokeRpc, object } from './rpc.mjs';
import { bearer, sameSecret, authenticate, identify, hostLogin, refresh, logout } from './auth.mjs';

const BODY_LIMIT=1024*1024;
// The SQL workspace contract permits 5 MiB of state plus the bounded RPC envelope.
const WORKSPACE_BODY_LIMIT=5*1024*1024+16*1024;
const MIME=new Map(Object.entries({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
  '.geojson':'application/geo+json; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf',
  '.txt':'text/plain; charset=utf-8','.pdf':'application/pdf','.webmanifest':'application/manifest+json'}));
const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const safeCode=e=>typeof e.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(e.code)?e.code:'OFFLINE_SERVER_ERROR';
const isLoopback=request=>LOOPBACK.has(request.socket.remoteAddress);
const localName=name=>name==='localhost'||name==='127.0.0.1'||name==='[::1]';

function headers(response) {
  response.setHeader('X-Content-Type-Options','nosniff');
  response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy','same-origin');
  response.setHeader('X-Frame-Options','DENY');
  response.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}
function json(response,status,value) {
  const bytes=Buffer.from(JSON.stringify(value));
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store'});
  response.end(bytes);
}
async function body(request,limit=BODY_LIMIT) {
  if(!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type']??''))throw new HttpError(415,'JSON_REQUIRED');
  if(request.headers['content-encoding'] && request.headers['content-encoding']!=='identity')throw new HttpError(415,'ENCODING_NOT_SUPPORTED');
  const length=Number(request.headers['content-length']);
  if(Number.isFinite(length)&&length>limit)throw new HttpError(413,'BODY_TOO_LARGE');
  const chunks=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>limit)throw new HttpError(413,'BODY_TOO_LARGE');chunks.push(chunk);}
  try{return size===0?{}:JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'INVALID_JSON');}
}
function networkHosts(extra) {
  const allowed=new Set(['127.0.0.1','localhost','[::1]']);
  let interfaces={};
  // Some sandboxed hosts prohibit adapter enumeration. Fail closed to loopback plus explicit names.
  try{interfaces=networkInterfaces();}catch{}
  for(const addresses of Object.values(interfaces))for(const address of addresses??[])
    if(address.family==='IPv4')allowed.add(address.address);
  if(extra){
    for(const name of extra.split(',').map(x=>x.trim()).filter(Boolean)) {
      if(!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?)$/.test(name))throw new Error('OFFLINE_PUBLIC_HOST_INVALID');
      allowed.add(name.toLowerCase());
    }
  }
  return allowed;
}
function checkRequest(request,port,allowed) {
  const host=request.headers.host;
  if(typeof host!=='string' || host.length>300 || request.rawHeaders.filter((_,i)=>i%2===0&&request.rawHeaders[i].toLowerCase()==='host').length!==1)
    throw new HttpError(400,'HOST_REQUIRED');
  let target;
  try{target=new URL(`http://${host}`);}catch{throw new HttpError(400,'HOST_INVALID');}
  if(target.username||target.password||target.pathname!=='/'||target.search||target.hash
      ||Number(target.port||80)!==port||!allowed.has(target.hostname))throw new HttpError(403,'HOST_NOT_ALLOWED');
  if(request.headers.origin!==undefined&&request.headers.origin!==target.origin)throw new HttpError(403,'ORIGIN_NOT_ALLOWED');
  if(typeof request.url!=='string'||!request.url.startsWith('/')||request.url.startsWith('//')||request.url.length>4096)
    throw new HttpError(400,'PATH_INVALID');
  const rawPath=request.url.split('?')[0];
  let decoded;
  try{decoded=decodeURIComponent(rawPath);}catch{throw new HttpError(400,'PATH_INVALID');}
  if(/[\\\u0000-\u001f]/.test(decoded)||decoded.split('/').some(p=>p==='..'||p==='.'))throw new HttpError(400,'PATH_INVALID');
  return {origin:target.origin,hostname:target.hostname,path:decoded,url:new URL(request.url,target.origin)};
}

async function within(base,path) {
  try {
    const root=await realpath(base),candidate=await realpath(resolve(base,path));
    const rel=relative(root,candidate);
    if(rel===''||rel.startsWith('..')||isAbsolute(rel))return null;
    const info=await stat(candidate);
    return info.isFile()?{path:candidate,info}:null;
  }catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e;}
}
async function staticFile(request,response,path,survey,root) {
  if(request.method!=='GET'&&request.method!=='HEAD')throw new HttpError(405,'METHOD_NOT_ALLOWED');
  const routed=path==='/'?(survey?'/survey.html':'/index.html'):path;
  if((survey&&routed==='/index.html')||(!survey&&routed==='/survey.html'))throw new HttpError(404,'NOT_FOUND');
  const ext=extname(routed);
  const permitted=routed==='/index.html'||routed==='/survey.html'||/^\/(?:favicon\.(?:svg|ico|png)|apple-touch-icon\.png|site\.webmanifest)$/.test(routed)
    || /^\/assets\/[a-zA-Z0-9_./-]+$/.test(routed)
    || /^\/fonts\/(?:DejaVuSans(?:-Bold)?\.ttf|LICENSE-DejaVu\.txt)$/.test(routed)
    ||(!survey&&/^\/data\/[a-zA-Z0-9_./-]+$/.test(routed));
  if(!permitted||!MIME.has(ext))throw new HttpError(404,'NOT_FOUND');
  const file=await within(resolve(root,'dist'),routed.slice(1))
    ??await within(resolve(root,'public'),routed.slice(1));
  if(!file)throw new HttpError(404,'NOT_FOUND');
  const etag=`W/"${file.info.size.toString(16)}-${Math.floor(file.info.mtimeMs).toString(16)}"`;
  response.setHeader('Content-Type',MIME.get(ext));
  response.setHeader('ETag',etag);
  response.setHeader('Cache-Control',ext==='.html'?'no-cache':'public, max-age=3600');
  if(request.headers['if-none-match']===etag){response.writeHead(304);return response.end();}
  if(ext==='.pdf') {
    response.setHeader('Accept-Ranges','bytes');
    const range=request.headers.range;
    if(range && (!request.headers['if-range']||request.headers['if-range']===etag)) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match||(!match[1]&&!match[2]))throw new HttpError(416,'INVALID_RANGE');
      const start=match[1]?Number(match[1]):Math.max(0,file.info.size-Number(match[2]));
      const end=match[1]?(match[2]?Math.min(Number(match[2]),file.info.size-1):file.info.size-1):file.info.size-1;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=file.info.size){
        response.setHeader('Content-Range',`bytes */${file.info.size}`);throw new HttpError(416,'INVALID_RANGE');
      }
      response.statusCode=206;response.setHeader('Content-Range',`bytes ${start}-${end}/${file.info.size}`);
      response.setHeader('Content-Length',end-start+1);
      return request.method==='HEAD'?response.end():pipeline(createReadStream(file.path,{start,end}),response);
    }
  }
  if(request.method==='HEAD'){response.setHeader('Content-Length',file.info.size);return response.end();}
  if(['.json','.geojson','.js','.mjs','.css','.svg','.html'].includes(ext)
      && /(?:^|,)\s*gzip(?:\s*;\s*q=(?!0(?:\D|$))[0-9.]+)?\s*(?:,|$)/i.test(request.headers['accept-encoding']??'')){
    response.setHeader('Content-Encoding','gzip');response.setHeader('Vary','Accept-Encoding');
    return pipeline(createReadStream(file.path),createGzip({level:4}),response);
  }
  response.setHeader('Content-Length',file.info.size);
  return pipeline(createReadStream(file.path),response);
}

export async function startServer({runtime,host=process.env.DW_OFFLINE_HOST??'0.0.0.0',
  port=Number(process.env.DW_OFFLINE_PORT??8787),surveyPort=Number(process.env.DW_OFFLINE_SURVEY_PORT??8788),
  publicHost=process.env.DW_OFFLINE_PUBLIC_HOST??'',root=ROOT,backupIntervalMs=5*60*1000,logger=console}={}) {
  let allowed;
  try {
    if(![port,surveyPort].every(p=>Number.isInteger(p)&&p>=0&&p<=65535)||port===surveyPort&&port!==0)
      throw new Error('OFFLINE_PORT_INVALID');
    if(!await within(resolve(root,'dist'),'index.html')||!await within(resolve(root,'dist'),'survey.html'))
      throw new Error('OFFLINE_BUILD_MISSING');
    allowed=networkHosts(publicHost);
  }catch(error){await runtime?.close();throw error;}
  if(!runtime)runtime=await openRuntime({progress:step=>logger.log(`Подготовка: ${step.phase} ${step.completed}${step.total?'/'+step.total:''}`)});
  const rate=new Map();
  let stopped=false,interval,backupQueued=false;
  let main,survey;
  const takeRate=(request)=>{
    const key=request.socket.remoteAddress,now=Date.now();
    if(rate.size>1000)for(const[k,v]of rate)if(now-v.since>60_000)rate.delete(k);
    const previous=rate.get(key);
    if(!previous||now-previous.since>60_000)rate.set(key,{since:now,count:1});
    else if(++previous.count>120)throw new HttpError(429,'AUTH_RATE_LIMITED');
  };
  async function requireAdmin(request,context) {
    if(!isLoopback(request)||!localName(context.hostname))throw new HttpError(403,'HOST_LOCAL_ONLY');
    const token=bearer(request);
    if(sameSecret(token,runtime.operator.hostKey))return;
    const identity=await authenticate(runtime,token);
    const permitted=(await runtime.db.query(`select 1 from offline.accounts a join private.facilitators f on f.user_id=a.user_id
      where a.user_id=$1 and a.kind in ('host','teacher') and f.revoked_at is null`,[identity.user.id])).rows.length===1;
    if(!permitted)throw new HttpError(403,'HOST_REQUIRED');
  }
  async function handle(request,response,isSurvey) {
    headers(response);
    const actualPort=(isSurvey?survey:main).address().port;
    const context=checkRequest(request,actualPort,allowed);
    if(request.method==='OPTIONS') {
      if(request.headers.origin!==context.origin)throw new HttpError(403,'ORIGIN_REQUIRED');
      response.writeHead(204,{'Access-Control-Allow-Origin':context.origin,
        'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-supabase-api-version, x-offline-host-bootstrap',
        'Vary':'Origin','Cache-Control':'no-store'});return response.end();
    }
    if(request.headers.origin===context.origin)response.setHeader('Access-Control-Allow-Origin',context.origin);
    const path=context.path;
    const mainPort=main.address().port,anonPort=survey.address().port;
    const classroomOrigin=`http://${context.hostname}:${mainPort}`;
    if(path==='/workshop-config.json'&&request.method==='GET') {
      return json(response,200,{schemaVersion:1,supabaseUrl:context.origin,
        supabasePublishableKey:`sb_publishable_offline_${runtime.operator.instanceId.replaceAll('-','')}`,
        realtime:false,offline:true,offlineInstanceId:runtime.operator.instanceId,
        ...(!isSurvey?{offlineAuthUrl:classroomOrigin}:{}),classroomOrigin,
        surveyUrl:`http://${context.hostname}:${anonPort}/survey.html`});
    }
    if(path==='/offline/status'&&request.method==='GET') {
      return json(response,200,{ready:!stopped,mode:'offline',instanceId:runtime.operator.instanceId,
        role:isSurvey?'survey':'classroom',port:mainPort,surveyPort:anonPort,
        canonical:runtime.ready.seed,updatedLocally:true});
    }
    if(path.startsWith('/rest/v1/rpc/')) {
      if(request.method!=='POST')throw new HttpError(405,'METHOD_NOT_ALLOWED');
      if(isSurvey&&(request.headers.authorization||request.headers.cookie))throw new HttpError(403,'SURVEY_AUTH_FORBIDDEN');
      const name=path.slice('/rest/v1/rpc/'.length);
      const input=await body(request,!isSurvey&&name==='dw_workspace_commit'?WORKSPACE_BODY_LIMIT:BODY_LIMIT);
      const result=await runtime.enqueue(async()=>{
        const identity=isSurvey?null:await authenticate(runtime,bearer(request));
        return invokeRpc(runtime.db,runtime.catalogue,name,input,identity,isSurvey);
      });
      return json(response,200,result);
    }
    if(isSurvey&&(path.startsWith('/auth/')||path.startsWith('/offline/auth/')||path.startsWith('/offline/admin/')))
      throw new HttpError(404,'NOT_FOUND');
    if(path.startsWith('/offline/auth/')||path.startsWith('/auth/v1/')) {
      takeRate(request);
      if(path==='/auth/v1/user'&&request.method==='GET') {
        const identity=await runtime.enqueue(()=>authenticate(runtime,bearer(request)));
        return json(response,200,identity.user);
      }
      if(request.method!=='POST')throw new HttpError(405,'METHOD_NOT_ALLOWED');
      const input=await body(request,16*1024);
      if(path==='/offline/auth/host-bootstrap') {
        if(!isLoopback(request)||!localName(context.hostname)||request.headers.origin!==context.origin
          ||request.headers['x-offline-host-bootstrap']!=='1'||!object(input)||Object.keys(input).some(key=>key!=='fullName'))
          throw new HttpError(403,'HOST_BOOTSTRAP_FORBIDDEN');
        if(input.fullName!==undefined&&typeof input.fullName!=='string')throw new HttpError(400,'INVALID_INPUT');
        return json(response,200,await runtime.enqueue(()=>hostLogin(runtime,{hostKey:runtime.operator.hostKey,
          ...(input.fullName?.trim()?{fullName:input.fullName}:{})})));
      }
      if(path==='/offline/auth/host') {
        if(!isLoopback(request)||!localName(context.hostname))throw new HttpError(403,'HOST_LOCAL_ONLY');
        return json(response,200,await runtime.enqueue(()=>hostLogin(runtime,input)));
      }
      if(path==='/offline/auth/identify')return json(response,200,await runtime.enqueue(()=>identify(runtime,input)));
      if(path==='/offline/auth/register'||path==='/offline/auth/recover')
        return json(response,410,{code:'SIMPLE_IDENTIFICATION_REQUIRED',message:'Введите email',details:null,hint:null});
      if(path==='/auth/v1/token'&&context.url.searchParams.get('grant_type')==='refresh_token')
        return json(response,200,await runtime.enqueue(()=>refresh(runtime,input)));
      if(path==='/auth/v1/logout') {
        await runtime.enqueue(async()=>logout(runtime,await authenticate(runtime,bearer(request)),context.url.searchParams.get('scope')??'global'));
        return json(response,200,{});
      }
      throw new HttpError(404,'NOT_FOUND');
    }
    if(path.startsWith('/offline/admin/')) {
      if(!isLoopback(request))throw new HttpError(403,'HOST_LOCAL_ONLY');
      if(path==='/offline/admin/status'&&request.method==='GET') {
        const status=await runtime.enqueue(async()=>{
          await requireAdmin(request,context);
          return {instanceId:runtime.operator.instanceId,joinCode:runtime.operator.joinCode,
            port:mainPort,surveyPort:anonPort,counts:await counts(runtime.db),
            lastBackup:runtime.lastBackup,lanHosts:[...allowed].filter(x=>!localName(x)),queueDepth:runtime.pending};
        });return json(response,200,status);
      }
      if(request.method!=='POST')throw new HttpError(405,'METHOD_NOT_ALLOWED');
      await body(request,1024);
      if(path==='/offline/admin/backup') {
        const backup=await runtime.enqueue(async()=>{await requireAdmin(request,context);return backupRuntime(runtime);});
        return json(response,200,{backup});
      }
      if(path==='/offline/admin/stop') {
        await runtime.enqueue(()=>requireAdmin(request,context));
        json(response,200,{stopping:true});setImmediate(()=>stop().catch(()=>{process.exitCode=1;}));return;
      }
      throw new HttpError(404,'NOT_FOUND');
    }
    if(path.startsWith('/rest/')||path.startsWith('/auth/')||path.startsWith('/offline/'))throw new HttpError(404,'NOT_FOUND');
    return staticFile(request,response,path,isSurvey,root);
  }
  function listener(isSurvey){
    const server=createServer((req,res)=>handle(req,res,isSurvey).catch(e=>{
      if(res.destroyed||e.code==='ERR_STREAM_PREMATURE_CLOSE'||e.code==='ECONNRESET')return;
      if(res.headersSent){res.destroy();return;}
      const domain=e.code==='P0001'&&/^[A-Z0-9_]{1,80}$/.test(e.message)?e.message:null;
      const status=e.status??(domain?400:/^(?:22|23)/.test(e.code??'')?400:500);
      json(res,status,{code:domain??safeCode(e),message:domain??safeCode(e),details:null,hint:null});
      if(status>=500)logger.error('Ошибка локального сервера:',safeCode(e));
    }));
    server.keepAliveTimeout=5000;server.headersTimeout=15_000;server.requestTimeout=30_000;
    server.maxHeadersCount=64;server.maxConnections=256;
    server.on('connect',(_request,socket)=>socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    server.on('upgrade',(_request,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    return server;
  }
  main=listener(false);survey=listener(true);
  async function listen(server,requested){
    return new Promise((done,reject)=>{server.once('error',reject);server.listen(requested,host,()=>{server.off('error',reject);done();});});
  }
  async function closeServer(server){
    if(!server.listening)return;
    const completion=new Promise(resolve=>server.close(resolve));
    server.closeIdleConnections();
    const timer=setTimeout(()=>server.closeAllConnections(),5000);timer.unref();
    await completion;clearTimeout(timer);
  }
  async function stop() {
    if(stopped)return;stopped=true;clearInterval(interval);
    await Promise.all([closeServer(main),closeServer(survey)]);
    await runtime.enqueue(()=>backupRuntime(runtime,{kind:'shutdown'})).catch(e=>logger.error('Резервная копия при остановке:',safeCode(e)));
    await runtime.close();
    logger.log('Локальный сервер остановлен; подтверждённые изменения сохранены.');
  }
  try {
    await listen(main,port);await listen(survey,surveyPort);
    const record={instanceId:runtime.operator.instanceId,pid:process.pid,port:main.address().port,
      surveyPort:survey.address().port,ready:true,startedAt:new Date().toISOString()};
    await atomicJson(resolve(runtime.dataDir,'runtime.json'),record);
    if(backupIntervalMs>0) {
      interval=setInterval(()=>{
        if(backupQueued||stopped)return;backupQueued=true;
        runtime.enqueue(()=>backupRuntime(runtime,{kind:'automatic'})).catch(e=>logger.error('Автоматическая копия:',safeCode(e))).finally(()=>{backupQueued=false;});
      },backupIntervalMs);interval.unref();
    }
    logger.log(`Мастерская готова: http://127.0.0.1:${record.port}/; опрос: http://127.0.0.1:${record.surveyPort}/survey.html`);
    return {runtime,main,survey,stop,...record};
  }catch(error){await Promise.all([closeServer(main),closeServer(survey)]);await runtime.close();throw error;}
}

async function cli() {
  const args=process.argv.slice(2);
  if(args.includes('--help')) {
    console.log('node scripts/offline/server.mjs [--prepare | --backup | --restore /path/manifest.json]\nDW_OFFLINE_DATA_DIR: external persistent directory; DW_OFFLINE_PORT=8787; DW_OFFLINE_SURVEY_PORT=8788; DW_OFFLINE_HOST=0.0.0.0; DW_OFFLINE_PUBLIC_HOST: optional explicit hostnames.');return;
  }
  if(args[0]==='--restore'&&args.length===2) {
    const result=await restoreBackup(resolve(args[1]),process.env.DW_OFFLINE_DATA_DIR??defaultDataDirectory());
    console.log(JSON.stringify({restored:true,...result}));return;
  }
  if(args.length>1||args.length===1&&!['--prepare','--backup'].includes(args[0]))throw new Error('OFFLINE_ARGUMENT_INVALID');
  if(args[0]) {
    const runtime=await openRuntime({progress:x=>console.log(`Подготовка: ${x.phase} ${x.completed}${x.total?'/'+x.total:''}`)});
    try {
      if(args[0]==='--backup')console.log(JSON.stringify({backup:await runtime.enqueue(()=>backupRuntime(runtime))}));
      else console.log(JSON.stringify({ready:true,instanceId:runtime.operator.instanceId,canonical:runtime.ready.seed}));
    }finally{await runtime.close();}
    return;
  }
  const app=await startServer();
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>app.stop().catch(()=>{process.exitCode=1;}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  cli().catch(e=>{console.error('Локальный сервер не запущен:',safeCode(e),e.message?.startsWith('OFFLINE_')?e.message:'');process.exitCode=1;});
