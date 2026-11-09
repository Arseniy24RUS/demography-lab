import { CalculationError } from './types';
import type { AnalysisIssue, CalendarActivity, CalendarResult, ProjectPeriod } from './types';

const DAY_MS = 86400000;

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    Number(value.slice(0, 4)) >= 1900 &&
    Number(value.slice(0, 4)) <= 2200
  );
}

export function calendarDay(value: string): number {
  if (!isCalendarDate(value))
    throw new CalculationError(
      'INVALID_DATE',
      'Используйте существующую календарную дату в формате ГГГГ-ММ-ДД.',
    );
  return new Date(`${value}T00:00:00.000Z`).getTime() / DAY_MS;
}

export function addCalendarDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days) || Math.abs(days) > 366000)
    throw new CalculationError(
      'INVALID_DAY_SHIFT',
      'Сдвиг должен быть целым числом календарных дней допустимого размера.',
    );
  const result = new Date((calendarDay(value) + days) * DAY_MS).toISOString().slice(0, 10);
  if (!isCalendarDate(result))
    throw new CalculationError(
      'DATE_OUT_OF_RANGE',
      'Сдвиг выходит за поддерживаемый диапазон календаря.',
    );
  return result;
}

export function shiftActivityDates(
  activity: CalendarActivity,
  days: number,
): Pick<CalendarActivity, 'startDate' | 'endDate'> {
  if (activity.startDate === null || activity.endDate === null)
    throw new CalculationError(
      'MISSING_ACTIVITY_DATES',
      'Для сдвига задайте обе даты мероприятия.',
    );
  return {
    startDate: addCalendarDays(activity.startDate, days),
    endDate: addCalendarDays(activity.endDate, days),
  };
}

export function inspectCalendar(
  activities: CalendarActivity[],
  period: ProjectPeriod,
): CalendarResult {
  const start = calendarDay(period.startDate),
    end = calendarDay(period.endDate);
  if (start > end)
    throw new CalculationError(
      'INVALID_PROJECT_PERIOD',
      'Окончание проекта не может предшествовать его началу.',
    );
  const issues: AnalysisIssue[] = [];
  const byId = new Map<string, CalendarActivity>();
  for (const activity of activities) {
    if (!activity.id || byId.has(activity.id))
      throw new CalculationError(
        'DUPLICATE_ACTIVITY',
        'Идентификаторы мероприятий должны быть уникальны.',
      );
    byId.set(activity.id, activity);
  }
  const graph = new Map<string, string[]>();
  const indegree = new Map(activities.map((activity) => [activity.id, 0]));
  const rows: CalendarResult['rows'] = [];
  for (const activity of activities) {
    const seen = new Set<string>();
    for (const dependency of activity.dependencies) {
      if (
        !Number.isInteger(dependency.lagDays) ||
        dependency.lagDays < 0 ||
        dependency.lagDays > 36600
      )
        throw new CalculationError(
          'INVALID_DEPENDENCY_LAG',
          'Лаг зависимости должен быть неотрицательным целым числом календарных дней.',
        );
      if (seen.has(dependency.predecessorId))
        throw new CalculationError(
          'DUPLICATE_DEPENDENCY',
          'Одна зависимость указана несколько раз.',
        );
      seen.add(dependency.predecessorId);
      if (!byId.has(dependency.predecessorId)) {
        issues.push({
          code: 'UNKNOWN_PREDECESSOR',
          severity: 'error',
          entityId: activity.id,
          field: 'dependencies',
          message: 'Указанный предшественник отсутствует в этой карте.',
        });
        continue;
      }
      graph.set(dependency.predecessorId, [
        ...(graph.get(dependency.predecessorId) ?? []),
        activity.id,
      ]);
      indegree.set(activity.id, indegree.get(activity.id)! + 1);
    }
    if (activity.startDate === null || activity.endDate === null) {
      issues.push({
        code: 'MISSING_ACTIVITY_DATES',
        severity: 'warning',
        entityId: activity.id,
        field: 'startDate',
        message: 'Для календаря необходимо задать начало и окончание мероприятия.',
      });
      continue;
    }
    if (!isCalendarDate(activity.startDate) || !isCalendarDate(activity.endDate)) {
      issues.push({
        code: 'INVALID_ACTIVITY_DATE',
        severity: 'error',
        entityId: activity.id,
        message: 'Дата мероприятия не существует в календаре.',
      });
      continue;
    }
    const itemStart = calendarDay(activity.startDate),
      itemEnd = calendarDay(activity.endDate);
    if (itemStart > itemEnd) {
      issues.push({
        code: 'REVERSED_ACTIVITY_DATES',
        severity: 'error',
        entityId: activity.id,
        message: 'Окончание мероприятия предшествует началу.',
      });
      continue;
    }
    if (itemStart < start || itemEnd > end)
      issues.push({
        code: 'ACTIVITY_OUTSIDE_PROJECT',
        severity: 'warning',
        entityId: activity.id,
        message: 'Мероприятие выходит за установленный период проекта; согласуйте сроки.',
      });
    rows.push({
      id: activity.id,
      title: activity.title,
      startDate: activity.startDate,
      endDate: activity.endDate,
      durationDays: itemEnd - itemStart + 1,
      offsetDays: itemStart - start,
    });
    for (const dependency of activity.dependencies) {
      const previous = byId.get(dependency.predecessorId);
      if (previous?.endDate && isCalendarDate(previous.endDate)) {
        const earliestStart = calendarDay(previous.endDate) + 1 + dependency.lagDays;
        if (itemStart < earliestStart)
          issues.push({
            code: 'DEPENDENCY_DATE_CONFLICT',
            severity: 'warning',
            entityId: activity.id,
            field: 'startDate',
            message: `Начало нарушает последовательность после «${previous.title}» и заданный лаг.`,
          });
      }
    }
  }
  const available = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (available.length) {
    const id = available.shift()!;
    order.push(id);
    for (const next of graph.get(id) ?? []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) {
        available.push(next);
        available.sort();
      }
    }
  }
  const hasCycle = order.length !== activities.length;
  if (hasCycle)
    issues.push({
      code: 'CYCLIC_DEPENDENCY',
      severity: 'error',
      message: 'Зависимости мероприятий образуют цикл. Исправьте последовательность действий.',
    });
  return {
    calendar: 'calendar_days',
    issues,
    rows: rows.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id)),
    topologicalOrder: hasCycle ? null : order,
    totalDays: end - start + 1,
  };
}
