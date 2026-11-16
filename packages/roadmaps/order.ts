import type { RoadmapActivityData } from './types';

/** Presentation order only: stored rows, references and frozen bytes stay unchanged. */
export function compareRoadmapActivities(
  a: { id: string; data: RoadmapActivityData },
  b: { id: string; data: RoadmapActivityData },
): number {
  return (a.data.startDate ?? '9999-12-31').localeCompare(b.data.startDate ?? '9999-12-31')
    || (a.data.endDate ?? '9999-12-31').localeCompare(b.data.endDate ?? '9999-12-31')
    || a.data.title.localeCompare(b.data.title, 'ru') || a.id.localeCompare(b.id);
}
