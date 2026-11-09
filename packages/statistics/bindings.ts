import type { AnalysisIssue } from '../analytics/types';
import type { FrozenRoadmapItem, RoadmapSeries } from '../roadmaps/types';
import type { MunicipalMetricId } from '../territories/types';
import type { StatisticsHead } from './types';
import { getEffectiveSeries } from './series';

export interface StatisticsBindingState {
  itemId: string;
  kind: 'fact' | 'scenario';
  metricId: MunicipalMetricId;
  pinnedSeriesId: string;
  pinnedFingerprint: string;
  currentSeriesId: string | null;
  currentFingerprint: string | null;
  stale: boolean;
  message: string;
}
interface BindingMaterial {
  items: readonly FrozenRoadmapItem[];
  series: readonly RoadmapSeries[];
  statistics?: readonly StatisticsHead[];
}

/** The comparison is confined to the supplied snapshot; it never fetches a live room. */
export function getStatisticsBindings(roadmap: BindingMaterial): StatisticsBindingState[] {
  // Schema 1 contains no working-head concept and remains interpreted as it was captured.
  if (!roadmap.statistics) return [];
  const effective = getEffectiveSeries([], roadmap.series, roadmap.statistics);
  return roadmap.items.flatMap((item): StatisticsBindingState[] => {
    if (item.status !== 'active' || (item.kind !== 'scenario' && item.kind !== 'fact')) return [];
    if (item.kind === 'fact' && item.data.sourceKind === 'external_unverified') return [];
    const seriesId = item.data.seriesId,
      fingerprint = item.data.seriesFingerprint;
    if (!seriesId || !fingerprint) return [];
    const pinned = roadmap.series.find(
      (row) => row.id === seriesId && row.fingerprint === fingerprint,
    );
    // Missing pinned material is handled separately as a reproducibility error.
    if (!pinned) return [];
    const current = effective.find((row) => row.metricId === pinned.metricId);
    const stale = current?.id !== pinned.id || current?.fingerprint !== pinned.fingerprint;
    const head = roadmap.statistics?.find((row) => row.metricId === pinned.metricId);
    const message = !stale
      ? 'Закреплённая редакция совпадает с рабочей редакцией в этом снимке.'
      : head?.mode === 'imported'
        ? 'Команда вернулась к исходным данным. Эта запись сохраняет ранее выбранную редакцию; обновите её явно, если требуется использовать восстановленный исходный ряд.'
        : 'Рабочая редакция статистики изменилась. Эта запись сохраняет прежние значения и источник; пересмотр расчёта или факта требует явного решения команды.';
    return [
      {
        itemId: item.id,
        kind: item.kind,
        metricId: pinned.metricId,
        pinnedSeriesId: pinned.id,
        pinnedFingerprint: pinned.fingerprint,
        currentSeriesId: current?.id ?? null,
        currentFingerprint: current?.fingerprint ?? null,
        stale,
        message,
      },
    ];
  });
}

export function inspectStatisticsBindings(roadmap: BindingMaterial): AnalysisIssue[] {
  return getStatisticsBindings(roadmap).flatMap((binding): AnalysisIssue[] =>
    binding.stale
      ? [
          {
            code: 'STATISTICS_SOURCE_CHANGED',
            severity: 'warning',
            entityId: binding.itemId,
            field: binding.kind,
            message: binding.message,
          },
        ]
      : [],
  );
}
