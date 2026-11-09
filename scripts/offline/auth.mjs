import { createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sha256, secret } from './storage.mjs';
import { HttpError, object } from './rpc.mjs';

const ACCESS_SECONDS=3600;
const REFRESH_SECONDS=7*24*3600;
const RECOVERY=/^[A-Za-z0-9_-]{43,128}$/;
const EMAIL=/^[^\s@\u0000-\u001f]+@[^\s@\u0000-\u001f]+\.[^\s@\u0000-\u001f]+$/u;
const receiptKey=operator=>Buffer.from(sha256('demography-lab:refresh-receipt:v1:'+operator.tokenSigningSecret),'hex');
function encryptReceipt(operator,session,oldHash) {
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',receiptKey(operator),nonce);
  cipher.setAAD(Buffer.from(oldHash));
  const value=JSON.stringify({access_token:session.access_token,refresh_token:session.refresh_token,
    expires_at:session.expires_at,expires_in:session.expires_in,token_type:session.token_type});
  const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
}
function decryptReceipt(operator,ciphertext,oldHash) {
  const bytes=Buffer.from(ciphertext,'base64url'),decipher=createDecipheriv('aes-256-gcm',receiptKey(operator),bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(oldHash));decipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
}
export function sameSecret(actual,expected) {
  if(typeof actual!=='string' || actual.length>2048)return false;
  return timingSafeEqual(Buffer.from(sha256(actual),'hex'),Buffer.from(sha256(expected),'hex'));
}
export function bearer(request) {
  const value=request.headers.authorization;
  return typeof value==='string' && /^Bearer [A-Za-z0-9_.-]{20,2048}$/i.test(value) ? value.slice(7) : null;
}
function userDto(row) {
  return {id:row.id,aud:'authenticated',role:'authenticated',email:row.email,
    phone:'',email_confirmed_at:null,confirmed_at:null,is_anonymous:false,
    app_metadata:{provider:'offline',providers:['offline'],offline:true,email_verified:false},
    user_metadata:{...row.raw_user_meta_data,claimed_email:row.email,email_verified:false},
    identities:[],created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString()};
}
function token(operator,user,sessionId,now) {
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({iss:`demography-lab:${operator.instanceId}`,aud:'authenticated',
    sub:user.id,role:'authenticated',iat:now,exp:now+ACCESS_SECONDS,session_id:sessionId,jti:secret(),
    is_anonymous:false,app_metadata:{offline:true,provider:'offline',email_verified:false}})).toString('base64url');
  const signature=createHmac('sha256',operator.tokenSigningSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
async function mint(db,operator,user,{sessionId=randomUUID(),rotate=false}={}) {
  const now=Math.floor(Date.now()/1000),accessToken=token(operator,user,sessionId,now),refreshToken=secret();
  if(rotate) await db.query(`update offline.sessions set access_hash=$2,refresh_hash=$3,
    access_expires_at=to_timestamp($4),refresh_expires_at=to_timestamp($5) where id=$1`,
    [sessionId,sha256(accessToken),sha256(refreshToken),now+ACCESS_SECONDS,now+REFRESH_SECONDS]);
  else await db.query(`insert into offline.sessions(id,user_id,access_hash,refresh_hash,access_expires_at,refresh_expires_at)
    values($1,$2,$3,$4,to_timestamp($5),to_timestamp($6))`,
    [sessionId,user.id,sha256(accessToken),sha256(refreshToken),now+ACCESS_SECONDS,now+REFRESH_SECONDS]);
  return {access_token:accessToken,refresh_token:refreshToken,expires_in:ACCESS_SECONDS,
    expires_at:now+ACCESS_SECONDS,token_type:'bearer',user};
}
export async function authenticate(runtime,accessToken) {
  if(!accessToken)throw new HttpError(401,'AUTH_REQUIRED');
  // The hash is the authority: a forged or previously revoked signed JWT is never sufficient.
  const {rows}=await runtime.db.query(`select s.id as session_id,u.* from offline.sessions s
    join auth.users u on u.id=s.user_id where s.revoked_at is null and (
      (s.access_hash=$1 and s.access_expires_at>now()) or exists(
        select 1 from offline.refresh_receipts r where r.session_id=s.id and r.old_access_hash=$1
          and r.new_refresh_hash=s.refresh_hash and r.expires_at>now() and r.old_access_expires_at>now()))`,[sha256(accessToken)]);
  if(!rows.length)throw new HttpError(401,'TOKEN_EXPIRED_OR_REVOKED');
  return {id:rows[0].session_id,user:userDto(rows[0])};
}
function fields(input,allowed) {
  if(!object(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw new HttpError(400,'INVALID_INPUT');
}
export async function register(runtime,input) {
  fields(input,['email','fullName','joinCode','recoverySecret']);
  if(!RECOVERY.test(input.recoverySecret??'') || typeof input.email!=='string' || input.email.length>254
    || !EMAIL.test(input.email.trim()) || typeof input.fullName!=='string'
    || input.fullName.trim().length<1 || input.fullName.trim().length>200)
    throw new HttpError(400,'INVALID_INPUT');
  if(!sameSecret(input.joinCode,runtime.operator.joinCode))throw new HttpError(403,'INVALID_CLASSROOM_CODE');
  return runtime.db.transaction(async tx=>{
    const existing=await tx.query(`select u.* from offline.accounts a join auth.users u on u.id=a.user_id
      where a.recovery_hash=$1 and a.kind='participant'`,[sha256(input.recoverySecret)]);
    if(existing.rows.length)return {session:await mint(tx,runtime.operator,userDto(existing.rows[0]))};
    const id=randomUUID(),email=input.email.trim(),fullName=input.fullName.trim();
    const row=(await tx.query(`insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data)
      values($1,$2,$3::jsonb,'{"offline":true,"provider":"offline","email_verified":false}'::jsonb) returning *`,
      [id,email,JSON.stringify({full_name:fullName,claimed_email:email,email_verified:false})])).rows[0];
    await tx.query("insert into offline.accounts(user_id,recovery_hash,kind) values($1,$2,'participant')",[id,sha256(input.recoverySecret)]);
    await tx.query('insert into public.dw_profiles(user_id,full_name) values($1,$2)',[id,fullName]);
    return {session:await mint(tx,runtime.operator,userDto(row))};
  });
}
export async function recover(runtime,input) {
  fields(input,['recoverySecret']);
  if(!RECOVERY.test(input.recoverySecret??''))throw new HttpError(400,'INVALID_RECOVERY_SECRET');
  return runtime.db.transaction(async tx=>{
    const {rows}=await tx.query(`select u.* from offline.accounts a join auth.users u on u.id=a.user_id
      where a.recovery_hash=$1 and a.kind='participant'`,[sha256(input.recoverySecret)]);
    if(!rows.length)throw new HttpError(403,'RECOVERY_NOT_FOUND');
    // Recovery revokes older sessions, preventing a lost device from continuing to write.
    await tx.query('update offline.sessions set revoked_at=now() where user_id=$1 and revoked_at is null',[rows[0].id]);
    return {session:await mint(tx,runtime.operator,userDto(rows[0]))};
  });
}
export async function hostLogin(runtime,input) {
  fields(input,['hostKey','fullName']);
  if(!sameSecret(input.hostKey,runtime.operator.hostKey))throw new HttpError(403,'HOST_KEY_INVALID');
  if(input.fullName!==undefined && (typeof input.fullName!=='string' || input.fullName.trim().length<1 || input.fullName.trim().length>200))
    throw new HttpError(400,'INVALID_INPUT');
  return runtime.db.transaction(async tx=>{
    let row=(await tx.query("select u.* from auth.users u join offline.accounts a on a.user_id=u.id where a.kind='host'")).rows[0];
    if(!row){
      const id=randomUUID(),fullName=input.fullName?.trim();
      row=(await tx.query(`insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data)
        values($1,$2,$3::jsonb,'{"offline":true,"provider":"offline","email_verified":false}'::jsonb) returning *`,
        [id,`host@${runtime.operator.instanceId}.local`,JSON.stringify({full_name:fullName,email_verified:false})])).rows[0];
      await tx.query("insert into offline.accounts(user_id,kind) values($1,'host')",[id]);
      if(fullName)await tx.query('insert into public.dw_profiles(user_id,full_name) values($1,$2)',[id,fullName]);
      await tx.query('insert into private.facilitators(user_id) values($1)',[id]);
    }
    return {session:await mint(tx,runtime.operator,userDto(row))};
  });
}
export async function refresh(runtime,input) {
  fields(input,['refresh_token']);
  if(!RECOVERY.test(input.refresh_token??''))throw new HttpError(400,'REFRESH_TOKEN_INVALID');
  return runtime.db.transaction(async tx=>{
    const oldHash=sha256(input.refresh_token);
    await tx.query('delete from offline.refresh_receipts where expires_at<=now()');
    const {rows}=await tx.query(`select s.id as session_id,s.access_hash as old_access_hash,s.access_expires_at as old_access_expires_at,u.* from offline.sessions s join auth.users u on u.id=s.user_id
      where s.refresh_hash=$1 and s.revoked_at is null and s.refresh_expires_at>now() for update of s`,[oldHash]);
    if(!rows.length) {
      const receipt=(await tx.query(`select r.response_ciphertext,s.access_hash,u.* from offline.refresh_receipts r
        join offline.sessions s on s.id=r.session_id join auth.users u on u.id=s.user_id
        where r.old_refresh_hash=$1 and r.expires_at>now() and r.new_refresh_hash=s.refresh_hash
          and s.revoked_at is null and s.access_expires_at>now()`,[oldHash])).rows[0];
      if(!receipt)throw new HttpError(400,'REFRESH_TOKEN_EXPIRED_OR_REUSED');
      const result=decryptReceipt(runtime.operator,receipt.response_ciphertext,oldHash);
      if(sha256(result.access_token)!==receipt.access_hash)throw new HttpError(400,'REFRESH_TOKEN_EXPIRED_OR_REUSED');
      return {...result,expires_in:Math.max(0,result.expires_at-Math.floor(Date.now()/1000)),user:userDto(receipt)};
    }
    const result=await mint(tx,runtime.operator,userDto(rows[0]),{sessionId:rows[0].session_id,rotate:true});
    await tx.query(`insert into offline.refresh_receipts(old_refresh_hash,session_id,new_refresh_hash,response_ciphertext,expires_at,old_access_hash,old_access_expires_at)
      values($1,$2,$3,$4,now()+interval '30 seconds',$5,$6)`,
      [oldHash,rows[0].session_id,sha256(result.refresh_token),encryptReceipt(runtime.operator,result,oldHash),rows[0].old_access_hash,rows[0].old_access_expires_at]);
    return result;
  });
}
export async function logout(runtime,identity,scope) {
  if(!['global','local','others'].includes(scope))throw new HttpError(400,'INVALID_LOGOUT_SCOPE');
  if(scope==='local')await runtime.db.query('update offline.sessions set revoked_at=now() where id=$1',[identity.id]);
  else await runtime.db.query('update offline.sessions set revoked_at=now() where user_id=$1 and ($2::uuid is null or id<>$2)',
    [identity.user.id,scope==='others'?identity.id:null]);
}
