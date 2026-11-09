import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createTestDatabase } from './harness.mjs';
const op=()=>randomUUID();
const token=()=>randomBytes(32).toString('hex');
const fail=(promise,code)=>assert.rejects(promise,e=>e.code==='P0001'&&e.message===code);
async function anon(db,sql,args=[]){return db.transaction(async tx=>{
 await tx.exec('set local role anon');
 await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
 return (await tx.query(sql,args)).rows[0]?.result;
});}
const identify=async(db,email,name)=> (await anon(db,'select public.dw_identify($1,$2) result',[email,name])).session;
const rpc=(db,s,method,args={})=>anon(db,'select public.dw_entry_rpc($1,$2,$3::jsonb) result',[s.access_token,method,JSON.stringify(args)]);
const enter=async(db,s)=> (await rpc(db,s,'dw_enter_workspace',{p_operation_id:op()})).session.id;
const entry=(db,s,id)=>rpc(db,s,'dw_workshop_survey',{p_session_id:id});
const answers={expectedRevision:0,questionVersion:1,perspective:'self',intention12m:null,intention36m:null,answerBarrier:'Недостаточно доступного жилья',answerSupport:'Постоянная работа рядом с домом',priorityChange:null,priorityConditionId:null,horizon:null,conditionalChange:null,additionalConditions:null,consentEducational:true,consentResearch:false,consentQuote:false,adultConfirmed:true};
const save=(db,e,secret)=>anon(db,'select public.dw_survey_save_response($1,$2,$3,$4,$5::jsonb) result',[op(),e.survey.id,e.invitationToken,secret,JSON.stringify(answers)]);

describe('shared opening survey',()=>{
 it('is ready to answer for the first participant without a teacher, and all entrants receive one stable form',async()=>{
  const db=await createTestDatabase({seedCorpus:false});try{
   const a=await identify(db,'survey-first@example.test','Первый Участник'),id=await enter(db,a);
   const one=await entry(db,a,id);
   assert.equal(one.survey.status,'open');assert.equal(one.survey.canRespond,true);
   const expectedRetention=(await db.query("select ((now() at time zone 'UTC')::date+365)::text as retention_date")).rows[0].retention_date;
   assert.equal(one.survey.retentionUntil,expectedRetention);
   assert.match(one.invitationToken,/^[a-f0-9]{64}$/);assert.equal(one.survey.responseCount,null);
   const b=await identify(db,'survey-second@example.test','Второй Участник');assert.equal(await enter(db,b),id);
   const two=await entry(db,b,id);assert.deepEqual(two,one);
   const counts=(await db.query('select count(*)::int n from research.surveys')).rows[0];assert.equal(counts.n,1);
   const membership=(await db.query('select role from public.dw_memberships where user_id=$1',[a.user.id])).rows[0];assert.equal(membership.role,'participant');
   const outsider=await identify(db,'survey-outsider@example.test','Другой Участник');await fail(entry(db,outsider,id),'FORBIDDEN');
  }finally{await db.close();}
 });
 it('keeps anonymous answers out of shared metadata, events and participant views, and preserves withdrawal',async()=>{
  const db=await createTestDatabase({seedCorpus:false});try{
   const a=await identify(db,'survey-privacy@example.test','Участник Опроса'),id=await enter(db,a),e=await entry(db,a,id),secret=token();
   const eventsBefore=(await db.query('select count(*)::int n from public.dw_barrier_events')).rows[0].n;
   const saved=await save(db,e,secret);assert.equal(saved.status,'submitted');
   const same=await entry(db,a,id);assert.equal(same.survey.responseCount,null);assert.equal(JSON.stringify(same).includes(answers.answerBarrier),false);assert.equal(JSON.stringify(same).includes(secret),false);
   const columns=(await db.query("select column_name from information_schema.columns where table_schema='research' and table_name='responses'")).rows.map(x=>x.column_name);assert.equal(columns.some(x=>/actor|user|profile|email/.test(x)),false);
   assert.equal((await db.query('select count(*)::int n from public.dw_barrier_events')).rows[0].n,eventsBefore);
   await fail(rpc(db,a,'dw_survey_host_state',{p_session_id:id,p_survey_id:e.survey.id}),'FORBIDDEN');
   const receipt=await anon(db,'select public.dw_survey_withdraw_response($1,$2,$3,$4) result',[op(),e.survey.id,secret,saved.revision]);assert.equal(receipt.status,'withdrawn');assert.equal(receipt.answerBarrier,null);
   const row=(await db.query('select answers,status from research.responses where survey_id=$1',[e.survey.id])).rows[0];assert.deepEqual(row,{answers:null,status:'withdrawn'});
  }finally{await db.close();}
 });
 it('does not revive a closed survey, extend retention or overwrite answers while resolving shared entry',async()=>{
  const db=await createTestDatabase({seedCorpus:false});try{
   const a=await identify(db,'survey-closed@example.test','Участник Опроса'),id=await enter(db,a),e=await entry(db,a,id),secret=token();await save(db,e,secret);
   await db.query("update research.surveys set status='closed',revision=revision+1 where id=$1",[e.survey.id]);
   const closed=await entry(db,a,id);assert.equal(closed.survey.status,'closed');assert.equal(closed.invitationToken,null);assert.equal(closed.survey.canRespond,false);assert.equal(closed.survey.retentionUntil,e.survey.retentionUntil);
   const row=(await db.query('select answers,status from research.responses where survey_id=$1',[e.survey.id])).rows[0];assert.equal(row.status,'submitted');assert.equal(row.answers.answerBarrier,answers.answerBarrier);
  }finally{await db.close();}
 });
 it('preserves an existing shorter agreement and reports expiry without blocking workshop membership',async()=>{
  const db=await createTestDatabase({seedCorpus:false});try{
   const a=await identify(db,'survey-expired@example.test','Участник Опроса'),id=await enter(db,a),e=await entry(db,a,id);
   const shorter=(await db.query("update research.surveys set retention_until=(now() at time zone 'UTC')::date+30 where id=$1 returning retention_until::text as retention_date",[e.survey.id])).rows[0].retention_date;
   const active=await entry(db,a,id);assert.equal(active.survey.retentionUntil,shorter);assert.equal(active.survey.canRespond,true);
   const expiredDate=(await db.query("update research.surveys set retention_until=(now() at time zone 'UTC')::date-1 where id=$1 returning retention_until::text as retention_date",[e.survey.id])).rows[0].retention_date;
   const expired=await entry(db,a,id);assert.equal(expired.survey.retentionUntil,expiredDate);assert.equal(expired.survey.expired,true);assert.equal(expired.survey.canRespond,false);assert.equal(expired.invitationToken,null);
   assert.equal(await enter(db,a),id);
  }finally{await db.close();}
 });
});
