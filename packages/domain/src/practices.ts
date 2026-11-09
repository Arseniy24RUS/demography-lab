import { anchorText, validateAnchor } from './anchors';
import { tokenizeForMatching } from './search';
import {
  PRACTICE_FIELDS,
  type DocumentVersion,
  type EvidenceContext,
  type FieldEvidenceEvaluation,
  type PracticeCandidate,
  type PracticeField,
  type PracticeOccurrence,
  type PracticeVariant,
  type TextAnchor,
  type ValidationIssue,
} from './types';

/** Exact reviewed representation. Changing this value requires a new field review. */
export function getPracticeFieldValue(
  variant: PracticeVariant,
  field: PracticeField,
): string | null {
  if (field === 'conditions')
    return variant.conditions?.length ? variant.conditions.join('\n') : null;
  const value = variant[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Structural evidence validity plus recorded human review, not semantic truth inference. */
export function evaluateFieldEvidence(
  variant: PracticeVariant,
  field: PracticeField,
  context: EvidenceContext,
): FieldEvidenceEvaluation {
  const value = getPracticeFieldValue(variant, field);
  const issues: ValidationIssue[] = [];
  const validOccurrenceIds = new Set<string>();
  if (value === null) return { field, status: 'unknown', validOccurrenceIds: [], issues };
  const occurrences = new Map(context.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const versions = new Map(context.versions.map((version) => [version.id, version]));
  let partial = false;
  let supported = false;
  let contradicted = false;
  for (const [index, evidence] of (variant.evidence ?? []).entries()) {
    const path = `evidence[${index}]`;
    if (evidence.field !== field) continue;
    if (evidence.kind === 'article') {
      try {
        const url = new URL(evidence.url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:')
          throw new Error('Unsupported protocol');
        partial = true;
      } catch {
        issues.push({
          code: 'invalid_evidence_url',
          path,
          message: 'Reference must be an HTTP(S) URL.',
        });
      }
      continue;
    }
    if (evidence.kind === 'document') {
      const version = versions.get(evidence.versionId);
      if (version && version.documentId === evidence.documentId) partial = true;
      else
        issues.push({
          code: 'document_reference_not_found',
          path,
          message: 'Referenced document edition is absent or mismatched.',
        });
      continue;
    }
    if (evidence.reviewStatus === 'rejected') continue;
    const occurrence = occurrences.get(evidence.occurrenceId);
    if (!occurrence || !variant.occurrenceIds.includes(evidence.occurrenceId)) {
      issues.push({
        code: 'occurrence_not_linked',
        path,
        message: 'Field evidence must reference an occurrence explicitly linked to this variant.',
      });
      continue;
    }
    const version = versions.get(occurrence.versionId);
    if (
      !version ||
      version.documentId !== occurrence.documentId ||
      occurrence.anchor.versionId !== occurrence.versionId
    ) {
      issues.push({
        code: 'occurrence_edition_mismatch',
        path,
        message: 'Occurrence edition could not be verified.',
      });
      continue;
    }
    const verifiedAnchor = validateAnchor(version, occurrence.anchor);
    if (!verifiedAnchor.valid) {
      issues.push(
        ...verifiedAnchor.issues.map((issue) => ({
          ...issue,
          path: `${path}.anchor.${issue.path}`,
        })),
      );
      continue;
    }
    if (occurrence.reviewStatus === 'rejected') continue;
    validOccurrenceIds.add(occurrence.id);
    if (evidence.reviewedValue !== value) {
      partial = true;
      issues.push({
        code: 'field_value_not_reviewed',
        path,
        message:
          'The current field value differs from the recorded reviewed value, or was not reviewed.',
      });
      continue;
    }
    if (occurrence.reviewStatus !== 'verified' || evidence.reviewStatus !== 'verified') {
      partial = true;
      continue;
    }
    if (evidence.relation === 'contradicts') contradicted = true;
    else if (evidence.relation === 'supports') supported = true;
    else partial = true;
  }
  return {
    field,
    status: contradicted
      ? 'contradicted'
      : supported
        ? 'supported'
        : partial
          ? 'partial'
          : 'unsupported',
    validOccurrenceIds: [...validOccurrenceIds].sort(),
    issues,
  };
}

export function evaluatePracticeEvidence(
  variant: PracticeVariant,
  context: EvidenceContext,
): Readonly<Record<PracticeField, FieldEvidenceEvaluation>> {
  return Object.fromEntries(
    PRACTICE_FIELDS.map((field) => [field, evaluateFieldEvidence(variant, field, context)]),
  ) as unknown as Readonly<Record<PracticeField, FieldEvidenceEvaluation>>;
}

// Generic policy vocabulary cannot by itself identify a practice mechanism.
const GENERIC_TOKENS = new Set([
  'а',
  'и',
  'или',
  'на',
  'в',
  'во',
  'для',
  'по',
  'с',
  'со',
  'от',
  'до',
  'не',
  'из',
  'к',
  'у',
  'при',
  'как',
  'что',
  'это',
  'также',
  'семья',
  'семьи',
  'семье',
  'семью',
  'семей',
  'семьям',
  'семьями',
  'семейный',
  'семейная',
  'дети',
  'детей',
  'детям',
  'детьми',
  'ребенок',
  'ребенка',
  'ребенку',
  'ребенком',
  'поддержка',
  'поддержки',
  'поддержке',
  'поддержку',
  'помощь',
  'помощи',
  'мера',
  'меры',
  'мер',
  'мерам',
  'социальная',
  'социальной',
  'социальные',
  'государственная',
  'государственной',
  'региональная',
  'региональной',
  'программа',
  'программы',
  'повышение',
  'повышения',
  'рождаемость',
  'рождаемости',
  'российской',
  'федерации',
  'предоставление',
  'предоставления',
  'оказание',
  'оказания',
  'реализация',
  'реализации',
  'год',
  'года',
  'годы',
  'году',
]);

function informativeTokens(text: string): string[] {
  return tokenizeForMatching(text).filter(
    (token) => token.length > 2 && !GENERIC_TOKENS.has(token),
  );
}

function anchorsOverlap(left: TextAnchor, right: TextAnchor): boolean {
  if (
    left.documentId !== right.documentId ||
    left.versionId !== right.versionId ||
    left.normalizationVersion !== right.normalizationVersion
  )
    return false;
  return left.spans.some((a) =>
    right.spans.some((b) => a.blockId === b.blockId && a.start < b.end && b.start < a.end),
  );
}

export interface CandidateOptions {
  readonly limit?: number;
  readonly minimumInformativeTokens?: number;
  readonly expected?: {
    readonly regionId?: string;
    readonly amount?: string;
    readonly eligibility?: string;
    readonly conditions?: readonly string[];
  };
}

/** Ranked suggestions only. No result creates or asserts a semantic association. */
export function rankPracticeCandidates(
  version: DocumentVersion,
  anchor: TextAnchor,
  variants: readonly PracticeVariant[],
  occurrences: readonly PracticeOccurrence[] = [],
  options: CandidateOptions = {},
): readonly PracticeCandidate[] {
  if (!validateAnchor(version, anchor).valid) return [];
  const limit = options.limit ?? 8;
  const minimum = options.minimumInformativeTokens ?? 2;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(minimum) ||
    minimum < 2 ||
    minimum > 20
  )
    throw new RangeError('Invalid candidate ranking bounds.');
  const selectedTokens = informativeTokens(anchorText(anchor));
  const selected = new Set(selectedTokens);
  const relevantOccurrences = new Map(
    occurrences
      .filter(
        (occurrence) =>
          occurrence.reviewStatus !== 'rejected' &&
          occurrence.versionId === version.id &&
          occurrence.documentId === version.documentId &&
          validateAnchor(version, occurrence.anchor).valid &&
          anchorsOverlap(anchor, occurrence.anchor),
      )
      .map((occurrence) => [occurrence.id, occurrence]),
  );
  const results: PracticeCandidate[] = [];
  for (const variant of variants) {
    if (variant.reviewStatus === 'rejected') continue;
    const terms = informativeTokens(
      [
        variant.title,
        variant.mechanism,
        variant.eligibility ?? '',
        variant.amount ?? '',
        ...(variant.conditions ?? []),
      ].join(' '),
    );
    const matchedTokens = terms.filter((token) => selected.has(token));
    const evidenceOccurrenceIds = variant.occurrenceIds
      .filter((id) => relevantOccurrences.has(id))
      .sort();
    // Explicit source overlap can propose a link even for a short selection; pure generic lexical coincidence cannot.
    if (!evidenceOccurrenceIds.length && matchedTokens.length < minimum) continue;
    const reasons: string[] = [];
    const union = new Set([...terms, ...selectedTokens]).size;
    let score = Math.round(
      (30 * matchedTokens.length) / Math.max(1, union) +
        (20 * matchedTokens.length) / Math.max(1, selectedTokens.length),
    );
    if (matchedTokens.length) reasons.push('informative_text_overlap');
    if (evidenceOccurrenceIds.length) {
      score += 60;
      reasons.push('same_edition_source_overlap');
    }
    const expected = options.expected;
    if (expected?.regionId) {
      if (variant.regionId === expected.regionId) {
        score += 8;
        reasons.push('region_matches');
      } else {
        score -= 8;
        reasons.push('different_region_variant');
      }
    }
    for (const field of ['amount', 'eligibility'] as const) {
      const wanted = expected?.[field];
      if (!wanted || !variant[field]) continue;
      const same =
        tokenizeForMatching(wanted).join(' ') === tokenizeForMatching(variant[field]!).join(' ');
      score += same ? 10 : -20;
      reasons.push(`${field}_${same ? 'matches' : 'differs'}`);
    }
    if (expected?.conditions?.length && variant.conditions?.length) {
      const expectedConditions = [...expected.conditions]
        .map((text) => tokenizeForMatching(text).join(' '))
        .sort();
      const actualConditions = [...variant.conditions]
        .map((text) => tokenizeForMatching(text).join(' '))
        .sort();
      const same = JSON.stringify(expectedConditions) === JSON.stringify(actualConditions);
      score += same ? 10 : -15;
      reasons.push(`conditions_${same ? 'match' : 'differ'}`);
    }
    results.push({
      variantId: variant.id,
      variant,
      score: Math.max(0, Math.min(100, score)),
      reasons,
      matchedTokens,
      evidenceOccurrenceIds,
      linkStatus: 'candidate',
      requiresConfirmation: true,
    });
  }
  return results
    .sort(
      (a, b) =>
        b.score - a.score || (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0),
    )
    .slice(0, limit);
}
