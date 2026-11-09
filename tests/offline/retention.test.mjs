import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { openRuntime, backupRuntime } from '../../scripts/offline/storage.mjs';
import { hostLogin, authenticate } from '../../scripts/offline/auth.mjs';
import { invokeRpc } from '../../scripts/offline/rpc.mjs';

process.env.NODE_ENV='test';
it('purges expired raw answers on startup and before backup while preserving withdrawal tombstones',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dw-offline-retention-'));
  const seed=async()=>({fixture:true});let runtime;
  try {
    runtime=await openRuntime({dataDir:dir,testSeed:seed});
    const session=(await runtime.enqueue(()=>hostLogin(runtime,{hostKey:runtime.operator.hostKey,fullName:'Retention test host'}))).session;
    const identity=await runtime.enqueue(()=>authenticate(runtime,session.access_token));
    const rpc=(name,args={},anon=false)=>runtime.enqueue(()=>invokeRpc(runtime.db,runtime.catalogue,name,args,anon?null:identity,anon));
    const lesson=(await rpc('dw_create_session',{p_operation_id:randomUUID(),p_title:'Retention check',p_scope:'federal',p_region_id:null})).session;
    const input={expectedRevision:0,questionVersion:1,perspective:'self',intention12m:null,intention36m:'unsure',
      answerBarrier:'Synthetic private answer retained until the chosen date.',answerSupport:null,priorityChange:null,
      priorityConditionId:null,horizon:null,conditionalChange:null,additionalConditions:null,
      consentEducational:true,consentResearch:false,consentQuote:false,adultConfirmed:true};
    async function create() {
      const invitation=randomBytes(32).toString('hex'),responseSecret=randomBytes(32).toString('hex');
      let survey=(await rpc('dw_save_survey',{p_operation_id:randomUUID(),p_session_id:lesson.id,p_input:{surveyId:null,expectedRevision:0,
        title:'Retention check',purpose:'Synthetic educational procedure for the retention test.',organizerContact:'host@example.test',
        retentionUntil:new Date(Date.now()+7*86400000).toISOString().slice(0,10),questionBarrier:'What is the principal barrier?',
        questionSupport:'Which change would help?',invitationToken:invitation}})).survey;
      survey=(await rpc('dw_manage_survey',{p_operation_id:randomUUID(),p_session_id:lesson.id,p_input:{surveyId:survey.id,
        expectedRevision:survey.revision,action:'open'}})).survey;
      const args={p_operation_id:randomUUID(),p_survey_id:survey.id,p_invitation_token:invitation,p_response_secret:responseSecret,p_input:input};
      const answer=await rpc('dw_survey_save_response',args,true);assert.equal(answer.revision,1);
      assert.equal((await runtime.db.query('select count(*)::int n from research.responses where survey_id=$1 and answers is not null',[survey.id])).rows[0].n,1);
      // Simulate passage beyond the configured UTC retention date, without changing the answer.
      await runtime.db.query("update research.surveys set retention_until=(now() at time zone 'UTC')::date-1 where id=$1",[survey.id]);
      return {survey,args,responseSecret};
    }
    async function assertCleared(e) {
      const row=(await runtime.db.query('select status,answers,revision from research.responses where survey_id=$1',[e.survey.id])).rows[0];
      assert.equal(row.answers,null);assert.equal(row.status,'withdrawn');assert.equal(row.revision,2);
      const own=await rpc('dw_survey_own_response',{p_survey_id:e.survey.id,p_response_secret:e.responseSecret},true);
      assert.equal(own.answerBarrier,null);assert.equal(own.availability,'purged');assert.equal(own.status,'withdrawn');
      const replay=await rpc('dw_survey_save_response',e.args,true);
      assert.equal(replay.answerBarrier,null);assert.equal(replay.status,'withdrawn');
      const withdrawal=await rpc('dw_survey_withdraw_response',{p_operation_id:randomUUID(),p_survey_id:e.survey.id,
        p_response_secret:e.responseSecret,p_expected_revision:own.revision},true);
      assert.equal(withdrawal.status,'withdrawn');
    }
    const first=await create();
    await runtime.close();runtime=await openRuntime({dataDir:dir,testSeed:seed});
    await assertCleared(first);
    const second=await create();
    await runtime.enqueue(()=>backupRuntime(runtime));
    await assertCleared(second);
  }finally{await runtime?.close();await rm(dir,{recursive:true,force:true});}
});
