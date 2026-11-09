import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  asUser,
  callRpc,
  createTestDatabase,
  projectRoot,
  seedAuthUser,
  seedCanonicalDocument,
  loadMordovia,
} from './harness.mjs';
import { loadRoadmapDataset, seedRoadmapDataset } from '../../scripts/seed-roadmaps.mjs';

const id = () => randomUUID();
const sha = (text) => createHash('sha256').update(text).digest('hex');
const code = (promise, expected) =>
  assert.rejects(promise, (e) => e.code === 'P0001' && e.message === expected);
const rpc = (db, who, name, args = {}) => callRpc(db, who, name, args);
const mutation = (db, env, name, input, who = env.alice, operation = id()) =>
  rpc(db, who, name, {
    p_operation_id: operation,
    p_session_id: env.sessionId,
    p_input: input,
  });
let db;
let dataset;
const metric = 'births_total';
const target = () =>
  dataset.territories.find(
    (t) =>
      t.record.level === 'municipality' &&
      dataset.series.some((s) => s.territoryKey === t.record.territoryKey && s.metricId === metric),
  ).record.territoryKey;
async function user(database, name) {
  const u = id();
  await seedAuthUser(database, { id: u, email: `${u}@statistics.test` });
  await rpc(database, u, 'dw_save_profile', {
    p_operation_id: id(),
    p_expected_revision: 0,
    p_full_name: name,
  });
  return u;
}
async function setup(database = db) {
  const host = await user(database, 'Ведущий');
  const alice = await user(database, 'Автор статистики');
  const bob = await user(database, 'Второй участник');
  await database.query('insert into private.facilitators(user_id) values($1)', [host]);
  const s = await rpc(database, host, 'dw_create_session', {
    p_operation_id: id(),
    p_title: 'Статистическая лаборатория',
    p_scope: 'municipality',
    p_region_id: 'respublika-mordoviia',
  });
  const sessionId = s.session.id;
  const invitation = await rpc(database, host, 'dw_invitation', { p_session_id: sessionId });
  for (const u of [alice, bob])
    await rpc(database, u, 'dw_join_session', { p_operation_id: id(), p_code: invitation.code });
  const env = { host, alice, bob, sessionId };
  const room = await mutation(database, env, 'dw_join_roadmap', {
    territoryKey: target(),
    dataEditionId: dataset.id,
    expectedAssignmentRevision: 0,
  });
  env.roomId = room.roadmapId;
  return env;
}
const saveInput = (e, changes = [{ year: 2025, action: 'set', value: 123 }], extra = {}) => ({
  roadmapId: e.roomId,
  metricId: metric,
  expectedRevision: 0,
  changes,
  sourceReference: 'Ведомственная форма А',
  sourceDate: '2026-01-15',
  reason: 'Уточнённые сведения территории',
  comparabilityNote: 'Границы и методика требуют сопоставления.',
  ...extra,
});
const save = (e, input = saveInput(e), who = e.alice, op = id(), database = db) =>
  mutation(database, e, 'dw_roadmap_statistics_save', input, who, op);
const snapshot = (e, database = db) =>
  rpc(database, e.alice, 'dw_roadmap_snapshot', {
    p_session_id: e.sessionId,
    p_roadmap_id: e.roomId,
  });
const team = (s, which = metric) =>
  s.series.find((item) => item.id === s.statistics.find((h) => h.metricId === which)?.seriesId);
const history = (e, extra = {}, database = db) =>
  rpc(database, e.alice, 'dw_roadmap_statistics_history', {
    p_session_id: e.sessionId,
    p_input: { roadmapId: e.roomId, metricId: metric, ...extra },
  });

before(async () => {
  db = await createTestDatabase();
  dataset = await loadRoadmapDataset({ regionIds: ['respublika-mordoviia'], fixture: true });
  await seedRoadmapDataset(db, dataset, { allowFixture: true });
});
after(async () => db?.close());

describe('Stage 6 immutable team statistics and upgrade invariants', () => {
  it('appends source-qualified versions, preserves distinct null/zero, and resets only selected observations', async () => {
    const e = await setup();
    const base = dataset.series.find((s) => s.territoryKey === target() && s.metricId === metric);
    const sourceYear = base.points.find((p) => p.value !== null).year;
    let state = await save(
      e,
      saveInput(e, [
        { year: sourceYear, action: 'set', value: 0 },
        { year: 2025, action: 'set', value: null },
      ]),
    );
    const first = team(state);
    assert.equal(first.points.find((p) => p.year === sourceYear).value, 0);
    assert.equal(first.points.find((p) => p.year === 2025).value, null);
    assert.deepEqual(first.baseSeries, base);
    assert.equal(sha(first.canonicalJson), first.fingerprint);
    const { fingerprint, canonicalJson, ...material } = first;
    assert.deepEqual(JSON.parse(canonicalJson), material);
    state = await save(
      e,
      saveInput(e, [{ year: 2024, action: 'set', value: 45 }], {
        expectedRevision: 1,
        sourceReference: 'Ведомственная форма Б',
        sourceDate: null,
      }),
    );
    assert.equal(
      team(state).overrides.find((p) => p.year === sourceYear).sourceReference,
      'Ведомственная форма А',
    );
    assert.equal(
      team(state).overrides.find((p) => p.year === 2024).sourceReference,
      'Ведомственная форма Б',
    );
    state = await save(
      e,
      saveInput(
        e,
        [
          { year: sourceYear, action: 'reset' },
          { year: 2025, action: 'reset' },
        ],
        { expectedRevision: 2 },
      ),
    );
    assert.deepEqual(
      team(state).points.find((p) => p.year === sourceYear),
      base.points.find((p) => p.year === sourceYear),
    );
    assert.equal(
      team(state).points.some((p) => p.year === 2025),
      false,
    );
    assert.deepEqual(
      team(state).overrides.map((p) => p.year),
      [2024],
    );
    const original = await db.query(
      'select material from private.dw_roadmap_series where dataset_id=$1 and id=$2',
      [dataset.id, base.id],
    );
    assert.deepEqual(original.rows[0].material, base);
    const old = await rpc(db, e.alice, 'dw_roadmap_statistics_series', {
      p_session_id: e.sessionId,
      p_input: { roadmapId: e.roomId, seriesId: first.id },
    });
    assert.deepEqual(old.series, first);
    await code(
      db.query(
        'update private.dw_roadmap_statistical_revisions set reason=$1 where roadmap_id=$2',
        ['Изменить прошлое', e.roomId],
      ),
      'STATISTICS_IMMUTABLE',
    );
    await code(
      db.query('delete from private.dw_roadmap_statistical_revisions where roadmap_id=$1', [
        e.roomId,
      ]),
      'STATISTICS_IMMUTABLE',
    );
  });

  it('serializes conflicting writers, preserves idempotence and checks current authorization before old receipts', async () => {
    const e = await setup();
    await mutation(
      db,
      e,
      'dw_join_roadmap',
      { territoryKey: target(), dataEditionId: dataset.id, expectedAssignmentRevision: 0 },
      e.bob,
    );
    const op = id();
    const input = saveInput(e);
    const first = await save(e, input, e.alice, op);
    await code(save(e, input, e.bob), 'REVISION_CONFLICT');
    assert.deepEqual(await save(e, input, e.alice, op), first);
    await code(
      save(e, { ...input, reason: 'Подмена запроса' }, e.alice, op),
      'IDEMPOTENCY_CONFLICT',
    );
    const s = await rpc(db, e.host, 'dw_session_snapshot', { p_session_id: e.sessionId });
    const member = s.members.find((m) => m.userId === e.alice);
    await rpc(db, e.host, 'dw_revoke_member', {
      p_operation_id: id(),
      p_session_id: e.sessionId,
      p_member_id: e.alice,
      p_expected_revision: member.revision,
    });
    await code(save(e, input, e.alice, op), 'FORBIDDEN');
    const still = await rpc(db, e.bob, 'dw_roadmap_snapshot', {
      p_session_id: e.sessionId,
      p_roadmap_id: e.roomId,
    });
    assert.equal(still.statistics[0].revision, 1);
    assert.equal(
      (
        await db.query(
          'select count(*)::int n from private.dw_roadmap_statistical_revisions where roadmap_id=$1',
          [e.roomId],
        )
      ).rows[0].n,
      1,
    );
  });

  it('rejects malformed patches, future observations and forged definitions atomically', async () => {
    const e = await setup();
    const inputs = [
      { ...saveInput(e), changes: [] },
      {
        ...saveInput(e),
        changes: [
          { year: 2025, action: 'set', value: 2 },
          { year: 2025, action: 'reset' },
        ],
      },
      { ...saveInput(e), changes: [{ year: 2025, action: 'set', value: -1 }] },
      { ...saveInput(e), changes: [{ year: 2025, action: 'set', value: 1.5 }] },
      { ...saveInput(e), changes: [{ year: 2025, action: 'set', value: '123' }] },
      { ...saveInput(e), changes: [{ year: 2025, action: 'reset', value: 10 }] },
      { ...saveInput(e), changes: [{ year: '2025', action: 'set', value: 123 }] },
      { ...saveInput(e), sourceReference: '  ' },
      { ...saveInput(e), reason: '' },
      { ...saveInput(e), reason: '\t\n\r' },
      { ...saveInput(e), sourceReference: '\u00a0\u202f\u2009' },
      { ...saveInput(e), sourceDate: '2025-02-30' },
      { ...saveInput(e), metricId: 'total_fertility_rate' },
      { ...saveInput(e), unit: 'children' },
      {
        ...saveInput(e),
        metricId: 'pop_mid',
        changes: [{ year: 2025, action: 'set', value: 1.1234567 }],
      },
      { ...saveInput(e), expectedRevision: 'bad' },
    ];
    for (const input of inputs) await code(save(e, input), 'INVALID_INPUT');
    const decimalDuplicate = JSON.stringify(saveInput(e)).replace(
      '"changes":[{"year":2025,"action":"set","value":123}]',
      '"changes":[{"year":2025,"action":"set","value":123},{"year":2025.0,"action":"reset"}]',
    );
    await code(
      rpc(db, e.alice, 'dw_roadmap_statistics_save', {
        p_operation_id: id(),
        p_session_id: e.sessionId,
        p_input: decimalDuplicate,
      }),
      'INVALID_INPUT',
    );
    const future = new Date().getUTCFullYear() + 1;
    await code(
      save(e, saveInput(e, [{ year: future, action: 'set', value: null }])),
      'STATISTICS_FUTURE_YEAR',
    );
    await code(
      save(
        e,
        saveInput(
          e,
          Array.from({ length: 100 }, (_, i) => ({ year: 1900 + i, action: 'set', value: i })),
          {
            sourceReference: 'А'.repeat(2000),
            reason: 'Б'.repeat(4000),
          },
        ),
      ),
      'ROADMAP_LIMIT',
    );
    assert.deepEqual((await snapshot(e)).statistics, []);
    assert.equal((await history(e)).currentRevision, 0);
    const state = await save(
      e,
      saveInput(e, [{ year: 2025, action: 'set', value: 123.123456 }], { metricId: 'pop_mid' }),
    );
    assert.equal(team(state, 'pop_mid').decimals, 6);
  });

  it('paginates the immutable author history and bounds revisions without mutating a source or leaking actor metadata into projection', async () => {
    const e = await setup();
    for (let n = 0; n < 51; n++)
      await save(
        e,
        saveInput(e, [{ year: 2025, action: 'set', value: n }], { expectedRevision: n }),
      );
    const page1 = await history(e);
    assert.equal(page1.entries.length, 50);
    assert.equal(page1.entries[0].revision, 51);
    assert.equal(page1.nextBeforeRevision, 2);
    const page2 = await history(e, { beforeRevision: page1.nextBeforeRevision });
    assert.deepEqual(
      page2.entries.map((entry) => entry.revision),
      [1],
    );
    assert.equal(page2.nextBeforeRevision, null);
    assert.equal(page2.entries[0].createdBy, e.alice);
    assert.equal(page2.entries[0].createdByName, 'Автор статистики');
    const projection = await rpc(db, e.host, 'dw_roadmaps_projector_snapshot', {
      p_session_id: e.sessionId,
      p_roadmap_id: e.roomId,
    });
    for (const identity of [e.alice, e.bob, e.host, 'Автор статистики', '@statistics.test'])
      assert.equal(JSON.stringify(projection).includes(identity), false);
    const events = await db.query(
      'select event_type from public.dw_roadmap_events where session_id=$1 and event_type=$2',
      [e.sessionId, 'roadmap.statistics_saved'],
    );
    assert.equal(events.rows.length, 51);
    await code(save(e, saveInput(e, undefined, { expectedRevision: 501 })), 'INVALID_INPUT');
    for (let n = 51; n < 500; n++)
      await mutation(db, e, 'dw_roadmap_statistics_restore', {
        roadmapId: e.roomId,
        metricId: metric,
        expectedRevision: n,
        reason: 'Проверка предела истории',
      });
    await code(
      mutation(db, e, 'dw_roadmap_statistics_restore', {
        roadmapId: e.roomId,
        metricId: metric,
        expectedRevision: 500,
        reason: 'Недопустимая следующая ревизия',
      }),
      'ROADMAP_LIMIT',
    );
    assert.equal((await history(e)).currentRevision, 500);
  });

  it('denies direct private access and all anonymous RPC execution while retaining narrow guarded wrappers', async () => {
    const e = await setup();
    const tables = await db.query(
      "select c.relname,c.relrowsecurity,has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') access from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relkind='r' and c.relname in ('dw_roadmap_statistical_revisions','dw_roadmap_statistics_heads')",
    );
    assert.equal(tables.rows.length, 2);
    assert.ok(tables.rows.every((t) => t.relrowsecurity && !t.access));
    await assert.rejects(
      asUser(db, e.alice, (tx) =>
        tx.query('select private.dw_s6_resolve_series($1,$2)', [e.roomId, 'anything']),
      ),
      (err) => err.code === '42501',
    );
    const functions = await db.query(
      "select n.nspname,p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon_exec,has_function_privilege('authenticated',p.oid,'EXECUTE') auth_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public') and (p.proname like 'dw_s6_%' or p.proname like 'dw_roadmap_statistics_%')",
    );
    const allowed = [
      'dw_roadmap_statistics_save',
      'dw_roadmap_statistics_restore',
      'dw_roadmap_statistics_history',
      'dw_roadmap_statistics_series',
    ];
    assert.ok(
      functions.rows.every((f) => !f.anon_exec && f.auth_exec === allowed.includes(f.proname)),
    );
    assert.ok(functions.rows.filter((f) => f.nspname === 'public').every((f) => !f.prosecdef));
    assert.ok(functions.rows.every((f) => f.proconfig.includes('search_path=""')));
    const outsider = await user(db, 'Другой слушатель');
    await code(save(e, saveInput(e), outsider), 'FORBIDDEN');
    await code(save(e, saveInput(e), e.bob), 'ROADMAP_ROOM_REQUIRED');
  });

  it('upgrades a populated 0.5 without rewriting frozen schema-1 bytes, captured facts, source records, or receipts', async () => {
    const prior = new PGlite();
    try {
      await prior.exec(
        await readFile(resolve(projectRoot, 'tests/database/bootstrap.sql'), 'utf8'),
      );
      const dir = resolve(projectRoot, 'supabase/migrations');
      const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
      const stage6 = files.find((file) => file.includes('stage6'));
      assert.ok(stage6);
      for (const file of files.filter((file) => file < stage6))
        await prior.exec(await readFile(resolve(dir, file), 'utf8'));
      await seedCanonicalDocument(prior, await loadMordovia());
      await seedRoadmapDataset(prior, dataset, { allowFixture: true });
      const e = await setup(prior);
      const base = dataset.series.find((s) => s.territoryKey === target() && s.metricId === metric);
      const point = base.points.find((p) => p.value !== null);
      const factInput = {
        roadmapId: e.roomId,
        itemId: null,
        expectedRevision: 0,
        seriesId: base.id,
        expectedSeriesFingerprint: base.fingerprint,
        year: point.year,
        interpretation: 'Исходный уровень до актуализации',
      };
      const operation = id();
      const captured = await mutation(
        prior,
        e,
        'dw_capture_roadmap_fact',
        factInput,
        e.alice,
        operation,
      );
      const fact = captured.items.find((i) => i.kind === 'fact');
      const frozen = await mutation(prior, e, 'dw_freeze_roadmap', {
        roadmapId: e.roomId,
        expectedRevision: captured.revision,
        title: 'Версия 0.5',
        kind: 'draft',
      });
      const versionArgs = {
        p_session_id: e.sessionId,
        p_roadmap_id: e.roomId,
        p_version_id: frozen.versions[0].id,
      };
      const versionBefore = await rpc(prior, e.alice, 'dw_roadmap_version', versionArgs);
      assert.equal(versionBefore.snapshot.schemaVersion, 1);
      assert.equal('statistics' in versionBefore.snapshot, false);
      const sourceBefore = await prior.query(
        'select canonical_text,fingerprint,material::text bytes from private.dw_roadmap_series where dataset_id=$1 and id=$2',
        [dataset.id, base.id],
      );
      const receiptsBefore = await prior.query(
        'select count(*)::int n from private.command_receipts',
      );
      await prior.exec(await readFile(resolve(dir, stage6), 'utf8'));
      assert.deepEqual(await rpc(prior, e.alice, 'dw_roadmap_version', versionArgs), versionBefore);
      const afterUpgrade = await snapshot(e, prior);
      assert.deepEqual(afterUpgrade.statistics, []);
      assert.deepEqual(
        afterUpgrade.items.find((i) => i.id === fact.id),
        fact,
      );
      assert.equal(
        (await prior.query('select count(*)::int n from private.command_receipts')).rows[0].n,
        receiptsBefore.rows[0].n,
      );
      const changed = await save(
        e,
        saveInput(e, [{ year: point.year, action: 'set', value: point.value + 999 }]),
        e.alice,
        id(),
        prior,
      );
      assert.equal(
        team(changed).points.find((p) => p.year === point.year).value,
        point.value + 999,
      );
      assert.deepEqual(
        changed.items.find((i) => i.id === fact.id),
        fact,
      );
      assert.deepEqual(await rpc(prior, e.alice, 'dw_roadmap_version', versionArgs), versionBefore);
      assert.deepEqual(
        (
          await prior.query(
            'select canonical_text,fingerprint,material::text bytes from private.dw_roadmap_series where dataset_id=$1 and id=$2',
            [dataset.id, base.id],
          )
        ).rows,
        sourceBefore.rows,
      );
      const replay = await mutation(
        prior,
        e,
        'dw_capture_roadmap_fact',
        factInput,
        e.alice,
        operation,
      );
      assert.equal(replay.items.filter((i) => i.kind === 'fact').length, 1);
      assert.deepEqual(
        replay.items.find((i) => i.id === fact.id),
        fact,
      );
      const next = await mutation(prior, e, 'dw_freeze_roadmap', {
        roadmapId: e.roomId,
        expectedRevision: replay.revision,
        title: 'Версия 0.6',
        kind: 'draft',
      });
      const newVersion = await rpc(prior, e.alice, 'dw_roadmap_version', {
        ...versionArgs,
        p_version_id: next.versions.find((v) => v.number === 2).id,
      });
      assert.equal(newVersion.snapshot.schemaVersion, 2);
      assert.equal(newVersion.snapshot.statistics[0].revision, 1);
      assert.equal(sha(newVersion.canonicalJson), newVersion.sha256);
    } finally {
      await prior.close();
    }
  });

  it('keeps the four released migration checksums unchanged', async () => {
    const expected = {
      '20261108131424_stage2_collaborative_sessions.sql':
        'a70f4eeec6700bfd259a18e922d0a307340709437252a6c22bf19faee326369d',
      '20261108172311_stage3_regions_families_voting.sql':
        '867e7d8d1fbbc2103092a5522a8e868f390e1a711205b9a9a25455fe837342e7',
      '20261108220024_stage4_barriers_evidence_surveys.sql':
        '2b1191b939d7af9929ee73a8ca847b758f9b4ddf54f612e2e283fdea45b9ede9',
      '20261108225303_stage5_territorial_roadmaps.sql':
        'dd26f20cc2b43ea6bda4b224fe247484e3024116a398f861a4b07db8210257d3',
    };
    for (const [file, fingerprint] of Object.entries(expected))
      assert.equal(
        sha(await readFile(resolve(projectRoot, 'supabase/migrations', file))),
        fingerprint,
      );
  });
});
