#!/usr/bin/env node
/** Owner-side corpus importer. No service key or database password belongs in the web app. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = (message) => { throw new Error(message); };

/** Recompute exactly the stage-1 immutable layout-canonical-v2 representation. */
export function validateCanonicalDocument(doc) {
  const v = doc?.version;
  if (!v || doc.schemaVersion !== 1 || !Array.isArray(v.blocks) || !Array.isArray(v.pages)
      || v.blocks.length === 0 || v.pages.length !== doc.pageCount
      || v.documentId !== doc.meta?.id || v.normalizationVersion !== 'unicode-nfc-lf-v1'
      || doc.extraction?.representationVersion !== 'layout-canonical-v2'
      || doc.extraction?.canonicalization !== v.normalizationVersion
      || !/^[a-f0-9]{64}$/.test(v.sourceSha256 ?? '') || v.sourceSha256 !== doc.source?.sha256) {
    fail('Invalid canonical document manifest');
  }
  const seen = new Set();
  let previous = -1;
  for (const b of v.blocks) {
    if (!b.id || seen.has(b.id) || !Number.isSafeInteger(b.order) || b.order <= previous
        || typeof b.text !== 'string' || b.text.includes('\u0000')
        || b.text !== b.text.normalize('NFC') || b.text.includes('\r')
        || !Number.isInteger(b.pageStart) || !Number.isInteger(b.pageEnd)
        || b.pageStart < 1 || b.pageEnd < b.pageStart || b.pageEnd > doc.pageCount
        || (b.textHash && sha256(b.text) !== b.textHash)) fail('Invalid canonical block');
    seen.add(b.id); previous = b.order;
  }
  const byId = new Map(v.blocks.map((b) => [b.id, b]));
  const pageBlockIds = [];
  for (let i = 0; i < v.pages.length; i++) {
    const p = v.pages[i];
    if (p.number !== i + 1 || !Array.isArray(p.blockIds)
        || p.blockIds.some((id) => !byId.has(id) || byId.get(id).pageStart !== p.number)) {
      fail('Invalid canonical page mapping');
    }
    pageBlockIds.push(...p.blockIds);
  }
  if (JSON.stringify(pageBlockIds) !== JSON.stringify(v.blocks.map((b) => b.id))) {
    fail('Page mapping does not cover canonical reading order');
  }
  const hash = sha256(JSON.stringify([
    doc.extraction.representationVersion, doc.extraction.canonicalization, doc.extraction.segmentation,
    v.blocks.map((b) => [b.id, b.order, b.kind, b.pageStart, b.pageEnd, b.text]),
    v.pages.map((p) => [p.number, p.blockIds, p.textHash]),
  ]));
  const expected = `${v.documentId}@layout-canonical-v2-${v.sourceSha256.slice(0, 12)}-${hash.slice(0, 12)}`;
  if (hash !== doc.canonicalHash || v.id !== expected) fail('Canonical checksum/version mismatch');
  const sourceUrl = v.sourceUrl ?? doc.meta.sourceUrl;
  if (typeof sourceUrl !== 'string' || !sourceUrl.startsWith('https://')) fail('Expected HTTPS source URL');
  return { versionId: v.id, documentId: v.documentId, normalizationVersion: v.normalizationVersion,
    sourceSha256: v.sourceSha256, canonicalHash: hash, title: doc.meta.title,
    sourceUrl, regionId: doc.meta.regionId, pageCount: doc.pageCount, blockCount: v.blocks.length };
}

/** Works with a pg Client or PGlite. Every document is inserted and sealed atomically. */
export async function seedCanonicalDocument(db, doc) {
  const manifest = validateCanonicalDocument(doc);
  await db.query('begin');
  try {
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`source:${manifest.versionId}`]);
    const { rows } = await db.query('select * from private.source_versions where version_id=$1', [manifest.versionId]);
    if (rows.length) {
      const previous = rows[0];
      const matching = previous.document_id === manifest.documentId
        && previous.normalization_version === manifest.normalizationVersion
        && previous.source_sha256 === manifest.sourceSha256 && previous.canonical_hash === manifest.canonicalHash
        && previous.block_count === manifest.blockCount && previous.page_count === manifest.pageCount
        && previous.title === manifest.title && previous.source_url === manifest.sourceUrl
        && previous.region_id === manifest.regionId && previous.sealed;
      if (!matching) fail('Existing immutable edition differs from the imported manifest');
      const count = await db.query('select count(*)::int as n from private.source_blocks where version_id=$1', [manifest.versionId]);
      if (count.rows[0].n !== manifest.blockCount) fail('Existing edition is incomplete');
      await db.query('commit');
      return { ...manifest, skipped: true };
    }
    await db.query(`insert into private.source_versions
      (version_id,document_id,normalization_version,source_sha256,canonical_hash,title,source_url,region_id,page_count,block_count)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [manifest.versionId, manifest.documentId,
      manifest.normalizationVersion, manifest.sourceSha256, manifest.canonicalHash,
      manifest.title, manifest.sourceUrl, manifest.regionId, manifest.pageCount, manifest.blockCount]);
    for (let start = 0; start < doc.version.blocks.length; start += 100) {
      const batch = doc.version.blocks.slice(start, start + 100).map((b) => ({
        block_id: b.id, block_order: b.order, kind: b.kind, page_start: b.pageStart,
        page_end: b.pageEnd, canonical_text: b.text,
      }));
      await db.query(`insert into private.source_blocks
        (version_id,block_id,block_order,kind,page_start,page_end,canonical_text)
        select $1,x.block_id,x.block_order,x.kind,x.page_start,x.page_end,x.canonical_text
        from jsonb_to_recordset($2::jsonb) as x(block_id text,block_order integer,kind text,
          page_start integer,page_end integer,canonical_text text)`, [manifest.versionId, JSON.stringify(batch)]);
    }
    await db.query('update private.source_versions set sealed=true where version_id=$1', [manifest.versionId]);
    await db.query('commit');
    return { ...manifest, skipped: false };
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const documentIndex = args.indexOf('--document');
  const documentId = documentIndex < 0 ? null : args[documentIndex + 1];
  if (args.includes('--help')) {
    process.stdout.write('Usage: node scripts/seed-supabase.mjs [--check] [--document DOCUMENT_ID]\n'
      + 'SUPABASE_DB_URL: owner-side PostgreSQL connection; never use a web publishable key.\n'
      + 'DW_FACILITATOR_EMAIL (optional): explicitly allow one already verified Auth account.\n');
    return;
  }
  if (documentIndex >= 0 && !/^[a-z0-9-]+$/.test(documentId ?? '')) fail('Invalid document identifier');
  const index = JSON.parse(await readFile(resolve(root, 'public/data/corpus/index.json'), 'utf8'));
  let entries = index.documents.filter((entry) => entry.versionId);
  if (documentId) entries = entries.filter((entry) => entry.id === documentId);
  if (!entries.length) fail('No canonical documents selected');
  let client;
  if (!checkOnly) {
    if (!process.env.SUPABASE_DB_URL) fail('Set SUPABASE_DB_URL in the server environment, or use --check');
    const { Client } = await import('pg');
    client = new Client({ connectionString: process.env.SUPABASE_DB_URL,
      application_name: 'demography-workshop-corpus-import', statement_timeout: 120000 });
    await client.connect();
  }
  try {
    let blocks = 0;
    let skipped = 0;
    for (const entry of entries) {
      const doc = JSON.parse(await readFile(resolve(root, `public/data/corpus/documents/${entry.id}.json`), 'utf8'));
      const manifest = validateCanonicalDocument(doc);
      if (manifest.versionId !== entry.versionId || manifest.canonicalHash !== entry.canonicalHash) {
        fail('Corpus index disagrees with immutable document');
      }
      if (client) skipped += (await seedCanonicalDocument(client, doc)).skipped ? 1 : 0;
      blocks += manifest.blockCount;
    }
    if (client && process.env.DW_FACILITATOR_EMAIL) {
      await client.query('begin');
      try {
        const candidate = await client.query(`select id from auth.users
          where lower(email)=lower($1) and email_confirmed_at is not null and is_anonymous=false for share`,
          [process.env.DW_FACILITATOR_EMAIL.trim()]);
        if (candidate.rows.length !== 1) fail('Facilitator must match exactly one verified, non-anonymous Auth account');
        await client.query(`insert into private.facilitators(user_id) values($1)
          on conflict(user_id) do update set revoked_at=null`, [candidate.rows[0].id]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      process.stdout.write('Facilitator permission recorded for the configured verified account.\n');
    }
    process.stdout.write(`${checkOnly ? 'Validated' : 'Registered'} ${entries.length} canonical editions / ${blocks} blocks; ${skipped} unchanged.\n`);
  } finally {
    if (client) await client.end();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    // Connection strings/passwords are intentionally never printed.
    process.stderr.write(`Corpus import failed: ${String(error.message).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted connection]')}\n`);
    process.exitCode = 1;
  });
}
