#!/usr/bin/env node
/** Owner-side, content-pinned importer. Never include owner credentials in the web app. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  adaptCanonicalSeries,
  canonicalSeriesText,
  verifyCanonicalSeriesFingerprint,
} from '../packages/territories/series.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const TERRITORY_INDEX_SHA256 =
  '02eaef7003e77fe059a94a6a6f9dd8edeff841e0d697f77579a91ce30c9148fa';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  throw new Error(message);
};
async function verifiedFile(publicPath, digest) {
  if (
    !/^\/data\/territories\/(?:index\.json|registry\.json|regions\/[a-z0-9-]+\.(?:map|statistics)\.json)$/.test(
      publicPath,
    )
  )
    fail('Unsafe dataset path');
  const raw = await readFile(resolve(root, 'public', publicPath.slice(1)));
  if (sha(raw) !== digest) fail('Territory dataset checksum mismatch: ' + publicPath);
  return JSON.parse(raw.toString('utf8'));
}
export function roadmapTerritory(index, record) {
  const source =
    index.sources.find((s) => s.id === 'rudn-geometry-' + record.sourceRegionId) ??
    index.sources.find((s) => s.id === 'rudn-municipal-catalog');
  if (!source) fail('Territory source passport missing');
  return {
    key: record.territoryKey,
    name: record.name,
    level: record.level,
    regionId: record.regionId,
    sourceEditionId: record.sourceEditionId,
    sourceCode: record.sourceCode,
    sourceType: record.unitKind,
    geographicStatus: record.geographicStatus,
    sourceUrl: source.url,
    boundaryVersion: record.geometryId ? index.geographyEditionId : null,
  };
}
/**
 * Production always loads the whole, schema-tested, byte-pinned release.
 * Explicit fixture filtering keeps the real values and IDs, only in an isolated test DB.
 * Schema validation is performed by the territory release tests; the pinned index and
 * its transitive SHA-256 manifest prevent unvalidated replacement of any release file.
 */
export async function loadRoadmapDataset({ regionIds, territoryKeys, fixture = false } = {}) {
  if ((regionIds || territoryKeys) && !fixture) fail('Partial datasets are test fixtures only');
  const index = await verifiedFile('/data/territories/index.json', TERRITORY_INDEX_SHA256);
  const registry = await verifiedFile(index.registryPath, index.registrySha256);
  if (
    index.schemaVersion !== 1 ||
    registry.schemaVersion !== 1 ||
    registry.editionId !== index.editionId
  )
    fail('Dataset edition mismatch');
  let series = [];
  const selected = index.regions.filter(
    (region) => !regionIds || regionIds.includes(region.regionId),
  );
  if (regionIds && selected.length !== new Set(regionIds).size) fail('Unknown fixture region');
  for (const region of selected) {
    const pack = await verifiedFile(region.statisticsPath, region.statisticsSha256);
    const map = await verifiedFile(region.mapPath, region.mapSha256);
    if (map.editionId !== index.editionId || map.regionId !== region.regionId)
      fail('Geometry edition mismatch');
    series.push(...(await adaptCanonicalSeries(index, registry, pack)));
  }
  let records = registry.records;
  if (fixture) {
    records = records.filter(
      (r) =>
        r.level === 'federal' ||
        r.level === 'region' ||
        ((!regionIds || regionIds.includes(r.regionId)) &&
          (!territoryKeys || territoryKeys.includes(r.territoryKey))),
    );
    const available = new Set(records.map((r) => r.territoryKey));
    if (territoryKeys && territoryKeys.some((key) => !available.has(key)))
      fail('Unknown fixture territory');
    series = series.filter((s) => available.has(s.territoryKey));
  }
  const territories = records.map((record) => ({
    record,
    material: roadmapTerritory(index, record),
  }));
  const metadata = {
    index,
    indexSha256: TERRITORY_INDEX_SHA256,
    fixture,
    selectedTerritoryKeys: fixture ? records.map((r) => r.territoryKey).sort() : null,
  };
  return {
    id: index.editionId,
    index,
    registry: { ...registry, records },
    metadata,
    territories,
    series,
    fixture,
  };
}

/** PGlite and pg Client share this interface; each sealed edition is one transaction. */
export async function seedRoadmapDataset(db, dataset, { allowFixture = false } = {}) {
  if (dataset.fixture && !allowFixture) fail('Fixture dataset refused by production importer');
  if (
    dataset.id !== dataset.index.editionId ||
    dataset.index.editionId !== dataset.registry.editionId
  )
    fail('Dataset identity mismatch');
  const keys = new Set(dataset.territories.map((t) => t.record.territoryKey));
  if (
    keys.size !== dataset.territories.length ||
    new Set(dataset.series.map((s) => s.id)).size !== dataset.series.length
  )
    fail('Duplicate dataset identity');
  for (const s of dataset.series) {
    if (
      !keys.has(s.territoryKey) ||
      !s.id.startsWith(dataset.id + ':') ||
      !(await verifyCanonicalSeriesFingerprint(s))
    )
      fail('Canonical series checksum mismatch');
  }
  const metadata = JSON.stringify(dataset.metadata);
  await db.query('begin');
  try {
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      'roadmap-dataset:' + dataset.id,
    ]);
    const { rows } = await db.query(
      'select *,metadata=$2::jsonb as same from private.dw_roadmap_datasets where id=$1',
      [dataset.id, metadata],
    );
    if (rows.length) {
      if (
        !rows[0].sealed ||
        !rows[0].same ||
        rows[0].territory_count !== dataset.territories.length ||
        rows[0].series_count !== dataset.series.length
      )
        fail('Existing immutable dataset differs; use a new edition ID');
      const count = await db.query(
        'select (select count(*)::int from private.dw_roadmap_territories where dataset_id=$1) t,(select count(*)::int from private.dw_roadmap_series where dataset_id=$1) s',
        [dataset.id],
      );
      if (
        count.rows[0].t !== dataset.territories.length ||
        count.rows[0].s !== dataset.series.length
      )
        fail('Existing dataset is incomplete');
      await db.query('commit');
      return {
        id: dataset.id,
        territories: dataset.territories.length,
        series: dataset.series.length,
        skipped: true,
      };
    }
    await db.query(
      'insert into private.dw_roadmap_datasets(id,metadata,territory_count,series_count) values($1,$2::jsonb,$3,$4)',
      [dataset.id, metadata, dataset.territories.length, dataset.series.length],
    );
    for (let i = 0; i < dataset.territories.length; i += 100) {
      const batch = dataset.territories.slice(i, i + 100).map(({ record, material }) => ({
        territory_key: record.territoryKey,
        level: record.level,
        region_id: record.regionId,
        room_eligible: record.roomEligible,
        material,
        catalog_record: record,
      }));
      await db.query(
        'insert into private.dw_roadmap_territories(dataset_id,territory_key,level,region_id,room_eligible,material,catalog_record) ' +
          'select $1,x.territory_key,x.level,x.region_id,x.room_eligible,x.material,x.catalog_record from jsonb_to_recordset($2::jsonb) ' +
          'as x(territory_key text,level text,region_id text,room_eligible boolean,material jsonb,catalog_record jsonb)',
        [dataset.id, JSON.stringify(batch)],
      );
    }
    for (let i = 0; i < dataset.series.length; i += 100) {
      const batch = dataset.series.slice(i, i + 100).map((s) => ({
        id: s.id,
        territory_key: s.territoryKey,
        fingerprint: s.fingerprint,
        material: s,
        canonical_text: canonicalSeriesText(s),
      }));
      await db.query(
        'insert into private.dw_roadmap_series(dataset_id,id,territory_key,fingerprint,material,canonical_text) ' +
          'select $1,x.id,x.territory_key,x.fingerprint,x.material,x.canonical_text from jsonb_to_recordset($2::jsonb) ' +
          'as x(id text,territory_key text,fingerprint text,material jsonb,canonical_text text)',
        [dataset.id, JSON.stringify(batch)],
      );
    }
    await db.query('update private.dw_roadmap_datasets set sealed=true where id=$1', [dataset.id]);
    await db.query('commit');
    return {
      id: dataset.id,
      territories: dataset.territories.length,
      series: dataset.series.length,
      skipped: false,
    };
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((a) => !['--check', '--help'].includes(a))) fail('Unknown importer argument');
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/seed-roadmaps.mjs [--check]\nOwner environment: SUPABASE_DB_URL. No cloud target is selected automatically.\n',
    );
    return;
  }
  const dataset = await loadRoadmapDataset();
  if (args.includes('--check')) {
    process.stdout.write(
      'Validated sealed-edition input: ' +
        dataset.territories.length +
        ' territories / ' +
        dataset.series.length +
        ' canonical series.\n',
    );
    return;
  }
  if (!process.env.SUPABASE_DB_URL) fail('Set owner-side SUPABASE_DB_URL or use --check');
  const { Client } = await import('pg');
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    application_name: 'demography-workshop-roadmaps-import',
    statement_timeout: 120000,
  });
  try {
    await client.connect();
    const result = await seedRoadmapDataset(client, dataset);
    process.stdout.write(
      (result.skipped ? 'Unchanged' : 'Registered') +
        ': ' +
        result.territories +
        ' territories / ' +
        result.series +
        ' series.\n',
    );
  } finally {
    await client.end();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      'Roadmap import failed: ' +
        String(error.message).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted connection]') +
        '\n',
    );
    process.exitCode = 1;
  });
}
