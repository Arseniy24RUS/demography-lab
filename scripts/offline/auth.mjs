import { createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { sha256, secret } from './storage.mjs';
import { HttpError, object } from './rpc.mjs';

const ACCESS_SECONDS=3600;
const REFRESH_SECONDS=7*24*3600;
const TOKEN=/^[A-Za-z0-9_-]{43,128}$/;
const EMAIL=/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/u;
// The workshop owner explicitly uses the same email-first entry as every participant.
// This is declared identification, not proof of mailbox ownership.
export const TEACHER_EMAIL='omnistat@yandex.ru';
// One local authority for email provenance, disabled actors and role eligibility.
const ACCOUNT_SAFE='private.dw_actor_eligible(u.id)';
const normalizeEmail=email=>email.trim().normalize('NFC').toLowerCase();
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
    join auth.users u on u.id=s.user_id where ${ACCOUNT_SAFE} and s.revoked_at is null and (
      (s.access_hash=$1 and s.access_expires_at>now()) or exists(
        select 1 from offline.refresh_receipts r where r.session_id=s.id and r.old_access_hash=$1
          and r.new_refresh_hash=s.refresh_hash and r.expires_at>now() and r.old_access_expires_at>now()))`,[sha256(accessToken)]);
  if(!rows.length)throw new HttpError(401,'TOKEN_EXPIRED_OR_REVOKED');
  return {id:rows[0].session_id,user:userDto(rows[0])};
}
function fields(input,allowed) {
  if(!object(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw new HttpError(400,'INVALID_INPUT');
}

/** Preserve the declared email's UUID; otherwise reuse the existing local cabinet. */
async function resolveTeacherAccount(tx,email) {
  const oldHost=(await tx.query(`select u.*,a.kind,actor.disabled_at,f.revoked_at
    from offline.accounts a join auth.users u on u.id=a.user_id
    join private.dw_actors actor on actor.id=u.id
    left join private.facilitators f on f.user_id=u.id where a.kind='host'`)).rows[0];
  let row=(await tx.query(`select u.*,a.kind,actor.disabled_at,f.revoked_at
    from offline.email_identities e join offline.accounts a on a.user_id=e.user_id
    join auth.users u on u.id=a.user_id join private.dw_actors actor on actor.id=u.id
    left join private.facilitators f on f.user_id=u.id where e.normalized_email=$1`,[email])).rows[0];
  row??=oldHost;
  if(!row) {
    const candidates=(await tx.query(`select u.*,a.kind,actor.disabled_at,f.revoked_at
      from offline.accounts a join auth.users u on u.id=a.user_id
      join private.dw_actors actor on actor.id=u.id
      left join private.facilitators f on f.user_id=u.id
      where a.kind='participant' and not exists(
        select 1 from offline.email_identities e where e.user_id=u.id)
      order by a.created_at,u.created_at,u.id`)).rows;
    row=candidates.find(candidate=>typeof candidate.email==='string'&&normalizeEmail(candidate.email)===email);
  }
  if(row) {
    // The new convenience entry must not silently undo an explicit account disable/revocation.
    if(row.disabled_at!==null || row.revoked_at!=null || row.raw_app_meta_data?.offline!==true
        || row.email_confirmed_at!==null || row.is_anonymous!==false)
      throw new HttpError(403,'TEACHER_IDENTITY_UNAVAILABLE');
  }
  return {row,kind:oldHost && oldHost.id!==row?.id?'teacher':'host',
    oldHostId:oldHost?.disabled_at===null && oldHost.revoked_at==null?oldHost?.id:null};
}

async function completeTeacherAccount(tx,email,fullName,resolved) {
  let row=resolved.row;
  if(row)await tx.query('update offline.accounts set kind=$2,recovery_hash=null where user_id=$1',[row.id,resolved.kind]);
  else {
    row=(await tx.query(`insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data)
      values($1,$2,$3::jsonb,'{"offline":true,"provider":"offline","email_verified":false}'::jsonb) returning *`,
      [randomUUID(),email,JSON.stringify({full_name:fullName,claimed_email:email,email_verified:false})])).rows[0];
    await tx.query("insert into offline.accounts(user_id,kind) values($1,'host')",[row.id]);
  }
  await tx.query('insert into private.facilitators(user_id) values($1) on conflict(user_id) do nothing',[row.id]);
  // A pre-existing email pointer always wins; no history or author/voter identity is rewritten.
  await tx.query(`insert into offline.email_identities(normalized_email,user_id) values($1,$2)
    on conflict(normalized_email) do update set last_identified_at=now()`,[email,row.id]);
  return row;
}

async function inheritLocalCabinet(tx,userId,oldHostId) {
  if(!oldHostId || oldHostId===userId)return;
  const memberships=(await tx.query(`insert into public.dw_memberships(session_id,user_id,role)
    select session_id,$1,'host' from public.dw_memberships
      where user_id=$2 and role='host' and revoked_at is null
    on conflict(session_id,user_id) do update set role='host',revision=dw_memberships.revision+1
      where dw_memberships.revoked_at is null and dw_memberships.role<>'host'
    returning session_id,revision`,[userId,oldHostId])).rows;
  for(const member of memberships)await tx.query('select private.dw_event($1,$2,$3,$4,$5)',[
    member.session_id,randomUUID(),member.revision===1?'member.joined':'member.role_changed',userId,member.revision]);
}
export async function identify(runtime,input) {
  fields(input,['email','fullName']);
  if(typeof input.email!=='string' || input.email.length>512)throw new HttpError(400,'INVALID_INPUT');
  const email=normalizeEmail(input.email);
  if(email.length>254 || !EMAIL.test(email))throw new HttpError(400,'INVALID_INPUT');
  return runtime.db.transaction(async tx=>{
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['offline-email:'+email]);
    const isTeacher=email===TEACHER_EMAIL;
    const teacher=isTeacher?await resolveTeacherAccount(tx,email):null;
    let row=isTeacher?teacher.row:(await tx.query(`select u.*,a.kind,(${ACCOUNT_SAFE}) as participant_safe
      from offline.email_identities e join offline.accounts a on a.user_id=e.user_id
      join auth.users u on u.id=e.user_id where e.normalized_email=$1`,[email])).rows[0];
    if(!isTeacher && row && (row.kind!=='participant'||!row.participant_safe))throw new HttpError(403,'PARTICIPANT_IDENTITY_UNAVAILABLE');
    if(!row && !isTeacher) {
      // Before 0.8 devices with the same claimed email could have separate accounts.
      // Select the earliest eligible identity without moving/deleting any historical work.
      // Keep exactly one canonicalizer: PostgreSQL lower and JS Unicode lower differ for e.g. İ/Σ.
      const candidates=(await tx.query(`select u.id,u.email from auth.users u join offline.accounts a on a.user_id=u.id
        where a.kind='participant' and ${ACCOUNT_SAFE}
          and not exists(select 1 from offline.email_identities e where e.user_id=u.id)
        order by a.created_at,u.created_at,u.id`)).rows;
      const legacy=candidates.find(candidate=>typeof candidate.email==='string'&&normalizeEmail(candidate.email)===email);
      if(legacy)row=(await tx.query('select * from auth.users where id=$1',[legacy.id])).rows[0];
    }
    const profile=row?(await tx.query('select full_name,revision from public.dw_profiles where user_id=$1',[row.id])).rows[0]:null;
    const hasSavedName=typeof profile?.full_name==='string' && profile.full_name.trim().length>0;
    let fullName=hasSavedName?profile.full_name:null;
    if(!hasSavedName) {
      // A first email lookup is read-only: there is no abandoned actor or transport session.
      if(input.fullName===undefined || input.fullName===null)return {profileRequired:true,email};
      if(typeof input.fullName!=='string' || input.fullName.length>512)throw new HttpError(400,'INVALID_INPUT');
      fullName=input.fullName.normalize('NFC').trim().replace(/\s+/gu,' ');
      if(!fullName || fullName.length>200 || /[\u0000-\u001f\u007f]/u.test(fullName))
        throw new HttpError(400,'INVALID_INPUT');
    }
    // A known name is owned by dw_save_profile. Login never overwrites it, even if an older
    // client sends an empty, stale or otherwise invalid fullName alongside the email.
    if(teacher)row=await completeTeacherAccount(tx,email,fullName,teacher);
    else {
      if(!row) {
        row=(await tx.query(`insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data)
          values($1,$2,$3::jsonb,'{"offline":true,"provider":"offline","email_verified":false}'::jsonb) returning *`,
          [randomUUID(),email,JSON.stringify({full_name:fullName,claimed_email:email,email_verified:false})])).rows[0];
        await tx.query("insert into offline.accounts(user_id,kind) values($1,'participant')",[row.id]);
      }
      await tx.query(`insert into offline.email_identities(normalized_email,user_id) values($1,$2)
        on conflict(normalized_email) do nothing`,[email,row.id]);
    }
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [row.id,JSON.stringify({sub:row.id,role:'authenticated',app_metadata:{offline:true,provider:'offline'}})]);
    if(!hasSavedName) {
      // Reuse the normal revision/event path so account attribution and session cursors stay coherent.
      await tx.query('select private.dw_save_profile($1,$2,$3)',[randomUUID(),profile?.revision??0,fullName]);
    }
    if(teacher)await inheritLocalCabinet(tx,row.id,teacher.oldHostId);
    row=(await tx.query(`update auth.users set email=$2,raw_user_meta_data=raw_user_meta_data||$3::jsonb,
      updated_at=now() where id=$1 returning *`,[row.id,email,JSON.stringify({full_name:fullName,claimed_email:email,email_verified:false})])).rows[0];
    await tx.query('update offline.email_identities set last_identified_at=now() where normalized_email=$1',[email]);
    return {session:await mint(tx,runtime.operator,userDto(row))};
  });
}
export async function hostLogin(runtime,input) {
  fields(input,['hostKey','fullName']);
  if(!sameSecret(input.hostKey,runtime.operator.hostKey))throw new HttpError(403,'HOST_KEY_INVALID');
  if(input.fullName!==undefined && (typeof input.fullName!=='string' || input.fullName.trim().length<1 || input.fullName.trim().length>200))
    throw new HttpError(400,'INVALID_INPUT');
  return runtime.db.transaction(async tx=>{
    let row=(await tx.query("select u.* from auth.users u join offline.accounts a on a.user_id=u.id where a.kind='host'")).rows[0];
    const fullName=input.fullName?.trim()??'Преподаватель';
    if(!row){
      const id=randomUUID();
      row=(await tx.query(`insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data)
        values($1,$2,$3::jsonb,'{"offline":true,"provider":"offline","email_verified":false}'::jsonb) returning *`,
        [id,`host@${runtime.operator.instanceId}.local`,JSON.stringify({full_name:fullName,email_verified:false})])).rows[0];
      await tx.query("insert into offline.accounts(user_id,kind) values($1,'host')",[id]);
      await tx.query('insert into private.facilitators(user_id) values($1)',[id]);
    }
    const profile=(await tx.query('select full_name from public.dw_profiles where user_id=$1',[row.id])).rows[0];
    if(!profile) {
      await tx.query('insert into public.dw_profiles(user_id,full_name) values($1,$2)',[row.id,fullName]);
      row=(await tx.query(`update auth.users set raw_user_meta_data=raw_user_meta_data||$2::jsonb,
        updated_at=now() where id=$1 returning *`,[row.id,JSON.stringify({full_name:fullName})])).rows[0];
    }
    return {session:await mint(tx,runtime.operator,userDto(row))};
  });
}
export async function refresh(runtime,input) {
  fields(input,['refresh_token']);
  if(!TOKEN.test(input.refresh_token??''))throw new HttpError(400,'REFRESH_TOKEN_INVALID');
  return runtime.db.transaction(async tx=>{
    const oldHash=sha256(input.refresh_token);
    await tx.query('delete from offline.refresh_receipts where expires_at<=now()');
    const {rows}=await tx.query(`select s.id as session_id,s.access_hash as old_access_hash,s.access_expires_at as old_access_expires_at,u.* from offline.sessions s join auth.users u on u.id=s.user_id
      where ${ACCOUNT_SAFE} and s.refresh_hash=$1 and s.revoked_at is null and s.refresh_expires_at>now() for update of s`,[oldHash]);
    if(!rows.length) {
      const receipt=(await tx.query(`select r.response_ciphertext,s.access_hash,u.* from offline.refresh_receipts r
        join offline.sessions s on s.id=r.session_id join auth.users u on u.id=s.user_id
        where ${ACCOUNT_SAFE} and r.old_refresh_hash=$1 and r.expires_at>now() and r.new_refresh_hash=s.refresh_hash
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
