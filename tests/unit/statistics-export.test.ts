import { describe, expect, it } from 'vitest';
import { prepareRoadmapExport, roadmapJson } from '../../packages/export/model';
import { makeStatisticsExportFixture } from './statistics.fixture';
import { resealFixture } from './roadmap-export.fixture';

describe('manual statistics in immutable document exports', () => {
  it('exports original and used values, per-year sources and the explicitly pinned earlier edition', async () => {
    const { version, v1, v2, manualScenarioId } = await makeStatisticsExportFixture();
    const prepared = await prepareRoadmapExport(version);
    const text = prepared.blocks
      .map((block) =>
        block.kind === 'table'
          ? `${block.caption}\n${block.rows.map((row) => row.join('|')).join('\n')}`
          : block.kind === 'paragraph'
            ? `${block.label}: ${block.text}`
            : block.kind === 'heading'
              ? block.text
              : '',
      )
      .join('\n');
    expect(text).toContain('Исходные и используемые значения');
    expect(text).toContain('2023|Нет данных|0|Участники');
    expect(text).toContain('2024|Год отсутствует|Нет данных|Участники');
    expect(text).toContain('2018|204|205|Участники');
    expect(text).toContain('значение подтверждено без изменения');
    expect(text).toContain(v1.sourceReference);
    expect(text).toContain(v2.sourceReference);
    expect(text).toContain('Рабочая редакция статистики изменилась');
    expect(text).toContain('Дата источника этого наблюдения: 12.03.2026');
    const json = JSON.parse(roadmapJson(prepared));
    expect(json.snapshot.statistics[0].seriesId).toBe(v2.id);
    expect(
      json.calculations.scenarios.find((row: { itemId: string }) => row.itemId === manualScenarioId)
        .result.baselineObservedValue,
    ).toBe(190);
    expect(
      json.snapshot.series.find((row: { id: string }) => row.id === v2.id).points.at(-1).value,
    ).toBe(195);
  });

  it('checks each manual series hash even when the enclosing frozen snapshot was freshly rehashed', async () => {
    const { version, v2 } = await makeStatisticsExportFixture();
    version.snapshot.series.find((row) => row.id === v2.id)!.fingerprint = '0'.repeat(64);
    await resealFixture(version);
    await expect(prepareRoadmapExport(version)).rejects.toThrow(
      'Контрольная сумма статистической редакции',
    );
  });

  it('blocks a manually sourced fact that contradicts its own frozen observation or pretends to be a registry fact', async () => {
    const { version, manualFactId } = await makeStatisticsExportFixture();
    const fact = version.snapshot.items.find((row) => row.id === manualFactId)!;
    if (fact.kind !== 'fact') throw new Error('fixture');
    fact.data.value = 195;
    await resealFixture(version);
    await expect(prepareRoadmapExport(version)).rejects.toThrow('Статистический факт');
    fact.data.value = 190;
    fact.data.sourceKind = 'registry';
    await resealFixture(version);
    await expect(prepareRoadmapExport(version)).rejects.toThrow('Статистический факт');
  });

  it('preserves manual provenance and reproducible old calculations after a return to original data', async () => {
    const { version, base, v2, manualScenarioId } = await makeStatisticsExportFixture();
    version.snapshot.statistics = [
      {
        metricId: base.metricId,
        revision: 3,
        mode: 'imported',
        seriesId: base.id,
        updatedAt: v2.recordedAt,
      },
    ];
    await resealFixture(version);
    const prepared = await prepareRoadmapExport(version);
    expect(
      prepared.scenarios.find((row) => row.itemId === manualScenarioId)?.result
        ?.baselineObservedValue,
    ).toBe(190);
    expect(
      prepared.blocks.some(
        (block) =>
          block.kind === 'paragraph' && block.text.includes('Команда вернулась к исходным данным'),
      ),
    ).toBe(true);
    expect(prepared.version.snapshot.series.some((row) => row.id === v2.id)).toBe(true);
  });
});
