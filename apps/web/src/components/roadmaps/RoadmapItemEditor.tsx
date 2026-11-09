import { randomUuid } from '../../../../../packages/security/crypto.mjs';
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '../Modal';
import { roadmapDataSchemas } from '../../../../../packages/roadmaps/schema';
import type { RoadmapItemKind, SaveRoadmapItemInput } from '../../../../../packages/roadmaps/types';
import {
  normalizeQuantity,
  parseRublesToKopecks,
  kopecksToRublesInput,
} from '../../../../../packages/analytics';
import { activeItems, emptyData, kindLabels, Note } from './common';
import type { EditorTarget, RoadmapWorkspaceProps } from './common';

type Field = {
  key: string;
  label: string;
  type?: 'text' | 'area' | 'date' | 'number' | 'money' | 'select';
  hint?: string;
  max?: number;
  options?: Array<[string, string]>;
  nullable?: boolean;
};
const f = (
  key: string,
  label: string,
  type: Field['type'] | Partial<Field> = 'area',
  extra: Partial<Field> = {},
): Field => ({
  key,
  label,
  type: typeof type === 'object' ? 'area' : type,
  ...(typeof type === 'object' ? type : extra),
});
const text = (key: string, label: string, extra: Partial<Field> = {}) =>
  f(key, label, 'text', extra);
const date = (key: string, label: string) => f(key, label, 'date', { nullable: true });
const select = (key: string, label: string, options: Array<[string, string]>) =>
  f(key, label, 'select', { options });
const fields: Record<RoadmapItemKind, Field[]> = {
  passport: [
    text('title', 'Название проекта', { max: 240 }),
    f('targetGroup', 'Целевая группа'),
    f('partners', 'Заинтересованные стороны и партнёры'),
    f('goal', 'Цель проекта'),
    date('startDate', 'Начало проекта'),
    date('endDate', 'Окончание проекта'),
    f('expectedResult', 'Ожидаемый результат'),
    date('defenseDate', 'Дата защиты'),
    f('humanResources', 'Кадровые ресурсы'),
    f('materialResources', 'Материальные ресурсы'),
    f('informationResources', 'Информационные ресурсы'),
  ],
  diagnosis: [
    f('problem', 'Приоритетная проблема', {
      hint: 'Сформулируйте, для какой группы и в чём проявляется затруднение. Приведите связь с фактами и барьерами.',
    }),
    f('causeHypothesis', 'Гипотеза о причинах', {
      hint: 'Отделите установленный факт от предполагаемого механизма.',
    }),
    f('conclusion', 'Вывод для проекта', {
      hint: 'Что команда может изменить и почему выбирает это направление?',
    }),
  ],
  monitoring: [
    text('frequency', 'Периодичность контроля', { max: 1000 }),
    f('method', 'Как собираем и проверяем данные'),
    text('responsible', 'Ответственный за мониторинг', { max: 1000 }),
    date('interimReportDate', 'Промежуточный отчёт'),
    date('finalReportDate', 'Итоговый отчёт'),
    f('qualitativeResults', 'Качественные результаты и обратная связь семей'),
    f('sustainability', 'Устойчивость после завершения проекта'),
  ],
  activity: [
    text('title', 'Название мероприятия', { max: 240 }),
    f('description', 'Содержание и механизм действия'),
    f('targetGroup', 'Для кого'),
    text('scale', 'Масштаб и охват', { max: 1000 }),
    date('startDate', 'Начало мероприятия'),
    date('endDate', 'Окончание мероприятия'),
    text('responsible', 'Ответственный исполнитель', { max: 1000 }),
    f('partners', 'Партнёры'),
    f('deliverable', 'Проверяемый результат'),
    f('completionCriterion', 'Критерий завершения'),
    select('stage', 'Этап', [
      ['preparation', 'Подготовка'],
      ['implementation', 'Реализация'],
      ['evaluation', 'Оценка результатов'],
      ['custom', 'Свой этап'],
    ]),
    text('stageLabel', 'Название своего этапа', { max: 240 }),
    select('progressStatus', 'Ход выполнения', [
      ['planned', 'Запланировано'],
      ['in_progress', 'В работе'],
      ['completed', 'Завершено'],
    ]),
    select('authorityLevel', 'Уровень полномочий', [
      ['unknown', 'Нужно установить'],
      ['municipal', 'Муниципальный'],
      ['regional', 'Региональный'],
      ['federal', 'Федеральный'],
      ['organization', 'Организация'],
      ['joint', 'Совместный'],
    ]),
    f('legalBasis', 'Документальное основание полномочий', {
      hint: 'Название, реквизиты и конкретное положение документа. Поле фиксирует проверку команды.',
    }),
    select('approvalStatus', 'Результат проверки полномочий', [
      ['unknown', 'Не проверено'],
      ['requires_decision', 'Необходимо решение'],
      ['verified_source', 'Команда проверила источник'],
      ['contradiction', 'Выявлено противоречие'],
    ]),
    text('responsibleBody', 'Орган, принимающий решение', { max: 1000 }),
    f('necessaryDecision', 'Необходимое решение или согласование'),
  ],
  indicator: [
    text('title', 'Название показателя', { max: 240 }),
    f('definition', 'Что именно измеряем'),
    select('kind', 'Место в логике проекта', [
      ['resource', 'Ресурс'],
      ['output', 'Непосредственный результат'],
      ['family_outcome', 'Изменение положения семей'],
      ['demographic_context', 'Демографический контекст'],
    ]),
    text('unit', 'Единица измерения', { max: 120 }),
    select('semanticType', 'Тип показателя', [
      ['flow', 'Поток за период'],
      ['stock', 'Численность / запас'],
      ['rate', 'Коэффициент'],
      ['share', 'Доля'],
    ]),
    select('valueDomain', 'Допустимые значения', [
      ['nonnegative', 'Ноль и положительные'],
      ['signed', 'Включая отрицательные'],
      ['percent', 'Проценты: от 0 до 100'],
      ['ratio', 'Доля: от 0 до 1'],
    ]),
    f('baselineYear', 'Год базового значения', 'number', { nullable: true }),
    f('baselineValue', 'Базовое значение', 'number', { nullable: true }),
    f('numeratorDefinition', 'Числитель (для коэффициента или доли)'),
    f('denominatorDefinition', 'Знаменатель (для коэффициента или доли)'),
    f('sourceReference', 'Источник и способ проверки'),
    text('frequency', 'Периодичность измерения', { max: 1000 }),
    text('responsible', 'Ответственный', { max: 1000 }),
    f('limitations', 'Ограничения интерпретации'),
  ],
  scenario: [],
  cost: [
    text('title', 'Статья затрат', { max: 240 }),
    f('year', 'Год расходов', 'number'),
    text('unit', 'Единица расчёта', { max: 120 }),
    text('quantity', 'Количество', { hint: 'До трёх знаков после запятой.' }),
    f('unitPriceKopecks', 'Стоимость единицы, ₽', 'money'),
    f('periods', 'Число повторений / периодов', 'number'),
    select('cashKind', 'Тип ресурса', [
      ['cash', 'Денежные расходы'],
      ['in_kind', 'Натуральный вклад'],
    ]),
    select('priceStatus', 'Основание цены', [
      ['estimated', 'Расчётная оценка'],
      ['confirmed', 'Подтверждена источником'],
    ]),
    f('priceSource', 'Источник цены'),
    date('priceDate', 'Дата источника цены'),
  ],
  funding: [
    text('sourceName', 'Источник средств', { max: 240 }),
    select('sourceKind', 'Тип источника', [
      ['municipal_budget', 'Муниципальный бюджет'],
      ['regional_budget', 'Региональный бюджет'],
      ['federal_budget', 'Федеральный бюджет'],
      ['employer', 'Работодатель'],
      ['grant', 'Грант'],
      ['other', 'Другой источник'],
    ]),
    f('amountKopecks', 'Сумма, ₽', 'money'),
    select('status', 'Статус финансирования', [
      ['assumption', 'Предположение'],
      ['application', 'Заявка'],
      ['budget_draft', 'Проект бюджета'],
      ['confirmed', 'Подтверждено'],
    ]),
    f('sourceReference', 'Подтверждающий документ', {
      hint: 'Для подтверждённых средств обязательны документ и дата.',
    }),
    date('sourceDate', 'Дата документа'),
    f('originReference', 'Происхождение средств / связь с трансфертом', {
      hint: 'Помогает команде исключить двойной счёт одного поступления.',
    }),
  ],
  risk: [
    text('title', 'Риск', { max: 240 }),
    f('mitigation', 'Как снижаем вероятность или последствия'),
    text('owner', 'Ответственный', { max: 1000 }),
    f('trigger', 'Сигнал для пересмотра плана'),
    f('contingency', 'Резервное действие'),
  ],
  fact: [
    text('title', 'Факт или наблюдение', { max: 240 }),
    f('year', 'Год', 'number', { nullable: true }),
    f('value', 'Значение', 'number', { nullable: true }),
    text('unit', 'Единица измерения', { max: 120 }),
    f('sourceReference', 'Источник'),
    date('sourceDate', 'Дата источника'),
    f('interpretation', 'Значение для проекта'),
  ],
};
function readable(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Не заполнено';
  if (Array.isArray(value))
    return (
      value
        .map((v) =>
          typeof v === 'object' && v !== null
            ? Object.values(v as Record<string, unknown>).join(' — ')
            : String(v),
        )
        .join('; ') || 'Не заполнено'
    );
  return String(value);
}
export function RoadmapItemEditor({
  target,
  snapshot,
  controller,
  editable,
  onClose,
}: Omit<RoadmapWorkspaceProps, 'onEdit'> & { target: EditorTarget; onClose(): void }) {
  const current = target.id ? snapshot.items.find((item) => item.id === target.id) : undefined;
  const [baseRevision, setBaseRevision] = useState(current?.revision ?? 0);
  const [data, setData] = useState<Record<string, unknown>>(
    () =>
      structuredClone(
        current?.data ?? { ...emptyData(target.kind), ...target.initial },
      ) as unknown as Record<string, unknown>,
  );
  const [moneyInput, setMoneyInput] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields[target.kind]
        .filter((field) => field.type === 'money')
        .map((field) => [
          field.key,
          kopecksToRublesInput(
            Number(
              (current?.data as unknown as Record<string, unknown> | undefined)?.[field.key] ??
                target.initial?.[field.key] ??
                0,
            ),
          ),
        ]),
    ),
  );
  const [error, setError] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const changed = Boolean(current && current.revision !== baseRevision);
  const put = (key: string, value: unknown) =>
    setData((previous) => ({ ...previous, [key]: value }));
  const registeredFact = target.kind === 'fact' && data.sourceKind !== 'external_unverified';
  const disabled = !editable || saving || controller.busy || current?.status === 'archived';
  const objectives = (data.objectives ?? []) as Array<{ id: string; title: string }>;
  const annualTargets = (data.annualTargets ?? []) as Array<{ year: number; value: number }>;
  const dependencies = (data.dependencies ?? []) as Array<{
    predecessorId: string;
    lagDays: number;
  }>;
  const selectedIndicators = (data.indicatorIds ?? []) as string[];
  function loadCurrent() {
    if (!current) return;
    setData(structuredClone(current.data) as unknown as Record<string, unknown>);
    setBaseRevision(current.revision);
    setMoneyInput(
      Object.fromEntries(
        fields[target.kind]
          .filter((field) => field.type === 'money')
          .map((field) => [
            field.key,
            kopecksToRublesInput(
              Number((current.data as unknown as Record<string, unknown>)[field.key]),
            ),
          ]),
      ),
    );
    setError(null);
  }
  async function save() {
    if (disabled || changed) return;
    setSaving(true);
    setError(null);
    try {
      const clean = { ...data };
      for (const field of fields[target.kind])
        if (field.type === 'money')
          clean[field.key] = parseRublesToKopecks(moneyInput[field.key] ?? '');
      if (target.kind === 'cost') clean.quantity = normalizeQuantity(String(clean.quantity));
      const parsed = roadmapDataSchemas[target.kind].safeParse(clean);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const label = fields[target.kind].find((field) => field.key === issue?.path[0])?.label;
        throw new Error(
          label
            ? `Проверьте поле «${label}»: значение не соответствует допустимому формату.`
            : 'Проверьте связанные значения: даты начала и окончания, базовый год и значение, уникальность целей и целевых лет.',
        );
      }
      if (registeredFact && target.id) {
        await controller.actions.captureFact({
          roadmapId: snapshot.roadmapId,
          itemId: target.id,
          expectedRevision: baseRevision,
          seriesId: String(clean.seriesId),
          expectedSeriesFingerprint: String(clean.seriesFingerprint),
          year: Number(clean.year),
          interpretation: String(clean.interpretation),
        });
      } else
        await controller.actions.saveItem({
          roadmapId: snapshot.roadmapId,
          itemId: target.id ?? null,
          expectedRevision: baseRevision,
          kind: target.kind,
          data: parsed.data,
          status: 'active',
        } as SaveRoadmapItemInput);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Сохранение не выполнено.');
      void controller.actions.refresh();
    } finally {
      setSaving(false);
    }
  }
  async function archive() {
    if (!current || disabled || changed) return;
    setSaving(true);
    setError(null);
    try {
      await controller.actions.saveItem({
        roadmapId: snapshot.roadmapId,
        itemId: current.id,
        expectedRevision: baseRevision,
        kind: current.kind,
        data: current.data,
        status: 'archived',
      } as SaveRoadmapItemInput);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Запись не удалось снять.');
      void controller.actions.refresh();
    } finally {
      setSaving(false);
    }
  }
  function reference(
    key: string,
    label: string,
    options: Array<[string, string]>,
    nullable = false,
  ) {
    return (
      <label className="rm-field" key={key}>
        <span>{label}</span>
        <select
          value={String(data[key] ?? '')}
          disabled={disabled}
          onChange={(event) => put(key, event.target.value || (nullable ? null : ''))}
        >
          <option value="">Выберите…</option>
          {options.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <Modal
      title={kindLabels[target.kind]}
      wide
      onClose={() => {
        if (!saving) onClose();
      }}
      actions={
        <>
          <button className="button button-secondary" onClick={onClose} disabled={saving}>
            Закрыть
          </button>
          <button
            className="button button-primary"
            disabled={disabled || changed}
            onClick={() => void save()}
          >
            {saving ? 'Сохраняем…' : 'Сохранить изменения'}
          </button>
        </>
      }
    >
      {current ? (
        <p className="rm-muted">
          Редакция {baseRevision}. Последнее изменение: {current.updatedByName}.
        </p>
      ) : (
        <p className="rm-muted">Новая запись общей дорожной карты.</p>
      )}
      {registeredFact ? (
        <Note>
          Значение и источник закреплены за статистическим рядом. Здесь можно изменить интерпретацию
          факта.
        </Note>
      ) : target.kind === 'fact' ? (
        <Note>
          Ручной источник. Команда самостоятельно проверяет его происхождение и сопоставимость.
        </Note>
      ) : null}
      {changed ? (
        <div className="rm-conflict" role="alert">
          <h3>Эту запись изменил другой участник</h3>
          <p>Ваш текст сохранён в открытой форме. Сопоставьте значения перед продолжением.</p>
          <div className="rm-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Поле</th>
                  <th>Текущая запись команды</th>
                  <th>Ваш вариант</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(data)
                  .filter(
                    (key) =>
                      JSON.stringify(data[key]) !==
                      JSON.stringify((current!.data as unknown as Record<string, unknown>)[key]),
                  )
                  .map((key) => (
                    <tr key={key}>
                      <th>
                        {fields[target.kind].find((field) => field.key === key)?.label ??
                          (
                            {
                              objectives: 'Задачи',
                              annualTargets: 'Ориентиры по годам',
                              dependencies: 'Зависимости',
                              indicatorIds: 'Показатели',
                            } as Record<string, string>
                          )[key] ??
                          key}
                      </th>
                      <td>
                        {readable((current!.data as unknown as Record<string, unknown>)[key])}
                      </td>
                      <td>{readable(data[key])}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="rm-actions">
            <button className="button button-secondary" onClick={loadCurrent}>
              Загрузить значения команды
            </button>
            <button
              className="button button-secondary"
              onClick={() => {
                setBaseRevision(current!.revision);
                setError(null);
              }}
            >
              Сверено: продолжить с моим вариантом
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="session-message" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      {current && !['passport', 'diagnosis', 'monitoring'].includes(target.kind) ? (
        <div className="rm-archive-control">
          {confirmArchive ? (
            <>
              <Note warning>
                Запись будет снята из активного проекта. Существующие зафиксированные версии
                сохранят её. Связанные записи сначала необходимо переназначить или снять.
              </Note>
              <div className="rm-actions">
                <button
                  className="button button-secondary"
                  disabled={disabled || changed}
                  onClick={() => void archive()}
                >
                  Подтвердить снятие
                </button>
                <button className="button button-quiet" onClick={() => setConfirmArchive(false)}>
                  Оставить запись
                </button>
              </div>
            </>
          ) : (
            <button
              className="button button-quiet"
              disabled={disabled || changed}
              onClick={() => setConfirmArchive(true)}
            >
              <Trash2 size={15} />
              Убрать запись из проекта
            </button>
          )}
        </div>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="rm-form-grid"
      >
        {target.kind === 'activity'
          ? reference(
              'objectiveId',
              'Задача проекта',
              activeItems(snapshot, 'passport')[0]?.data.objectives.map((item) => [
                item.id,
                item.title || 'Задача без названия',
              ]) ?? [],
              true,
            )
          : null}
        {target.kind === 'cost'
          ? reference(
              'activityId',
              'Мероприятие',
              activeItems(snapshot, 'activity').map((item) => [
                item.id,
                item.data.title || 'Без названия',
              ]),
            )
          : null}
        {target.kind === 'funding'
          ? reference(
              'costLineId',
              'Финансируемая статья',
              activeItems(snapshot, 'cost')
                .filter((item) => item.data.cashKind === 'cash')
                .map((item) => [
                  item.id,
                  `${item.data.year} · ${item.data.title || 'Статья затрат'}`,
                ]),
            )
          : null}
        {fields[target.kind].map((field) => {
          const id = `rm-edit-${field.key}`,
            locked = disabled || (registeredFact && field.key !== 'interpretation');
          return (
            <label
              className={`rm-field${field.type === 'area' ? ' full' : ''}`}
              key={field.key}
              htmlFor={id}
            >
              <span>{field.label}</span>
              {field.type === 'area' ? (
                <textarea
                  id={id}
                  rows={3}
                  maxLength={field.max ?? 4000}
                  value={String(data[field.key] ?? '')}
                  disabled={locked}
                  onChange={(event) => put(field.key, event.target.value)}
                />
              ) : field.type === 'select' ? (
                <select
                  id={id}
                  value={String(data[field.key] ?? '')}
                  disabled={locked}
                  onChange={(event) => put(field.key, event.target.value)}
                >
                  {field.options?.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type={
                    field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'
                  }
                  step={field.type === 'number' ? 'any' : undefined}
                  maxLength={field.max ?? (field.type === 'text' ? 1000 : undefined)}
                  inputMode={field.type === 'money' ? 'decimal' : undefined}
                  value={
                    field.type === 'money'
                      ? (moneyInput[field.key] ?? '')
                      : typeof data[field.key] === 'number' && !Number.isFinite(data[field.key])
                        ? ''
                        : String(data[field.key] ?? '')
                  }
                  disabled={locked}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (field.type === 'money')
                      setMoneyInput((previous) => ({ ...previous, [field.key]: value }));
                    else
                      put(
                        field.key,
                        field.type === 'number'
                          ? value === '' && field.nullable
                            ? null
                            : event.target.valueAsNumber
                          : field.type === 'date'
                            ? value || null
                            : value,
                      );
                  }}
                />
              )}
              {field.hint ? <small>{field.hint}</small> : null}
            </label>
          );
        })}
        {target.kind === 'passport' ? (
          <fieldset className="rm-array full">
            <legend>Задачи проекта</legend>
            {objectives.map((objective, index) => (
              <div className="rm-array-row" key={objective.id}>
                <input
                  aria-label={`Задача ${index + 1}`}
                  maxLength={1000}
                  value={objective.title}
                  disabled={disabled}
                  onChange={(event) =>
                    put(
                      'objectives',
                      objectives.map((item) =>
                        item.id === objective.id ? { ...item, title: event.target.value } : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  disabled={disabled}
                  aria-label={`Удалить задачу ${index + 1}`}
                  onClick={() =>
                    put(
                      'objectives',
                      objectives.filter((item) => item.id !== objective.id),
                    )
                  }
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button button-secondary"
              disabled={disabled || objectives.length >= 30}
              onClick={() =>
                put('objectives', [...objectives, { id: randomUuid(), title: '' }])
              }
            >
              <Plus size={16} />
              Добавить задачу
            </button>
          </fieldset>
        ) : null}
        {target.kind === 'indicator' ? (
          <fieldset className="rm-array full">
            <legend>Целевые значения по годам</legend>
            {annualTargets.map((target, index) => (
              <div className="rm-array-row" key={index}>
                <label>
                  <span>Год</span>
                  <input
                    aria-label={`Целевой год ${index + 1}`}
                    type="number"
                    min={1900}
                    max={2200}
                    value={target.year}
                    disabled={disabled}
                    onChange={(event) =>
                      put(
                        'annualTargets',
                        annualTargets.map((row, i) =>
                          i === index ? { ...row, year: Number(event.target.value) } : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  <span>Значение</span>
                  <input
                    aria-label={`Целевое значение ${index + 1}`}
                    type="number"
                    step="any"
                    value={target.value}
                    disabled={disabled}
                    onChange={(event) =>
                      put(
                        'annualTargets',
                        annualTargets.map((row, i) =>
                          i === index ? { ...row, value: Number(event.target.value) } : row,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  disabled={disabled}
                  aria-label={`Удалить целевой год ${index + 1}`}
                  onClick={() =>
                    put(
                      'annualTargets',
                      annualTargets.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button button-secondary"
              disabled={disabled || annualTargets.length >= 31}
              onClick={() =>
                put('annualTargets', [
                  ...annualTargets,
                  {
                    year:
                      Math.max(
                        new Date().getFullYear() - 1,
                        ...annualTargets.map((row) => row.year),
                      ) + 1,
                    value: 0,
                  },
                ])
              }
            >
              <Plus size={16} />
              Добавить год
            </button>
            {data.scenarioId ? (
              <p className="rm-muted">
                Ориентиры связаны с сохранённым сценарием. Его изменение требует явного обновления
                значений показателя.
              </p>
            ) : null}
          </fieldset>
        ) : null}
        {target.kind === 'activity' ? (
          <>
            <fieldset className="rm-array full">
              <legend>Показатели результата</legend>
              {activeItems(snapshot, 'indicator').length ? (
                activeItems(snapshot, 'indicator').map((item) => (
                  <label className="rm-check" key={item.id}>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={selectedIndicators.includes(item.id)}
                      onChange={(event) =>
                        put(
                          'indicatorIds',
                          event.target.checked
                            ? [...selectedIndicators, item.id]
                            : selectedIndicators.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span>{item.data.title || 'Показатель без названия'}</span>
                  </label>
                ))
              ) : (
                <p className="rm-muted">Сначала добавьте показатель во вкладке «Мероприятия».</p>
              )}
            </fieldset>
            <fieldset className="rm-array full">
              <legend>Предшествующие мероприятия</legend>
              <p className="rm-muted">
                Начало возможно на следующий день после окончания предшественника и указанного
                дополнительного интервала.
              </p>
              {dependencies.map((dependency, index) => (
                <div className="rm-array-row" key={index}>
                  <select
                    aria-label={`Предшественник ${index + 1}`}
                    disabled={disabled}
                    value={dependency.predecessorId}
                    onChange={(event) =>
                      put(
                        'dependencies',
                        dependencies.map((row, i) =>
                          i === index ? { ...row, predecessorId: event.target.value } : row,
                        ),
                      )
                    }
                  >
                    <option value="">Выберите мероприятие</option>
                    {activeItems(snapshot, 'activity')
                      .filter((item) => item.id !== target.id)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.data.title || 'Без названия'}
                        </option>
                      ))}
                  </select>
                  <label>
                    <span>Дополнительно, дней</span>
                    <input
                      aria-label={`Интервал ${index + 1}`}
                      type="number"
                      min={0}
                      max={3650}
                      disabled={disabled}
                      value={dependency.lagDays}
                      onChange={(event) =>
                        put(
                          'dependencies',
                          dependencies.map((row, i) =>
                            i === index ? { ...row, lagDays: Number(event.target.value) } : row,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={disabled}
                    aria-label={`Удалить зависимость ${index + 1}`}
                    onClick={() =>
                      put(
                        'dependencies',
                        dependencies.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              ))}
              <button
                className="button button-secondary"
                type="button"
                disabled={
                  disabled ||
                  dependencies.length >= 39 ||
                  activeItems(snapshot, 'activity').length < 2
                }
                onClick={() =>
                  put('dependencies', [...dependencies, { predecessorId: '', lagDays: 0 }])
                }
              >
                <Plus size={16} />
                Добавить зависимость
              </button>
            </fieldset>
          </>
        ) : null}
      </form>
    </Modal>
  );
}
