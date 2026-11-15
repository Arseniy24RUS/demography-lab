import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { counts, seedProduction, sha256 } from '../../scripts/offline/storage.mjs';
import { seedCanonicalDocument } from '../../scripts/seed-supabase.mjs';
import { TERRITORY_INDEX_SHA256 } from '../../scripts/seed-roadmaps.mjs';
import { canonicalSeriesText } from '../../packages/territories/series.mjs';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const oldId = 'territories-v1-rudn-08c68f1fe1c8-spd-59b778760c9e';
const oldHash = '02eaef7003e77fe059a94a6a6f9dd8edeff841e0d697f77579a91ce30c9148fa';

it('registers the BDMO release in a prepared offline database without rebinding saved rooms', async () => {
  const db = await PGlite.create();
  const territoryKey = 'rudn-mun-51490-2343';
  const region = 'moskovskaia-oblast';
  const sessionId = randomUUID();
  const roomId = randomUUID();
  const userId = randomUUID();
  const roomMaterial = { key: territoryKey, name: 'Городской округ Домодедово' };
  const seriesId = `${oldId}:${territoryKey}:births_total`;
  const source = { id: seriesId, territoryKey, metricId: 'births_total', points: [{ year: 2020, value: 1866 }] };
  const canonical = canonicalSeriesText(source);
  source.fingerprint = sha256(canonical);
  const marker = async () => (await db.query("select value from offline.settings where key='canonical-release'")).rows[0].value;
  try {
    await db.exec(await read('scripts/offline/bootstrap.sql'));
    const migrations = await readdir(new URL('../../supabase/migrations/', import.meta.url));
    for (const filename of migrations.filter(name => name.endsWith('.sql')).sort())
      await db.exec(await read(`supabase/migrations/${filename}`));

    const corpus = await read('public/data/corpus/index.json');
    for (const entry of JSON.parse(corpus).documents.filter(entry => entry.versionId)) {
      const document = await read(`public/data/corpus/documents/${entry.id}.json`);
      await seedCanonicalDocument(db, JSON.parse(document));
    }
    await db.query(`insert into private.dw_roadmap_datasets(id,metadata,territory_count,series_count)
      values($1,$2::jsonb,1,1)`, [oldId, JSON.stringify({ indexSha256: oldHash })]);
    await db.query(`insert into private.dw_roadmap_territories(dataset_id,territory_key,level,region_id,room_eligible,material,catalog_record)
      values($1,$2,'municipality',$3,true,$4::jsonb,'{}')`, [oldId, territoryKey, region, JSON.stringify(roomMaterial)]);
    await db.query(`insert into private.dw_roadmap_series(dataset_id,id,territory_key,fingerprint,material,canonical_text)
      values($1,$2,$3,$4,$5::jsonb,$6)`, [oldId, seriesId, territoryKey, source.fingerprint, JSON.stringify(source), canonical]);
    await db.query('update private.dw_roadmap_datasets set sealed=true where id=$1', [oldId]);

    await db.query("insert into auth.users(id,email) values($1,'owner@example.test')", [userId]);
    await db.query(`insert into public.dw_sessions(id,owner_id,title,scope,region_id)
      values($1,$2,'Сохранённое занятие','municipality',$3)`, [sessionId, userId, region]);
    await db.query('update private.dw_roadmap_state set dataset_id=$2 where session_id=$1', [sessionId, oldId]);
    await db.query(`insert into private.dw_roadmaps(id,session_id,dataset_id,territory_key,territory)
      values($1,$2,$3,$4,$5::jsonb)`, [roomId, sessionId, oldId, territoryKey, JSON.stringify(roomMaterial)]);
    const before = await counts(db);
    const old = { documents: before.documents, blocks: before.blocks, territories: 1, series: 1,
      corpusIndexSha256: sha256(corpus), territoryIndexSha256: oldHash, datasetId: oldId, fixture: false };
    await db.query("insert into offline.settings(key,value) values('canonical-release',$1::jsonb)", [JSON.stringify(old)]);

    const interrupted = { query(sql, params) {
      if (sql.includes("values('canonical-release'")) throw new Error('MARKER_WRITE_INTERRUPTED');
      return db.query(sql, params);
    } };
    await assert.rejects(seedProduction(interrupted), /MARKER_WRITE_INTERRUPTED/);
    assert.deepEqual(await marker(), old);
    const datasets = (await db.query('select id,sealed from private.dw_roadmap_datasets order by id')).rows;
    assert.equal(datasets.length, 2);
    assert.ok(datasets.every(dataset => dataset.sealed));

    const ready = await seedProduction(db);
    assert.equal(ready.datasetId, 'territories-v1-rudn-08c68f1fe1c8-bdmo-20260928');
    assert.equal(ready.territoryIndexSha256, TERRITORY_INDEX_SHA256);
    assert.equal(ready.territories, 2471);
    assert.ok(ready.series > old.series);
    assert.deepEqual(await savedRoom(db, roomId), { dataset_id: oldId, territory: roomMaterial });
    assert.deepEqual((await db.query('select material from private.dw_roadmap_series where dataset_id=$1 and id=$2', [oldId, seriesId])).rows[0].material, source);
    assert.deepEqual(await counts(db), { ...before, territories: ready.territories + 1, series: ready.series + 1 });
    assert.deepEqual(await marker(), ready);
    assert.deepEqual(await seedProduction(db), ready);
  } finally {
    await db.close();
  }
});

async function savedRoom(db, roomId) {
  return (await db.query('select dataset_id,territory from private.dw_roadmaps where id=$1', [roomId])).rows[0];
}
