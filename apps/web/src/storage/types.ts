import type {
  FieldEvidence,
  PracticeVariant,
  TextAnchor,
  DocumentMeta,
  DocumentVersion,
} from '../../../../packages/domain/src/types';

/** Stage 1 stores a local working copy. These types are not an identity or multiplayer API. */
export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const EXCHANGE_FORMAT = 'demography-workshop.workspace' as const;
export const MAX_EXCHANGE_BYTES = 5 * 1024 * 1024;

export interface LocalProfile {
  displayName: string;
  /** Unverified contact text, saved in this browser only. */
  email?: string;
}

export interface SourceReference {
  sourceId: string;
  editionId: string;
  title: string;
  /** Exact digest of the source edition, never a signature or an authenticity guarantee. */
  sha256?: string;
  normalizationVersion: string;
  sourceUrl?: string;
  regionId?: string;
}

export interface WorkspaceAnnotation {
  id: string;
  anchor: TextAnchor;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeProposal {
  id: string;
  title: string;
  summary: string;
  annotationIds: string[];
  catalogPracticeId?: string;
  createdAt: string;
  updatedAt: string;
}

export type LinkStatus = 'catalog-only' | 'candidate' | 'verified' | 'contradicted';

export interface LinkDecision {
  id: string;
  annotationId: string | null;
  practiceId: string;
  status: LinkStatus;
  rationale: string;
  decidedAt: string;
  origin: 'local' | 'imported';
  fieldEvidence: FieldEvidence[];
  /** Previous status is provenance, not a verification obtained by the receiving browser. */
  importedStatus?: LinkStatus;
}

export interface CustomPracticeCard extends PracticeVariant {
  createdAt: string;
  updatedAt: string;
}

/** Stage 1 does not equate a selected fragment with a completed full-document review. */
export type ReadingTaskStatus = 'not-started' | 'in-progress' | 'fragment-reviewed';

export interface ReadingTask {
  id: string;
  sourceEditionId: string;
  status: ReadingTaskStatus;
  reviewedBlockIds: string[];
  annotationIds: string[];
  note: string;
  updatedAt: string;
}

export interface WorkspacePreferences {
  selectedRegionId: string | null;
  selectedSourceEditionId: string | null;
  selectedPracticeId: string | null;
  activePanel: 'documents' | 'practice-catalog' | 'my-work';
  readerFontScale: number;
}

export interface WorkspaceState {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  title: string;
  profile: LocalProfile | null;
  sourceReferences: SourceReference[];
  annotations: WorkspaceAnnotation[];
  practiceProposals: PracticeProposal[];
  linkDecisions: LinkDecision[];
  customCards: CustomPracticeCard[];
  readingTasks: ReadingTask[];
  preferences: WorkspacePreferences;
}

export interface WorkspaceSnapshot {
  state: WorkspaceState;
  revision: number;
  updatedAt: string;
}

export interface WorkspaceExchange {
  format: typeof EXCHANGE_FORMAT;
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  exportedAt: string;
  revision: number;
  workspace: WorkspaceState;
}

export interface ValidatedWorkspaceImport {
  workspace: WorkspaceState;
  exportedRevision: number;
  exportedAt: string;
  /** Every imported decision is attributed to imported provenance. */
  importedDecisionCount: number;
  /** Count of global/field/card verifications reset to candidate for local review. */
  verificationResetCount: number;
  containsProfile: boolean;
}

export interface WorkspaceChangeNotice {
  workspaceId: string;
  revision: number;
  source: 'local' | 'other-tab';
}

export interface CommitRequest {
  workspaceId: string;
  operationId: string;
  /** 0 creates a workspace. No blind overwrite is supported. */
  expectedRevision: number;
  state: WorkspaceState;
}

export type CommitResult =
  | {
      kind: 'committed';
      /** Revision at which this operation was first applied. */
      revision: number;
      replayed: boolean;
      /** Current committed snapshot; it can be newer than revision on an idempotent replay. */
      snapshot: WorkspaceSnapshot;
    }
  | {
      kind: 'conflict';
      expectedRevision: number;
      actualRevision: number;
      snapshot: WorkspaceSnapshot | null;
    };

export interface WorkspaceStore {
  read(workspaceId: string): Promise<WorkspaceSnapshot | null>;
  commit(request: CommitRequest): Promise<CommitResult>;
  subscribe(workspaceId: string, listener: (notice: WorkspaceChangeNotice) => void): () => void;
  close(): void;
}

export function createEmptyWorkspace(
  id = 'local-workspace',
  title = 'Моя рабочая тетрадь',
): WorkspaceState {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id,
    title,
    profile: null,
    sourceReferences: [],
    annotations: [],
    practiceProposals: [],
    linkDecisions: [],
    customCards: [],
    readingTasks: [],
    preferences: {
      selectedRegionId: null,
      selectedSourceEditionId: null,
      selectedPracticeId: null,
      activePanel: 'documents',
      readerFontScale: 1,
    },
  };
}

/** Adapter preserves known source provenance without inventing a digest when ingestion lacks one. */
export function sourceReferenceForDocument(
  meta: DocumentMeta,
  version: DocumentVersion,
): SourceReference {
  return {
    sourceId: version.documentId,
    editionId: version.id,
    title: meta.title,
    normalizationVersion: version.normalizationVersion,
    ...(version.sourceSha256 ? { sha256: version.sourceSha256 } : {}),
    ...((version.sourceUrl ?? meta.sourceUrl)
      ? { sourceUrl: version.sourceUrl ?? meta.sourceUrl }
      : {}),
    regionId: meta.regionId,
  };
}
