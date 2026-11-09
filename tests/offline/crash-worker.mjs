import { openRuntime } from '../../scripts/offline/storage.mjs';
const runtime=await openRuntime({dataDir:process.argv[2],testSeed:async()=>({fixture:true})});
await runtime.db.query("insert into offline.settings(key,value) values('crash-committed','true')");
await runtime.db.transaction(async tx=>{
  await tx.query("insert into offline.settings(key,value) values('crash-uncommitted','true')");
  process.send?.({ready:true});
  await new Promise(()=>{});
});
