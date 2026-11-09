import { useId, useRef, useState } from 'react';
import { CalendarDays, MoveHorizontal } from 'lucide-react';
import type { RoadmapItem } from '../../../../../packages/roadmaps/types';
import {
  calendarDay,
  computeRoadmapBudget,
  inspectCalendar,
  shiftActivityDates,
} from '../../../../../packages/analytics';
import type { CalendarActivity } from '../../../../../packages/analytics';
import { Modal } from '../Modal';
import {
  activeItems,
  dateLabel,
  EditButton,
  EmptySection,
  money,
  Note,
  saveInput,
  SectionHeading,
  useRoadmapTask,
} from './common';
import type { RoadmapWorkspaceProps } from './common';

export function CalendarResources(props: RoadmapWorkspaceProps) {
  const { snapshot, controller, editable, onEdit } = props,
    activities = activeItems(snapshot, 'activity'),
    costs = activeItems(snapshot, 'cost'),
    funding = activeItems(snapshot, 'funding'),
    passport = activeItems(snapshot, 'passport')[0];
  const [moving, setMoving] = useState<{ item: RoadmapItem<'activity'>; days: number } | null>(
      null,
    ),
    [drag, setDrag] = useState<{ id: string; days: number } | null>(null);
  const dragRef = useRef<{
      id: string;
      startX: number;
      pixelWidth: number;
      span: number;
      days: number;
      pointerId: number;
    } | null>(null),
    marker = useId(),
    task = useRoadmapTask();
  const calendarInputs: CalendarActivity[] = activities.map((item) => ({
    id: item.id,
    title: item.data.title || 'Без названия',
    startDate: item.data.startDate,
    endDate: item.data.endDate,
    dependencies: item.data.dependencies,
  }));
  const dated = calendarInputs.filter(
    (item): item is CalendarActivity & { startDate: string; endDate: string } =>
      Boolean(item.startDate && item.endDate),
  );
  const dates = dated.flatMap((item) => [item.startDate, item.endDate]);
  const period = {
    startDate: passport?.data.startDate ?? dates.sort()[0] ?? `${new Date().getFullYear()}-01-01`,
    endDate: passport?.data.endDate ?? dates.sort().at(-1) ?? `${new Date().getFullYear()}-12-31`,
  };
  const calendar = inspectCalendar(calendarInputs, period),
    budget = computeRoadmapBudget(snapshot);
  const start = Math.min(calendarDay(period.startDate), ...dates.map(calendarDay)),
    end = Math.max(calendarDay(period.endDate), ...dates.map(calendarDay)),
    span = Math.max(1, end - start + 1),
    width = 1000,
    head = 42,
    rowHeight = 57,
    left = 300,
    right = 20,
    plotWidth = width - left - right;
  const x = (day: number) => left + ((day - start) / span) * plotWidth;
  const ticks = [
    ...new Set(
      Array.from(
        { length: Math.min(5, span + 1) },
        (_, i) => start + Math.round(((span - 1) * i) / Math.min(4, span)),
      ),
    ),
  ];
  let preview: ReturnType<typeof shiftActivityDates> | null = null,
    previewError: string | null = null;
  if (moving) {
    try {
      preview = shiftActivityDates({ id: moving.item.id, ...moving.item.data }, moving.days);
    } catch (cause) {
      previewError = cause instanceof Error ? cause.message : 'Невозможный сдвиг.';
    }
  }
  const previewIssues =
    preview && moving
      ? inspectCalendar(
          calendarInputs.map((item) =>
            item.id === moving.item.id ? { ...item, ...preview } : item,
          ),
          period,
        ).issues
      : [];
  function openMove(item: RoadmapItem<'activity'>, days = 0) {
    setMoving({ item, days });
  }
  return (
    <div className="rm-resources">
      <section className="rm-section">
        <SectionHeading title="Календарь проекта">
          Перемещайте полосу мероприятия или задайте даты в его карточке. Изменение сохраняется
          после проверки.
        </SectionHeading>
        {dated.length ? (
          <>
            <div className="rm-gantt-scroll">
              <svg
                className="rm-gantt"
                viewBox={`0 0 ${width} ${head + activities.length * rowHeight + 12}`}
                role="group"
                aria-label="Календарь мероприятий"
              >
                <defs>
                  <marker
                    id={marker}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0 L8 4 L0 8Z" fill="#778aa4" />
                  </marker>
                </defs>
                <rect width={width} height={head} fill="#f3f6fb" />
                <text x={16} y={27} className="rm-gantt-heading">
                  Мероприятие
                </text>
                {ticks.map((day, tickIndex) => (
                  <g key={day}>
                    <line
                      x1={x(day)}
                      x2={x(day)}
                      y1={head}
                      y2={head + activities.length * rowHeight}
                      stroke="#e3e9f0"
                    />
                    <text
                      x={x(day)}
                      y={26}
                      textAnchor={tickIndex === ticks.length - 1 ? 'end' : 'middle'}
                      className="rm-chart-tick"
                    >
                      {new Date(day * 86400000).toLocaleDateString('ru-RU', {
                        day: '2-digit',
                        month: 'short',
                        year: '2-digit',
                        timeZone: 'UTC',
                      })}
                    </text>
                  </g>
                ))}
                {activities.flatMap((item, index) =>
                  item.data.dependencies.map((dep) => {
                    const prior = activities.findIndex(
                      (candidate) => candidate.id === dep.predecessorId,
                    );
                    const from = activities[prior];
                    if (prior < 0 || !from?.data.endDate || !item.data.startDate) return null;
                    const x1 = x(calendarDay(from.data.endDate) + 1),
                      x2 = x(calendarDay(item.data.startDate)),
                      y1 = head + prior * rowHeight + rowHeight / 2,
                      y2 = head + index * rowHeight + rowHeight / 2;
                    return (
                      <path
                        key={`${item.id}-${dep.predecessorId}`}
                        d={`M${x1} ${y1} H${x1 + 10} V${y2} H${x2}`}
                        fill="none"
                        stroke="#778aa4"
                        strokeWidth="1.4"
                        markerEnd={`url(#${marker})`}
                      />
                    );
                  }),
                )}
                {activities.map((item, index) => {
                  const y = head + index * rowHeight,
                    offset = drag?.id === item.id ? drag.days : 0;
                  return (
                    <g key={item.id}>
                      <line
                        x1={0}
                        x2={width}
                        y1={y + rowHeight}
                        y2={y + rowHeight}
                        stroke="#e3e9f0"
                      />
                      <foreignObject x={14} y={y + 7} width={left - 30} height={rowHeight - 10}>
                        <div className="rm-gantt-label">
                          <strong>
                            {String(index + 1).padStart(2, '0')} ·{' '}
                            {item.data.title || 'Без названия'}
                          </strong>
                          <span>{item.data.responsible || 'Исполнитель не назначен'}</span>
                        </div>
                      </foreignObject>
                      {item.data.startDate && item.data.endDate ? (
                        <rect
                          x={x(calendarDay(item.data.startDate) + offset)}
                          y={y + 15}
                          width={Math.max(
                            5,
                            ((calendarDay(item.data.endDate) -
                              calendarDay(item.data.startDate) +
                              1) /
                              span) *
                              plotWidth,
                          )}
                          height={26}
                          rx={5}
                          className="rm-gantt-bar"
                          data-stage={item.data.stage}
                          data-complete={item.data.progressStatus === 'completed'}
                          role="button"
                          tabIndex={0}
                          aria-label={`${item.data.title || 'Мероприятие'}: ${dateLabel(item.data.startDate)} — ${dateLabel(item.data.endDate)}. Открыть перенос сроков`}
                          aria-disabled={!editable}
                          onPointerDown={(event) => {
                            if (!editable || controller.busy || event.button !== 0) return;
                            const bounds =
                              event.currentTarget.ownerSVGElement!.getBoundingClientRect();
                            event.currentTarget.setPointerCapture(event.pointerId);
                            dragRef.current = {
                              id: item.id,
                              startX: event.clientX,
                              pixelWidth: (bounds.width / width) * plotWidth,
                              span,
                              days: 0,
                              pointerId: event.pointerId,
                            };
                            setDrag({ id: item.id, days: 0 });
                          }}
                          onPointerMove={(event) => {
                            const active = dragRef.current;
                            if (!active || active.id !== item.id) return;
                            active.days = Math.round(
                              ((event.clientX - active.startX) / active.pixelWidth) * active.span,
                            );
                            setDrag({ id: item.id, days: active.days });
                          }}
                          onPointerUp={(event) => {
                            const active = dragRef.current;
                            if (!active || active.id !== item.id) return;
                            event.currentTarget.releasePointerCapture(event.pointerId);
                            dragRef.current = null;
                            setDrag(null);
                            openMove(item, active.days);
                          }}
                          onPointerCancel={() => {
                            dragRef.current = null;
                            setDrag(null);
                          }}
                          onKeyDown={(event) => {
                            if (
                              editable &&
                              (event.key === 'Enter' ||
                                event.key === ' ' ||
                                event.key === 'ArrowLeft' ||
                                event.key === 'ArrowRight')
                            ) {
                              event.preventDefault();
                              openMove(
                                item,
                                event.key === 'ArrowLeft'
                                  ? -(event.shiftKey ? 7 : 1)
                                  : event.key === 'ArrowRight'
                                    ? event.shiftKey
                                      ? 7
                                      : 1
                                    : 0,
                              );
                            }
                          }}
                        >
                          <title>
                            {item.data.title} · {dateLabel(item.data.startDate)}–
                            {dateLabel(item.data.endDate)}
                          </title>
                        </rect>
                      ) : (
                        <text x={left + 10} y={y + 34} className="rm-chart-tick">
                          Даты не заданы
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
            <p className="rm-source-caption">
              Календарные дни. Стрелки показывают зависимости «завершение → начало». Перенос дат не
              изменяет автоматически год расходов.
            </p>
          </>
        ) : (
          <EmptySection>
            <CalendarDays size={28} />
            <p>Задайте даты хотя бы одного мероприятия, чтобы построить календарь.</p>
          </EmptySection>
        )}
        {calendar.issues.map((issue, index) => (
          <p className="rm-warning-text" key={`${issue.code}-${index}`}>
            {issue.message}
          </p>
        ))}
        <div className="rm-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Мероприятие</th>
                <th>Начало</th>
                <th>Окончание</th>
                <th>Управление сроками</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((item) => (
                <tr key={item.id}>
                  <th>{item.data.title || 'Без названия'}</th>
                  <td>{dateLabel(item.data.startDate)}</td>
                  <td>{dateLabel(item.data.endDate)}</td>
                  <td>
                    <div className="rm-actions">
                      {editable ? (
                        <>
                          <EditButton
                            label="Даты и зависимости"
                            onClick={() => onEdit({ kind: 'activity', id: item.id })}
                          />
                          <button
                            className="button button-quiet"
                            disabled={!item.data.startDate || !item.data.endDate}
                            onClick={() => openMove(item)}
                          >
                            <MoveHorizontal size={15} />
                            Сдвинуть
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {task.feedback}
      <section className="rm-section">
        <SectionHeading title="Стоимость и обеспеченность">
          Каждая статья относится к мероприятию и конкретному году. Расчёт денежных сумм выполняется
          в копейках.
        </SectionHeading>
        <div className="rm-budget-totals">
          <div>
            <span>Денежная потребность</span>
            <strong>{money(budget.totals.needCashKopecks)}</strong>
          </div>
          <div>
            <span>Подтверждено</span>
            <strong>{money(budget.totals.confirmedKopecks)}</strong>
          </div>
          <div data-gap={budget.totals.confirmedGapKopecks > 0}>
            <span>Неподтверждённая потребность</span>
            <strong>{money(budget.totals.confirmedGapKopecks)}</strong>
          </div>
          <div>
            <span>Заявки и предположения</span>
            <strong>{money(budget.totals.expectedKopecks)}</strong>
          </div>
        </div>
        <Note>
          Натуральный вклад: {money(budget.totals.inKindKopecks)}. Заявки и проекты бюджетов
          учитываются отдельно от подтверждённых средств. Проверка полномочий, бюджетных оснований и
          источников остаётся содержательной работой команды.
        </Note>
        {budget.years.length ? (
          <div className="rm-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Год</th>
                  <th>Потребность</th>
                  <th>Подтверждено</th>
                  <th>Заявки и ожидания</th>
                  <th>Неподтверждено</th>
                  <th>Натуральный вклад</th>
                </tr>
              </thead>
              <tbody>
                {budget.years.map((year) => (
                  <tr key={year.year}>
                    <th>{year.year}</th>
                    <td>{money(year.needCashKopecks)}</td>
                    <td>{money(year.confirmedKopecks)}</td>
                    <td>{money(year.expectedKopecks)}</td>
                    <td>{money(year.confirmedGapKopecks)}</td>
                    <td>{money(year.inKindKopecks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <section className="rm-section">
        <SectionHeading
          title="Статьи затрат"
          onAdd={
            editable && activities.length
              ? () => onEdit({ kind: 'cost', initial: { activityId: activities[0]!.id } })
              : undefined
          }
          addLabel="Добавить затраты"
        />
        {costs.length ? (
          <div className="rm-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Статья / мероприятие</th>
                  <th>Год</th>
                  <th>Расчёт</th>
                  <th>Сумма</th>
                  <th>Основание цены</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((item) => (
                  <tr key={item.id}>
                    <th>
                      {item.data.title || 'Без названия'}
                      <small>
                        {
                          activities.find((activity) => activity.id === item.data.activityId)?.data
                            .title
                        }
                      </small>
                      <small>
                        {item.data.cashKind === 'in_kind'
                          ? 'Натуральный вклад'
                          : 'Денежные расходы'}
                      </small>
                    </th>
                    <td>{item.data.year}</td>
                    <td>
                      {item.data.quantity} {item.data.unit} × {money(item.data.unitPriceKopecks)} ×{' '}
                      {item.data.periods}
                    </td>
                    <td>
                      {money(budget.lines.find((line) => line.id === item.id)?.totalKopecks ?? 0)}
                    </td>
                    <td>
                      {item.data.priceStatus === 'confirmed' ? 'Подтверждённая цена' : 'Оценка'}
                      <small>{item.data.priceSource || 'Источник не указан'}</small>
                    </td>
                    <td>
                      {editable ? (
                        <EditButton onClick={() => onEdit({ kind: 'cost', id: item.id })} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptySection>
            {activities.length
              ? 'Добавьте количество, стоимость единицы и число повторений для каждой статьи.'
              : 'Сначала добавьте мероприятие во вкладке «Мероприятия».'}
          </EmptySection>
        )}
      </section>
      <section className="rm-section">
        <SectionHeading
          title="Источники финансирования"
          onAdd={
            editable && costs.some((item) => item.data.cashKind === 'cash')
              ? () =>
                  onEdit({
                    kind: 'funding',
                    initial: {
                      costLineId: costs.find((item) => item.data.cashKind === 'cash')!.id,
                    },
                  })
              : undefined
          }
          addLabel="Добавить финансирование"
        />
        {funding.length ? (
          <div className="rm-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Источник</th>
                  <th>Статья затрат</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Подтверждение</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {funding.map((item) => (
                  <tr key={item.id}>
                    <th>{item.data.sourceName || 'Без названия'}</th>
                    <td>{costs.find((cost) => cost.id === item.data.costLineId)?.data.title}</td>
                    <td>{money(item.data.amountKopecks)}</td>
                    <td>
                      {
                        {
                          confirmed: 'Подтверждено',
                          budget_draft: 'Проект бюджета',
                          application: 'Заявка',
                          assumption: 'Предположение',
                        }[item.data.status]
                      }
                    </td>
                    <td className="rm-long-text">
                      {item.data.sourceReference || 'Не указано'}
                      <small>{dateLabel(item.data.sourceDate)}</small>
                    </td>
                    <td>
                      {editable ? (
                        <EditButton onClick={() => onEdit({ kind: 'funding', id: item.id })} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptySection>
            Свяжите источник средств с конкретной денежной статьёй. Одно поступление нельзя
            учитывать повторно под разными названиями.
          </EmptySection>
        )}
        {budget.issues.map((issue, index) => (
          <p className="rm-warning-text" key={`${issue.code}-${index}`}>
            {issue.message}
          </p>
        ))}
      </section>
      <section className="rm-section">
        <SectionHeading title="Кадровые, материальные и информационные ресурсы" />
        {passport ? (
          <>
            <dl className="rm-resource-description">
              <div>
                <dt>Кадры</dt>
                <dd>{passport.data.humanResources || 'Не описаны'}</dd>
              </div>
              <div>
                <dt>Материальные ресурсы</dt>
                <dd>{passport.data.materialResources || 'Не описаны'}</dd>
              </div>
              <div>
                <dt>Информационные ресурсы</dt>
                <dd>{passport.data.informationResources || 'Не описаны'}</dd>
              </div>
            </dl>
            {editable ? (
              <EditButton
                label="Описать ресурсы"
                onClick={() => onEdit({ kind: 'passport', id: passport.id })}
              />
            ) : null}
          </>
        ) : null}
      </section>
      {moving ? (
        <Modal
          title="Перенос сроков мероприятия"
          onClose={() => {
            if (!task.working) setMoving(null);
          }}
        >
          <h3>{moving.item.data.title}</h3>
          <label className="rm-field">
            <span>Сдвиг в календарных днях</span>
            <input
              type="number"
              step={1}
              value={moving.days}
              onChange={(event) => setMoving({ ...moving, days: Number(event.target.value) })}
            />
          </label>
          <p className="modal-intro">
            {dateLabel(moving.item.data.startDate)} — {dateLabel(moving.item.data.endDate)} →{' '}
            {preview
              ? `${dateLabel(preview.startDate)} — ${dateLabel(preview.endDate)}`
              : 'Некорректные даты'}
          </p>
          {previewError ? <p role="alert">{previewError}</p> : null}
          {previewIssues.map((issue, index) => (
            <p className="rm-warning-text" key={index}>
              {issue.message}
            </p>
          ))}
          <Note>
            Связанные мероприятия и годы затрат не перемещаются автоматически. Сопоставьте их с
            новыми датами.
          </Note>
          {task.feedback}
          <div className="rm-actions">
            <button
              className="button button-primary"
              disabled={
                !preview ||
                task.working ||
                controller.busy ||
                moving.days === 0 ||
                previewIssues.some((issue) => issue.severity === 'error')
              }
              onClick={() =>
                void task.run(async () => {
                  if (!preview) return;
                  await controller.actions.saveItem(
                    saveInput(snapshot.roadmapId, moving.item, { ...moving.item.data, ...preview }),
                  );
                  setMoving(null);
                }, 'Новые сроки сохранены.')
              }
            >
              Сохранить перенос
            </button>
            <button
              className="button button-secondary"
              disabled={task.working}
              onClick={() => setMoving(null)}
            >
              Отменить
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
