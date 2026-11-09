import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FIXTURE_IDENTITIES } from '../../scripts/test-collaboration-gateway.mjs';
import {
  adaptCanonicalSeries,
  verifyCanonicalSeriesFingerprint,
} from '../../packages/territories/series.mjs';
import {
  startWorkshopHarness,
  successfulRpc as rpc,
  rejectedRpc,
} from './workshop-test-support.mjs';
import { assertNoKeys, named, sessionSnapshot } from './barriers-test-support.mjs';

const dataIndex = JSON.parse(
  await readFile(new URL('../../public/data/territories/index.json', import.meta.url), 'utf8'),
);
const registry = JSON.parse(
  await readFile(new URL('../../public/data/territories/registry.json', import.meta.url), 'utf8'),
);
const statistics = JSON.parse(
  await readFile(
    new URL(
      '../../public/data/territories/regions/respublika-mordoviia.statistics.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const canonical = await adaptCanonicalSeries(dataIndex, registry, statistics);
const canonicalBytes = JSON.stringify(canonical);
const ARDATOV = 'rudn-mun-72196-894';
const SARANSK = 'rudn-mun-72196-904';
const SOURCE = 'Муниципальная годовая сводка; учебный источник для проверки актуализации';
const REASON = 'Уточнение по более поздней годовой сводке муниципалитета.';
let harness;

const index = (sdk, sessionId) => rpc(sdk, 'dw_roadmaps_index', { p_session_id: sessionId });
const snapshot = (sdk, sessionId, roadmapId) =>
  rpc(sdk, 'dw_roadmap_snapshot', { p_session_id: sessionId, p_roadmap_id: roadmapId });
const imported = (metricId) => {
  const result = canonical.find(
    (series) => series.territoryKey === ARDATOV && series.metricId === metricId,
  );
  assert.ok(result, `Missing prepared fixture: ${metricId}`);
  return result;
};
const head = (state, metricId) => {
  const result = state.statistics?.find((item) => item.metricId === metricId);
  return (
    result ?? {
      metricId,
      revision: 0,
      mode: 'imported',
      seriesId:
        canonical.find(
          (series) => series.territoryKey === state.territory.key && series.metricId === metricId,
        )?.id ?? null,
    }
  );
};
const selected = (state, metricId) => {
  const current = head(state, metricId);
  const result = state.series.find((series) => series.id === current.seriesId);
  assert.ok(result, `Current series must be present: ${metricId}/${current.seriesId}`);
  return result;
};
const point = (series, year) => series.points.find((entry) => entry.year === year);
const set = (year, value) => ({ year, action: 'set', value });
const reset = (year) => ({ year, action: 'reset' });
const saveInput = (state, metricId, changes, extra = {}) => ({
  roadmapId: state.roadmapId,
  metricId,
  expectedRevision: head(state, metricId).revision,
  changes,
  sourceReference: SOURCE,
  sourceDate: '2026-10-01',
  reason: REASON,
  comparabilityNote: 'Границы и методика требуют самостоятельной проверки команды.',
  ...extra,
});
const save = (sdk, sessionId, state, metricId, changes, extra) =>
  rpc(
    sdk,
    'dw_roadmap_statistics_save',
    named(sessionId, saveInput(state, metricId, changes, extra)),
  );
const restore = (sdk, sessionId, state, metricId) =>
  rpc(
    sdk,
    'dw_roadmap_statistics_restore',
    named(sessionId, {
      roadmapId: state.roadmapId,
      metricId,
      expectedRevision: head(state, metricId).revision,
      reason: 'Команда возвращается к исходному импортированному ряду.',
    }),
  );
const history = (sdk, sessionId, roadmapId, metricId, extra = {}) =>
  rpc(sdk, 'dw_roadmap_statistics_history', {
    p_session_id: sessionId,
    p_input: { roadmapId, metricId, ...extra },
  });
const oldSeries = (sdk, sessionId, roadmapId, seriesId) =>
  rpc(sdk, 'dw_roadmap_statistics_series', {
    p_session_id: sessionId,
    p_input: { roadmapId, seriesId },
  });
const createItem = (state, kind, data) => ({
  roadmapId: state.roadmapId,
  itemId: null,
  expectedRevision: 0,
  kind,
  data,
  status: 'active',
});
const scenario = (series, extra = {}) => ({
  title: 'Сценарий на закреплённом статистическом основании',
  seriesId: series.id,
  seriesFingerprint: series.fingerprint,
  assumptions: 'Условная траектория; не оценка эффекта мероприятий.',
  parameters: {
    metricId: series.metricId,
    historyStartYear: 2018,
    historyEndYear: 2022,
    endYear: 2027,
    baselineMethod: 'last_value',
    targetMode: 'absolute_end',
    targetValue: 150,
    ...extra,
  },
});
const captureFact = (sdk, sessionId, state, series, year) =>
  rpc(
    sdk,
    'dw_capture_roadmap_fact',
    named(sessionId, {
      roadmapId: state.roadmapId,
      itemId: null,
      expectedRevision: 0,
      seriesId: series.id,
      expectedSeriesFingerprint: series.fingerprint,
      year,
      interpretation: 'Факт команды с явно сохранённым источником и версией.',
    }),
  );

async function rejected(sdk, name, args, pattern) {
  const error = await rejectedRpc(sdk, name, args, pattern);
  assert.ok(
    ['P0001', '42501'].includes(error.code),
    `Expected guarded domain rejection, not SQL failure: ${JSON.stringify(error)}`,
  );
  return error;
}

async function classroom(options = {}) {
  const context = await harness.classroom({ includeBob: true, ...options });
  const current = await index(context.host, context.sessionId);
  await rpc(
    context.host,
    'dw_configure_roadmaps',
    named(context.sessionId, {
      expectedRevision: current.configuration.revision,
      roomLevel: 'municipality',
    }),
  );
  return context;
}
async function join(sdk, sessionId, territoryKey = ARDATOV) {
  const current = await index(sdk, sessionId);
  return rpc(
    sdk,
    'dw_join_roadmap',
    named(sessionId, {
      territoryKey,
      dataEditionId: dataIndex.editionId,
      expectedAssignmentRevision: current.assignmentRevision,
    }),
  );
}

describe(
  'Stage 6: team statistical revisions through Supabase SDK, HTTP and real SQL',
  { concurrency: false },
  () => {
    before(async () => {
      harness = await startWorkshopHarness();
    });
    beforeEach(async () => {
      await harness.reset();
    });
    after(async () => {
      await harness?.close();
    });

    it('edits all seven standard metrics without rewriting imported values or definitions', async () => {
      const { alice, bob, sessionId } = await classroom();
      let state = await join(alice, sessionId);
      await join(bob, sessionId);
      const values = {
        births_total: 301,
        deaths_total: 450,
        pop_mid: 27000.5,
        mig_in_total: 650,
        mig_out_total: 950,
        mig_net_total: -300,
        natural_change: -149,
      };
      for (const [metricId, value] of Object.entries(values)) {
        state = await save(alice, sessionId, state, metricId, [set(2014, value)]);
        const revised = selected(state, metricId);
        const source = imported(metricId);
        assert.equal(head(state, metricId).revision, 1);
        assert.equal(head(state, metricId).mode, 'team');
        assert.equal(point(revised, 2014).value, value);
        assert.equal(revised.sourceKind, 'team_reported');
        assert.equal(revised.provenanceStatus, 'participant_supplied');
        assert.equal(revised.sourceReference, SOURCE);
        assert.equal(revised.sourceDate, '2026-10-01');
        assert.equal(revised.reason, REASON);
        assert.notEqual(revised.id, source.id);
        assert.notEqual(revised.fingerprint, source.fingerprint);
        assert.deepEqual(revised.baseSeries, source);
        for (const key of [
          'title',
          'unit',
          'semanticType',
          'valueDomain',
          'aggregation',
          'reference',
        ]) {
          assert.equal(
            revised[key],
            source[key],
            `Definition must remain fixed: ${metricId}/${key}`,
          );
        }
        assert.equal(revised.decimals, metricId === 'pop_mid' ? 6 : 0);
        assert.equal(revised.sourceEditionId, 'team-statistics-v1');
        assert.equal(Object.hasOwn(revised, 'sourceSha256'), false);
        assert.equal(
          createHash('sha256').update(revised.canonicalJson).digest('hex'),
          revised.fingerprint,
        );
        const { canonicalJson, fingerprint: _fingerprint, ...material } = revised;
        assert.deepEqual(JSON.parse(canonicalJson), material);
        assert.equal(await verifyCanonicalSeriesFingerprint(revised.baseSeries), true);
      }
      const shared = await snapshot(bob, sessionId, state.roadmapId);
      for (const [metricId, value] of Object.entries(values))
        assert.equal(point(selected(shared, metricId), 2014).value, value);
      assert.equal(JSON.stringify(canonical), canonicalBytes);
      const fresh = await harness.signIn('participant-a@workshop.test');
      assert.deepEqual(
        (await snapshot(fresh, sessionId, state.roadmapId)).statistics,
        state.statistics,
      );
    });

    it('distinguishes zero, explicit null, inserted historical years and resetting each point', async () => {
      const { alice, sessionId } = await classroom();
      let state = await join(alice, sessionId);
      state = await save(alice, sessionId, state, 'births_total', [
        set(2014, 0),
        set(2015, null),
        set(2024, 31),
        set(2025, null),
      ]);
      const first = selected(state, 'births_total');
      assert.equal(point(first, 2014).value, 0);
      assert.equal(point(first, 2015).value, null);
      assert.equal(point(first, 2024).value, 31);
      assert.equal(point(first, 2025).value, null);
      state = await captureFact(alice, sessionId, state, first, 2014);
      assert.equal(state.items.find((item) => item.kind === 'fact').data.value, 0);
      await rejected(
        alice,
        'dw_capture_roadmap_fact',
        named(sessionId, {
          roadmapId: state.roadmapId,
          itemId: null,
          expectedRevision: 0,
          seriesId: first.id,
          expectedSeriesFingerprint: first.fingerprint,
          year: 2015,
          interpretation: 'Пропуск не является нулём.',
        }),
        /SOURCE_VALUE_MISSING/,
      );
      state = await save(alice, sessionId, state, 'births_total', [reset(2014), reset(2024)], {
        sourceReference: 'Протокол сопоставления с исходной редакцией',
        reason: 'Два значения возвращены к источнику.',
      });
      assert.equal(point(selected(state, 'births_total'), 2014).value, 253);
      assert.equal(point(selected(state, 'births_total'), 2024), undefined);
      assert.equal(point(selected(state, 'births_total'), 2015).value, null);
      assert.equal(
        selected(state, 'births_total').overrides.find((entry) => entry.year === 2015)
          .sourceReference,
        SOURCE,
        'Later provenance must not overwrite the source of an untouched observation',
      );
      assert.equal(
        point((await oldSeries(alice, sessionId, state.roadmapId, first.id)).series, 2024).value,
        31,
      );
      state = await restore(alice, sessionId, state, 'births_total');
      assert.equal(head(state, 'births_total').revision, 3);
      assert.equal(head(state, 'births_total').mode, 'imported');
      assert.equal(head(state, 'births_total').seriesId, imported('births_total').id);
      assert.equal(state.items.find((item) => item.kind === 'fact').data.value, 0);
      assert.equal(
        point((await oldSeries(alice, sessionId, state.roadmapId, first.id)).series, 2014).value,
        0,
      );
      const audit = await history(alice, sessionId, state.roadmapId, 'births_total');
      assert.equal(audit.currentRevision, 3);
      assert.deepEqual(
        audit.entries.map((entry) => [entry.revision, entry.action]),
        [
          [3, 'restore'],
          [2, 'save'],
          [1, 'save'],
        ],
      );
      assert.equal(
        audit.entries[1].createdBy,
        FIXTURE_IDENTITIES['participant-a@workshop.test'].id,
      );
      assert.ok(audit.entries[1].createdByName.length > 0);
    });

    it('detects same-metric conflicts, permits independent metrics and replays a lost response once', async () => {
      const { alice, bob, sessionId } = await classroom();
      const initial = await join(alice, sessionId);
      await join(bob, sessionId);
      const cursor = await rpc(alice, 'dw_roadmaps_cursor', { p_session_id: sessionId });
      const firstCommand = named(sessionId, saveInput(initial, 'births_total', [set(2024, 310)]));
      const first = await rpc(alice, 'dw_roadmap_statistics_save', firstCommand);
      await rejected(
        bob,
        'dw_roadmap_statistics_save',
        named(sessionId, saveInput(initial, 'births_total', [set(2024, 315)])),
        /REVISION_CONFLICT/,
      );
      const independent = await save(bob, sessionId, initial, 'deaths_total', [set(2024, 440)]);
      assert.equal(point(selected(independent, 'births_total'), 2024).value, 310);
      assert.equal(point(selected(independent, 'deaths_total'), 2024).value, 440);
      const second = await save(bob, sessionId, independent, 'births_total', [set(2024, 320)]);
      await rpc(alice, 'dw_roadmap_statistics_save', firstCommand);
      const current = await snapshot(alice, sessionId, initial.roadmapId);
      assert.equal(head(current, 'births_total').revision, 2);
      assert.equal(point(selected(current, 'births_total'), 2024).value, 320);
      assert.equal(
        (await history(alice, sessionId, initial.roadmapId, 'births_total')).entries.length,
        2,
      );
      assert.notEqual(head(first, 'births_total').seriesId, head(second, 'births_total').seriesId);
      assert.ok((await rpc(alice, 'dw_roadmaps_cursor', { p_session_id: sessionId })) > cursor);
    });

    it('rejects malformed metadata, impossible domains, future observations and forged source fields', async () => {
      const { alice, sessionId } = await classroom();
      const state = await join(alice, sessionId);
      const valid = saveInput(state, 'births_total', [set(2024, 150)]);
      const bad = [
        { sourceReference: '' },
        { reason: '  ' },
        { sourceDate: '2026-02-30' },
        { changes: [set(2024, -1)] },
        { changes: [set(2024, 1.5)] },
        { changes: [set(2024.5, 12)] },
        { changes: [set(2024, '150')] },
        { changes: [set(2024, 12), set(2024, 14)] },
        { changes: [set(2024, 1e300)] },
        { metricId: 'fabricated_metric' },
        { sourceKind: 'source_reported' },
        { baseSeries: imported('births_total') },
      ];
      for (const patch of bad)
        await rejected(
          alice,
          'dw_roadmap_statistics_save',
          named(sessionId, { ...valid, ...patch }),
          /INVALID_INPUT/,
        );
      await rejected(
        alice,
        'dw_roadmap_statistics_save',
        named(sessionId, { ...valid, changes: [set(new Date().getUTCFullYear() + 1, 150)] }),
        /STATISTICS_FUTURE_YEAR/,
      );
      assert.equal(
        head(await snapshot(alice, sessionId, state.roadmapId), 'births_total').revision,
        0,
      );
      const allMissing = await save(
        alice,
        sessionId,
        state,
        'births_total',
        imported('births_total').points.map(({ year }) => set(year, null)),
        { sourceDate: null },
      );
      assert.ok(selected(allMissing, 'births_total').points.every((entry) => entry.value === null));
      assert.equal(selected(allMissing, 'births_total').sourceDate, null);
    });

    it('pins old facts, scenarios and frozen bytes while a new year becomes an explicit new scenario anchor', async () => {
      const { alice, sessionId } = await classroom();
      let state = await join(alice, sessionId);
      const source = imported('births_total');
      state = await captureFact(alice, sessionId, state, source, 2014);
      const originalFact = state.items.find((item) => item.kind === 'fact');
      state = await rpc(
        alice,
        'dw_save_roadmap_item',
        named(sessionId, createItem(state, 'scenario', scenario(source))),
      );
      const originalScenario = state.items.find((item) => item.kind === 'scenario');
      state = await rpc(
        alice,
        'dw_freeze_roadmap',
        named(sessionId, {
          roadmapId: state.roadmapId,
          expectedRevision: state.revision,
          title: 'До уточнения исходных данных',
          kind: 'draft',
        }),
      );
      const versionRequest = {
        p_session_id: sessionId,
        p_roadmap_id: state.roadmapId,
        p_version_id: state.versions[0].id,
      };
      const before = await rpc(alice, 'dw_roadmap_version', versionRequest);
      state = await save(alice, sessionId, state, 'births_total', [set(2014, 301), set(2024, 155)]);
      const team = selected(state, 'births_total');
      assert.deepEqual(
        state.items.find((item) => item.id === originalFact.id).data,
        originalFact.data,
      );
      assert.deepEqual(
        state.items.find((item) => item.id === originalScenario.id).data,
        originalScenario.data,
      );
      state = await captureFact(alice, sessionId, state, team, 2024);
      const revisedFact = state.items.find(
        (item) => item.kind === 'fact' && item.data.seriesId === team.id,
      );
      assert.equal(revisedFact.data.value, 155);
      assert.equal(revisedFact.data.sourceKind, 'team_statistics');
      await rejected(
        alice,
        'dw_save_roadmap_item',
        named(sessionId, {
          roadmapId: state.roadmapId,
          itemId: revisedFact.id,
          expectedRevision: revisedFact.revision,
          kind: 'fact',
          status: 'active',
          data: { ...revisedFact.data, value: 999 },
        }),
      );
      state = await rpc(
        alice,
        'dw_save_roadmap_item',
        named(
          sessionId,
          createItem(
            state,
            'scenario',
            scenario(team, {
              historyStartYear: 2024,
              historyEndYear: 2024,
              endYear: 2027,
            }),
          ),
        ),
      );
      const teamScenario = state.items.find(
        (item) => item.kind === 'scenario' && item.data.seriesId === team.id,
      );
      assert.equal(teamScenario.data.parameters.historyEndYear, 2024);
      state = await restore(alice, sessionId, state, 'births_total');
      assert.ok(
        state.series.some((series) => series.id === team.id),
        'Referenced historical team series remains available after restore',
      );
      assert.equal(
        state.items.find((item) => item.id === teamScenario.id).data.seriesFingerprint,
        team.fingerprint,
      );
      const after = await rpc(alice, 'dw_roadmap_version', versionRequest);
      assert.equal(after.canonicalJson, before.canonicalJson);
      assert.equal(after.sha256, before.sha256);
      assert.equal(createHash('sha256').update(after.canonicalJson).digest('hex'), after.sha256);
      assert.deepEqual(JSON.parse(after.canonicalJson), after.snapshot);
      state = await rpc(
        alice,
        'dw_freeze_roadmap',
        named(sessionId, {
          roadmapId: state.roadmapId,
          expectedRevision: state.revision,
          title: 'После возврата к источнику с сохранением оснований',
          kind: 'draft',
        }),
      );
      const frozen = await rpc(alice, 'dw_roadmap_version', {
        ...versionRequest,
        p_version_id: state.versions.find((version) => version.title.startsWith('После')).id,
      });
      assert.ok(frozen.snapshot.series.some((series) => series.id === team.id));
      assert.ok(frozen.snapshot.series.some((series) => series.id === source.id));
      assert.equal(
        frozen.snapshot.statistics.find((entry) => entry.metricId === 'births_total').mode,
        'imported',
      );
    });

    for (const [scope, territoryKey, regionId] of [
      ['municipality', 'rudn-mun-108081-1730', 'stavropolskii-krai'],
      ['region', 'region:respublika-mordoviia', 'respublika-mordoviia'],
      ['federal', 'federal:ru', null],
    ]) {
      it(`creates and restores a manually reported ${scope} series when there is no imported statistical row`, async () => {
        const host = await harness.signIn('teacher@workshop.test', 'Преподаватель проверки уровня');
        const created = await rpc(host, 'dw_create_session', {
          p_operation_id: randomUUID(),
          p_title: 'Проверка статистики без исходного ряда',
          p_scope: scope,
          p_region_id: regionId,
        });
        const sessionId = created.session.id;
        let state = await join(host, sessionId, territoryKey);
        assert.equal(head(state, 'births_total').seriesId, null);
        state = await save(
          host,
          sessionId,
          state,
          'births_total',
          [set(2024, 600), set(2025, 610)],
          { sourceDate: null },
        );
        const team = selected(state, 'births_total');
        assert.equal(team.baseSeries, null);
        assert.equal(team.territoryKey, territoryKey);
        assert.equal(team.provenanceStatus, 'participant_supplied');
        assert.deepEqual(team.points, [
          { year: 2024, value: 600 },
          { year: 2025, value: 610 },
        ]);
        state = await captureFact(host, sessionId, state, team, 2025);
        assert.equal(state.items.find((item) => item.kind === 'fact').data.value, 610);
        state = await rpc(
          host,
          'dw_save_roadmap_item',
          named(
            sessionId,
            createItem(
              state,
              'scenario',
              scenario(team, { historyStartYear: 2024, historyEndYear: 2025, endYear: 2028 }),
            ),
          ),
        );
        state = await restore(host, sessionId, state, 'births_total');
        assert.equal(head(state, 'births_total').mode, 'imported');
        assert.equal(head(state, 'births_total').seriesId, null);
        assert.ok(state.series.some((series) => series.id === team.id));
        assert.equal(
          (await oldSeries(host, sessionId, state.roadmapId, team.id)).series.id,
          team.id,
        );
      });
    }

    it('restricts edits to the current team and strips authors from projector while retaining source provenance', async () => {
      const { host, alice, bob, observer, sessionId } = await classroom({ includeObserver: true });
      let state = await join(alice, sessionId);
      await join(bob, sessionId, SARANSK);
      const command = named(sessionId, saveInput(state, 'births_total', [set(2024, 155)]));
      await rejected(bob, 'dw_roadmap_statistics_save', command, /FORBIDDEN|ROADMAP_ROOM_REQUIRED/);
      await rejected(observer, 'dw_roadmap_statistics_save', command, /FORBIDDEN/);
      state = await rpc(alice, 'dw_roadmap_statistics_save', command);
      const team = selected(state, 'births_total');
      state = await rpc(
        alice,
        'dw_save_roadmap_item',
        named(
          sessionId,
          createItem(
            state,
            'scenario',
            scenario(team, { historyStartYear: 2024, historyEndYear: 2024 }),
          ),
        ),
      );
      const projection = await rpc(host, 'dw_roadmaps_projector_snapshot', {
        p_session_id: sessionId,
        p_roadmap_id: state.roadmapId,
      });
      assertNoKeys(
        projection,
        new Set([
          'userId',
          'authorId',
          'createdBy',
          'updatedBy',
          'createdByName',
          'updatedByName',
          'members',
          'teamNames',
          'email',
          'responseSecret',
          'answerBarrier',
          'answerSupport',
        ]),
      );
      assert.ok(projection.selected.series.some((series) => series.id === team.id));
      assert.equal(
        point(
          projection.selected.series.find((series) => series.id === team.id),
          2024,
        ).value,
        155,
      );
      const sourceOwner = await sessionSnapshot(host, sessionId);
      const member = sourceOwner.members.find(
        (entry) => entry.userId === FIXTURE_IDENTITIES['participant-a@workshop.test'].id,
      );
      await rpc(host, 'dw_revoke_member', {
        p_operation_id: randomUUID(),
        p_session_id: sessionId,
        p_member_id: member.userId,
        p_expected_revision: member.revision,
      });
      await rejected(alice, 'dw_roadmap_statistics_save', command, /FORBIDDEN/);
      await rejected(
        alice,
        'dw_roadmap_statistics_history',
        {
          p_session_id: sessionId,
          p_input: { roadmapId: state.roadmapId, metricId: 'births_total' },
        },
        /FORBIDDEN/,
      );
      await rejected(
        alice,
        'dw_roadmap_statistics_series',
        { p_session_id: sessionId, p_input: { roadmapId: state.roadmapId, seriesId: team.id } },
        /FORBIDDEN/,
      );
      assert.equal(
        (await history(host, sessionId, state.roadmapId, 'births_total')).entries.length,
        1,
      );
    });
  },
);
