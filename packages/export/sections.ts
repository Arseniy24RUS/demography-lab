import type { RoadmapFigure } from './types';
import type { CanonicalMunicipalSeries } from '../territories/types';

export const roadmapReportSections = [
  { id: 'passport', label: 'Паспорт проекта' },
  { id: 'diagnosis', label: 'Проблемы и обоснование мер' },
  { id: 'statistics', label: 'Демографическая статистика' },
  { id: 'forecast', label: 'Демографический прогноз' },
  { id: 'indicators', label: 'Целевые показатели' },
  { id: 'activities', label: 'План мероприятий' },
  { id: 'calendar', label: 'Календарный план' },
  { id: 'resources', label: 'Ресурсное обеспечение' },
  { id: 'risks', label: 'Риски и меры реагирования' },
  { id: 'monitoring', label: 'Мониторинг и оценка' },
] as const;

export type RoadmapReportSection = (typeof roadmapReportSections)[number]['id'];

/** Organizations keep authored project sections without territorial demographic data. */
export function availableRoadmapReportSections(level: string) {
  return level === 'organization'
    ? roadmapReportSections.filter(({ id }) => id !== 'statistics' && id !== 'forecast')
    : [...roadmapReportSections];
}

export interface RoadmapReportOptions {
  sections?: readonly RoadmapReportSection[];
  publishedStatistics?: readonly CanonicalMunicipalSeries[];
  cohort?: RoadmapFigure;
  cohortDescription?: string;
}
