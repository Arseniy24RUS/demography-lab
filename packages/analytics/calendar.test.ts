import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  calendarDay,
  inspectCalendar,
  isCalendarDate,
  shiftActivityDates,
} from './calendar';
import type { CalendarActivity, ProjectPeriod } from './types';

const period: ProjectPeriod = { startDate: '2027-01-01', endDate: '2027-12-31' };
function activity(id: string, overrides: Partial<CalendarActivity> = {}): CalendarActivity {
  return {
    id,
    title: id,
    startDate: '2027-03-01',
    endDate: '2027-03-10',
    dependencies: [],
    ...overrides,
  };
}

describe('calendar days and activity dependencies', () => {
  it('rejects nonexistent dates and preserves leap-day arithmetic independently of timezone', () => {
    expect(isCalendarDate('2027-02-29')).toBe(false);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2028-04-31')).toBe(false);
    expect(isCalendarDate('2028-2-01')).toBe(false);
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(calendarDay('2027-03-29') - calendarDay('2027-03-28')).toBe(1);
  });

  it('computes inclusive durations, offsets and sorted dates without assigning dates to drafts', () => {
    const result = inspectCalendar(
      [
        activity('later'),
        activity('first', { startDate: '2027-01-01', endDate: '2027-01-01' }),
        activity('draft', { startDate: null, endDate: null }),
      ],
      period,
    );
    expect(result.totalDays).toBe(365);
    expect(result.rows.map((item) => [item.id, item.durationDays, item.offsetDays])).toEqual([
      ['first', 1, 0],
      ['later', 10, 59],
    ]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'MISSING_ACTIVITY_DATES',
        entityId: 'draft',
        severity: 'warning',
      }),
    );
  });

  it('detects a date conflict with finish-to-start and explicit calendar-day lag', () => {
    const predecessor = activity('predecessor');
    const successor = activity('successor', {
      startDate: '2027-03-12',
      endDate: '2027-03-13',
      dependencies: [{ predecessorId: predecessor.id, lagDays: 2 }],
    });
    expect(
      inspectCalendar([predecessor, successor], period).issues.map((item) => item.code),
    ).toContain('DEPENDENCY_DATE_CONFLICT');
    successor.startDate = '2027-03-13';
    expect(inspectCalendar([predecessor, successor], period).issues).toEqual([]);
  });

  it('detects self-cycles and multi-step cycles instead of returning a misleading order', () => {
    const a = activity('a', { dependencies: [{ predecessorId: 'c', lagDays: 0 }] });
    const b = activity('b', { dependencies: [{ predecessorId: 'a', lagDays: 0 }] });
    const c = activity('c', { dependencies: [{ predecessorId: 'b', lagDays: 0 }] });
    const result = inspectCalendar([a, b, c], period);
    expect(result.topologicalOrder).toBeNull();
    expect(result.issues.map((item) => item.code)).toContain('CYCLIC_DEPENDENCY');
    expect(
      inspectCalendar(
        [activity('a', { dependencies: [{ predecessorId: 'a', lagDays: 0 }] })],
        period,
      ).topologicalOrder,
    ).toBeNull();
  });

  it('never resolves an unknown predecessor or duplicate relationship by choosing another item', () => {
    expect(
      inspectCalendar(
        [activity('a', { dependencies: [{ predecessorId: 'foreign', lagDays: 0 }] })],
        period,
      ).issues,
    ).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_PREDECESSOR', severity: 'error' }));
    expect(() =>
      inspectCalendar(
        [
          activity('a'),
          activity('b', {
            dependencies: [
              { predecessorId: 'a', lagDays: 0 },
              { predecessorId: 'a', lagDays: 0 },
            ],
          }),
        ],
        period,
      ),
    ).toThrow(/несколько раз/u);
  });

  it('flags reversed dates and dates outside the project independently of dependencies', () => {
    const result = inspectCalendar(
      [
        activity('reversed', { startDate: '2027-04-01', endDate: '2027-03-01' }),
        activity('outside', { startDate: '2026-12-31', endDate: '2027-01-02' }),
      ],
      period,
    );
    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(['REVERSED_ACTIVITY_DATES', 'ACTIVITY_OUTSIDE_PROJECT']),
    );
    expect(() => inspectCalendar([], { startDate: '2027-02-02', endDate: '2027-01-01' })).toThrow(
      /Окончание/u,
    );
  });

  it('returns deterministic topological order for independent rows and preserves input data during shifts', () => {
    const a = activity('a');
    expect(
      inspectCalendar(
        [activity('c', { dependencies: [{ predecessorId: 'a', lagDays: 0 }] }), activity('b'), a],
        period,
      ).topologicalOrder,
    ).toEqual(['a', 'b', 'c']);
    expect(shiftActivityDates(a, 31)).toEqual({ startDate: '2027-04-01', endDate: '2027-04-10' });
    expect(a.startDate).toBe('2027-03-01');
    expect(() => shiftActivityDates(activity('draft', { startDate: null }), 1)).toThrow(
      /обе даты/u,
    );
  });
});
