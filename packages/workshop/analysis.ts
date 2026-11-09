import type { SharedSubmission } from '../collaboration/types';

export interface FamilySuggestion {
  leftId: string;
  rightId: string;
  /** Lexical overlap coefficient, never a probability of legal equivalence. */
  score: number;
  reasons: string[];
}

const stop = new Set(['поддерж', 'предос', 'семь', 'семей', 'ребен', 'детей', 'ребенк', 'дети', 'меры', 'социал', 'регион', 'област', 'респуб', 'програ', 'развит', 'гражда', 'явля', 'имею', 'числе', 'также', 'рамках', 'осущес', 'органи', 'россий', 'федера', 'населе', 'возмож']);
const normalize = (text: string) => text.normalize('NFC').toLocaleLowerCase('ru').replaceAll('ё', 'е');
function tokens(text: string): Set<string> {
  return new Set((normalize(text).match(/[\p{L}]{4,}/gu) ?? []).map((word) => word.slice(0, 6))
    .filter((word) => ![...stop].some((prefix) => word.startsWith(prefix))).slice(0, 96));
}
function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}
function mechanismKind(text: string): string | null {
  const value = normalize(text);
  if (/(субсидир.{0,30}(ставк|процент)|компенсац.{0,30}процент)/u.test(value)) return 'interest_subsidy';
  if (/(льготн.{0,20}(кредит|ипотек)|выдач.{0,20}кредит)/u.test(value)) return 'loan';
  if (/(единовременн.{0,20}(выплат|пособ)|ежемесячн.{0,20}(выплат|пособ)|денежн.{0,15}выплат)/u.test(value)) return 'payment';
  if (/(предоставлен.{0,25}(квартир|жил.{0,5}помещен)|передач.{0,15}жиль)/u.test(value)) return 'housing_in_kind';
  return null;
}
const citationKeys = (item: SharedSubmission) => item.bundle.occurrences.map((occurrence) => JSON.stringify([
  occurrence.documentId, occurrence.versionId,
  occurrence.anchor.spans.map((span) => [span.blockId, span.start, span.end, span.exact]),
]));

/** Candidate retrieval is bounded by informative tokens; it never mutates or groups submissions. */
export function suggestFamilyPairs(submissions: SharedSubmission[], limit = 16): FamilySuggestion[] {
  const items = submissions.filter((item) => item.status === 'shared').map((item) => ({
    item, title: tokens(item.bundle.practice.title), mechanism: tokens(item.bundle.practice.mechanism),
    source: citationKeys(item), kind: mechanismKind(item.bundle.practice.mechanism),
  }));
  const postings = new Map<string, number[]>();
  for (let index = 0; index < items.length; index++) {
    const data = items[index];
    const family = data.item.bundle.practice.familyId;
    const keys = [
      ...new Set([...data.title, ...data.mechanism].map((token) => `t:${token}`)),
      ...data.source.map((source) => `s:${source}`),
      ...(!/unknown|custom|local|catalog|unassigned/iu.test(family) ? [`f:${family}`] : []),
    ];
    for (const key of keys) {
      const values = postings.get(key) ?? [];
      // Very common words do not generate quadratic work or imply a shared mechanism.
      if (values.length <= 100) values.push(index);
      postings.set(key, values);
    }
  }
  const candidates = new Set<string>();
  for (const values of postings.values()) {
    if (values.length > 100) continue;
    for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
      if (candidates.size < 40000) candidates.add(`${values[i]}:${values[j]}`);
    }
  }
  const suggestions: FamilySuggestion[] = [];
  for (const key of candidates) {
    const [left, right] = key.split(':').map(Number);
    const a = items[left], b = items[right];
    if (a.kind && b.kind && a.kind !== b.kind) continue;
    const sameSource = a.source.some((value) => b.source.includes(value));
    const sameFamily = a.item.bundle.practice.familyId === b.item.bundle.practice.familyId
      && !/unknown|custom|local|catalog|unassigned/iu.test(a.item.bundle.practice.familyId);
    const lexical = .4 * overlap(a.title, b.title) + .6 * overlap(a.mechanism, b.mechanism);
    const score = sameSource ? Math.max(.95, lexical) : sameFamily ? Math.max(.75, lexical) : lexical;
    if (score < .28) continue;
    const reasons = [sameSource ? 'Совпадает точный фрагмент одной редакции' : sameFamily ? 'Общее семейство в подготовленном каталоге' : 'Есть общие термины в названии и механизме'];
    if (a.item.bundle.practice.eligibility !== b.item.bundle.practice.eligibility) reasons.push('Получатели описаны по-разному — сравните условия');
    if (a.item.bundle.practice.amount !== b.item.bundle.practice.amount) reasons.push('Размеры или формы поддержки различаются');
    reasons.push('Объединение требует содержательного подтверждения');
    suggestions.push({ leftId: a.item.id, rightId: b.item.id, score, reasons });
  }
  return suggestions.sort((a, b) => b.score - a.score || a.leftId.localeCompare(b.leftId) || a.rightId.localeCompare(b.rightId)).slice(0, Math.max(0, Math.min(100, limit)));
}

/** Independent, denominator-explicit calculation used in validation and portable exports. */
export function evaluateTotals(totals: { support: number; oppose: number; neutral: number }, eligibleCount: number, minCoverage = .7, minSubstantiveVotes = 3) {
  const values = [totals.support, totals.oppose, totals.neutral, eligibleCount];
  if (values.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid vote counts');
  const substantive = totals.support + totals.oppose;
  const cast = substantive + totals.neutral;
  if (cast > eligibleCount) throw new Error('Responses exceed the fixed eligible roster');
  const coverage = eligibleCount ? cast / eligibleCount : null;
  const support = substantive ? totals.support / substantive : null;
  const net = substantive ? (totals.support - totals.oppose) / substantive : null;
  return { substantive, cast, unanswered: eligibleCount - cast, coverage, support, net,
    qualified: coverage !== null && coverage >= minCoverage && substantive >= minSubstantiveVotes && net !== null };
}
