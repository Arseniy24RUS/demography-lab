import { useEffect, useRef, useState } from 'react';
import { History, Plus, RotateCcw, Save } from 'lucide-react';
import type {
  CanonicalMunicipalSeries,
  MunicipalMetricId,
} from '../../../../../packages/territories/types';
import type { RoadmapSeries, RoadmapSnapshot } from '../../../../../packages/roadmaps/types';
import type {
  StatisticsChange,
  StatisticsHistory,
  TeamStatisticalSeries,
} from '../../../../../packages/statistics/types';
import { STATISTICS_METRIC_IDS } from '../../../../../packages/statistics/types';
import { saveStatisticsInputSchema } from '../../../../../packages/statistics/schema';
import {
  STATISTICS_METRIC_LABELS,
  compareSeriesPoints,
  getEffectiveSeries,
  isTeamStatisticalSeries,
  parseObservationInput,
  statisticsPointOrigin,
} from '../../../../../packages/statistics/series';
import { Modal } from '../Modal';
import { Note, numeric } from './common';
import type { RoadmapWorkspaceProps } from './common';

type DraftRow = { raw: string; action: 'keep' | 'set' | 'reset' };
type Draft = Record<number, DraftRow>;
type Base = { series: RoadmapSeries | null; revision: number };
const formatInput = (value: number | null) =>
  value === null ? '' : String(value).replace('.', ',');
const pointLabel = (series: RoadmapSeries | null, year: number) => {
  const point = series?.points.find((row) => row.year === year);
  return point ? numeric(point.value, 6) : 'Год отсутствует';
};
const rowsFrom = (series: RoadmapSeries | null): Draft =>
  Object.fromEntries(
    (series?.points ?? []).map((point) => [
      point.year,
      { raw: formatInput(point.value), action: 'keep' },
    ]),
  );
const originalOf = (series: RoadmapSeries | null) =>
  series && isTeamStatisticalSeries(series) ? series.baseSeries : series;
const timestampLabel = (value: string) =>
  new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

/** Drafts are intentionally local until an explicit compare-and-save command succeeds. */
export function StatisticsEditor({
  workspace,
  imported,
  initialMetric,
  onClose,
}: {
  workspace: RoadmapWorkspaceProps;
  imported: CanonicalMunicipalSeries[];
  initialMetric: MunicipalMetricId;
  onClose(): void;
}) {
  const { snapshot, controller, editable } = workspace;
  const [metricId, setMetricId] = useState(initialMetric);
  const currentBase = (next: RoadmapSnapshot, metric = metricId): Base => ({
    series:
      getEffectiveSeries(imported, next.series, next.statistics).find(
        (series) => series.metricId === metric,
      ) ?? null,
    revision: next.statistics?.find((head) => head.metricId === metric)?.revision ?? 0,
  });
  const [base, setBase] = useState(() => currentBase(snapshot, initialMetric));
  const [draft, setDraft] = useState<Draft>(() => rowsFrom(base.series));
  const [newYear, setNewYear] = useState(
    String(
      Math.min(
        new Date().getUTCFullYear(),
        Math.max(
          1900,
          ...(base.series?.points.length
            ? base.series.points.map((p) => p.year + 1)
            : [new Date().getUTCFullYear() - 1]),
        ),
      ),
    ),
  );
  const [source, setSource] = useState(''),
    [sourceDate, setSourceDate] = useState(''),
    [reason, setReason] = useState('');
  const [comparabilityNote, setComparabilityNote] = useState(base.series?.comparabilityNote ?? '');
  const [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null);
  const [preview, setPreview] = useState<StatisticsChange[] | null>(null),
    [working, setWorking] = useState(false);
  const [serverConflict, setServerConflict] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false),
    [restoreReason, setRestoreReason] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false),
    [history, setHistory] = useState<StatisticsHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false),
    [historyError, setHistoryError] = useState<string | null>(null);
  const [historicalSeries, setHistoricalSeries] = useState<TeamStatisticalSeries | null>(null);
  const [leaveIntent, setLeaveIntent] = useState<MunicipalMetricId | 'close' | null>(null);
  const alive = useRef(true),
    historyRequest = useRef(0),
    seriesRequest = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      historyRequest.current++;
      seriesRequest.current++;
    };
  }, []);
  const latest = currentBase(snapshot),
    original = originalOf(base.series);
  const conflict = latest.revision !== base.revision || serverConflict;
  const locked = !editable || working || controller.busy;
  const dirtyYears = Object.keys(draft)
    .map(Number)
    .filter((year) => draft[year]?.action !== 'keep');
  const dirty =
    dirtyYears.length > 0 ||
    source !== '' ||
    sourceDate !== '' ||
    reason !== '' ||
    comparabilityNote !== (base.series?.comparabilityNote ?? '');
  const years = Object.keys(draft)
    .map(Number)
    .sort((a, b) => b - a);
  const conflictDiff = compareSeriesPoints(base.series, latest.series).filter(
    (row) => row.change !== 'unchanged' || row.provenanceChanged,
  );

  function clearPreview() {
    setPreview(null);
    setRestoreOpen(false);
    setError(null);
    setSuccess(null);
  }
  function acceptBase(next: Base, keepDraft = false) {
    const nextRows = rowsFrom(next.series);
    if (keepDraft) for (const year of dirtyYears) nextRows[year] = draft[year]!;
    setBase(next);
    setDraft(nextRows);
    setPreview(null);
    setServerConflict(false);
    setError(null);
    if (!keepDraft) {
      setSource('');
      setSourceDate('');
      setReason('');
      setComparabilityNote(next.series?.comparabilityNote ?? '');
    }
  }
  function leave(intent: MunicipalMetricId | 'close', force = false) {
    if (working) return;
    if (dirty && !force) {
      setLeaveIntent(intent);
      return;
    }
    setLeaveIntent(null);
    if (intent === 'close') {
      onClose();
      return;
    }
    historyRequest.current++;
    seriesRequest.current++;
    setMetricId(intent);
    acceptBase(currentBase(snapshot, intent));
    setHistory(null);
    setHistoricalSeries(null);
    setHistoryOpen(false);
    setHistoryLoading(false);
    setHistoryError(null);
    setRestoreOpen(false);
    setRestoreReason('');
    setSuccess(null);
  }
  function edit(year: number, raw: string) {
    setDraft((previous) => ({ ...previous, [year]: { raw, action: 'set' } }));
    clearPreview();
  }
  function undo(year: number) {
    setDraft((previous) => {
      const next = { ...previous },
        point = base.series?.points.find((row) => row.year === year);
      if (point) next[year] = { raw: formatInput(point.value), action: 'keep' };
      else delete next[year];
      return next;
    });
    clearPreview();
  }
  function resetYear(year: number) {
    const override =
      base.series &&
      isTeamStatisticalSeries(base.series) &&
      base.series.overrides.some((row) => row.year === year);
    if (!override) {
      undo(year);
      return;
    }
    setDraft((previous) => ({
      ...previous,
      [year]: {
        raw: formatInput(original?.points.find((row) => row.year === year)?.value ?? null),
        action: 'reset',
      },
    }));
    clearPreview();
  }
  function addYear() {
    clearPreview();
    if (!/^\d{4}$/u.test(newYear)) {
      setError('Введите год четырьмя цифрами.');
      return;
    }
    const year = Number(newYear);
    if (year < 1900 || year > new Date().getUTCFullYear()) {
      setError(
        'Фактическое наблюдение должно относиться к прошедшему или текущему году. Будущие значения задаются в сценарии.',
      );
      return;
    }
    if (draft[year]) {
      setError(`Год ${year} уже есть в таблице.`);
      return;
    }
    setDraft((previous) => ({ ...previous, [year]: { raw: '', action: 'set' } }));
  }
  function prepare() {
    clearPreview();
    if (conflict) {
      setError('Сначала сравните ваш ввод с новой редакцией команды.');
      return;
    }
    try {
      if (!dirtyYears.length)
        throw new Error('Измените хотя бы одно наблюдение или верните его исходное значение.');
      if (!source.trim() || !reason.trim())
        throw new Error('Укажите источник уточнения и основание изменения.');
      const changes = dirtyYears
        .sort((a, b) => a - b)
        .map((year): StatisticsChange => {
          const row = draft[year]!;
          if (row.action === 'reset') return { year, action: 'reset' };
          try {
            return { year, action: 'set', value: parseObservationInput(row.raw, metricId) };
          } catch (cause) {
            throw new Error(
              `${year}: ${cause instanceof Error ? cause.message : 'Проверьте значение.'}`,
            );
          }
        });
      const parsed = saveStatisticsInputSchema.safeParse({
        roadmapId: snapshot.roadmapId,
        metricId,
        expectedRevision: base.revision,
        changes,
        sourceReference: source.trim(),
        sourceDate: sourceDate || null,
        reason: reason.trim(),
        comparabilityNote: comparabilityNote.trim(),
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.find((issue) => issue.code === 'custom')?.message ??
            'Проверьте дату, длину текста и значения наблюдений.',
        );
      setPreview(changes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Проверьте введённые данные.');
    }
  }
  async function loadHistory(append = false) {
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const next = await controller.actions.statisticsHistory({
        roadmapId: snapshot.roadmapId,
        metricId,
        ...(append && history?.nextBeforeRevision
          ? { beforeRevision: history.nextBeforeRevision }
          : {}),
      });
      if (!alive.current || request !== historyRequest.current) return;
      setHistory((previous) =>
        append && previous ? { ...next, entries: [...previous.entries, ...next.entries] } : next,
      );
    } catch (cause) {
      if (alive.current && request === historyRequest.current)
        setHistoryError(cause instanceof Error ? cause.message : 'История недоступна.');
    } finally {
      if (alive.current && request === historyRequest.current) setHistoryLoading(false);
    }
  }
  async function inspectEdition(seriesId: string) {
    const request = ++seriesRequest.current;
    setHistoryError(null);
    setHistoricalSeries(null);
    try {
      const next = await controller.actions.statisticsSeries({
        roadmapId: snapshot.roadmapId,
        seriesId,
      });
      if (alive.current && request === seriesRequest.current) {
        if (
          next.series.metricId !== metricId ||
          next.series.territoryKey !== snapshot.territory.key
        )
          throw new Error('Редакция относится к другому показателю или территории.');
        setHistoricalSeries(next.series);
      }
    } catch (cause) {
      if (alive.current && request === seriesRequest.current)
        setHistoryError(cause instanceof Error ? cause.message : 'Редакция недоступна.');
    }
  }
  async function commit(restore = false) {
    if (locked || conflict || (!restore && !preview)) return;
    if (restore && dirty) {
      setRestoreOpen(false);
      setError(
        'Сначала сохраните или отмените введённые уточнения. Возврат исходного ряда не должен удалять ваш несохранённый ввод.',
      );
      return;
    }
    if (restore && !restoreReason.trim()) {
      setError('Укажите основание возврата к исходному ряду.');
      return;
    }
    setWorking(true);
    setError(null);
    setSuccess(null);
    try {
      const next = restore
        ? await controller.actions.restoreStatistics({
            roadmapId: snapshot.roadmapId,
            metricId,
            expectedRevision: base.revision,
            reason: restoreReason.trim(),
          })
        : await controller.actions.saveStatistics({
            roadmapId: snapshot.roadmapId,
            metricId,
            expectedRevision: base.revision,
            changes: preview!,
            sourceReference: source.trim(),
            sourceDate: sourceDate || null,
            reason: reason.trim(),
            comparabilityNote: comparabilityNote.trim(),
          });
      if (!alive.current) return;
      acceptBase(currentBase(next));
      setRestoreOpen(false);
      setRestoreReason('');
      setSuccess(
        restore
          ? 'Команда вернулась к исходному ряду. Ранее сохранённые расчёты и уточнения остались в истории.'
          : 'Уточнения сохранены для всей территориальной команды. Сохранённые ранее расчёты остаются на своей редакции данных.',
      );
      if (historyOpen) void loadHistory();
    } catch (cause) {
      if (!alive.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : 'Сохранить уточнения не удалось. Ввод остаётся в форме.',
      );
      if (cause instanceof Error && 'code' in cause && cause.code === 'REVISION_CONFLICT') {
        setServerConflict(true);
        setPreview(null);
        await controller.actions.refresh();
      }
    } finally {
      if (alive.current) setWorking(false);
    }
  }

  return (
    <Modal
      title="Уточнение статистики"
      wide
      onClose={() => leave('close')}
      actions={
        <>
          <button
            className="button button-secondary"
            disabled={working}
            onClick={() => leave('close')}
          >
            Закрыть
          </button>
          {editable ? (
            preview ? (
              <button
                className="button button-primary"
                disabled={locked || conflict}
                onClick={() => void commit()}
              >
                <Save size={16} />
                Применить уточнения
              </button>
            ) : (
              <button
                className="button button-primary"
                disabled={locked || conflict || !dirtyYears.length}
                onClick={prepare}
              >
                Проверить изменения
              </button>
            )
          ) : null}
        </>
      }
    >
      <div className="rm-statistics-editor">
        <p className="rm-muted">
          {snapshot.territory.name} · общие данные команды · редакция {base.revision}
        </p>
        <label className="rm-field">
          <span>Редактируемый показатель</span>
          <select
            aria-label="Редактируемый показатель"
            value={metricId}
            disabled={working}
            onChange={(event) => leave(event.target.value as MunicipalMetricId)}
          >
            {STATISTICS_METRIC_IDS.map((id) => (
              <option key={id} value={id}>
                {STATISTICS_METRIC_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <Note>
          Исходный пакет сохраняется. Источник и основание относятся только к отмеченным годам;
          сведения об остальных наблюдениях остаются прежними. Пустое поле означает «нет данных»,
          число 0 — нулевое наблюдение.
        </Note>
        {metricId === 'pop_mid' ? (
          <p className="rm-source-caption">
            Среднегодовая численность, человек. Не подменяйте её численностью на 1 января. Допустимо
            до шести знаков после запятой.
          </p>
        ) : (
          <p className="rm-source-caption">
            Годовое значение, человек. Доли и коэффициенты не вводятся вместо абсолютного числа.
          </p>
        )}
        {leaveIntent ? (
          <div className="rm-statistics-confirm" role="alert">
            <p>В форме есть несохранённые изменения. Продолжить редактирование или закрыть их?</p>
            <div className="rm-inline-actions">
              <button className="button button-primary" onClick={() => setLeaveIntent(null)}>
                Продолжить редактирование
              </button>
              <button className="button button-secondary" onClick={() => leave(leaveIntent, true)}>
                Закрыть без сохранения
              </button>
            </div>
          </div>
        ) : null}
        {conflict ? (
          <div className="rm-statistics-conflict" role="alert">
            <h3>Данные команды изменились</h3>
            <p>
              Вы начали с редакции {base.revision}, сейчас доступна редакция {latest.revision}. Ваш
              ввод сохранён. Сравните изменения перед повторной проверкой.
            </p>
            <div className="rm-table-scroll">
              <table className="rm-data-table">
                <thead>
                  <tr>
                    <th>Год</th>
                    <th>До открытия</th>
                    <th>У команды сейчас</th>
                    <th>Ваш ввод</th>
                  </tr>
                </thead>
                <tbody>
                  {[...new Set([...conflictDiff.map((row) => row.year), ...dirtyYears])]
                    .sort((a, b) => b - a)
                    .map((year) => (
                      <tr key={year}>
                        <th>{year}</th>
                        <td>{pointLabel(base.series, year)}</td>
                        <td>
                          {pointLabel(latest.series, year)}
                          <small>
                            {statisticsPointOrigin(latest.series, year).sourceReference}
                          </small>
                        </td>
                        <td>
                          {draft[year]?.action === 'reset'
                            ? 'Возврат к исходному'
                            : draft[year]?.action === 'set'
                              ? draft[year]?.raw || 'Нет данных'
                              : 'Без вашей правки'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <button
              className="button button-secondary"
              disabled={locked || latest.revision === base.revision}
              onClick={() => {
                acceptBase(latest, true);
                setSuccess('Ваш ввод сохранён поверх новой основы. Проверьте изменения ещё раз.');
              }}
            >
              Сохранить мой ввод для повторной проверки
            </button>
            <button
              className="button button-quiet"
              disabled={locked}
              onClick={() =>
                void controller.actions.refresh().catch((cause) => setError(String(cause)))
              }
            >
              Обновить данные команды
            </button>
          </div>
        ) : null}
        <div
          className="rm-table-scroll rm-statistics-table"
          tabIndex={0}
          aria-label="Таблица редактирования исходных показателей"
        >
          <table className="rm-data-table">
            <thead>
              <tr>
                <th>Год</th>
                <th>Исходный пакет</th>
                <th>Рабочая редакция</th>
                <th>Ваше уточнение</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {years.map((year) => {
                const row = draft[year]!,
                  origin = statisticsPointOrigin(base.series, year);
                const overridden =
                  base.series &&
                  isTeamStatisticalSeries(base.series) &&
                  base.series.overrides.some((point) => point.year === year);
                return (
                  <tr key={year} data-edited={row.action !== 'keep'}>
                    <th scope="row">
                      {year}
                      {year === new Date().getUTCFullYear() ? <small>Текущий год</small> : null}
                    </th>
                    <td>{pointLabel(original, year)}</td>
                    <td>
                      {pointLabel(base.series, year)}
                      {origin.kind === 'participant_supplied' ? (
                        <details>
                          <summary>Источник уточнения</summary>
                          <p>{origin.sourceReference}</p>
                          {origin.sourceDate ? <p>{origin.sourceDate}</p> : null}
                          <p>{origin.reason}</p>
                          <p>Редакция {origin.revision}</p>
                        </details>
                      ) : null}
                    </td>
                    <td>
                      <input
                        aria-label={`Значение за ${year} год`}
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={row.raw}
                        maxLength={40}
                        disabled={locked || row.action === 'reset'}
                        onChange={(event) => edit(year, event.target.value)}
                        placeholder="Нет данных"
                      />
                      {row.action === 'reset' ? (
                        <small>
                          {original?.points.some((point) => point.year === year)
                            ? 'Вернётся исходное значение'
                            : 'Добавленный год будет удалён'}
                        </small>
                      ) : row.action === 'set' ? (
                        <small>Уточнение к сохранению</small>
                      ) : null}
                    </td>
                    <td>
                      {row.action !== 'keep' ? (
                        <button
                          className="button button-quiet"
                          disabled={locked}
                          aria-label={`Отменить ввод за ${year} год`}
                          onClick={() => undo(year)}
                        >
                          Отменить ввод
                        </button>
                      ) : null}
                      {overridden && row.action !== 'reset' ? (
                        <button
                          className="button button-quiet"
                          disabled={locked}
                          aria-label={`Вернуть исходное за ${year} год`}
                          onClick={() => resetYear(year)}
                        >
                          <RotateCcw size={14} />
                          Исходное
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!years.length ? (
            <p className="rm-empty">
              Для этой территории ряд пока не заполнен. Добавьте год и укажите значение из своего
              источника.
            </p>
          ) : null}
        </div>
        {editable ? (
          <>
            <div className="rm-statistics-add">
              <label className="rm-field">
                <span>Добавляемый год</span>
                <input
                  aria-label="Добавляемый год"
                  type="text"
                  inputMode="numeric"
                  value={newYear}
                  maxLength={4}
                  disabled={locked}
                  onChange={(event) => setNewYear(event.target.value)}
                />
              </label>
              <button className="button button-secondary" disabled={locked} onClick={addYear}>
                <Plus size={16} />
                Добавить год
              </button>
            </div>
            {years.some(
              (year) => year === new Date().getUTCFullYear() && draft[year]?.action === 'set',
            ) ? (
              <Note warning>
                Текущий календарный год ещё не завершён. Укажите в основании, что сведения
                предварительные, и охваченный период. Неполный год нельзя напрямую сопоставлять с
                итогами полных лет.
              </Note>
            ) : null}
            <div className="rm-form-grid">
              <label className="rm-field">
                <span>Источник уточнения</span>
                <textarea
                  aria-label="Источник уточнения"
                  rows={2}
                  maxLength={2000}
                  disabled={locked}
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value);
                    clearPreview();
                  }}
                  placeholder="Организация, документ, таблица или ссылка; реквизиты источника"
                />
              </label>
              <label className="rm-field">
                <span>Дата источника</span>
                <input
                  aria-label="Дата источника"
                  type="date"
                  min="1900-01-01"
                  max="2200-12-31"
                  disabled={locked}
                  value={sourceDate}
                  onChange={(event) => {
                    setSourceDate(event.target.value);
                    clearPreview();
                  }}
                />
              </label>
            </div>
            <label className="rm-field">
              <span>Основание изменения</span>
              <textarea
                aria-label="Основание изменения"
                rows={2}
                maxLength={4000}
                disabled={locked}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  clearPreview();
                }}
                placeholder="Что уточнено и почему этим значениям следует доверять"
              />
            </label>
            <label className="rm-field">
              <span>Ограничения сопоставимости</span>
              <textarea
                aria-label="Ограничения сопоставимости"
                rows={2}
                maxLength={4000}
                disabled={locked}
                value={comparabilityNote}
                onChange={(event) => {
                  setComparabilityNote(event.target.value);
                  clearPreview();
                }}
                placeholder="Границы территории, методика учёта, полнота года"
              />
            </label>
          </>
        ) : null}
        {preview ? (
          <section className="rm-statistics-preview" aria-label="Проверка уточнений">
            <h3>Перед применением</h3>
            <p>
              Будет изменено наблюдений: {preview.length}. Источник: {source}. Основание: {reason}.
            </p>
            <div className="rm-table-scroll">
              <table className="rm-data-table">
                <thead>
                  <tr>
                    <th>Год</th>
                    <th>Было</th>
                    <th>Станет</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((change) => (
                    <tr key={change.year}>
                      <th>{change.year}</th>
                      <td>{pointLabel(base.series, change.year)}</td>
                      <td>
                        {change.action === 'set'
                          ? numeric(change.value, 6)
                          : pointLabel(original, change.year)}
                        {change.action === 'reset' ? ' · исходное' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="rm-source-caption">
              Сохранённые сценарии и факты сохранят прежние числа до явного пересчёта или повторного
              закрепления.
            </p>
          </section>
        ) : null}
        {error ? (
          <p className="session-message" data-tone="error" role="alert">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="session-message" role="status">
            {success}
          </p>
        ) : null}
        <div className="rm-inline-actions">
          <button
            className="button button-secondary"
            onClick={() => {
              setHistoryOpen((previous) => !previous);
              if (!historyOpen) void loadHistory();
            }}
          >
            <History size={16} />
            История уточнений
          </button>
          {editable && latest.series && isTeamStatisticalSeries(latest.series) ? (
            <button
              className="button button-quiet"
              disabled={locked || conflict || dirty}
              onClick={() => setRestoreOpen((previous) => !previous)}
            >
              <RotateCcw size={16} />
              Вернуть весь исходный ряд
            </button>
          ) : null}
        </div>
        {restoreOpen ? (
          <section className="rm-statistics-confirm">
            <h3>Возврат к исходным данным</h3>
            <p>
              Рабочим станет исходный ряд. Если исходного ряда не было, текущие наблюдения будут
              сняты. Все прежние редакции и ссылки из расчётов сохранятся.
            </p>
            <label className="rm-field">
              <span>Основание возврата</span>
              <textarea
                aria-label="Основание возврата"
                rows={2}
                maxLength={4000}
                value={restoreReason}
                disabled={locked}
                onChange={(event) => setRestoreReason(event.target.value)}
              />
            </label>
            <button
              className="button button-secondary"
              disabled={locked || conflict || dirty || !restoreReason.trim()}
              onClick={() => void commit(true)}
            >
              Подтвердить возврат
            </button>
          </section>
        ) : null}
        {historyOpen ? (
          <section className="rm-statistics-history">
            <div className="rm-section-heading">
              <h3>История уточнений</h3>
              <button
                className="button button-quiet"
                disabled={historyLoading}
                onClick={() => void loadHistory()}
              >
                Обновить историю
              </button>
            </div>
            {historyLoading ? <p aria-busy="true">Загружаем историю…</p> : null}
            {historyError ? <p role="alert">{historyError}</p> : null}
            {history?.entries.map((entry) => (
              <article key={entry.revision}>
                <div>
                  <strong>
                    Редакция {entry.revision} ·{' '}
                    {entry.action === 'restore' ? 'Возврат к исходному' : 'Уточнение'}
                  </strong>
                  <p>
                    {entry.createdByName} · {timestampLabel(entry.createdAt)} (мск)
                  </p>
                  <p>{entry.reason}</p>
                  {entry.sourceReference ? (
                    <p className="rm-source-caption">
                      {entry.sourceReference}
                      {entry.sourceDate ? ` · ${entry.sourceDate}` : ''}
                    </p>
                  ) : null}
                </div>
                {entry.action === 'save' && entry.seriesId ? (
                  <button
                    className="button button-secondary"
                    onClick={() => void inspectEdition(entry.seriesId!)}
                  >
                    Показать редакцию {entry.revision}
                  </button>
                ) : null}
              </article>
            ))}
            {history && !history.entries.length ? <p>Ручных уточнений ещё нет.</p> : null}
            {history?.nextBeforeRevision ? (
              <button
                className="button button-secondary"
                disabled={historyLoading}
                onClick={() => void loadHistory(true)}
              >
                Более ранние уточнения
              </button>
            ) : null}
            {historicalSeries ? (
              <section className="rm-statistics-preview">
                <h4>Редакция {historicalSeries.revision}: наблюдения и происхождение</h4>
                <p className="rm-source-caption">
                  Эта таблица открыта только для просмотра. Текущая рабочая редакция не меняется.
                </p>
                <div className="rm-table-scroll">
                  <table className="rm-data-table">
                    <thead>
                      <tr>
                        <th>Год</th>
                        <th>Исходное</th>
                        <th>В редакции</th>
                        <th>Источник наблюдения</th>
                      </tr>
                    </thead>
                    <tbody>
                      {compareSeriesPoints(historicalSeries.baseSeries, historicalSeries).map(
                        (row) => (
                          <tr key={row.year}>
                            <th>{row.year}</th>
                            <td>
                              {row.before.present
                                ? numeric(row.before.value, 6)
                                : 'Год отсутствует'}
                            </td>
                            <td>
                              {row.after.present ? numeric(row.after.value, 6) : 'Год отсутствует'}
                            </td>
                            <td>
                              {row.after.origin.kind === 'participant_supplied'
                                ? row.after.origin.sourceReference
                                : 'Исходный пакет'}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="rm-source-caption">
                  SHA-256: <code>{historicalSeries.fingerprint}</code>
                </p>
              </section>
            ) : null}
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
