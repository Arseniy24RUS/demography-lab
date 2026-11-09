import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime } from '../../scripts/offline/storage.mjs';
import { identify, authenticate, logout } from '../../scripts/offline/auth.mjs';
import { invokeRpc } from '../../scripts/offline/rpc.mjs';

process.env.NODE_ENV='test';
const id=()=>randomUUID();
const seed=async()=>({fixture:true});
const call=(runtime,identity,name,args={})=>runtime.enqueue(()=>invokeRpc(runtime.db,runtime.catalogue,name,args,identity,false));
const identityCounts=async runtime=>(await runtime.db.query(`select
  (select count(*)::int from auth.users) as users,
  (select count(*)::int from private.dw_actors) as actors,
  (select count(*)::int from public.dw_profiles) as profiles,
  (select count(*)::int from private.facilitators) as facilitators,
  (select count(*)::int from offline.email_identities) as emails,
  (select count(*)::int from offline.sessions) as sessions`)).rows[0];

it('asks for a name only after an unknown email, without creating an identity or session during the first step',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'dw-email-first-'));
  let runtime;
  try {
    runtime=await openRuntime({dataDir,testSeed:seed});
    const before=await identityCounts(runtime);
    for(const [input,email]of[
      ['  NEW@Example.Test  ','new@example.test'],['new@EXAMPLE.test','new@example.test'],
      [' OMNISTAT@YANDEX.RU ','omnistat@yandex.ru'],
    ])assert.deepEqual(await runtime.enqueue(()=>identify(runtime,{email:input})),{profileRequired:true,email});
    assert.deepEqual(await identityCounts(runtime),before);
    for(const fullName of['', ' ', '\u0000', 'x'.repeat(201), 42])
      await assert.rejects(runtime.enqueue(()=>identify(runtime,{email:'new@example.test',fullName})),{code:'INVALID_INPUT'});
    assert.deepEqual(await identityCounts(runtime),before);
    const completions=await Promise.all(['Первое сохранённое ФИО','Запоздалый второй ввод']
      .map(fullName=>runtime.enqueue(()=>identify(runtime,{email:'new@example.test',fullName}))));
    assert.equal(completions[0].session.user.id,completions[1].session.user.id);
    assert.equal(completions[1].session.user.user_metadata.full_name,'Первое сохранённое ФИО');
    const after=await identityCounts(runtime);
    assert.equal(after.actors,before.actors+1);assert.equal(after.profiles,before.profiles+1);
    assert.equal(after.emails,before.emails+1);assert.equal(after.sessions,before.sessions+2);

    // A historical account missing only its profile is neither replaced nor completed by a lookup.
    const legacyId=id();
    await runtime.db.query(`insert into auth.users(id,email,raw_app_meta_data)
      values($1,'missing-name@example.test','{"offline":true,"email_verified":false}')`,[legacyId]);
    await runtime.db.query("insert into offline.accounts(user_id,kind) values($1,'participant')",[legacyId]);
    await runtime.db.query("insert into offline.email_identities(normalized_email,user_id) values('missing-name@example.test',$1)",[legacyId]);
    const missingBefore=await identityCounts(runtime);
    assert.deepEqual(await runtime.enqueue(()=>identify(runtime,{email:'missing-name@example.test'})),
      {profileRequired:true,email:'missing-name@example.test'});
    assert.deepEqual(await identityCounts(runtime),missingBefore);
    const completed=await runtime.enqueue(()=>identify(runtime,{email:'missing-name@example.test',fullName:'Дополненное ФИО'}));
    assert.equal(completed.session.user.id,legacyId);
    assert.equal(completed.session.user.user_metadata.full_name,'Дополненное ФИО');
  } finally {await runtime?.close();await rm(dataDir,{recursive:true,force:true});}
});

it('returns a known participant or teacher by email alone and keeps explicit profile edits after logout and restart',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'dw-email-profile-'));
  let runtime;
  try {
    runtime=await openRuntime({dataDir,testSeed:seed});
    const saved=[];
    for(const email of['participant@example.test','omnistat@yandex.ru']) {
      const initial=await runtime.enqueue(()=>identify(runtime,{email,fullName:'Первое ФИО'}));
      const userId=initial.session.user.id;
      const identity=await runtime.enqueue(()=>authenticate(runtime,initial.session.access_token));
      const boot=await call(runtime,identity,'dw_bootstrap');
      assert.equal(boot.canCreateSession,email==='omnistat@yandex.ru');
      await call(runtime,identity,'dw_save_profile',{p_operation_id:id(),p_expected_revision:boot.profile.revision,
        p_full_name:'Отредактированное ФИО'});
      await runtime.enqueue(()=>logout(runtime,identity,'local'));
      const inputs=[{email},{email,fullName:null},{email,fullName:'Другое имя'},
        {email,fullName:''},{email,fullName:'\u0000'},{email,fullName:'x'.repeat(1000)}];
      for(const input of inputs) {
        const returned=await runtime.enqueue(()=>identify(runtime,input));
        assert.equal(returned.session.user.id,userId);
        assert.equal(returned.session.user.user_metadata.full_name,'Отредактированное ФИО');
      }
      const profile=(await runtime.db.query('select full_name,revision from public.dw_profiles where user_id=$1',[userId])).rows[0];
      assert.equal(profile.full_name,'Отредактированное ФИО');assert.equal(profile.revision,2);
      saved.push({email,userId});
    }
    await runtime.close();runtime=null;
    runtime=await openRuntime({dataDir,testSeed:seed});
    for(const {email,userId}of saved) {
      const returned=await runtime.enqueue(()=>identify(runtime,{email:email.toUpperCase()}));
      assert.equal(returned.session.user.id,userId);
      const identity=await runtime.enqueue(()=>authenticate(runtime,returned.session.access_token));
      const boot=await call(runtime,identity,'dw_bootstrap');
      assert.equal(boot.profile.fullName,'Отредактированное ФИО');
      assert.equal(boot.profile.revision,2);assert.equal(boot.canCreateSession,email==='omnistat@yandex.ru');
    }
  } finally {await runtime?.close();await rm(dataDir,{recursive:true,force:true});}
});
