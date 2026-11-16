import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './harness.mjs';
import { loadRoadmapDataset, seedRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';
import { buildSaranskExample } from '../../scripts/maintenance/saransk-example.mjs';
import { buildSeedExampleSql } from '../../scripts/maintenance/seed-example.mjs';

test('the actual guarded example import preserves canonical facts, coherent budgets, all references and one immutable final version', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const dataset = await loadRoadmapDataset({ fixture: true, regionIds: ['respublika-mordoviia'], territoryKeys: ['rudn-mun-72196-904'] });
    await seedRoadmapDataset(db, dataset, { allowFixture: true });
    const template = await buildSaranskExample();
    const sql = buildSeedExampleSql(template);
    const canonical = (await db.query('select material from private.dw_roadmap_territories order by territory_key')).rows;
    await db.exec(sql);
    assert.deepEqual((await db.query('select material from private.dw_roadmap_territories order by territory_key')).rows, canonical);
    assert.equal((await db.query('select count(*)::int n from public.dw_profiles')).rows[0].n, 1);
    const room = (await db.query('select * from private.dw_roadmaps')).rows[0];
    assert.equal(room.example_label, 'ПРИМЕР');
    assert.deepEqual(room.territory, template.territory);
    const items = (await db.query('select * from private.dw_roadmap_items order by id')).rows;
    assert.equal(items.length, 111);
    const kinds = Object.fromEntries([...new Set(items.map(item => item.kind))].map(kind => [kind, items.filter(item => item.kind === kind).length]));
    assert.deepEqual(kinds, { activity: 9, cost: 21, diagnosis: 1, fact: 7, funding: 54, indicator: 8, monitoring: 1, passport: 1, risk: 7, scenario: 2 });
    for (const fact of items.filter(item => item.kind === 'fact')) {
      assert.equal(fact.data.sourceKind, 'registry');
      const series = dataset.series.find(series => series.id === fact.data.seriesId);
      assert(series);
      assert.equal(fact.data.seriesFingerprint, series.fingerprint);
      assert.equal(fact.data.value, series.points.find(point => point.year === fact.data.year).value);
    }
    const budget = (await db.query('select private.dw_roadmap_budget($1) b', [room.id])).rows[0].b;
    assert.equal(budget.needCashKopecks, 722800000);
    assert.equal(budget.inKindKopecks, 43500000);
    assert.equal(budget.confirmedKopecks, 0);
    assert.equal(budget.expectedKopecks, budget.needCashKopecks);
    assert.equal(budget.confirmedGapKopecks, budget.needCashKopecks);
    const versions = (await db.query('select * from private.dw_roadmap_versions')).rows;
    assert.equal(versions.length, 1);
    assert.equal(versions[0].kind, 'submitted');
    assert.equal(versions[0].material.exampleLabel, 'ПРИМЕР');
    assert.equal(versions[0].material.items.length, 111);
    assert.equal(versions[0].material.cohortSettings.parameters.endYear, 2029);
    await db.exec(sql);
    assert.deepEqual((await db.query('select * from private.dw_roadmap_items order by id')).rows, items);
    assert.deepEqual((await db.query('select * from private.dw_roadmap_versions')).rows, versions);
    for (const table of ['public.dw_submissions', 'private.dw_barriers', 'private.dw_solutions', 'private.dw_flipchart_notes', 'private.dw_workspaces'])
      assert.equal((await db.query(`select count(*)::int n from ${table}`)).rows[0].n, 0);
  } finally { await db.close(); }
});
