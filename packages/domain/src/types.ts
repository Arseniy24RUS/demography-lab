/** Canonical text is NFC, LF newlines, without whitespace folding or trimming. */
export const NORMALIZATION_VERSION = 'unicode-nfc-lf-v1' as const;
export const POPPLER_NORMALIZATION_VERSION =
  'poppler-layout-nfc-lf-rstrip-lines-blank-paragraphs-v1' as const;
export type NormalizationVersion =
  typeof NORMALIZATION_VERSION | typeof POPPLER_NORMALIZATION_VERSION;
export const NORMALIZATION_VERSIONS: readonly string[] = [
  NORMALIZATION_VERSION,
  POPPLER_NORMALIZATION_VERSION,
];

export interface DocumentMeta {
  readonly id: string;
  readonly title: string;
  readonly regionId: string;
  readonly regionName?: string;
  readonly kind?: 'programme' | 'legal-act' | 'report' | 'other';
  readonly sourceUrl?: string;
  readonly authority?: string;
  readonly adoptedAt?: string;
  readonly number?: string;
  readonly availability?: 'full' | 'partial' | 'metadata-only' | 'unavailable';
  readonly notes?: string;
}

export interface DocumentPage {
  /** 1-based file page; printed page labels are separate. */
  readonly number: number;
  readonly printedLabel?: string;
  readonly text?: string;
  readonly imageUrl?: string;
  readonly sourceUrl?: string;
}

export interface DocumentBlock {
  readonly id: string;
  /** Strictly increasing canonical reading order, independent of the DOM. */
  readonly order: number;
  readonly kind:
    'heading' | 'paragraph' | 'list-item' | 'table-cell' | 'table-row' | 'caption' | 'other';
  readonly text: string;
  readonly pageStart?: number;
  readonly pageEnd?: number;
  readonly sectionPath?: readonly string[];
  readonly table?: {
    readonly id: string;
    readonly row: number;
    readonly column?: number;
    readonly headers?: readonly string[];
  };
}

export interface DocumentVersion {
  readonly id: string;
  readonly documentId: string;
  readonly normalizationVersion: NormalizationVersion;
  readonly blocks: readonly DocumentBlock[];
  readonly pages?: readonly DocumentPage[];
  readonly editionLabel?: string;
  readonly capturedAt?: string;
  /** The actual SHA-256 of the immutable source, supplied by ingestion. */
  readonly sourceSha256?: string;
  readonly sourceUrl?: string;
  readonly sourceFileName?: string;
  readonly completeness?: 'full' | 'partial';
}

export interface BlockSelection {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
}

export interface TextSpan extends BlockSelection {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
}

export interface TextAnchor {
  readonly id: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly normalizationVersion: NormalizationVersion;
  readonly spans: readonly TextSpan[];
}

export interface TextPoint {
  readonly blockId: string;
  readonly offset: number;
}

export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly valid: true; readonly value: T; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] };

export interface SearchHit extends BlockSelection {
  readonly id: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly exact: string;
  readonly before: string;
  readonly after: string;
  readonly pageStart?: number;
  readonly pageEnd?: number;
}

export interface SearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly totalMatches: number;
  readonly truncated: boolean;
}

export type PracticeField = 'title' | 'mechanism' | 'eligibility' | 'amount' | 'conditions';
export const PRACTICE_FIELDS: readonly PracticeField[] = [
  'title',
  'mechanism',
  'eligibility',
  'amount',
  'conditions',
];
export type EvidenceRelation = 'supports' | 'partial' | 'contradicts';
export type ReviewStatus = 'candidate' | 'verified' | 'rejected';

export interface PracticeOccurrence {
  readonly id: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly anchor: TextAnchor;
  readonly reviewStatus: ReviewStatus;
  readonly note?: string;
}

/** A link to a whole document/article is not field-level proof. */
export type FieldEvidence =
  | {
      readonly kind: 'fragment';
      readonly field: PracticeField;
      readonly occurrenceId: string;
      readonly relation: EvidenceRelation;
      readonly reviewStatus: ReviewStatus;
      /** The value reviewed, so edits invalidate the previous field verification. */
      readonly reviewedValue?: string;
      readonly note?: string;
    }
  | {
      readonly kind: 'document';
      readonly field?: PracticeField;
      readonly documentId: string;
      readonly versionId: string;
      readonly note?: string;
    }
  | {
      readonly kind: 'article';
      readonly field?: PracticeField;
      readonly url: string;
      readonly title?: string;
      readonly note?: string;
    };

export interface PracticeVariant {
  readonly id: string;
  readonly familyId: string;
  readonly regionId: string;
  readonly title: string;
  readonly mechanism: string;
  readonly eligibility?: string | null;
  readonly amount?: string | null;
  readonly conditions?: readonly string[];
  readonly occurrenceIds: readonly string[];
  readonly evidence?: readonly FieldEvidence[];
  readonly reviewStatus?: ReviewStatus;
}

export interface PracticeFamily {
  readonly id: string;
  readonly title: string;
  readonly mechanism: string;
  readonly description?: string;
  readonly barrierIds?: readonly string[];
}

export interface EvidenceContext {
  readonly occurrences: readonly PracticeOccurrence[];
  readonly versions: readonly DocumentVersion[];
}

export interface FieldEvidenceEvaluation {
  readonly field: PracticeField;
  readonly status: 'unknown' | 'unsupported' | 'partial' | 'supported' | 'contradicted';
  readonly validOccurrenceIds: readonly string[];
  readonly issues: readonly ValidationIssue[];
}

export interface PracticeCandidate {
  readonly variantId: string;
  readonly variant: PracticeVariant;
  /** Deterministic ranking score, never probability or evidence of effectiveness. */
  readonly score: number;
  readonly reasons: readonly string[];
  readonly matchedTokens: readonly string[];
  readonly evidenceOccurrenceIds: readonly string[];
  readonly linkStatus: 'candidate';
  readonly requiresConfirmation: true;
}
