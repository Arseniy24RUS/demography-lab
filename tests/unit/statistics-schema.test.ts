import { describe, expect, it } from 'vitest';
import {
  saveStatisticsInputSchema,
  parseTeamStatisticalSeries,
  statisticsHistorySchema,
} from '../../packages/statistics/schema';
import { parseFrozenRoadmapData, parseRoadmapVersion } from '../../packages/roadmaps/schema';
import {
  makeTeamStatistics,
  makeStatisticsExportFixture,
  statisticsOverride,
} from './statistics.fixture';
import { makeRoadmapExportFixture, uuid } from './roadmap-export.fixture';

const input = () => ({
  roadmapId: uuid(1),
  metricId: 'births_total',
  expectedRevision: 0,
  changes: [{ year: 2025, action: 'set', value: 0 }],
  sourceReference: 'Муниципальный отчёт',
  sourceDate: null,
  reason: 'Уточнение полного годового наблюдения',
  comparabilityNote: '',
});

describe('closed statistics contracts', () => {
  it('accepts deliberate missing values and resets, rejecting unknown fields, duplicate years and false metric semantics', () => {
    expect(saveStatisticsInputSchema.parse(input()).changes[0]).toMatchObject({ value: 0 });
    expect(
      saveStatisticsInputSchema.parse({
        ...input(),
        changes: [{ year: 2025, action: 'set', value: null }],
      }).changes[0],
    ).toMatchObject({ value: null });
    expect(
      saveStatisticsInputSchema.parse({ ...input(), changes: [{ year: 2025, action: 'reset' }] })
        .changes[0],
    ).toEqual({ year: 2025, action: 'reset' });
    for (const bad of [
      { ...input(), unit: 'children' },
      { ...input(), metricId: 'tfr' },
      { ...input(), sourceReference: '\u202f\t' },
      { ...input(), changes: [{ year: 2025, action: 'set', value: -1 }] },
      { ...input(), changes: [{ year: 2025, action: 'set', value: 1.5 }] },
      { ...input(), changes: [{ year: 2025, action: 'reset', value: 0 }] },
      {
        ...input(),
        changes: [
          { year: 2025, action: 'set', value: 0 },
          { year: 2025, action: 'reset' },
        ],
      },
      {
        ...input(),
        changes: [{ year: new Date().getUTCFullYear() + 1, action: 'set', value: null }],
      },
    ])
      expect(saveStatisticsInputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an internally inconsistent or incorrectly attributed team material even when its JSON text was reserialized', async () => {
    const good = await makeTeamStatistics(null, [statisticsOverride(2025, 0)]);
    expect(parseTeamStatisticalSeries(good).points[0]!.value).toBe(0);
    const resealJson = (value: unknown) => {
      const object = structuredClone(value) as Record<string, unknown>;
      const { canonicalJson: _json, fingerprint: _fp, ...material } = object;
      object.canonicalJson = JSON.stringify(material);
      return object;
    };
    for (const bad of [
      { ...good, sourceKind: 'source_reported' },
      { ...good, sourceSha256: 'a'.repeat(64) },
      { ...good, createdBy: uuid(8) },
      { ...good, unit: 'percent' },
      { ...good, semanticType: 'stock' },
      { ...good, points: [{ year: 2025, value: null }] },
      { ...good, overrides: [{ ...good.overrides[0]!, revision: 2 }] },
      {
        ...good,
        points: [
          { year: 2025, value: 0 },
          { year: 2025, value: 0 },
        ],
      },
    ])
      expect(() => parseTeamStatisticalSeries(resealJson(bad))).toThrow();
  });

  it('requires exact current head references in schema-2 frozen material while permitting pinned older series', async () => {
    const { version, v1, v2 } = await makeStatisticsExportFixture();
    expect(parseFrozenRoadmapData(version.snapshot).series.some((s) => s.id === v1.id)).toBe(true);
    const invalid = structuredClone(version.snapshot);
    invalid.statistics![0]!.revision = 1;
    expect(() => parseFrozenRoadmapData(invalid)).toThrow();
    invalid.statistics![0]!.revision = 2;
    invalid.series = invalid.series.filter((s) => s.id !== v2.id);
    expect(() => parseFrozenRoadmapData(invalid)).toThrow();
    invalid.series = version.snapshot.series;
    delete invalid.statistics;
    expect(() => parseFrozenRoadmapData(invalid)).toThrow();
  });

  it('keeps legacy frozen schema-1 objects byte equivalent without adding defaults or admitting new-format material', async () => {
    const version = await makeRoadmapExportFixture();
    const bytes = version.canonicalJson;
    expect(parseRoadmapVersion(version).canonicalJson).toBe(bytes);
    expect(parseFrozenRoadmapData(version.snapshot)).toEqual(version.snapshot);
    expect('statistics' in parseFrozenRoadmapData(version.snapshot)).toBe(false);
    expect(() => parseFrozenRoadmapData({ ...version.snapshot, statistics: [] })).toThrow();
  });

  it('rejects reordered, future or duplicate history revisions rather than presenting misleading audit order', () => {
    const entry = {
      revision: 1,
      action: 'save',
      seriesId: 'series-1',
      createdAt: '2026-01-01T12:00:00.000Z',
      createdBy: uuid(1),
      createdByName: 'Автор',
      sourceReference: 'Отчёт',
      sourceDate: null,
      reason: 'Уточнение',
    };
    const good = {
      roadmapId: uuid(1),
      metricId: 'births_total',
      currentRevision: 2,
      entries: [{ ...entry, revision: 2 }, entry],
      nextBeforeRevision: null,
    };
    expect(statisticsHistorySchema.safeParse(good).success).toBe(true);
    expect(statisticsHistorySchema.safeParse({ ...good, entries: [entry, entry] }).success).toBe(
      false,
    );
    expect(statisticsHistorySchema.safeParse({ ...good, currentRevision: 1 }).success).toBe(false);
    expect(
      statisticsHistorySchema.safeParse({ ...good, entries: [...good.entries].reverse() }).success,
    ).toBe(false);
  });
});
