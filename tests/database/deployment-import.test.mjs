import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  canonicalImportSteps,
  roadmapImportSteps,
} from '../../scripts/prepare-supabase-import.mjs';
import { loadRoadmapDataset, seedRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';
import { seedCanonicalDocument } from '../../scripts/seed-supabase.mjs';
import { createTestDatabase, loadMordovia } from './harness.mjs';

test('independent corpus statements resume, reject early seal, repeat after seal and preserve the original importer', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const doc = await loadMordovia();
    const steps = await canonicalImportSteps(db, doc, { maxBytes: 30000 });
    assert.ok(steps.length > 4);
    assert.ok(steps.every((step) => Buffer.byteLength(step.sql) <= 30000));
    await db.exec(steps[0].sql);
    await db.exec(steps[1].sql);
    await db.exec(steps[1].sql);
    await assert.rejects(db.exec(steps.at(-1).sql), /IMPORT_FINAL_DIGEST_MISMATCH/);
    assert.equal(
      (await db.query('select sealed from private.source_versions')).rows[0].sealed,
      false,
    );
    for (const step of steps) await db.exec(step.sql);
    for (const step of steps) await db.exec(step.sql);
    const state = await db.query(
      'select sealed,block_count,(select count(*)::int from private.source_blocks) as actual from private.source_versions',
    );
    assert.deepEqual(state.rows[0], {
      sealed: true,
      block_count: doc.version.blocks.length,
      actual: doc.version.blocks.length,
    });
    assert.equal((await seedCanonicalDocument(db, doc)).skipped, true);
  } finally {
    await db.close();
  }
});

test('a preexisting source row with changed text cannot be silently accepted or sealed', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const doc = await loadMordovia(),
      block = doc.version.blocks[0];
    const steps = await canonicalImportSteps(db, doc, { maxBytes: 30000 });
    await db.exec(steps[0].sql);
    await db.query(
      `insert into private.source_blocks(version_id,block_id,block_order,kind,page_start,page_end,canonical_text)
      values($1,$2,$3,$4,$5,$6,$7)`,
      [
        doc.version.id,
        block.id,
        block.order,
        block.kind,
        block.pageStart,
        block.pageEnd,
        'changed',
      ],
    );
    await assert.rejects(db.exec(steps[1].sql), /IMPORT_EXISTING_ROW_MISMATCH/);
    await assert.rejects(db.exec(steps.at(-1).sql), /IMPORT_FINAL_DIGEST_MISMATCH/);
    assert.equal(
      (await db.query('select sealed from private.source_versions')).rows[0].sealed,
      false,
    );
  } finally {
    await db.close();
  }
});

test('territory and series SQL resume without long transactions and include all JSONB fields in the seal digest', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const dataset = await loadRoadmapDataset({
      regionIds: ['respublika-mordoviia'],
      fixture: true,
    });
    await assert.rejects(roadmapImportSteps(db, dataset), /Fixture dataset refused/);
    const steps = await roadmapImportSteps(db, dataset, { allowFixture: true });
    assert.ok(steps.every((step) => Buffer.byteLength(step.sql) <= 300000));
    await db.exec(steps[0].sql);
    await db.exec(steps[1].sql);
    await assert.rejects(db.exec(steps.at(-1).sql), /IMPORT_FINAL_DIGEST_MISMATCH/);
    for (const step of steps) await db.exec(step.sql);
    for (const step of steps) await db.exec(step.sql);
    const state = (
      await db.query('select sealed,territory_count,series_count from private.dw_roadmap_datasets')
    ).rows[0];
    assert.deepEqual(state, {
      sealed: true,
      territory_count: dataset.territories.length,
      series_count: dataset.series.length,
    });
    assert.equal((await seedRoadmapDataset(db, dataset, { allowFixture: true })).skipped, true);
  } finally {
    await db.close();
  }
});

test('territorial metadata mismatch and changed catalog text fail closed, without publishing the partial edition', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const dataset = await loadRoadmapDataset({
      regionIds: ['respublika-mordoviia'],
      fixture: true,
    });
    const steps = await roadmapImportSteps(db, dataset, { allowFixture: true });
    await db.exec(steps[0].sql);
    const { record, material } = dataset.territories[0];
    await db.query(
      `insert into private.dw_roadmap_territories(dataset_id,territory_key,level,region_id,room_eligible,material,catalog_record)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [
        dataset.id,
        record.territoryKey,
        record.level,
        record.regionId,
        record.roomEligible,
        JSON.stringify(material),
        JSON.stringify({ ...record, name: 'A changed name' }),
      ],
    );
    await assert.rejects(db.exec(steps[1].sql), /IMPORT_EXISTING_ROW_MISMATCH/);
    await assert.rejects(db.exec(steps.at(-1).sql), /IMPORT_FINAL_DIGEST_MISMATCH/);
    const incompatible = {
      ...dataset,
      metadata: { ...dataset.metadata, fixture: false },
      fixture: false,
    };
    const incompatibleSteps = await roadmapImportSteps(db, incompatible);
    await assert.rejects(db.exec(incompatibleSteps[0].sql), /IMPORT_MANIFEST_MISMATCH/);
    assert.equal(
      (await db.query('select sealed from private.dw_roadmap_datasets')).rows[0].sealed,
      false,
    );
  } finally {
    await db.close();
  }
});

test('the generator requires no authentication database or remote connection', async () => {
  const db = new PGlite();
  try {
    const steps = await canonicalImportSteps(db, await loadMordovia());
    assert.equal(steps[0].kind, 'source_init');
    assert.equal(steps.at(-1).kind, 'source_seal');
    assert.match(steps.at(-1).digest, /^[a-f0-9]{64}$/);
  } finally {
    await db.close();
  }
});
