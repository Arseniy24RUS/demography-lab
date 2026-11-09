import { PGlite } from '@electric-sql/pglite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, open, chmod, rename, rm, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedCanonicalDocument, validateCanonicalDocument } from '../seed-supabase.mjs';
import { loadRoadmapDataset, seedRoadmapDataset, TERRITORY_INDEX_SHA256 } from '../seed-roadmaps.mjs';
import { purgeExpiredSurveys } from '../purge-expired-surveys.mjs';
import { discoverRpc, HttpError } from './rpc.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
const exists = async path => { try { await stat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export const defaultDataDirectory = () => platform() === 'darwin'
  ? resolve(homedir(), 'Library/Application Support/DemographyLab')
  : resolve(homedir(), '.local/share/DemographyLab');

/** A rename is the commit point. fsync covers data and directory entries. */
export async function atomicWrite(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}
export const atomicJson = (path, value) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
async function syncDirectory(path) {
  const directory=await open(path,'r');
  try{await directory.sync();}finally{await directory.close();}
}

export async function acquireLock(dataDirectory) {
  const lock = resolve(dataDirectory, 'server.lock');
  const guard = resolve(dataDirectory, 'lock-recovery');
  const ownership = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
  async function create() {
    if (await exists(guard)) throw new Error('OFFLINE_LOCK_RECOVERY_IN_PROGRESS');
    const fd = await open(lock, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(ownership)); await fd.sync(); } finally { await fd.close(); }
  }
  try { await create(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { await mkdir(guard, { mode: 0o700 }); } catch { throw new Error('OFFLINE_DATABASE_IN_USE'); }
    try {
      const previous = JSON.parse(await readFile(lock, 'utf8'));
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('OFFLINE_LOCK_INVALID');
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
      if (alive) throw new Error('OFFLINE_DATABASE_IN_USE');
      await rm(lock);
    } finally { await rm(guard, { recursive: true, force: true }); }
    await create();
  }
  return async () => {
    try {
      const current = JSON.parse(await readFile(lock, 'utf8'));
      if (current.nonce === ownership.nonce) await rm(lock);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
}

export async function prepareDirectory(path) {
  await mkdir(resolve(path), { recursive: true, mode: 0o700 });
  const dataDir = await realpath(resolve(path));
  const rel = relative(ROOT, dataDir);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    throw new Error('OFFLINE_DATA_DIRECTORY_MUST_BE_OUTSIDE_PROJECT');
  await chmod(dataDir, 0o700);
  return dataDir;
}

async function migrations(db) {
  const files = (await readdir(resolve(ROOT, 'supabase/migrations'))).filter(x => /^\d{14}_[a-z0-9_]+\.sql$/.test(x)).sort();
  if (files.length < 5) throw new Error('OFFLINE_MIGRATIONS_MISSING');
  const result = [];
  const applied = new Map((await db.query('select name,sha256 from offline.migrations')).rows.map(r => [r.name,r.sha256]));
  if ([...applied.keys()].some(name => !files.includes(name))) throw new Error('OFFLINE_DATABASE_NEWER_THAN_BUILD');
  for (const name of files) {
    const sql = await readFile(resolve(ROOT, 'supabase/migrations', name), 'utf8');
    const hash = sha256(sql);
    if (applied.has(name) && applied.get(name) !== hash) throw new Error('OFFLINE_MIGRATION_CHANGED: ' + name);
    if (!applied.has(name)) await db.transaction(async tx => {
      await tx.exec(sql);
      await tx.query('insert into offline.migrations(name,sha256) values($1,$2)', [name,hash]);
    });
    result.push({ name, sha256: hash });
  }
  return result;
}

/** The normal runtime always registers the complete shipped canonical release. */
async function seedProduction(db, progress) {
  const bytes = await readFile(resolve(ROOT, 'public/data/corpus/index.json'));
  const corpusHash = sha256(bytes);
  const index = JSON.parse(bytes);
  const entries = index.documents.filter(x => x.versionId);
  const old = (await db.query("select value from offline.settings where key='canonical-release'")).rows[0]?.value;
  if (old) {
    if (old.corpusIndexSha256 !== corpusHash || old.territoryIndexSha256 !== TERRITORY_INDEX_SHA256)
      throw new Error('OFFLINE_SOURCE_RELEASE_CHANGED_REQUIRES_EXPLICIT_MIGRATION');
    const c = await counts(db);
    if (c.documents !== old.documents || c.blocks !== old.blocks || c.territories !== old.territories || c.series !== old.series)
      throw new Error('OFFLINE_CANONICAL_DATABASE_INCOMPLETE');
    return old;
  }
  let blocks = 0;
  for (let i=0;i<entries.length;i++) {
    const e = entries[i];
    if (!/^[a-z0-9-]+$/.test(e.id)) throw new Error('OFFLINE_CORPUS_PATH_INVALID');
    const doc = JSON.parse(await readFile(resolve(ROOT, `public/data/corpus/documents/${e.id}.json`), 'utf8'));
    const manifest = validateCanonicalDocument(doc);
    if (manifest.versionId !== e.versionId || manifest.canonicalHash !== e.canonicalHash)
      throw new Error('OFFLINE_CORPUS_MANIFEST_MISMATCH');
    await seedCanonicalDocument(db, doc);
    blocks += manifest.blockCount;
    if ((i+1)%10 === 0 || i+1 === entries.length) progress?.({ phase:'documents', completed:i+1, total:entries.length });
  }
  progress?.({ phase:'territories', completed:0 });
  const dataset = await loadRoadmapDataset();
  const territorial = await seedRoadmapDataset(db, dataset);
  const release = { documents:entries.length, blocks, territories:territorial.territories,
    series:territorial.series, corpusIndexSha256:corpusHash, territoryIndexSha256:TERRITORY_INDEX_SHA256,
    datasetId:territorial.id, fixture:false };
  await db.query("insert into offline.settings(key,value) values('canonical-release',$1::jsonb)", [JSON.stringify(release)]);
  return release;
}

export async function counts(db) {
  return (await db.query(`select
    (select count(*)::int from private.source_versions where sealed) as documents,
    (select count(*)::int from private.source_blocks) as blocks,
    (select count(*)::int from private.dw_roadmap_territories) as territories,
    (select count(*)::int from private.dw_roadmap_series) as series,
    (select count(*)::int from offline.accounts) as accounts,
    (select count(*)::int from public.dw_sessions) as sessions`)).rows[0];
}

/** One exclusive owner and one queued connection, including auth, RPC, backup and shutdown. */
export async function openRuntime({ dataDir=process.env.DW_OFFLINE_DATA_DIR ?? defaultDataDirectory(), progress,
  testSeed } = {}) {
  process.umask(0o077);
  if (testSeed && process.env.NODE_ENV !== 'test') throw new Error('OFFLINE_TEST_SEED_FORBIDDEN');
  dataDir = await prepareDirectory(dataDir);
  const releaseLock = await acquireLock(dataDir);
  let db;
  try {
    if(await exists(resolve(dataDir,'restore.pending.json')))throw new Error('OFFLINE_RESTORE_INCOMPLETE');
    if(await exists(resolve(dataDir,'ready.json')) && !await exists(resolve(dataDir,'database/PG_VERSION')))
      throw new Error('OFFLINE_PREPARED_DATABASE_MISSING');
    const operatorPath = resolve(dataDir, 'operator.json');
    let operator;
    if (await exists(operatorPath)) operator = JSON.parse(await readFile(operatorPath, 'utf8'));
    else {
      if (await exists(resolve(dataDir, 'database/PG_VERSION'))) throw new Error('OFFLINE_OPERATOR_FILE_MISSING');
      operator = { schemaVersion:1, instanceId:randomUUID(), hostKey:secret(), joinCode:randomBytes(9).toString('base64url'),
        tokenSigningSecret:secret(), createdAt:new Date().toISOString() };
      await atomicJson(operatorPath, operator);
    }
    if (operator.schemaVersion!==1 || !/^[a-zA-Z0-9_-]{43}$/.test(operator.hostKey)
        || !/^[a-zA-Z0-9_-]{43}$/.test(operator.tokenSigningSecret)
        || !/^[a-zA-Z0-9_-]{12}$/.test(operator.joinCode)) throw new Error('OFFLINE_OPERATOR_FILE_INVALID');
    await chmod(operatorPath, 0o600);
    db = await PGlite.create(resolve(dataDir, 'database'), { relaxedDurability:false });
    const initialized = (await db.query("select to_regclass('offline.settings') is not null as initialized")).rows[0].initialized;
    if (!initialized) await db.transaction(async tx => {
      await tx.exec(await readFile(new URL('./bootstrap.sql', import.meta.url), 'utf8'));
      await tx.query("insert into offline.settings(key,value) values('instance-id',$1::jsonb)", [JSON.stringify(operator.instanceId)]);
    });
    if ((await db.query("select value from offline.settings where key='instance-id'")).rows[0]?.value !== operator.instanceId)
      throw new Error('OFFLINE_INSTANCE_ID_MISMATCH');
    const migrationManifest = await migrations(db);
    const identitySql = await readFile(new URL('./identity.sql', import.meta.url), 'utf8');
    const refreshSql = await readFile(new URL('./refresh.sql', import.meta.url), 'utf8');
    await db.transaction(tx => tx.exec(identitySql));
    await db.transaction(tx => tx.exec(refreshSql));
    const seed = testSeed ? await testSeed(db) : await seedProduction(db, progress);
    await purgeExpiredSurveys(db, { apply:true });
    const catalogue = await discoverRpc(db);
    const ready = { schemaVersion:1, instanceId:operator.instanceId, migrations:migrationManifest,
      identitySha256:sha256(identitySql), runtimeSchemaSha256:sha256(refreshSql), seed, preparedAt:new Date().toISOString() };
    await atomicJson(resolve(dataDir, 'ready.json'), ready);
    let tail=Promise.resolve(), pending=0, closing=false, closingPromise=null, lastBackup=await latestBackup(dataDir);
    const runtime = {
      db, dataDir, operator, ready, catalogue,
      get lastBackup() { return lastBackup; },
      set lastBackup(value) { lastBackup=value; },
      get pending() { return pending; },
      enqueue(task) {
        if (closing) return Promise.reject(new HttpError(503,'OFFLINE_STOPPING'));
        if (pending>=128) return Promise.reject(new HttpError(503,'OFFLINE_BUSY'));
        pending++;
        const operation=tail.then(task);
        tail=operation.catch(()=>{}).finally(()=>{pending--;});
        return operation;
      },
      async close() {
        if (closing) return closingPromise;
        closing=true;
        closingPromise=(async()=>{
          await tail;
          try { await db.close(); }
          finally { await rm(resolve(dataDir,'runtime.json'),{force:true}); await releaseLock(); }
        })();
        return closingPromise;
      },
    };
    return runtime;
  } catch(error) {
    if (db) await db.close().catch(()=>{});
    await releaseLock();
    throw error;
  }
}

/** Call within runtime.enqueue so no auth/RPC transaction interleaves with the snapshot. */
export async function backupRuntime(runtime,{kind='manual'}={}) {
  if(!['manual','automatic','shutdown'].includes(kind))throw new Error('OFFLINE_BACKUP_KIND_INVALID');
  await purgeExpiredSurveys(runtime.db, { apply:true });
  const backups=resolve(runtime.dataDir,'backups');
  await mkdir(backups,{recursive:true,mode:0o700});
  const name=`backup-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
  const temporary=resolve(backups,`.${name}.tmp`), destination=resolve(backups,name);
  await mkdir(temporary,{mode:0o700});
  try {
    const data=Buffer.from(await (await runtime.db.dumpDataDir('gzip')).arrayBuffer());
    const operator=Buffer.from(JSON.stringify(runtime.operator,null,2)+'\n');
    await atomicWrite(resolve(temporary,'database.tar.gz'),data);
    await atomicWrite(resolve(temporary,'operator.json'),operator);
    const manifest={schemaVersion:1,format:'demography-lab-pglite-0.5.15',instanceId:runtime.operator.instanceId,
      createdAt:new Date().toISOString(),kind,ready:runtime.ready,counts:await counts(runtime.db),
      files:[{name:'database.tar.gz',bytes:data.length,sha256:sha256(data)},
        {name:'operator.json',bytes:operator.length,sha256:sha256(operator)}]};
    await atomicJson(resolve(temporary,'manifest.json'),manifest);
    await rename(temporary,destination);
    const parent=await open(backups,'r'); try { await parent.sync(); } finally { await parent.close(); }
    runtime.lastBackup={createdAt:manifest.createdAt,path:resolve(destination,'manifest.json'),bytes:data.length};
    // Keep bounded rolling safety copies. Explicit manual copies are never pruned.
    if(kind!=='manual')await pruneAutomaticBackups(backups);
    return runtime.lastBackup;
  } catch(error) { await rm(temporary,{recursive:true,force:true}); throw error; }
}

async function backupManifests(dataDir) {
  const folder=resolve(dataDir,'backups');
  let names;
  try{names=await readdir(folder);}catch(e){if(e.code==='ENOENT')return[];throw e;}
  const result=[];
  for(const name of names.filter(n=>/^backup-[0-9TZ-]+-[a-f0-9]{8}$/.test(n))) {
    try {
      const path=resolve(folder,name,'manifest.json');
      const value=JSON.parse(await readFile(path,'utf8'));
      const valid=value?.schemaVersion===1 && value.format==='demography-lab-pglite-0.5.15'
        && typeof value.instanceId==='string' && value.ready?.instanceId===value.instanceId
        && typeof value.createdAt==='string' && Number.isFinite(Date.parse(value.createdAt))
        && Array.isArray(value.files) && value.files.length===2
        && value.files[0]?.name==='database.tar.gz' && value.files[1]?.name==='operator.json'
        && value.files.every(file=>Number.isSafeInteger(file.bytes)&&file.bytes>=0&&/^[a-f0-9]{64}$/.test(file.sha256))
        && (value.kind===undefined || ['manual','automatic','shutdown'].includes(value.kind));
      if(valid)result.push({path,value});
    }catch{} // A damaged or incomplete copy is retained, never selected for automatic pruning.
  }
  return result.sort((a,b)=>b.value.createdAt.localeCompare(a.value.createdAt));
}
async function latestBackup(dataDir) {
  const latest=(await backupManifests(dataDir))[0];
  return latest?{createdAt:latest.value.createdAt,path:latest.path,bytes:latest.value.files[0].bytes}:null;
}
async function pruneAutomaticBackups(folder) {
  const manifests=await backupManifests(dirname(folder));
  for(const entry of manifests.filter(e=>['automatic','shutdown'].includes(e.value.kind)).slice(12))
    await rm(dirname(entry.path),{recursive:true});
}

/** Restore to a NEW directory only; never overwrite the live/old classroom. */
export async function restoreBackup(manifestPath,dataDir) {
  dataDir=await prepareDirectory(dataDir);
  const release=await acquireLock(dataDir);
  let db;
  const temporary=resolve(dataDir,`.restore-${randomUUID()}`);
  try {
    const existing=(await readdir(dataDir)).filter(x=>x!=='server.lock');
    if (existing.length) throw new Error('OFFLINE_RESTORE_REQUIRES_EMPTY_DIRECTORY');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    if (manifest.schemaVersion!==1 || manifest.format!=='demography-lab-pglite-0.5.15'
        || !Array.isArray(manifest.files) || manifest.files.length!==2
        || manifest.files[0].name!=='database.tar.gz' || manifest.files[1].name!=='operator.json'
        || manifest.ready?.instanceId!==manifest.instanceId) throw new Error('OFFLINE_BACKUP_MANIFEST_INVALID');
    const contents=[];
    for (const file of manifest.files) {
      if (basename(file.name)!==file.name || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('OFFLINE_BACKUP_FILE_INVALID');
      const bytes=await readFile(resolve(dirname(manifestPath),file.name));
      if (bytes.length!==file.bytes || sha256(bytes)!==file.sha256) throw new Error('OFFLINE_BACKUP_INTEGRITY_FAILURE');
      contents.push(bytes);
    }
    const operator=JSON.parse(contents[1]);
    if (operator.instanceId!==manifest.instanceId) throw new Error('OFFLINE_BACKUP_INSTANCE_MISMATCH');
    // This durable guard must precede every restore write. A killed restore cannot be
    // mistaken for an ordinary first start and silently reseed an empty classroom.
    const pending=resolve(dataDir,'restore.pending.json');
    await atomicJson(pending,{schemaVersion:1,instanceId:manifest.instanceId,startedAt:new Date().toISOString()});
    db=await PGlite.create(temporary,{loadDataDir:new Blob([contents[0]]),relaxedDurability:false});
    if ((await db.query("select value from offline.settings where key='instance-id'")).rows[0]?.value!==manifest.instanceId)
      throw new Error('OFFLINE_BACKUP_DATABASE_MISMATCH');
    const actual=await counts(db);
    if (Object.keys(actual).some(k=>actual[k]!==manifest.counts[k])) throw new Error('OFFLINE_BACKUP_COUNTS_MISMATCH');
    await db.close(); db=null;
    await atomicWrite(resolve(dataDir,'operator.json'),contents[1]);
    await atomicJson(resolve(dataDir,'ready.json'),manifest.ready);
    await rename(temporary,resolve(dataDir,'database'));
    await syncDirectory(dataDir);
    await rm(pending);
    await syncDirectory(dataDir);
    return {instanceId:manifest.instanceId,createdAt:manifest.createdAt,counts:actual};
  } finally { if(db)await db.close().catch(()=>{}); await rm(temporary,{recursive:true,force:true}); await release(); }
}
