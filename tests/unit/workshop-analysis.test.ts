import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateTotals, suggestFamilyPairs } from '../../packages/workshop/analysis';
import { parseRegionMap } from '../../apps/web/src/lib/region-map';
import type { SharedSubmission } from '../../packages/collaboration/types';

describe('workshop evaluation denominators', () => {
  it('keeps no response separate from inability to evaluate', () => {
    expect(evaluateTotals({ support: 2, oppose: 1, neutral: 2 }, 10, .7, 3)).toEqual({ substantive: 3, cast: 5, unanswered: 5, coverage: .5, support: 2 / 3, net: 1 / 3, qualified: false });
  });
  it('does not rank an empty or entirely neutral group as zero support', () => {
    expect(evaluateTotals({ support: 0, oppose: 0, neutral: 0 }, 0)).toMatchObject({ coverage: null, support: null, net: null, qualified: false });
    expect(evaluateTotals({ support: 0, oppose: 0, neutral: 4 }, 4)).toMatchObject({ coverage: 1, support: null, net: null, qualified: false });
  });
  it('ranks a genuinely balanced assessment only after coverage and count thresholds', () => {
    expect(evaluateTotals({ support: 2, oppose: 2, neutral: 0 }, 5)).toMatchObject({ coverage: .8, net: 0, support: .5, qualified: true });
  });
  it('rejects incoherent counters instead of displaying coverage above 100%', () => {
    expect(() => evaluateTotals({ support: 4, oppose: 2, neutral: 1 }, 6)).toThrow();
    expect(() => evaluateTotals({ support: -1, oppose: 0, neutral: 0 }, 6)).toThrow();
  });
});
const make = (id: string, mechanism: string, eligibility = 'Семьи с детьми'): SharedSubmission => ({
  id, sessionId: 'session', authorId: 'author', authorName: 'Автор', localKey: id,
  status: 'shared', revision: 1, createdAt: '2026-11-08T12:00:00Z', updatedAt: '2026-11-08T12:00:00Z',
  bundle: { schemaVersion: 1, note: '', sources: [], occurrences: [], practice: { id, familyId: 'unassigned', regionId: id, title: 'Поддержка семей', mechanism, eligibility, occurrenceIds: [] } },
});
describe('explainable grouping candidates', () => {
  it('does not equate loans and cash payments despite the same generic title', () => {
    expect(suggestFamilyPairs([make('a', 'Льготный кредит на приобретение квартиры'), make('b', 'Единовременная выплата на приобретение квартиры')])).toEqual([]);
  });
  it('keeps different recipients visible and leaves both source objects untouched', () => {
    const input = [make('a', 'Организация кратковременного присмотра за ребёнком', 'Студенческие семьи'), make('b', 'Организация кратковременного присмотра за ребёнком', 'Многодетные семьи')];
    const before = JSON.stringify(input);
    expect(suggestFamilyPairs(input)[0]).toMatchObject({ leftId: 'a', rightId: 'b' });
    expect(suggestFamilyPairs(input)[0].reasons.join(' ')).toContain('Получатели');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('excludes withdrawn submissions from suggestions', () => {
    const a = make('a', 'Прокат детских колясок'), b = make('b', 'Прокат детских колясок');
    b.status = 'withdrawn';
    expect(suggestFamilyPairs([a, b])).toEqual([]);
  });
});
describe('source-backed geographic navigation', () => {
  const raw = JSON.parse(readFileSync('public/data/regions.map.json', 'utf8'));
  const data = parseRegionMap(raw);
  const corpus = JSON.parse(readFileSync('public/data/corpus/index.json', 'utf8'));
  it('maps all 89 passports once to actual geometry without using population values', () => {
    expect(data.shapes).toHaveLength(89);
    expect(new Set(data.shapes.map((shape) => shape.regionId))).toEqual(new Set(corpus.documents.map((entry: { regionId: string }) => entry.regionId)));
    expect(JSON.stringify(data)).not.toContain('population');
    expect(raw.source.inputSha256).toBe(createHash('sha256').update(readFileSync('public/data/regions.geojson')).digest('hex'));
  });
  it('keeps all geometry inside the canvas, including both sides of the antimeridian', () => {
    for (const shape of data.shapes) {
      expect(shape.bounds[0]).toBeGreaterThanOrEqual(0); expect(shape.bounds[1]).toBeGreaterThanOrEqual(0);
      expect(shape.bounds[2]).toBeLessThanOrEqual(1200); expect(shape.bounds[3]).toBeLessThanOrEqual(620);
      expect(shape.bounds[2]).toBeGreaterThan(shape.bounds[0]);
    }
    const center = (id: string) => data.shapes.find((shape) => shape.regionId === id)!.centroid;
    expect(center('respublika-mordoviia')[0]).toBeLessThan(center('omskaia-oblast')[0]);
    expect(center('omskaia-oblast')[0]).toBeLessThan(center('sakhalinskaia-oblast')[0]);
  });
  it('rejects duplicate regions and malformed paths before drawing', () => {
    expect(() => parseRegionMap({ ...raw, shapes: [raw.shapes[0], raw.shapes[0]] })).toThrow();
    expect(() => parseRegionMap({ ...raw, shapes: [{ ...raw.shapes[0], d: '<script>' }] })).toThrow();
  });
});
