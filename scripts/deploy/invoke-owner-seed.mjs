#!/usr/bin/env node
/** The raw operator key is loaded from a private file and never written to output or argv. */
import { readFile } from 'node:fs/promises';
const state=JSON.parse(await readFile(process.argv[2],'utf8'));
if(!/^[A-Za-z0-9_-]{43}$/.test(state.secret)||state.expiresAt<=Date.now())throw new Error('PRIVATE_OPERATOR_STATE_INVALID');
const payload=JSON.parse(process.argv[3]??'{"mode":"status"}');
const response=await fetch('https://alyrowehwzypgtrqnvdi.supabase.co/functions/v1/dw-owner-seed',{
  method:'POST',redirect:'error',headers:{'content-type':'application/json','x-demography-owner-import':state.secret},
  body:JSON.stringify(payload),signal:AbortSignal.timeout(100000),
});
const value=await response.json();
console.log(JSON.stringify({httpStatus:response.status,...value}));
if(!response.ok||!value.ok)process.exitCode=1;
