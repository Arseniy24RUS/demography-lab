/** Temporary owner-only canonical importer. Deployment builder replaces the two sentinels.
 * No request can supply SQL, credentials, an arbitrary URL, a table, or source bytes.
 * Retire immediately after verified completion by redeploying the 404 tombstone.
 */
import postgres from 'npm:postgres@3.4.3';
import { validateCanonicalDocument, roadmapTerritory } from './canonical-contracts.mjs';
import { adaptCanonicalSeries, canonicalSeriesText } from './packages/territories/series.mjs';

const OPERATOR_SHA256 = '__OPERATOR_SHA256__';
const EXPIRES = Number('__EXPIRES_AT__');
const ROOT = 'https://raw.githubusercontent.com/Arseniy24RUS/demography-lab/ce65b09d4e800061948e9037e71f15410be42d90/public';
const CORPUS_HASH = '86c6bf55df05a03931246cc4a092f31b66fd0a3d73d24e53de4923e626f0fd95';
const TERRITORY_HASH = '02eaef7003e77fe059a94a6a6f9dd8edeff841e0d697f77579a91ce30c9148fa';
const EXPECTED = { documents: 80, blocks: 52390, territories: 2471, series: 12053 };
const failure = (code: string): never => { throw new Error(code); };
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');

async function source(path: string, digest?: string) {
  if(!/^\/data\/(?:corpus\/(?:index\.json|documents\/[a-z0-9-]+\.json)|territories\/(?:index\.json|registry\.json|regions\/[a-z0-9-]+\.(?:map|statistics)\.json))$/.test(path))failure('SOURCE_PATH_INVALID');
  const response=await fetch(ROOT+path,{redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)failure('SOURCE_FETCH_FAILED');
  const declared=Number(response.headers.get('content-length'));
  if(declared>16*1024*1024)failure('SOURCE_SIZE_LIMIT');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.byteLength>16*1024*1024)failure('SOURCE_SIZE_LIMIT');
  if(digest&&await hash(bytes)!==digest)failure('SOURCE_CHECKSUM_MISMATCH');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
async function corpus(sql: any, documentId: string) {
  const index=await source('/data/corpus/index.json',CORPUS_HASH);
  if(index.documents.filter((d: any)=>d.versionId).length!==EXPECTED.documents)failure('CORPUS_COUNT_MISMATCH');
  const entry=index.documents.find((d: any)=>d.id===documentId&&d.versionId);
  if(!entry)failure('DOCUMENT_NOT_IN_PINNED_RELEASE');
  const doc=await source(`/data/corpus/documents/${entry.id}.json`);
  const manifest=validateCanonicalDocument(doc);
  if(manifest.versionId!==entry.versionId||manifest.canonicalHash!==entry.canonicalHash)failure('CORPUS_MANIFEST_MISMATCH');
  return sql.begin(async(tx: any)=>{
    await tx.unsafe("set local statement_timeout='90s'");
    await tx.unsafe('select pg_advisory_xact_lock(hashtextextended($1,0))',[`source:${manifest.versionId}`]);
    let previous=(await tx.unsafe('select * from private.source_versions where version_id=$1 for update',[manifest.versionId]))[0];
    if(!previous){
      previous=(await tx.unsafe(`insert into private.source_versions
        (version_id,document_id,normalization_version,source_sha256,canonical_hash,title,source_url,region_id,page_count,block_count)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,[manifest.versionId,manifest.documentId,
        manifest.normalizationVersion,manifest.sourceSha256,manifest.canonicalHash,manifest.title,manifest.sourceUrl,
        manifest.regionId,manifest.pageCount,manifest.blockCount]))[0];
    }
    const expectedFields={document_id:manifest.documentId,normalization_version:manifest.normalizationVersion,
      source_sha256:manifest.sourceSha256,canonical_hash:manifest.canonicalHash,title:manifest.title,
      source_url:manifest.sourceUrl,region_id:manifest.regionId,page_count:manifest.pageCount,block_count:manifest.blockCount};
    if(Object.entries(expectedFields).some(([key,value])=>previous[key]!==value))failure('EXISTING_SOURCE_METADATA_MISMATCH');
    const expected=new Map(doc.version.blocks.map((b: any)=>[b.id,b]));
    const existing=await tx.unsafe('select * from private.source_blocks where version_id=$1',[manifest.versionId]);
    const seen=new Set();
    for(const block of existing){
      const wanted: any=expected.get(block.block_id);
      if(!wanted||block.block_order!==wanted.order||block.kind!==wanted.kind||block.page_start!==wanted.pageStart
        ||block.page_end!==wanted.pageEnd||block.canonical_text!==wanted.text)failure('EXISTING_SOURCE_CONTENT_MISMATCH');
      seen.add(block.block_id);
    }
    if(previous.sealed){
      if(existing.length!==manifest.blockCount)failure('EXISTING_SEALED_SOURCE_INCOMPLETE');
      return {documentId,blocks:manifest.blockCount,inserted:0,skipped:true,sealed:true};
    }
    const missing=doc.version.blocks.filter((b: any)=>!seen.has(b.id));
    for(let start=0;start<missing.length;start+=200){
      const batch=missing.slice(start,start+200).map((b: any)=>({block_id:b.id,block_order:b.order,kind:b.kind,
        page_start:b.pageStart,page_end:b.pageEnd,canonical_text:b.text}));
      await tx.unsafe(`insert into private.source_blocks(version_id,block_id,block_order,kind,page_start,page_end,canonical_text)
        select $1,x.block_id,x.block_order,x.kind,x.page_start,x.page_end,x.canonical_text
        from jsonb_to_recordset(($2::text)::jsonb) as x(block_id text,block_order integer,kind text,page_start integer,page_end integer,canonical_text text)`,
        [manifest.versionId,JSON.stringify(batch)]);
    }
    const count=(await tx.unsafe('select count(*)::int n from private.source_blocks where version_id=$1',[manifest.versionId]))[0].n;
    if(count!==manifest.blockCount)failure('SOURCE_FINAL_COUNT_MISMATCH');
    await tx.unsafe('update private.source_versions set sealed=true where version_id=$1 and not sealed',[manifest.versionId]);
    return {documentId,blocks:count,inserted:missing.length,skipped:false,sealed:true};
  });
}
async function territoryRelease(){
  const index=await source('/data/territories/index.json',TERRITORY_HASH);
  const registry=await source(index.registryPath,index.registrySha256);
  if(index.schemaVersion!==1||registry.schemaVersion!==1||index.editionId!==registry.editionId
    ||registry.records.length!==EXPECTED.territories)failure('TERRITORY_RELEASE_INVALID');
  return {index,registry,metadata:{index,indexSha256:TERRITORY_HASH,fixture:false,selectedTerritoryKeys:null}};
}
async function datasetRow(tx: any,release: any){
  const {index,metadata}=release;
  await tx.unsafe("set local statement_timeout='90s'");
  await tx.unsafe('select pg_advisory_xact_lock(hashtextextended($1,0))',[`roadmap-dataset:${index.editionId}`]);
  let row=(await tx.unsafe('select *,metadata=($2::text)::jsonb as same from private.dw_roadmap_datasets where id=$1 for update',
    [index.editionId,JSON.stringify(metadata)]))[0];
  if(!row){
    row=(await tx.unsafe(`insert into private.dw_roadmap_datasets(id,metadata,territory_count,series_count)
      values($1,($2::text)::jsonb,$3,$4) returning *,true as same`,[index.editionId,JSON.stringify(metadata),EXPECTED.territories,EXPECTED.series]))[0];
  }
  if(!row.same||row.territory_count!==EXPECTED.territories||row.series_count!==EXPECTED.series)failure('EXISTING_TERRITORY_RELEASE_MISMATCH');
  return row;
}
async function territoryRegistry(sql: any){
  const release=await territoryRelease();
  return sql.begin(async(tx: any)=>{
    const row=await datasetRow(tx,release),dataset=release.index.editionId;
    const keys=new Set(release.registry.records.map((r: any)=>r.territoryKey));
    const existing=await tx.unsafe('select territory_key from private.dw_roadmap_territories where dataset_id=$1',[dataset]);
    if(existing.some((r: any)=>!keys.has(r.territory_key)))failure('EXISTING_TERRITORY_KEY_MISMATCH');
    for(let start=0;start<release.registry.records.length;start+=100){
      const batch=release.registry.records.slice(start,start+100).map((r: any)=>({territory_key:r.territoryKey,level:r.level,
        region_id:r.regionId,room_eligible:r.roomEligible,material:roadmapTerritory(release.index,r),catalog_record:r}));
      const raw=JSON.stringify(batch);
      const mismatches=await tx.unsafe(`select count(*)::int n from private.dw_roadmap_territories t
        join jsonb_to_recordset(($2::text)::jsonb) as x(territory_key text,level text,region_id text,room_eligible boolean,material jsonb,catalog_record jsonb)
        on t.territory_key=x.territory_key where t.dataset_id=$1 and
        (t.level is distinct from x.level or t.region_id is distinct from x.region_id or t.room_eligible is distinct from x.room_eligible
         or t.material is distinct from x.material or t.catalog_record is distinct from x.catalog_record)`,[dataset,raw]);
      if(mismatches[0].n)failure('EXISTING_TERRITORY_CONTENT_MISMATCH');
      if(!row.sealed)await tx.unsafe(`insert into private.dw_roadmap_territories(dataset_id,territory_key,level,region_id,room_eligible,material,catalog_record)
        select $1,x.territory_key,x.level,x.region_id,x.room_eligible,x.material,x.catalog_record
        from jsonb_to_recordset(($2::text)::jsonb) as x(territory_key text,level text,region_id text,room_eligible boolean,material jsonb,catalog_record jsonb)
        where not exists(select 1 from private.dw_roadmap_territories t where t.dataset_id=$1 and t.territory_key=x.territory_key)`,[dataset,raw]);
    }
    const count=(await tx.unsafe('select count(*)::int n from private.dw_roadmap_territories where dataset_id=$1',[dataset]))[0].n;
    if(count!==EXPECTED.territories)failure('TERRITORY_FINAL_COUNT_MISMATCH');
    return {datasetId:dataset,territories:count,inserted:count-existing.length,sealed:row.sealed};
  });
}
async function territoryRegion(sql: any,regionId: string){
  const release=await territoryRelease(),region=release.index.regions.find((r: any)=>r.regionId===regionId);
  if(!region)failure('REGION_NOT_IN_PINNED_RELEASE');
  const pack=await source(region.statisticsPath,region.statisticsSha256);
  const map=await source(region.mapPath,region.mapSha256);
  if(map.editionId!==release.index.editionId||map.regionId!==regionId)failure('GEOMETRY_EDITION_MISMATCH');
  const series=await adaptCanonicalSeries(release.index,release.registry,pack);
  const ids=new Set(series.map((s: any)=>s.id));
  return sql.begin(async(tx: any)=>{
    const row=await datasetRow(tx,release),dataset=release.index.editionId;
    const existing=await tx.unsafe(`select s.id from private.dw_roadmap_series s
      join private.dw_roadmap_territories t on t.dataset_id=s.dataset_id and t.territory_key=s.territory_key
      where s.dataset_id=$1 and t.region_id=$2`,[dataset,regionId]);
    if(existing.some((s: any)=>!ids.has(s.id)))failure('EXISTING_SERIES_ID_MISMATCH');
    for(let start=0;start<series.length;start+=100){
      const batch=series.slice(start,start+100).map((s: any)=>({id:s.id,territory_key:s.territoryKey,fingerprint:s.fingerprint,
        material:s,canonical_text:canonicalSeriesText(s)}));
      const raw=JSON.stringify(batch);
      const mismatch=await tx.unsafe(`select count(*)::int n from private.dw_roadmap_series t
        join jsonb_to_recordset(($2::text)::jsonb) as x(id text,territory_key text,fingerprint text,material jsonb,canonical_text text)
        on t.id=x.id where t.dataset_id=$1 and (t.territory_key is distinct from x.territory_key
          or t.fingerprint is distinct from x.fingerprint or t.material is distinct from x.material or t.canonical_text is distinct from x.canonical_text)`,[dataset,raw]);
      if(mismatch[0].n)failure('EXISTING_SERIES_CONTENT_MISMATCH');
      if(!row.sealed)await tx.unsafe(`insert into private.dw_roadmap_series(dataset_id,id,territory_key,fingerprint,material,canonical_text)
        select $1,x.id,x.territory_key,x.fingerprint,x.material,x.canonical_text
        from jsonb_to_recordset(($2::text)::jsonb) as x(id text,territory_key text,fingerprint text,material jsonb,canonical_text text)
        where not exists(select 1 from private.dw_roadmap_series t where t.dataset_id=$1 and t.id=x.id)`,[dataset,raw]);
    }
    const count=(await tx.unsafe(`select count(*)::int n from private.dw_roadmap_series s
      join private.dw_roadmap_territories t on t.dataset_id=s.dataset_id and t.territory_key=s.territory_key
      where s.dataset_id=$1 and t.region_id=$2`,[dataset,regionId]))[0].n;
    if(count!==series.length)failure('REGION_SERIES_FINAL_COUNT_MISMATCH');
    return {datasetId:dataset,regionId,series:count,inserted:count-existing.length,sealed:row.sealed};
  });
}
async function sealTerritories(sql: any){
  const release=await territoryRelease();
  return sql.begin(async(tx: any)=>{
    const row=await datasetRow(tx,release),dataset=release.index.editionId;
    const count=(await tx.unsafe(`select (select count(*)::int from private.dw_roadmap_territories where dataset_id=$1) territories,
      (select count(*)::int from private.dw_roadmap_series where dataset_id=$1) series,
      (select count(*)::int from private.dw_roadmap_series where dataset_id=$1 and encode(sha256(convert_to(canonical_text,'UTF8')),'hex')<>fingerprint) invalid_fingerprints`,[dataset]))[0];
    if(count.territories!==EXPECTED.territories||count.series!==EXPECTED.series||count.invalid_fingerprints)failure('DATASET_FINAL_VALIDATION_FAILED');
    if(!row.sealed)await tx.unsafe('update private.dw_roadmap_datasets set sealed=true where id=$1',[dataset]);
    return {datasetId:dataset,...count,sealed:true};
  });
}
async function status(sql: any){
  const corpus=(await sql.unsafe(`select (select count(*)::int from private.source_versions where sealed) documents,
    (select count(*)::int from private.source_versions where not sealed) partial_documents,
    (select count(*)::int from private.source_blocks) blocks`))[0];
  const available=(await sql.unsafe("select to_regclass('private.dw_roadmap_datasets') is not null as available"))[0].available;
  const datasets=available?await sql.unsafe(`select id,sealed,territory_count,series_count,
    (select count(*)::int from private.dw_roadmap_territories t where t.dataset_id=d.id) territories,
    (select count(*)::int from private.dw_roadmap_series s where s.dataset_id=d.id) series from private.dw_roadmap_datasets d`):[];
  return {corpus,datasets};
}

Deno.serve(async(req: Request)=>{
  const deny=()=>new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
  const credential=req.headers.get('x-demography-owner-import')??'';
  if(req.method!=='POST'||Date.now()>EXPIRES||credential.length!==43||await hash(new TextEncoder().encode(credential))!==OPERATOR_SHA256)return deny();
  if(req.headers.get('origin')||!/^application\/json(?:;|$)/i.test(req.headers.get('content-type')??''))return deny();
  if(Number(req.headers.get('content-length'))>4096)return deny();
  let sql: any;
  try{
    const raw=await req.text();if(raw.length>4096)failure('INPUT_LIMIT');
    const input=JSON.parse(raw);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['mode','documentId','regionId'].includes(k)))failure('INPUT_INVALID');
    const conn=Deno.env.get('SUPABASE_DB_URL');if(!conn)failure('DB_URL_UNAVAILABLE');
    sql=postgres(conn,{max:1,prepare:false,connect_timeout:15,idle_timeout:5,onnotice:()=>{}});
    let result;
    if(input.mode==='status')result=await status(sql);
    else if(input.mode==='corpus'&&typeof input.documentId==='string')result=await corpus(sql,input.documentId);
    else if(input.mode==='territory-registry')result=await territoryRegistry(sql);
    else if(input.mode==='territory-region'&&typeof input.regionId==='string')result=await territoryRegion(sql,input.regionId);
    else if(input.mode==='territory-seal')result=await sealTerritories(sql);
    else failure('MODE_INVALID');
    return Response.json({ok:true,result},{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    const code=/^[A-Z0-9_]{1,80}$/.test(error?.message??'')?error.message:/^[A-Z0-9]{5}$/.test(error?.code??'')?error.code:'IMPORT_FAILED';
    return Response.json({ok:false,code},{status:500,headers:{'Cache-Control':'no-store'}});
  }finally{if(sql)await sql.end({timeout:5});}
});
