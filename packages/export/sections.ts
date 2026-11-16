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

export interface RoadmapReportOptions {
  sections?: readonly RoadmapReportSection[];
  publishedStatistics?: readonly CanonicalMunicipalSeries[];
  cohort?: RoadmapFigure;
  cohortDescription?: string;
}
