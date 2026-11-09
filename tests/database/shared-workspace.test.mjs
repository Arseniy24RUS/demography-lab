import {it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createTestDatabase,projectRoot,loadMordovia,seedCanonicalDocument} from './harness.mjs';
import {realPracticeBundle} from '../collaboration/workshop-test-support.mjs';

const MIGRATION='20261109163142_stage9_shared_workspace.sql';
const op=()=>randomUUID();
const failure=(promise,code)=>assert.rejects(promise,e=>e.code==='P0001'&&e.message===code);
async function anon(db,sql,args=[]){return db.transaction(async tx=>{
  await tx.exec('set local role anon');
  await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
  return (await tx.query(sql,args)).rows[0]?.result;
});}
const identify=(db,email=op()+'@example.test',name='Технический участник')=>anon(db,'select public.dw_identify($1,$2) result',[email,name]).then(x=>x.session);
const rpc=(db,s,method,args={})=>anon(db,'select public.dw_entry_rpc($1,$2,$3::jsonb) result',[s.access_token,method,JSON.stringify(args)]);
const enter=(db,s,operation=op())=>rpc(db,s,'dw_enter_workspace',{p_operation_id:operation});
const create=(db,s,title='Сохранённая работа')=>rpc(db,s,'dw_create_session',{p_operation_id:op(),p_title:title,p_scope:'municipality',p_region_id:'respublika-mordoviia'});
const change=(db,s,room,patch)=>rpc(db,s,'dw_update_session',{p_operation_id:op(),p_session_id:room.session.id,p_expected_revision:room.session.revision,p_patch:patch});
const configure=(db,s,room,input)=>rpc(db,s,'dw_configure_workspace',{p_operation_id:op(),p_session_id:room.session.id,p_expected_revision:room.session.revision,p_input:input});
async function family(db,s,sid){
 const bundle=await realPracticeBundle('mordovia-kindergarten-compensation');
 const published=await rpc(db,s,'dw_publish_submission',{p_operation_id:op(),p_session_id:sid,p_local_key:bundle.practice.id,p_expected_revision:null,p_bundle:bundle});
 const board=await rpc(db,s,'dw_workshop_snapshot',{p_session_id:sid});
 return rpc(db,s,'dw_save_family',{p_operation_id:op(),p_session_id:sid,p_family_id:null,p_expected_board_revision:board.boardRevision,p_title:'Поддержка дошкольного воспитания',p_mechanism:'Возмещение части родительских расходов',p_rationale:'Обсуждение механизма поддержки',p_submission_ids:[published.submissions[0].id]});
}
async function priorDatabase(){
 const db=new PGlite();
 try{
  await db.exec(await readFile(resolve(projectRoot,'tests/database/bootstrap.sql'),'utf8'));
  const dir=resolve(projectRoot,'supabase/migrations');
  for(const f of (await readdir(dir)).filter(x=>x.endsWith('.sql')&&x<MIGRATION).sort())await db.exec(await readFile(resolve(dir,f),'utf8'));
  await seedCanonicalDocument(db,await loadMordovia());
  return db;
 }catch(error){await db.close();throw error;}
}

it('the first ordinary participant creates one shared workspace without receiving teacher powers; later and repeated entrants share it',async()=>{
 const db=await createTestDatabase();
 try{
  const a=await identify(db),b=await identify(db);
  const entered=await Promise.all([enter(db,a),enter(db,b),enter(db,a)]);
  const sid=entered[0].session.id;
  assert(entered.every(x=>x.session.id===sid&&x.session.role==='participant'));
  assert.equal((await rpc(db,a,'dw_bootstrap')).canCreateSession,false);
  assert.equal((await db.query('select count(*) n from private.dw_current_workspace')).rows[0].n,1);
  assert.equal((await db.query('select count(*) n from public.dw_sessions')).rows[0].n,1);
  assert.equal((await db.query('select count(*) n from public.dw_memberships')).rows[0].n,2);
  assert.equal((await db.query('select count(*) n from private.facilitators')).rows[0].n,0);
  assert.equal(entered[0].session.regionId,'respublika-mordoviia');
  await failure(configure(db,a,entered[0],{title:'Нельзя менять настройки',scope:'federal',regionId:null}),'FORBIDDEN');
  const teacher=await identify(db,'omnistat@yandex.ru','Преподаватель'),room=await enter(db,teacher);
  assert.equal(room.session.id,sid);assert.equal(room.session.role,'host');
  assert.equal(room.members.find(m=>m.userId===a.user.id).role,'participant');
  const operation=op();await enter(db,a,operation);const before=(await enter(db,a)).cursor;
  assert.equal((await enter(db,a,operation)).cursor,before);
  for(const method of ['dw_projector_snapshot','dw_workshop_projector_snapshot','dw_workshop_projector_updates','dw_barriers_projector_snapshot','dw_roadmaps_projector_snapshot','dw_workspace_votes_projection']){
   const result=await rpc(db,a,method,{p_session_id:sid});
   assert.equal(typeof result,'object',method);
   assert(!JSON.stringify(result).includes(a.user.id),method+' does not expose participant ID');
  }
  await assert.rejects(anon(db,'select public.dw_enter_workspace($1) result',[op()]),e=>e.code==='42501');
  assert.equal((await db.query("select has_table_privilege('authenticated','private.dw_current_workspace','SELECT') allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});

it('legacy close, join, observer and revoke controls cannot block the shared workspace, and discussion does not block source work',async()=>{
 const db=await createTestDatabase();
 try{
  const teacher=await identify(db,'omnistat@yandex.ru','Преподаватель'),a=await identify(db);
  let room=await enter(db,teacher);await enter(db,a);
  room=await change(db,teacher,room,{status:'closed',joinOpen:false,phase:'discussion'});
  assert.equal(room.session.status,'open');assert.equal(room.session.joinOpen,true);
  const member=room.members.find(x=>x.userId===a.user.id);
  await failure(rpc(db,teacher,'dw_set_member_role',{p_operation_id:op(),p_session_id:room.session.id,p_member_id:a.user.id,p_expected_revision:member.revision,p_role:'observer'}),'FORBIDDEN');
  await failure(rpc(db,teacher,'dw_revoke_member',{p_operation_id:op(),p_session_id:room.session.id,p_member_id:a.user.id,p_expected_revision:member.revision}),'FORBIDDEN');
  const board=await family(db,a,room.session.id);
  assert.equal(board.families.length,1);
  await failure(rpc(db,teacher,'dw_open_voting_round',{p_operation_id:op(),p_session_id:room.session.id,p_title:'Устаревшее управление раундом',p_results_visibility:'after_close',p_expected_board_revision:board.boardRevision,p_settings:{}}),'WORKSPACE_LIVE_VOTING');
  assert.equal((await db.query('select count(*) n from private.dw_voting_rounds')).rows[0].n,0);
  const work=await rpc(db,a,'dw_region_work',{p_operation_id:op(),p_session_id:room.session.id,p_region_id:'respublika-mordoviia',p_action:'claim',p_expected_revision:0,p_note:''});
  assert.equal(work.regionWork[0].status,'in_progress');
  assert.equal((await enter(db,a)).session.role,'participant');
 }finally{await db.close();}
});

it('upgrades a populated prior database without reviving a closed rehearsal or rewriting its records',async()=>{
 const db=await priorDatabase();
 try{
  const teacher=await identify(db,'omnistat@yandex.ru','Преподаватель'),old=await create(db,teacher);
  const oldBoard=await family(db,teacher,old.session.id);
  const discussing=await change(db,teacher,old,{phase:'discussion'});
  const round=await rpc(db,teacher,'dw_open_voting_round',{p_operation_id:op(),p_session_id:old.session.id,p_title:'Историческая оценка',p_results_visibility:'after_close',p_expected_board_revision:oldBoard.boardRevision,p_settings:{}});
  await rpc(db,teacher,'dw_cast_vote',{p_operation_id:op(),p_session_id:old.session.id,p_round_id:round.round.id,p_family_id:oldBoard.families[0].id,p_value:1,p_expected_revision:0});
  await rpc(db,teacher,'dw_close_voting_round',{p_operation_id:op(),p_session_id:old.session.id,p_round_id:round.round.id,p_expected_revision:round.round.revision});
  const frozen=await rpc(db,teacher,'dw_workshop_round_snapshot',{p_session_id:old.session.id,p_round_id:round.round.id});
  await change(db,teacher,discussing,{status:'closed',joinOpen:false});
  const oldData=await db.query('select row_to_json(s)::text as row from public.dw_sessions s where id=$1',[old.session.id]);
  const sourceData=await db.query('select row_to_json(s)::text as row from public.dw_submissions s order by id');
  await db.exec(await readFile(resolve(projectRoot,'supabase/migrations',MIGRATION),'utf8'));
  const a=await identify(db),room=await enter(db,a);
  assert.notEqual(room.session.id,old.session.id);
  assert.equal(room.session.role,'participant');
  assert.deepEqual(await db.query('select row_to_json(s)::text as row from public.dw_sessions s where id=$1',[old.session.id]),oldData);
  assert.deepEqual(await db.query('select row_to_json(s)::text as row from public.dw_submissions s order by id'),sourceData);
  assert.deepEqual(await rpc(db,teacher,'dw_workshop_round_snapshot',{p_session_id:old.session.id,p_round_id:round.round.id}),frozen);
  assert.equal(frozen.eligibleCount,1);assert.equal(frozen.families[0].myVote,1);
  await failure(rpc(db,a,'dw_session_snapshot',{p_session_id:old.session.id}),'FORBIDDEN');
  await failure(rpc(db,a,'dw_projector_snapshot',{p_session_id:old.session.id}),'FORBIDDEN');
 }finally{await db.close();}
});

it('adopts the latest suitable active session, keeps configuration revisioned, and supports regional and federal contexts',async()=>{
 const db=await createTestDatabase();
 try{
  const teacher=await identify(db,'omnistat@yandex.ru','Преподаватель'),old=await create(db,teacher);
  await change(db,teacher,old,{joinOpen:false});
  const a=await identify(db),room=await enter(db,a),hostRoom=await enter(db,teacher);
  assert.equal(room.session.id,old.session.id);assert.equal(room.session.joinOpen,true);
  const configured=await configure(db,teacher,hostRoom,{title:'Общая федеральная мастерская',scope:'federal',regionId:null});
  assert.equal(configured.session.scope,'federal');assert.equal(configured.session.regionId,null);
  assert.equal((await rpc(db,teacher,'dw_roadmaps_index',{p_session_id:room.session.id})).configuration.roomLevel,'federal');
  await failure(configure(db,teacher,hostRoom,{title:'Несвежий вариант',scope:'region',regionId:'respublika-mordoviia'}),'REVISION_CONFLICT');
  await failure(configure(db,teacher,configured,{title:'Неизвестный регион',scope:'region',regionId:'invented-region'}),'REGION_UNAVAILABLE');
  const regional=await configure(db,teacher,configured,{title:'Региональная мастерская',scope:'region',regionId:'respublika-mordoviia'});
  assert.equal(regional.session.scope,'region');assert.equal(regional.session.regionId,'respublika-mordoviia');
  assert.equal((await enter(db,a)).session.title,'Региональная мастерская');
 }finally{await db.close();}
});

it('late entrants can like/dislike the live board; source changes require a new assessment; repeats and conflicts are explicit',async()=>{
 const db=await createTestDatabase();
 try{
  const a=await identify(db),room=await enter(db,a),sid=room.session.id;
  let board=await family(db,a,sid),f=board.families[0];
  let votes=await rpc(db,a,'dw_workspace_votes',{p_session_id:sid}),row=votes.families[0];
  assert.equal(row.title,f.title);assert.equal(row.myVote,null);assert.equal(votes.participantCount,1);
  const input={p_operation_id:op(),p_session_id:sid,p_family_id:f.id,p_value:1,p_expected_revision:0,p_expected_fingerprint:row.fingerprint};
  votes=await rpc(db,a,'dw_workspace_vote',input);assert.equal(votes.families[0].support,1);assert.equal(votes.families[0].myVoteRevision,1);
  const replay=await rpc(db,a,'dw_workspace_vote',input);assert.equal(replay.families[0].myVoteRevision,1);
  await failure(rpc(db,a,'dw_workspace_vote',{...input,p_value:-1}),'IDEMPOTENCY_CONFLICT');
  const beforeJoinCursor=replay.cursor;
  const b=await identify(db);await enter(db,b);
  votes=await rpc(db,b,'dw_workspace_votes',{p_session_id:sid});assert.equal(votes.participantCount,2);
  assert(votes.cursor>beforeJoinCursor,'membership changes invalidate the live vote cursor');
  const joinedCursor=votes.cursor;await enter(db,b);
  assert.equal((await rpc(db,b,'dw_workspace_votes',{p_session_id:sid})).cursor,joinedCursor,'repeat entry does not invalidate an unchanged board');
  assert.equal(votes.families[0].myVote,null);assert.equal(votes.families[0].unanswered,1);
  const opposing=await rpc(db,b,'dw_workspace_vote',{...input,p_operation_id:op(),p_value:-1});
  assert.equal(opposing.families[0].oppose,1);assert.equal(opposing.families[0].score,0);
  await failure(rpc(db,b,'dw_workspace_vote',{...input,p_operation_id:op(),p_value:1}),'REVISION_CONFLICT');
  const projection=await rpc(db,b,'dw_workspace_votes_projection',{p_session_id:sid});
  assert.equal(projection.families[0].support,1);assert.equal(projection.families[0].oppose,1);
  for(const key of ['myVote','myVoteRevision','needsReview','actorId','userId'])assert.equal(key in projection.families[0],false);
  const current=await rpc(db,a,'dw_workshop_snapshot',{p_session_id:sid});
  board=await rpc(db,a,'dw_save_family',{p_operation_id:op(),p_session_id:sid,p_family_id:f.id,p_expected_board_revision:current.boardRevision,p_title:'Уточнённый механизм поддержки',p_mechanism:f.mechanism,p_rationale:f.rationale,p_submission_ids:f.submissionIds});
  votes=await rpc(db,a,'dw_workspace_votes',{p_session_id:sid});row=votes.families[0];
  assert.equal(row.support,0);assert.equal(row.oppose,0);assert.equal(row.myVote,null);assert.equal(row.needsReview,true);assert.equal(row.myVoteRevision,1);
  await failure(rpc(db,a,'dw_workspace_vote',{...input,p_operation_id:op(),p_expected_revision:1}),'FAMILY_CHANGED');
  votes=await rpc(db,a,'dw_workspace_vote',{...input,p_operation_id:op(),p_expected_revision:1,p_expected_fingerprint:row.fingerprint});
  assert.equal(votes.families[0].support,1);assert.equal(votes.families[0].needsReview,false);
  votes=await rpc(db,a,'dw_workspace_vote',{...input,p_operation_id:op(),p_expected_revision:2,p_expected_fingerprint:row.fingerprint,p_value:null});
  assert.equal(votes.families[0].support,0);assert.equal(votes.families[0].myVoteRevision,3);assert.equal(votes.families[0].unanswered,2);
  await failure(rpc(db,a,'dw_workspace_vote',{...input,p_operation_id:op(),p_expected_revision:3,p_expected_fingerprint:row.fingerprint,p_value:0}),'INVALID_INPUT');
  assert.equal((await db.query('select count(*) n from private.dw_voting_rounds')).rows[0].n,0);
 }finally{await db.close();}
});
