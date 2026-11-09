import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FilePlus2, PencilLine, Save } from 'lucide-react';
import type {
  CanonicalMunicipalSeries,
  MunicipalMetricId,
  TerritoryDataIndex,
  TerritoryRecord,
  TerritoryRegistry,
} from '../../../../../packages/territories/types';
import type {
  RoadmapScenarioParameters,
  RoadmapItem,
  RoadmapScenarioData,
  RoadmapSeries,
} from '../../../../../packages/roadmaps/types';
import { STATISTICS_METRIC_IDS } from '../../../../../packages/statistics/types';
import {
  STATISTICS_METRIC_LABELS,
  getEffectiveSeries,
  inspectStatisticalBalances,
  isTeamStatisticalSeries,
  statisticsPointOrigin,
} from '../../../../../packages/statistics/series';
import { computeCanonicalScenario, suggestHistoryWindow } from '../../../../../packages/analytics';
import type { ScenarioResult } from '../../../../../packages/analytics';
import { loadCanonicalSeries } from '../../lib/territories';
import {
  activeItems,
  EditButton,
  EmptySection,
  Note,
  numeric,
  SectionHeading,
  useRoadmapTask,
} from './common';
import type { RoadmapWorkspaceProps } from './common';
import { ScenarioChart } from './ScenarioChart';
import { StatisticsEditor } from './StatisticsEditor';

function defaults(series: RoadmapSeries): RoadmapScenarioParameters | null {
  const interval = suggestHistoryWindow(series.points);
  return interval
    ? {
        metricId: series.metricId,
        historyStartYear: interval.startYear,
        historyEndYear: interval.endYear,
        endYear: Math.min(
          interval.endYear + 10,
          Math.max(interval.endYear + 3, new Date().getFullYear() + 3),
        ),
        baselineMethod: 'last_value',
        targetMode: series.valueDomain === 'signed' ? 'absolute_delta_end' : 'relative_end',
        targetValue: series.valueDomain === 'signed' ? 0 : 10,
      }
    : null;
}
const targetLabels: Record<RoadmapScenarioParameters['targetMode'], string> = {
  absolute_end: 'Точное значение в конечном году',
  relative_end: 'Отклонение от базы к конечному году, %',
  annual_growth: 'Ежегодный темп от последнего наблюдения, %',
  absolute_delta_end: 'Добавка к базе в конечном году, человек',
  percentage_points: 'Изменение в процентных пунктах',
};

export function DiagnosticWorkbench({
  index,
  registry,
  territory,
  workspace,
}: {
  index: TerritoryDataIndex;
  registry: TerritoryRegistry;
  territory: TerritoryRecord;
  workspace?: RoadmapWorkspaceProps;
}) {
  const [allSeries, setAllSeries] = useState<CanonicalMunicipalSeries[]>([]),
    [loadError, setLoadError] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [selectedMetric, setSelectedMetric] = useState<MunicipalMetricId>('births_total'),
    [comparisonKeys, setComparisonKeys] = useState<string[]>([]);
  const [parameters, setParameters] = useState<RoadmapScenarioParameters | null>(null),
    [title, setTitle] = useState(''),
    [assumptions, setAssumptions] = useState('');
  const [opened, setOpened] = useState<{ id: string; revision: number } | null>(null),
    [factYear, setFactYear] = useState<number | null>(null),
    [interpretation, setInterpretation] = useState('');
  const task = useRoadmapTask();
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const [pinnedSeries, setPinnedSeries] = useState<RoadmapSeries | null>(null);
  const imported = useMemo(
    () => allSeries.filter((row) => row.territoryKey === territory.territoryKey),
    [allSeries, territory.territoryKey],
  );
  const snapshot = workspace?.snapshot,
    editable = workspace?.editable ?? false;
  const ownSeries = useMemo(
    () => getEffectiveSeries(imported, snapshot?.series ?? [], snapshot?.statistics),
    [imported, snapshot?.series, snapshot?.statistics],
  );
  const material = [...imported, ...(snapshot?.series ?? [])];
  const currentSeries = ownSeries.find((row) => row.metricId === selectedMetric) ?? null;
  const selected = pinnedSeries?.metricId === selectedMetric ? pinnedSeries : currentSeries;
  const originalSeries =
    currentSeries && isTeamStatisticalSeries(currentSeries)
      ? currentSeries.baseSeries
      : (imported.find((row) => row.metricId === selectedMetric) ?? currentSeries);
  const balances = useMemo(() => inspectStatisticalBalances(ownSeries), [ownSeries]);
  const contextRef = useRef('');
  const viewIdentity = `${snapshot?.roadmapId ?? territory.territoryKey}:${selectedMetric}:${selected?.id ?? ''}:${opened?.id ?? ''}`;
  const currentView = useRef(viewIdentity);
  currentView.current = viewIdentity;
  useEffect(() => {
    let active = true;
    setAllSeries([]);
    setLoadError(null);
    setLoading(true);
    if (!territory.regionId || !territory.statistics.hasSeries) {
      setLoading(false);
      return;
    }
    void loadCanonicalSeries(index, registry, territory.regionId)
      .then((value) => {
        if (active) setAllSeries(value);
      })
      .catch((cause) => {
        if (active)
          setLoadError(cause instanceof Error ? cause.message : 'Не удалось загрузить статистику.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [index, registry, territory.regionId, territory.statistics.hasSeries, attempt]);
  useEffect(() => {
    setComparisonKeys([]);
    setOpened(null);
    setPinnedSeries(null);
    setStatisticsOpen(false);
    setInterpretation('');
  }, [territory.territoryKey]);
  useEffect(() => {
    const context = `${territory.territoryKey}:${selectedMetric}`;
    const changedContext = contextRef.current !== context;
    contextRef.current = context;
    if (!selected) {
      setParameters(null);
      return;
    }
    // Polling may deliver new objects. Keep an in-progress scenario's parameters intact.
    if (changedContext || !parameters) {
      setParameters(defaults(selected));
      setTitle(`${selected.title}: целевой сценарий`);
      setAssumptions('');
      setOpened(null);
    }
    setFactYear((previous) =>
      previous !== null &&
      selected.points.some((point) => point.year === previous && point.value !== null)
        ? previous
        : (selected.points.filter((point) => point.value !== null).at(-1)?.year ?? null),
    );
  }, [selected?.id, selected?.fingerprint, territory.territoryKey, selectedMetric]);
  let calculated: ScenarioResult | null = null,
    calculationError: string | null = null;
  if (selected && parameters) {
    try {
      calculated = computeCanonicalScenario(selected, parameters);
    } catch (cause) {
      calculationError = cause instanceof Error ? cause.message : 'Расчёт не выполнен.';
    }
  }
  const comparisons = comparisonKeys.flatMap((key) => {
    const series = allSeries.find(
      (item) => item.territoryKey === key && item.metricId === selectedMetric,
    );
    const record = registry.records.find((item) => item.territoryKey === key);
    return series && record ? [{ name: record.name, series }] : [];
  });
  const comparisonOptions = registry.records.filter(
    (record) =>
      record.regionId === territory.regionId &&
      record.territoryKey !== territory.territoryKey &&
      record.statistics.hasSeries &&
      record.roomEligible,
  );
  const anomalies =
    selected?.semanticType === 'stock'
      ? selected.points
          .filter((point) => point.value !== null)
          .flatMap((point, i, rows) => {
            const previous = rows[i - 1];
            return previous &&
              previous.value !== null &&
              point.value !== null &&
              previous.value !== 0 &&
              Math.abs(point.value / previous.value - 1) > 0.5
              ? [`${previous.year}–${point.year}`]
              : [];
          })
      : [];
  const currentSaved =
    snapshot && opened
      ? activeItems(snapshot, 'scenario').find((item) => item.id === opened.id)
      : undefined;
  const unchanged = Boolean(
    currentSaved &&
    parameters &&
    JSON.stringify(currentSaved.data.parameters) === JSON.stringify(parameters) &&
    currentSaved.data.seriesFingerprint === selected?.fingerprint,
  );
  function param<K extends keyof RoadmapScenarioParameters>(
    key: K,
    value: RoadmapScenarioParameters[K],
  ) {
    setParameters((previous) => (previous ? { ...previous, [key]: value } : null));
  }
  function openScenario(item: RoadmapItem<'scenario'>) {
    const canonical = material.find((series) => series.id === item.data.seriesId);
    if (!canonical) {
      return;
    }
    setSelectedMetric(canonical.metricId);
    setPinnedSeries(canonical);
    setParameters(item.data.parameters);
    setTitle(item.data.title);
    setAssumptions(item.data.assumptions);
    setOpened({ id: item.id, revision: item.revision });
  }
  // Selecting another metric schedules defaults; then restore the explicitly opened saved edition.
  const [pendingScenario, setPendingScenario] = useState<RoadmapItem<'scenario'> | null>(null);
  useEffect(() => {
    if (pendingScenario && selected?.id === pendingScenario.data.seriesId) {
      setParameters(pendingScenario.data.parameters);
      setTitle(pendingScenario.data.title);
      setAssumptions(pendingScenario.data.assumptions);
      setOpened({ id: pendingScenario.id, revision: pendingScenario.revision });
      setPendingScenario(null);
    }
  }, [pendingScenario, selected]);
  async function saveScenario() {
    if (!workspace || !selected || !parameters || !calculated) return;
    const expectedView = currentView.current;
    await task.run(async () => {
      const data: RoadmapScenarioData = {
        title: title.trim() || selected.title,
        seriesId: selected.id,
        seriesFingerprint: selected.fingerprint,
        parameters,
        assumptions,
      };
      const before = new Set(workspace.snapshot.items.map((item) => item.id));
      const next = await workspace.controller.actions.saveItem({
        roadmapId: workspace.snapshot.roadmapId,
        itemId: opened?.id ?? null,
        expectedRevision: opened?.revision ?? 0,
        kind: 'scenario',
        data,
        status: 'active',
      });
      // A valid save may finish after the user has opened another metric or scenario.
      // Keep its server result, but never attach that item ID to the newly opened form.
      if (currentView.current !== expectedView) return;
      const saved = next.items.find(
        (item): item is RoadmapItem<'scenario'> =>
          item.kind === 'scenario' && (opened ? item.id === opened.id : !before.has(item.id)),
      );
      if (saved) {
        setOpened({ id: saved.id, revision: saved.revision });
        setPinnedSeries(selected);
      }
    }, 'Сценарий сохранён в общей дорожной карте.');
  }
  function useTargets() {
    if (!workspace || !calculated || !currentSaved || !unchanged) return;
    const baselineSource = statisticsPointOrigin(selected!, calculated.baselineYear);
    const sourceReference = isTeamStatisticalSeries(selected!)
      ? `Составной ряд «${selected!.title}», редакция ${selected!.revision}; ${selected!.id}; SHA-256 ${selected!.fingerprint}. Базовое наблюдение ${calculated.baselineYear}: ${baselineSource.sourceReference ?? 'Источник не указан'}${baselineSource.sourceDate ? `; дата ${baselineSource.sourceDate}` : ''}. Источники остальных лет закреплены в погодовой атрибуции этой редакции.`
      : selected!.sourceUrl;
    workspace.onEdit({
      kind: 'indicator',
      initial: {
        title: selected!.title,
        definition: `Плановый ориентир по ряду «${selected!.title}»`,
        kind: 'demographic_context',
        unit: 'человек',
        semanticType: selected!.semanticType,
        valueDomain: selected!.valueDomain,
        baselineValue: calculated.baselineObservedValue,
        baselineYear: calculated.baselineYear,
        annualTargets: calculated.years
          .filter((row) => row.year > calculated!.baselineYear)
          .map((row) => ({
            year: row.year,
            value: row.plannedTargetValue ?? row.targetValue ?? 0,
          })),
        sourceReference,
        limitations:
          'Целевой сценарий команды. Разрыв с базовым сценарием не является оценкой причинного эффекта мероприятий. Происхождение первичных данных и сопоставимость границ требуют проверки.',
        scenarioId: currentSaved.id,
      },
    });
  }
  return (
    <section className="rm-diagnostic">
      <SectionHeading title="Диагностика и сценарии">
        {territory.name}. Исходные наблюдения, проверка гипотез и точные плановые ориентиры.
      </SectionHeading>
      {workspace ? (
        <div className="rm-statistics-launch">
          <div>
            <strong>Статистика территории</strong>
            <p>
              Уточните исходные значения, заполните пропуски или добавьте новые годы. Данные
              сохраняются для всей команды.
            </p>
          </div>
          <button
            className="button button-secondary"
            disabled={
              workspace.controller.busy || loading || Boolean(loadError && !snapshot?.series.length)
            }
            onClick={() => setStatisticsOpen(true)}
          >
            <PencilLine size={17} />
            {editable ? 'Уточнить данные' : 'Посмотреть уточнения'}
          </button>
        </div>
      ) : null}
      {loading ? (
        <p className="rm-empty" aria-busy="true">
          Загружаем проверенный пакет муниципальных рядов…
        </p>
      ) : loadError ? (
        <div className="rm-empty">
          <p role="alert">{loadError}</p>
          <button
            className="button button-secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить
          </button>
        </div>
      ) : !ownSeries.length && !selected ? (
        <Note warning>
          Для этой территории в текущем выпуске нет однозначно сопоставленных рядов. Диагностику
          {workspace
            ? ' можно построить, введя статистику через «Уточнить данные».'
            : ' можно строить на отдельно проверенных источниках и ручных фактах.'}{' '}
          Агрегаты регионального и федерального уровня не выводятся суммированием неполного набора
          муниципалитетов.
        </Note>
      ) : (
        <>
          <div className="rm-diagnostic-toolbar">
            <label className="rm-field">
              <span>Показатель</span>
              <select
                value={selectedMetric}
                onChange={(event) => {
                  setPendingScenario(null);
                  setPinnedSeries(null);
                  setOpened(null);
                  setSelectedMetric(event.target.value as MunicipalMetricId);
                }}
              >
                {(workspace
                  ? STATISTICS_METRIC_IDS
                  : ownSeries.map((series) => series.metricId)
                ).map((metricId) => (
                  <option key={metricId} value={metricId}>
                    {STATISTICS_METRIC_LABELS[metricId]}
                  </option>
                ))}
              </select>
            </label>
            {currentSeries && selected ? (
              <label className="rm-field">
                <span>Редакция данных</span>
                <select
                  aria-label="Редакция данных"
                  value={selected.id}
                  onChange={(event) => {
                    const chosen =
                      event.target.value === currentSeries.id ? currentSeries : originalSeries;
                    if (!chosen) return;
                    setPinnedSeries(chosen.id === currentSeries.id ? null : chosen);
                    setOpened(null);
                    setPendingScenario(null);
                    setParameters(defaults(chosen));
                    setTitle(`${chosen.title}: целевой сценарий`);
                    setAssumptions('');
                  }}
                >
                  <option value={currentSeries.id}>
                    {isTeamStatisticalSeries(currentSeries)
                      ? `Уточнение команды · редакция ${currentSeries.revision}`
                      : 'Исходный пакет'}
                  </option>
                  {originalSeries && originalSeries.id !== currentSeries.id ? (
                    <option value={originalSeries.id}>Исходный пакет · до уточнений</option>
                  ) : null}
                  {selected.id !== currentSeries.id && selected.id !== originalSeries?.id ? (
                    <option value={selected.id}>
                      Закреплённая редакция{' '}
                      {isTeamStatisticalSeries(selected) ? selected.revision : ''}
                    </option>
                  ) : null}
                </select>
              </label>
            ) : null}
            <details className="rm-comparison-picker">
              <summary>Сравнить территории · {comparisonKeys.length} / 3</summary>
              <div>
                {comparisonOptions.map((record) => (
                  <label className="rm-check" key={record.territoryKey}>
                    <input
                      type="checkbox"
                      checked={comparisonKeys.includes(record.territoryKey)}
                      disabled={
                        !comparisonKeys.includes(record.territoryKey) && comparisonKeys.length >= 3
                      }
                      onChange={(event) =>
                        setComparisonKeys((previous) =>
                          event.target.checked
                            ? [...previous, record.territoryKey]
                            : previous.filter((key) => key !== record.territoryKey),
                        )
                      }
                    />
                    <span>{record.name}</span>
                  </label>
                ))}
              </div>
            </details>
          </div>
          {selected && parameters ? (
            <div className="rm-analysis-layout">
              <div className="rm-chart-panel">
                <ScenarioChart series={selected} result={calculated} comparisons={comparisons} />
                {calculated ? (
                  <div className="rm-scenario-results">
                    <div>
                      <span>Последнее наблюдение в расчёте</span>
                      <strong>
                        {calculated.baselineYear}:{' '}
                        {numeric(calculated.baselineObservedValue, selected.decimals)}
                      </strong>
                    </div>
                    <div>
                      <span>Разрыв в {parameters.endYear} году</span>
                      <strong>{numeric(calculated.endGap)} чел.</strong>
                    </div>
                    {calculated.cumulativeFlowGap !== null ? (
                      <div>
                        <span>Суммарный разрыв потоков</span>
                        <strong>{numeric(calculated.cumulativeFlowGap)} чел.</strong>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {calculationError ? (
                  <p className="session-message" data-tone="error" role="alert">
                    {calculationError}
                  </p>
                ) : null}
                <Note>
                  {isTeamStatisticalSeries(selected)
                    ? `Используется уточнение команды, редакция ${selected.revision}. Источники отдельных лет указаны в истории; актуальность и сопоставимость требуют проверки.`
                    : 'Набор из авторского проекта Settlements-projection-dashboard. Первичная выгрузка и сопоставимость муниципальных границ не полностью документированы.'}{' '}
                  Сценарии — условные расчёты; они не устанавливают влияние мер на рождаемость.
                </Note>
                {selected.id !== currentSeries?.id ? (
                  <Note warning>
                    Открыта закреплённая редакция данных.{' '}
                    {currentSeries
                      ? 'Для команды уже доступна другая рабочая редакция.'
                      : 'В текущей рабочей редакции этот ряд отсутствует.'}{' '}
                    {opened && currentSeries ? (
                      <button
                        className="button button-secondary"
                        onClick={() => {
                          setPinnedSeries(currentSeries);
                          setPendingScenario(null);
                          setParameters((previous) =>
                            previous ? { ...previous } : defaults(currentSeries),
                          );
                        }}
                      >
                        Пересчитать по актуальным данным
                      </button>
                    ) : null}
                  </Note>
                ) : null}
                {anomalies.length ? (
                  <Note warning>
                    В исходном ряду обнаружено изменение численности более чем на 50% между
                    наблюдениями: {anomalies.join(', ')}. Проверьте первоисточник и территориальную
                    сопоставимость. Значения сохранены без исправления.
                  </Note>
                ) : null}
                {calculated?.warnings
                  .filter(
                    (issue) =>
                      ![
                        'INCOMPLETE_PRIMARY_PROVENANCE',
                        'GEOGRAPHY_COMPARABILITY_NOT_VERIFIED',
                      ].includes(issue.code),
                  )
                  .map((issue) => (
                    <p className="rm-warning-text" key={issue.code}>
                      {issue.message}
                    </p>
                  ))}
                {calculated?.backtest ? (
                  <p className="rm-source-caption">
                    Контроль на {calculated.backtest.heldOutYears.join(', ')} гг.: средняя
                    абсолютная ошибка линейного продолжения —{' '}
                    {numeric(calculated.backtest.linearMae)}, постоянного уровня —{' '}
                    {numeric(calculated.backtest.lastValueMae)}. Это проверка на части истории, а не
                    гарантия прогноза.
                  </p>
                ) : null}
                <details className="rm-source-details">
                  <summary>Источник, определение и ограничения</summary>
                  <p>
                    {index.metrics.find((metric) => metric.id === selected.metricId)?.definition}
                  </p>
                  <p>{selected.comparabilityNote}</p>
                  {isTeamStatisticalSeries(selected) ? (
                    <>
                      <p>
                        Уточнения команды: {selected.sourceReference}
                        {selected.sourceDate ? ` · ${selected.sourceDate}` : ''}
                      </p>
                      <p>{selected.reason}</p>
                      <p>
                        Источник каждого изменённого года можно проверить в редакторе статистики.
                      </p>
                      {selected.baseSeries ? (
                        <a href={selected.baseSeries.sourceUrl} target="_blank" rel="noreferrer">
                          Исходный файл до уточнений
                        </a>
                      ) : null}
                    </>
                  ) : (
                    <a href={selected.sourceUrl} target="_blank" rel="noreferrer">
                      Открыть закреплённый исходный файл
                    </a>
                  )}
                  <p>
                    Редакция: <code>{selected.sourceEditionId}</code>
                  </p>
                  <p>
                    SHA-256 ряда: <code>{selected.fingerprint}</code>
                  </p>
                  {!isTeamStatisticalSeries(selected) &&
                    index.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                </details>
              </div>
              <aside className="rm-scenario-inspector">
                <h3>Конструктор сценария</h3>
                <label className="rm-field">
                  <span>Название</span>
                  <input
                    maxLength={240}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <div className="rm-form-grid">
                  <label className="rm-field">
                    <span>История с</span>
                    <input
                      aria-label="Начало истории"
                      type="number"
                      min={1900}
                      max={2200}
                      value={parameters.historyStartYear}
                      onChange={(event) => param('historyStartYear', Number(event.target.value))}
                    />
                  </label>
                  <label className="rm-field">
                    <span>История по</span>
                    <input
                      aria-label="Окончание истории"
                      type="number"
                      min={1900}
                      max={2200}
                      value={parameters.historyEndYear}
                      onChange={(event) => param('historyEndYear', Number(event.target.value))}
                    />
                  </label>
                </div>
                <label className="rm-field">
                  <span>Конечный год</span>
                  <input
                    aria-label="Горизонт сценария"
                    type="number"
                    min={parameters.historyEndYear + 1}
                    max={
                      (selected.points
                        .filter(
                          (point) =>
                            point.value !== null && point.year <= parameters.historyEndYear,
                        )
                        .at(-1)?.year ?? parameters.historyEndYear) + 30
                    }
                    value={parameters.endYear}
                    onChange={(event) => param('endYear', Number(event.target.value))}
                  />
                </label>
                <label className="rm-field">
                  <span>Базовая траектория</span>
                  <select
                    value={parameters.baselineMethod}
                    onChange={(event) =>
                      param(
                        'baselineMethod',
                        event.target.value as RoadmapScenarioParameters['baselineMethod'],
                      )
                    }
                  >
                    <option value="last_value">Постоянный последний уровень</option>
                    <option value="linear">Линейное продолжение истории</option>
                  </select>
                </label>
                <label className="rm-field">
                  <span>Способ задания цели</span>
                  <select
                    value={parameters.targetMode}
                    onChange={(event) =>
                      param(
                        'targetMode',
                        event.target.value as RoadmapScenarioParameters['targetMode'],
                      )
                    }
                  >
                    {Object.entries(targetLabels)
                      .filter(
                        ([key]) =>
                          key !== 'percentage_points' &&
                          (selected.valueDomain !== 'signed' ||
                            !['relative_end', 'annual_growth'].includes(key)),
                      )
                      .map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="rm-field">
                  <span>
                    {parameters.targetMode === 'relative_end' ||
                    parameters.targetMode === 'annual_growth'
                      ? 'Значение, %'
                      : 'Значение, человек'}
                  </span>
                  <input
                    aria-label="Параметр целевого сценария"
                    type="number"
                    step="any"
                    value={parameters.targetValue}
                    onChange={(event) => param('targetValue', Number(event.target.value))}
                  />
                </label>
                <label className="rm-field">
                  <span>Условия и допущения команды</span>
                  <textarea
                    rows={4}
                    maxLength={4000}
                    value={assumptions}
                    onChange={(event) => setAssumptions(event.target.value)}
                    placeholder="Какие условия должны выполняться? Что требует дополнительной проверки?"
                  />
                </label>
                {workspace ? (
                  <>
                    <button
                      className="button button-primary"
                      disabled={
                        !editable || task.working || workspace.controller.busy || !calculated
                      }
                      onClick={() => void saveScenario()}
                    >
                      <Save size={16} />
                      {opened ? 'Сохранить редакцию сценария' : 'Сохранить сценарий'}
                    </button>
                    {opened ? (
                      <button
                        className="button button-quiet"
                        onClick={() => {
                          setOpened(null);
                          setTitle(`${title} — вариант`.slice(0, 240));
                        }}
                      >
                        Создать отдельный вариант
                      </button>
                    ) : null}
                    <button
                      className="button button-secondary"
                      disabled={!editable || !unchanged || !calculated}
                      onClick={useTargets}
                    >
                      Перенести ориентиры в показатель
                      <ArrowRight size={16} />
                    </button>
                    {!unchanged ? (
                      <p className="rm-muted">
                        Для переноса ориентиров сохраните текущую редакцию сценария.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="rm-muted">
                    Расчёт выполняется локально. В совместном занятии сценарий можно сохранить в
                    дорожную карту.
                  </p>
                )}
              </aside>
            </div>
          ) : (
            <Note>Для выбранного показателя нет числовых наблюдений.</Note>
          )}
        </>
      )}
      {balances.length ? (
        <details className="rm-source-details">
          <summary>Проверка согласованности показателей · {balances.length}</summary>
          <p>
            Расхождение балансов может указывать на разные редакции или методики источников.
            Значения автоматически не пересчитываются.
          </p>
          {balances.map((issue) => (
            <p className="rm-warning-text" key={`${issue.metricId}:${issue.year}`}>
              {issue.message}
            </p>
          ))}
        </details>
      ) : null}
      {task.feedback}
      {workspace && snapshot ? (
        <>
          {activeItems(snapshot, 'scenario').length ? (
            <section className="rm-section">
              <SectionHeading title="Сохранённые сценарии" />
              <div className="rm-card-grid">
                {activeItems(snapshot, 'scenario').map((item) => (
                  <article className="rm-small-card" key={item.id}>
                    <h4>{item.data.title}</h4>
                    <p>
                      {item.data.parameters.historyStartYear}–{item.data.parameters.historyEndYear}{' '}
                      → {item.data.parameters.endYear} ·{' '}
                      {targetLabels[item.data.parameters.targetMode]}
                    </p>
                    <button
                      className="button button-secondary"
                      disabled={!material.some((series) => series.id === item.data.seriesId)}
                      onClick={() => {
                        openScenario(item);
                        setPendingScenario(item);
                      }}
                    >
                      Открыть параметры
                    </button>
                    <span className="rm-muted">Редакция {item.revision}</span>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          <section className="rm-section">
            <SectionHeading
              title="Факты для диагноза"
              onAdd={editable ? () => workspace.onEdit({ kind: 'fact' }) : undefined}
              addLabel="Ручной источник"
            >
              Выберите наблюдение и объясните его значение для проекта.
            </SectionHeading>
            {selected && factYear !== null ? (
              <div className="rm-capture-fact">
                <label className="rm-field">
                  <span>Наблюдение</span>
                  <select
                    aria-label="Год факта"
                    value={factYear}
                    onChange={(event) => setFactYear(Number(event.target.value))}
                  >
                    {selected.points
                      .filter((point) => point.value !== null)
                      .map((point) => (
                        <option key={point.year} value={point.year}>
                          {point.year}: {numeric(point.value, selected.decimals)} чел.
                        </option>
                      ))}
                  </select>
                </label>
                <label className="rm-field">
                  <span>Интерпретация для проекта</span>
                  <textarea
                    rows={2}
                    maxLength={4000}
                    value={interpretation}
                    onChange={(event) => setInterpretation(event.target.value)}
                  />
                </label>
                <button
                  className="button button-secondary"
                  disabled={!editable || task.working || workspace.controller.busy}
                  onClick={() =>
                    void task.run(
                      () =>
                        workspace.controller.actions.captureFact({
                          roadmapId: snapshot.roadmapId,
                          itemId: null,
                          expectedRevision: 0,
                          seriesId: selected.id,
                          expectedSeriesFingerprint: selected.fingerprint,
                          year: factYear,
                          interpretation,
                        }),
                      'Факт закреплён с его источником и значением.',
                    )
                  }
                >
                  <FilePlus2 size={16} />
                  Закрепить факт
                </button>
              </div>
            ) : null}
            <div className="rm-card-grid">
              {activeItems(snapshot, 'fact').map((item) => (
                <article className="rm-small-card" key={item.id}>
                  <span className="rm-eyebrow">
                    {item.data.sourceKind === 'registry'
                      ? 'Закреплённый ряд'
                      : item.data.sourceKind === 'team_statistics'
                        ? 'Уточнение команды'
                        : 'Ручной источник'}
                  </span>
                  <h4>{item.data.title}</h4>
                  <strong>
                    {item.data.year ?? 'Год не указан'} · {numeric(item.data.value)}{' '}
                    {item.data.unit}
                  </strong>
                  <p>{item.data.interpretation || 'Добавьте интерпретацию для проекта.'}</p>
                  <p className="rm-source-caption">{item.data.sourceReference}</p>
                  {editable ? (
                    <EditButton onClick={() => workspace.onEdit({ kind: 'fact', id: item.id })} />
                  ) : null}
                </article>
              ))}
            </div>
            {!activeItems(snapshot, 'fact').length ? (
              <EmptySection>
                Отберите несколько фактов, которые действительно меняют выбор проблемы, целевой
                группы или масштаба проекта.
              </EmptySection>
            ) : null}
          </section>
          <section className="rm-section">
            <SectionHeading title="Проблема, причины и вывод" />
            {activeItems(snapshot, 'diagnosis').map((item) => (
              <article className="rm-diagnosis-summary" key={item.id}>
                <div>
                  <h4>Проблема</h4>
                  <p>{item.data.problem || 'Ещё не сформулирована.'}</p>
                </div>
                <div>
                  <h4>Гипотеза о причинах</h4>
                  <p>{item.data.causeHypothesis || 'Ещё не сформулирована.'}</p>
                </div>
                <div>
                  <h4>Вывод для проекта</h4>
                  <p>{item.data.conclusion || 'Ещё не сформулирован.'}</p>
                </div>
                {editable ? (
                  <EditButton
                    label="Сформулировать диагноз"
                    onClick={() => workspace.onEdit({ kind: 'diagnosis', id: item.id })}
                  />
                ) : null}
              </article>
            ))}
          </section>
        </>
      ) : null}
      {statisticsOpen && workspace ? (
        <StatisticsEditor
          key={workspace.snapshot.roadmapId}
          workspace={workspace}
          imported={imported}
          initialMetric={selectedMetric}
          onClose={() => setStatisticsOpen(false)}
        />
      ) : null}
    </section>
  );
}
