#!/usr/bin/env node
/** Prepare tool payload in memory/from a private operator state; never print the raw credential. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const operator=JSON.parse(await readFile(process.argv[2],'utf8'));
if(!/^[A-Za-z0-9_-]{43}$/.test(operator.secret)||!Number.isSafeInteger(operator.expiresAt)||operator.expiresAt<=Date.now())throw new Error('PRIVATE_OPERATOR_STATE_INVALID');
const digest=createHash('sha256').update(operator.secret).digest('hex');
const template=await readFile(resolve(root,'scripts/deploy/edge-owner-seed.ts'),'utf8');
function exactSlice(source,start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a);
  if(a<0||b<=a||source.indexOf(start,a+1)!==-1)throw new Error('CANONICAL_CONTRACT_BOUNDARY_CHANGED');
  return source.slice(a,b).trim();
}
const seed=await readFile(resolve(root,'scripts/seed-supabase.mjs'),'utf8');
const territories=await readFile(resolve(root,'scripts/seed-roadmaps.mjs'),'utf8');
const pure=`// Exact pure validators extracted from the versioned production import contracts.\nimport { createHash } from 'node:crypto';\nconst sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');\nconst fail=message=>{throw new Error(message);};\n`
  +exactSlice(seed,'export function validateCanonicalDocument(doc) {','/** Works with a pg Client')+'\n'
  +exactSlice(territories,'export function roadmapTerritory(index, record) {','/**\n * Production always')+'\n';
const files=[
  {name:'index.ts',content:template.replace('__OPERATOR_SHA256__',digest).replace('__EXPIRES_AT__',String(operator.expiresAt))},
  {name:'canonical-contracts.mjs',content:pure},
  {name:'packages/territories/series.mjs',content:await readFile(resolve(root,'packages/territories/series.mjs'),'utf8')},
  {name:'packages/security/crypto.mjs',content:await readFile(resolve(root,'packages/security/crypto.mjs'),'utf8')},
  {name:'deno.json',content:JSON.stringify({imports:{'@noble/hashes/sha2.js':'npm:@noble/hashes@2.4.0/sha2.js'}})},
];
process.stdout.write(JSON.stringify({project_id:'alyrowehwzypgtrqnvdi',name:'dw-owner-seed',entrypoint_path:'index.ts',import_map_path:'deno.json',verify_jwt:false,files}));
