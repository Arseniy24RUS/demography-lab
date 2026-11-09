import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, Pencil, Plus } from 'lucide-react';
import type {
  RoadmapDataMap,
  RoadmapItem,
  RoadmapItemKind,
  RoadmapSnapshot,
  SaveRoadmapItemInput,
} from '../../../../../packages/roadmaps/types';
import type { RoadmapsController } from '../../hooks/useRoadmaps';
import { formatKopecks } from '../../../../../packages/analytics';

export type RoadmapTab = 'territory' | 'diagnosis' | 'activities' | 'resources' | 'review';
export const roadmapTabs: Array<[RoadmapTab, string]> = [
  ['territory', 'Территория'],
  ['diagnosis', 'Диагностика'],
  ['activities', 'Мероприятия'],
  ['resources', 'Календарь и ресурсы'],
  ['review', 'Проверка и экспорт'],
];
export interface EditorTarget {
  kind: RoadmapItemKind;
  id?: string;
  initial?: Record<string, unknown>;
}
export interface RoadmapWorkspaceProps {
  snapshot: RoadmapSnapshot;
  controller: RoadmapsController;
  editable: boolean;
  onEdit(target: EditorTarget): void;
}
export const numeric = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined
    ? 'Нет данных'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
export const money = (value: number) => `${formatKopecks(value)} ₽`;
export const dateLabel = (value: string | null) =>
  value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC' })
    : 'Не задана';
export function activeItems<K extends RoadmapItemKind>(
  snapshot: Pick<RoadmapSnapshot, 'items'>,
  kind: K,
): RoadmapItem<K>[] {
  return snapshot.items.filter(
    (item) => item.kind === kind && item.status === 'active',
  ) as RoadmapItem<K>[];
}
export function saveInput<K extends RoadmapItemKind>(
  roadmapId: string,
  item: RoadmapItem<K>,
  data = item.data,
): SaveRoadmapItemInput<K> {
  return {
    roadmapId,
    itemId: item.id,
    expectedRevision: item.revision,
    kind: item.kind,
    data,
    status: item.status,
  } as SaveRoadmapItemInput<K>;
}
export const kindLabels: Record<RoadmapItemKind, string> = {
  passport: 'Паспорт проекта',
  diagnosis: 'Диагноз и приоритет',
  monitoring: 'Мониторинг и устойчивость',
  activity: 'Мероприятие',
  indicator: 'Показатель',
  scenario: 'Сценарий',
  cost: 'Статья затрат',
  funding: 'Источник финансирования',
  risk: 'Риск',
  fact: 'Факт для диагностики',
};
export function emptyData(kind: RoadmapItemKind): RoadmapDataMap[RoadmapItemKind] {
  switch (kind) {
    case 'passport':
      return {
        title: '',
        targetGroup: '',
        partners: '',
        goal: '',
        objectives: [],
        startDate: null,
        endDate: null,
        expectedResult: '',
        defenseDate: null,
        humanResources: '',
        materialResources: '',
        informationResources: '',
      };
    case 'diagnosis':
      return { problem: '', causeHypothesis: '', conclusion: '' };
    case 'monitoring':
      return {
        frequency: '',
        method: '',
        responsible: '',
        interimReportDate: null,
        finalReportDate: null,
        qualitativeResults: '',
        sustainability: '',
      };
    case 'activity':
      return {
        title: '',
        description: '',
        objectiveId: null,
        targetGroup: '',
        scale: '',
        startDate: null,
        endDate: null,
        responsible: '',
        partners: '',
        deliverable: '',
        completionCriterion: '',
        authorityLevel: 'unknown',
        legalBasis: '',
        approvalStatus: 'unknown',
        responsibleBody: '',
        necessaryDecision: '',
        indicatorIds: [],
        dependencies: [],
        stage: 'implementation',
        stageLabel: '',
        progressStatus: 'planned',
      };
    case 'indicator':
      return {
        title: '',
        definition: '',
        kind: 'output',
        unit: 'семей',
        semanticType: 'flow',
        valueDomain: 'nonnegative',
        numeratorDefinition: '',
        denominatorDefinition: '',
        baselineValue: null,
        baselineYear: null,
        annualTargets: [],
        sourceReference: '',
        frequency: 'Ежегодно',
        responsible: '',
        limitations: '',
        scenarioId: null,
      };
    case 'scenario':
      return {
        title: '',
        seriesId: '',
        seriesFingerprint: '',
        assumptions: '',
        parameters: {
          metricId: 'births_total',
          historyStartYear: 2013,
          historyEndYear: 2022,
          endYear: 2030,
          baselineMethod: 'last_value',
          targetMode: 'relative_end',
          targetValue: 10,
        },
      };
    case 'cost':
      return {
        activityId: '',
        year: new Date().getFullYear(),
        title: '',
        unit: 'услуга',
        quantity: '1',
        unitPriceKopecks: 0,
        periods: 1,
        cashKind: 'cash',
        priceStatus: 'estimated',
        priceSource: '',
        priceDate: null,
      };
    case 'funding':
      return {
        costLineId: '',
        sourceName: '',
        sourceKind: 'municipal_budget',
        amountKopecks: 0,
        status: 'assumption',
        sourceReference: '',
        sourceDate: null,
        originReference: '',
      };
    case 'risk':
      return { title: '', mitigation: '', owner: '', trigger: '', contingency: '' };
    case 'fact':
      return {
        sourceKind: 'external_unverified',
        title: '',
        interpretation: '',
        year: null,
        value: null,
        unit: '',
        sourceReference: '',
        sourceDate: null,
        seriesId: null,
        seriesFingerprint: null,
        metricId: null,
      };
  }
}
export function SectionHeading({
  title,
  children,
  onAdd,
  addLabel = 'Добавить',
}: {
  title: string;
  children?: ReactNode;
  onAdd?: () => void;
  addLabel?: string;
}) {
  return (
    <div className="rm-section-heading">
      <div>
        <h3>{title}</h3>
        {children ? <p>{children}</p> : null}
      </div>
      {onAdd ? (
        <button className="button button-secondary" onClick={onAdd}>
          <Plus size={16} />
          {addLabel}
        </button>
      ) : null}
    </div>
  );
}
export function EditButton({
  onClick,
  label = 'Изменить',
  disabled = false,
}: {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button className="button button-quiet" onClick={onClick} disabled={disabled}>
      <Pencil size={15} />
      {label}
    </button>
  );
}
export function EmptySection({ children }: { children: ReactNode }) {
  return <div className="rm-empty">{children}</div>;
}
export function Note({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return (
    <div className={`rm-note${warning ? ' warning' : ''}`}>
      <AlertCircle size={17} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
export function useRoadmapTask() {
  const [working, setWorking] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  async function run<T>(operation: () => Promise<T>, success?: string): Promise<T | undefined> {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const value = await operation();
      if (success) setNotice(success);
      return value;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие.');
      return undefined;
    } finally {
      setWorking(false);
    }
  }
  const feedback = (
    <>
      {error ? (
        <p className="session-message" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="session-message" role="status">
          {notice}
        </p>
      ) : null}
    </>
  );
  return { working, error, notice, run, feedback };
}
