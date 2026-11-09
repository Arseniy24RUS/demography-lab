import {after,before,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createTestDatabase,projectRoot,asUser} from './harness.mjs';

let db;
const id=()=>randomUUID();
const MIGRATION='20261109143041_stage8_personal_workspace.sql';
const fail=(promise,code)=>assert.rejects(promise,e=>e.code==='P0001'&&e.message===code);
const denied=promise=>assert.rejects(promise,e=>e.code==='42501');
before(async()=>{db=await createTestDatabase({seedCorpus:false});});
after(async()=>{await db?.close();});
async function anon(database,sql,args=[]){return database.transaction(async tx=>{
  await tx.exec('set local role anon');
  await tx.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{\"role\":\"anon\"}',true)");
  return (await tx.query(sql,args)).rows[0]?.result;
});}
const identify=async(database=db,email=id()+'@example.test')=>(await anon(database,"select public.dw_identify($1,'Технический участник') result",[email])).session;
const rpc=(session,method,args={},database=db)=>anon(database,'select public.dw_entry_rpc($1,$2,$3::jsonb) result',[session.access_token,method,JSON.stringify(args)]);
const read=(s,known=-1,database=db)=>rpc(s,'dw_workspace_read',{p_known_revision:known},database);
const commit=(s,state,revision=0,operation=id(),database=db)=>rpc(s,'dw_workspace_commit',{p_operation_id:operation,p_expected_revision:revision,p_state:state},database);
const empty=()=>({schemaVersion:1,id:'personal-workspace',title:'Моя рабочая тетрадь',profile:null,
 sourceReferences:[],annotations:[],practiceProposals:[],linkDecisions:[],customCards:[],readingTasks:[],
 preferences:{selectedRegionId:null,selectedSourceEditionId:null,selectedPracticeId:null,activePanel:'documents',readerFontScale:1}});
function draft(){
  const date='2026-11-09T12:00:00.000Z',state=empty();
  state.sourceReferences=[{sourceId:'document-1',editionId:'edition-1',title:'Тестовый источник',normalizationVersion:'unicode-nfc-lf-v1',sha256:'a'.repeat(64),sourceUrl:'https://example.test/programme.pdf',regionId:'ru-13'}];
  state.annotations=[{id:'annotation-1',note:'Сопоставить условия поддержки',createdAt:date,updatedAt:date,
    anchor:{id:'anchor-1',documentId:'document-1',versionId:'edition-1',normalizationVersion:'unicode-nfc-lf-v1',spans:[
      {blockId:'block-1',start:4,end:10,exact:'семья👪',prefix:'Для ',suffix:''},
      {blockId:'block-2',start:0,end:7,exact:'пособие',prefix:'',suffix:'.'}]}}];
  state.practiceProposals=[{id:'proposal-1',title:'Поддержка семьи',summary:'Кандидат для обсуждения',annotationIds:['annotation-1'],createdAt:date,updatedAt:date}];
  state.linkDecisions=[{id:'decision-1',annotationId:'annotation-1',practiceId:'catalog-1',status:'candidate',rationale:'Проверить применимость',decidedAt:date,origin:'local',fieldEvidence:[]}];
  state.customCards=[{id:'custom-1',familyId:'family-1',regionId:'ru-13',title:'Моя карточка',mechanism:'Компенсация расходов',eligibility:'Семьи',amount:'Размер уточняется',conditions:['Условия проверяются'],occurrenceIds:['annotation-1'],createdAt:date,updatedAt:date}];
  state.readingTasks=[{id:'reading-1',sourceEditionId:'edition-1',status:'fragment-reviewed',reviewedBlockIds:['block-1','block-2'],annotationIds:['annotation-1'],note:'Изучены отдельные фрагменты',updatedAt:date}];
  return state;
}

it('persists the complete private notebook, including multiblock quotations and author cards, across email-only entry on another device',async()=>{
  const actor=await identify(),state=draft();
  assert.deepEqual(await read(actor),{snapshot:null});
  const saved=await commit(actor,state);
  assert.equal(saved.kind,'committed');assert.equal(saved.revision,1);assert.equal(saved.replayed,false);
  assert.deepEqual(saved.snapshot.state,state);
  assert.match(saved.snapshot.updatedAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  state.annotations[0].note='Изменено только в памяти клиента';
  assert.notEqual((await read(actor)).snapshot.state.annotations[0].note,state.annotations[0].note);
  const next=(await anon(db,'select public.dw_identify($1) result',[actor.user.email])).session;
  assert.equal(next.user.id,actor.user.id);
  assert.deepEqual(await read(next),{snapshot:saved.snapshot});
  assert.deepEqual(await read(next,1),{unchanged:true,revision:1});
  assert.deepEqual(await read(next,0),{snapshot:saved.snapshot});
  assert.equal(JSON.stringify(await read(next)).includes(actor.user.email),false);
  assert.equal(JSON.stringify(await read(next)).includes(actor.user.id),false);
});

it('detects stale writes without overwriting and replays a committed operation with its original revision and the current snapshot',async()=>{
  const actor=await identify(),initial=draft(),firstId=id();
  const first=await commit(actor,initial,0,firstId);
  const next=structuredClone(initial);next.annotations[0].note='Новое сохранённое замечание';
  const second=await commit(actor,next,1);
  assert.equal(second.revision,2);
  const stale=await commit(actor,{...initial,title:'Устаревший редактор'},1);
  assert.deepEqual(stale,{kind:'conflict',expectedRevision:1,actualRevision:2,snapshot:second.snapshot});
  const replay=await commit(actor,initial,0,firstId);
  assert.deepEqual(replay,{kind:'committed',revision:first.revision,replayed:true,snapshot:second.snapshot});
  await fail(commit(actor,{...initial,title:'Другие аргументы'},0,firstId),'IDEMPOTENCY_CONFLICT');
  await fail(commit(actor,initial,1,firstId),'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await read(actor),{snapshot:second.snapshot});
  assert.equal((await db.query('select count(*) n from private.dw_workspace_receipts where user_id=$1',[actor.user.id])).rows[0].n,2);
});

it('isolates actor notebooks, derives ownership on the server, and denies raw table or unauthenticated access',async()=>{
  const a=await identify(),b=await identify(),sharedOperation=id();
  const aState={...empty(),title:'Работа первого участника'},bState={...empty(),title:'Работа второго участника'};
  const savedA=await commit(a,aState,0,sharedOperation);
  assert.deepEqual(await read(b),{snapshot:null});
  const savedB=await commit(b,bState,0,sharedOperation);
  assert.deepEqual(await read(a),{snapshot:savedA.snapshot});
  assert.deepEqual(await read(b),{snapshot:savedB.snapshot});
  await fail(rpc(b,'dw_workspace_read',{p_known_revision:-1,p_user_id:a.user.id}),'INVALID_INPUT');
  await denied(anon(db,'select public.dw_workspace_read() result'));
  await denied(anon(db,'select state result from private.dw_workspaces limit 1'));
  await denied(asUser(db,a.user.id,tx=>tx.query('select state from private.dw_workspaces')));
  await denied(asUser(db,a.user.id,tx=>tx.query('select request_hash from private.dw_workspace_receipts')));
  await denied(asUser(db,a.user.id,tx=>tx.query("select private.dw_workspace_validate('{}')")));
  const grants=(await db.query(`select n.nspname,p.proname,p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('dw_workspace_read','dw_workspace_commit')`)).rows;
  assert.equal(grants.length,2);assert(grants.every(x=>!x.prosecdef&&!x.anon&&x.authenticated));
  assert((await db.query("select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and relname in ('dw_workspaces','dw_workspace_receipts')")).rows.every(x=>x.relrowsecurity));
});

it('rejects malformed or oversized notebooks atomically, including copied profile data and invalid revision bounds',async()=>{
  const actor=await identify(),state=empty(),first=await commit(actor,state);
  const malformed=[
    {...state,profile:{displayName:'Чужой профиль',email:'private@example.test'}},
    {...state,id:'another-workspace'},
    {...state,schemaVersion:2},
    {...state,ownerId:actor.user.id},
    {...state,annotations:{}},
    {...state,annotations:[{id:'same'},{id:'same'}]},
    {...state,preferences:{...state.preferences,readerFontScale:'large'}},
    {...state,preferences:{...state.preferences,readerFontScale:0}},
    {...state,preferences:{...state.preferences,activePanel:'other'}},
    {...state,sourceReferences:[{sourceId:'d',editionId:'e',title:'Источник',normalizationVersion:'v1',sha256:'wrong'}]},
  ];
  const missing=structuredClone(state);delete missing.readingTasks;malformed.push(missing);
  for(const value of malformed)await fail(commit(actor,value,1),'INVALID_INPUT');
  await fail(commit(actor,{...state,annotations:[{id:'oversized',note:'x'.repeat(5*1024*1024)}]},1),'LIMIT_EXCEEDED');
  await fail(commit(actor,{...state,annotations:Array.from({length:5001},(_,i)=>({id:'a-'+i}))},1),'LIMIT_EXCEEDED');
  for(const revision of [-1,null,9007199254740991])await fail(commit(actor,state,revision),'INVALID_INPUT');
  await fail(read(actor,-2),'INVALID_INPUT');await fail(read(actor,null),'INVALID_INPUT');
  assert.deepEqual(await read(actor),{snapshot:first.snapshot});
  assert.equal((await db.query('select count(*) n from private.dw_workspace_receipts where user_id=$1',[actor.user.id])).rows[0].n,1);
});

it('rolls back the notebook write if its durable operation receipt cannot be saved',async()=>{
  const actor=await identify();
  await db.exec(`create function private.dw_test_receipt_failure() returns trigger language plpgsql as $$
    begin raise exception 'TEST_RECEIPT_FAILURE'; end $$;
    create trigger dw_test_receipt_failure before insert on private.dw_workspace_receipts
      for each row execute function private.dw_test_receipt_failure();`);
  try{
    await assert.rejects(commit(actor,empty()),e=>e.message==='TEST_RECEIPT_FAILURE');
    assert.deepEqual(await read(actor),{snapshot:null});
    assert.equal((await db.query('select count(*) n from private.dw_workspace_receipts where user_id=$1',[actor.user.id])).rows[0].n,0);
  }finally{
    await db.exec('drop trigger dw_test_receipt_failure on private.dw_workspace_receipts; drop function private.dw_test_receipt_failure();');
  }
  assert.equal((await commit(actor,empty())).revision,1);
});

it('keeps a saved notebook after logout but rejects revoked sessions and disabled actors',async()=>{
  const actor=await identify(),saved=await commit(actor,draft());
  await anon(db,'select public.dw_entry_logout($1) result',[actor.access_token]);
  await fail(read(actor),'AUTH_REQUIRED');
  const next=(await anon(db,'select public.dw_identify($1) result',[actor.user.email])).session;
  assert.deepEqual(await read(next),{snapshot:saved.snapshot});
  await db.query('update private.dw_actors set disabled_at=now() where id=$1',[next.user.id]);
  await fail(read(next),'AUTH_REQUIRED');
  await fail(commit(next,empty(),1),'AUTH_REQUIRED');
  assert.deepEqual((await db.query('select state from private.dw_workspaces where user_id=$1',[next.user.id])).rows[0].state,saved.snapshot.state);
});

it('adds private persistence to a populated prior schema without rewriting profiles, shared sessions or memberships',async()=>{
  const old=new PGlite();
  try{
    await old.exec(await readFile(resolve(projectRoot,'tests/database/bootstrap.sql'),'utf8'));
    const dir=resolve(projectRoot,'supabase/migrations');
    for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')&&x<MIGRATION).sort())await old.exec(await readFile(resolve(dir,file),'utf8'));
    const teacher=await identify(old,'omnistat@yandex.ru');
    const lesson=await rpc(teacher,'dw_create_session',{p_operation_id:id(),p_title:'Существующее занятие',p_scope:'federal',p_region_id:null},old);
    const before=(await old.query('select row_to_json(s)::text row from public.dw_sessions s')).rows;
    const members=(await old.query('select row_to_json(m)::text row from public.dw_memberships m')).rows;
    const profiles=(await old.query('select row_to_json(p)::text row from public.dw_profiles p')).rows;
    await old.exec(await readFile(resolve(dir,MIGRATION),'utf8'));
    assert.deepEqual((await old.query('select row_to_json(s)::text row from public.dw_sessions s')).rows,before);
    assert.deepEqual((await old.query('select row_to_json(m)::text row from public.dw_memberships m')).rows,members);
    assert.deepEqual((await old.query('select row_to_json(p)::text row from public.dw_profiles p')).rows,profiles);
    assert.deepEqual(await read(teacher,-1,old),{snapshot:null});
    assert.equal((await commit(teacher,draft(),0,id(),old)).revision,1);
    assert.equal((await rpc(teacher,'dw_bootstrap',{},old)).sessions[0].id,lesson.session.id);
  }finally{await old.close();}
});
