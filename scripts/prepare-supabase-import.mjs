#!/usr/bin/env node
/**
 * Prepare owner-only, independently committed SQL for Supabase MCP execute_sql.
 * This generator has no network or credential access. Every SQL file is retryable.
 * Unsealed editions remain unavailable to application RPCs until the final digest
 * check publishes them atomically. Existing immutable rows are never overwritten.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { validateCanonicalDocument } from './seed-supabase.mjs';
import { loadRoadmapDataset } from './seed-roadmaps.mjs';
import {
  canonicalSeriesText,
  verifyCanonicalSeriesFingerprint,
} from '../packages/territories/series.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const fail = (message) => {
  throw new Error(message);
};
export const DEFAULT_MAX_BYTES = 300000;

// Dollar quoting is chosen from the actual payload; document text is never SQL.
function literal(value) {
  const text = String(value);
  let suffix = sha(text).slice(0, 20);
  while (text.includes(`$dw_${suffix}$`)) suffix += 'x';
  const tag = `$dw_${suffix}$`;
  return `${tag}${text}${tag}`;
}
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
function statement(body) {
  const tag = `$dw_do_${sha(body).slice(0, 20)}$`;
  if (body.includes(tag)) fail('Unexpected SQL delimiter collision');
  return `-- Owner-side immutable import. One statement is one transaction.\nDO ${tag}\n${body}\n${tag};\n`;
}
const columnList = (definition) => definition.columns.map(([name]) => name).join(',');
const recordType = (definition) =>
  definition.columns.map(([name, type]) => `${name} ${type}`).join(',');
const materialExpression = (definition, alias) =>
  `jsonb_build_object(${definition.columns.map(([name]) => `'${name}',${alias}.${name}`).join(',')})`;
const rowHashExpression = (definition, alias) =>
  `encode(sha256(convert_to(${materialExpression(definition, alias)}::text,'UTF8')),'hex')`;
const pack = (value) => `${bytes(value)}:${value}`;

/** PostgreSQL itself supplies JSONB canonicalization; no JS emulation is used. */
async function digestRows(db, definition, rows) {
  const pairs = [];
  for (let start = 0; start < rows.length; start += 100) {
    const result = await db.query(
      `select x.${definition.key} as k,${rowHashExpression(definition, 'x')} as h
      from jsonb_to_recordset($1::jsonb) as x(${recordType(definition)})`,
      [JSON.stringify(rows.slice(start, start + 100))],
    );
    pairs.push(...result.rows);
  }
  pairs.sort((a, b) => Buffer.compare(Buffer.from(a.k), Buffer.from(b.k)));
  const hash = createHash('sha256');
  for (const pair of pairs) hash.update(pack(pair.k) + pack(pair.h));
  return hash.digest('hex');
}

function sourceContext(manifest) {
  const metadata = {
    version_id: manifest.versionId,
    document_id: manifest.documentId,
    normalization_version: manifest.normalizationVersion,
    source_sha256: manifest.sourceSha256,
    canonical_hash: manifest.canonicalHash,
    title: manifest.title,
    source_url: manifest.sourceUrl,
    region_id: manifest.regionId,
    page_count: manifest.pageCount,
    block_count: manifest.blockCount,
  };
  return {
    id: manifest.versionId,
    kind: 'corpus',
    parentTable: 'private.source_versions',
    parentKey: 'version_id',
    lock: `source:${manifest.versionId}`,
    metadata,
    guard: `(to_jsonb(v)-'sealed'-'created_at') is distinct from m`,
  };
}

function roadmapContext(dataset) {
  return {
    id: dataset.id,
    kind: 'roadmaps',
    parentTable: 'private.dw_roadmap_datasets',
    parentKey: 'id',
    lock: `roadmap-dataset:${dataset.id}`,
    metadata: {
      id: dataset.id,
      metadata: dataset.metadata,
      territory_count: dataset.territories.length,
      series_count: dataset.series.length,
    },
    compactMetadata: {
      id: dataset.id,
      territory_count: dataset.territories.length,
      series_count: dataset.series.length,
      indexSha256: dataset.metadata.indexSha256,
      fixture: dataset.fixture,
    },
    guard: `v.id is distinct from m->>'id' or v.territory_count is distinct from (m->>'territory_count')::integer
      or v.series_count is distinct from (m->>'series_count')::integer
      or v.metadata->>'indexSha256' is distinct from m->>'indexSha256'
      or v.metadata->'fixture' is distinct from m->'fixture'`,
  };
}

function declarations(context, compact = false) {
  return `m jsonb := ${json(compact ? (context.compactMetadata ?? context.metadata) : context.metadata)};
  v ${context.parentTable}%rowtype;`;
}
function lockAndRead(context) {
  return `perform pg_advisory_xact_lock(hashtextextended(${literal(context.lock)},0));
  select * into v from ${context.parentTable} where ${context.parentKey}=${literal(context.id)} for update;`;
}
function guard(context, compact = false) {
  const comparison = compact
    ? context.guard
    : `(to_jsonb(v)-'sealed'-'created_at') is distinct from m`;
  return `if not found then raise exception 'IMPORT_PARENT_MISSING'; end if;
  if ${comparison} then raise exception 'IMPORT_MANIFEST_MISMATCH'; end if;`;
}
function initSql(context) {
  const columns = Object.keys(context.metadata).join(',');
  return statement(`declare ${declarations(context)}
begin
  ${lockAndRead(context)}
  if not found then
    insert into ${context.parentTable}(${columns})
      select ${columns} from jsonb_populate_record(null::${context.parentTable},m);
  elsif (to_jsonb(v)-'sealed'-'created_at') is distinct from m then
    raise exception 'IMPORT_MANIFEST_MISMATCH';
  end if;
end`);
}
function chunkSql(context, definition, rows) {
  const parent = `${definition.parent}=${literal(context.id)}`;
  const rowTuple = (alias) =>
    `row(${definition.columns.map(([name]) => `${alias}.${name}`).join(',')})`;
  const expected = `jsonb_to_recordset(r) as x(${recordType(definition)})`;
  const missing = `not exists(select 1 from ${definition.table} t where t.${parent} and t.${definition.key}=x.${definition.key})`;
  return statement(`declare ${declarations(context, true)}
  r jsonb := ${json(rows)};
begin
  ${lockAndRead(context)}
  ${guard(context, true)}
  if exists(select 1 from ${expected} join ${definition.table} t
    on t.${parent} and t.${definition.key}=x.${definition.key}
    where ${rowTuple('t')} is distinct from ${rowTuple('x')}) then
    raise exception 'IMPORT_EXISTING_ROW_MISMATCH';
  end if;
  if v.sealed and exists(select 1 from ${expected} where ${missing}) then
    raise exception 'IMPORT_SEALED_CONTENT_MISMATCH';
  end if;
  insert into ${definition.table}(${definition.parent},${columnList(definition)})
    select ${literal(context.id)},${definition.columns.map(([name]) => `x.${name}`).join(',')}
    from ${expected} where ${missing};
end`);
}
function finalDigestSql(context, definition, expectedCount, expectedHash) {
  const key = `t.${definition.key}`;
  const hash = rowHashExpression(definition, 't');
  return `select count(*)::integer,encode(sha256(convert_to(coalesce(string_agg(
    octet_length(${key})::text||':'||${key}||'64:'||${hash},'' order by ${key} collate "C"),''),'UTF8')),'hex')
    into n,h from ${definition.table} t where t.${definition.parent}=${literal(context.id)};
  if n<>${expectedCount} or h<>${literal(expectedHash)} then raise exception 'IMPORT_FINAL_DIGEST_MISMATCH'; end if;`;
}
function sealSql(context, checks) {
  return statement(`declare ${declarations(context)}
  n integer; h text;
begin
  ${lockAndRead(context)}
  ${guard(context)}
  ${checks.map(({ definition, count, digest }) => finalDigestSql(context, definition, count, digest)).join('\n  ')}
  if not v.sealed then
    update ${context.parentTable} set sealed=true where ${context.parentKey}=${literal(context.id)};
  end if;
end`);
}

function chunkSteps(context, definition, rows, maxBytes) {
  const overhead = bytes(chunkSql(context, definition, []));
  // Payload's dollar-quote tag has a fixed width; reserve some room for delimiters.
  const payloadBudget = maxBytes - overhead - 100;
  if (payloadBudget < 1000) fail('SQL byte limit is too small for the immutable manifest');
  const steps = [];
  let batch = [],
    batchBytes = 2;
  function flush() {
    if (!batch.length) return;
    const sql = chunkSql(context, definition, batch);
    if (bytes(sql) > maxBytes) fail('SQL byte limit exceeded');
    steps.push({ kind: definition.kind, editionId: context.id, rows: batch.length, sql });
    batch = [];
    batchBytes = 2;
  }
  for (const row of rows) {
    const size = bytes(JSON.stringify(row)) + 1;
    if (size > payloadBudget) fail('One immutable row exceeds the SQL byte limit');
    if (batchBytes + size > payloadBudget) flush();
    batch.push(row);
    batchBytes += size;
  }
  flush();
  return steps;
}

const blockDefinition = {
  kind: 'source_blocks',
  table: 'private.source_blocks',
  parent: 'version_id',
  key: 'block_id',
  columns: [
    ['block_id', 'text'],
    ['block_order', 'integer'],
    ['kind', 'text'],
    ['page_start', 'integer'],
    ['page_end', 'integer'],
    ['canonical_text', 'text'],
  ],
};
const territoryDefinition = {
  kind: 'territories',
  table: 'private.dw_roadmap_territories',
  parent: 'dataset_id',
  key: 'territory_key',
  columns: [
    ['territory_key', 'text'],
    ['level', 'text'],
    ['region_id', 'text'],
    ['room_eligible', 'boolean'],
    ['material', 'jsonb'],
    ['catalog_record', 'jsonb'],
  ],
};
const seriesDefinition = {
  kind: 'series',
  table: 'private.dw_roadmap_series',
  parent: 'dataset_id',
  key: 'id',
  columns: [
    ['id', 'text'],
    ['territory_key', 'text'],
    ['fingerprint', 'text'],
    ['material', 'jsonb'],
    ['canonical_text', 'text'],
  ],
};

export async function canonicalImportSteps(db, doc, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const manifest = validateCanonicalDocument(doc),
    context = sourceContext(manifest);
  const rows = doc.version.blocks.map((b) => ({
    block_id: b.id,
    block_order: b.order,
    kind: b.kind,
    page_start: b.pageStart,
    page_end: b.pageEnd,
    canonical_text: b.text,
  }));
  const digest = await digestRows(db, blockDefinition, rows);
  return [
    { kind: 'source_init', editionId: context.id, rows: 0, sql: initSql(context) },
    ...chunkSteps(context, blockDefinition, rows, maxBytes),
    {
      kind: 'source_seal',
      editionId: context.id,
      rows: rows.length,
      digest,
      sql: sealSql(context, [{ definition: blockDefinition, count: rows.length, digest }]),
    },
  ];
}

export async function roadmapImportSteps(
  db,
  dataset,
  { maxBytes = DEFAULT_MAX_BYTES, allowFixture = false } = {},
) {
  if (dataset.fixture && !allowFixture) fail('Fixture dataset refused by production generator');
  if (dataset.id !== dataset.index.editionId || dataset.id !== dataset.registry.editionId)
    fail('Dataset identity mismatch');
  const context = roadmapContext(dataset);
  const territories = dataset.territories.map(({ record, material }) => ({
    territory_key: record.territoryKey,
    level: record.level,
    region_id: record.regionId,
    room_eligible: record.roomEligible,
    material,
    catalog_record: record,
  }));
  const territoryKeys = new Set(territories.map((t) => t.territory_key));
  if (
    territoryKeys.size !== territories.length ||
    new Set(dataset.series.map((s) => s.id)).size !== dataset.series.length
  )
    fail('Duplicate dataset identity');
  const series = [];
  for (const value of dataset.series) {
    if (
      !territoryKeys.has(value.territoryKey) ||
      !value.id.startsWith(dataset.id + ':') ||
      !(await verifyCanonicalSeriesFingerprint(value))
    )
      fail('Canonical series checksum mismatch');
    series.push({
      id: value.id,
      territory_key: value.territoryKey,
      fingerprint: value.fingerprint,
      material: value,
      canonical_text: canonicalSeriesText(value),
    });
  }
  const territoriesDigest = await digestRows(db, territoryDefinition, territories);
  const seriesDigest = await digestRows(db, seriesDefinition, series);
  const steps = [
    { kind: 'dataset_init', editionId: context.id, rows: 0, sql: initSql(context) },
    ...chunkSteps(context, territoryDefinition, territories, maxBytes),
    ...chunkSteps(context, seriesDefinition, series, maxBytes),
    {
      kind: 'dataset_seal',
      editionId: context.id,
      rows: territories.length + series.length,
      territoriesDigest,
      seriesDigest,
      sql: sealSql(context, [
        { definition: territoryDefinition, count: territories.length, digest: territoriesDigest },
        { definition: seriesDefinition, count: series.length, digest: seriesDigest },
      ]),
    },
  ];
  if (steps.some((step) => bytes(step.sql) > maxBytes))
    fail('SQL byte limit is too small for dataset metadata');
  return steps;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/prepare-supabase-import.mjs --out ABSOLUTE_EMPTY_DIRECTORY [--max-bytes 300000]\n' +
        'Generates canonical owner-only SQL and a SHA-256 manifest; does not connect to a server.\n',
    );
    return;
  }
  let out,
    maxBytes = DEFAULT_MAX_BYTES;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--max-bytes') maxBytes = Number(args[++i]);
    else fail('Unknown generator argument');
  }
  if (!out || !isAbsolute(out)) fail('An absolute output directory is required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 200000 || maxBytes > 1000000)
    fail('max-bytes must be an integer between 200000 and 1000000');
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) fail('Output directory must be empty');
  const db = new PGlite();
  const files = [];
  async function save(steps) {
    for (const step of steps) {
      const filename = `${String(files.length + 1).padStart(5, '0')}-${step.kind}.sql`;
      const { sql, ...description } = step;
      if (bytes(sql) > maxBytes) fail('SQL byte limit exceeded');
      await writeFile(resolve(out, filename), sql, { flag: 'wx' });
      files.push({
        index: files.length + 1,
        filename,
        ...description,
        bytes: bytes(sql),
        sha256: sha(sql),
      });
    }
  }
  try {
    const index = JSON.parse(
      await readFile(resolve(root, 'public/data/corpus/index.json'), 'utf8'),
    );
    const documents = index.documents.filter((entry) => entry.versionId);
    let blocks = 0;
    for (const entry of documents) {
      const doc = JSON.parse(
        await readFile(resolve(root, `public/data/corpus/documents/${entry.id}.json`), 'utf8'),
      );
      const validated = validateCanonicalDocument(doc);
      if (
        validated.versionId !== entry.versionId ||
        validated.canonicalHash !== entry.canonicalHash
      )
        fail('Corpus index disagrees with immutable document');
      await save(await canonicalImportSteps(db, doc, { maxBytes }));
      blocks += validated.blockCount;
    }
    const dataset = await loadRoadmapDataset();
    await save(await roadmapImportSteps(db, dataset, { maxBytes }));
    const manifest = {
      schemaVersion: 1,
      mode: 'owner-sql-sealed-editions',
      maxBytes,
      expected: {
        sourceEditions: documents.length,
        sourceBlocks: blocks,
        datasetId: dataset.id,
        territories: dataset.territories.length,
        series: dataset.series.length,
      },
      files,
    };
    await writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
    });
    process.stdout.write(
      JSON.stringify(
        {
          directory: out,
          files: files.length,
          sqlBytes: files.reduce((total, file) => total + file.bytes, 0),
          largestSql: Math.max(...files.map((file) => file.bytes)),
          expected: manifest.expected,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await db.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write('Import preparation failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
