import type { FieldEvidence } from '../../../../packages/domain/src/types';
import { WorkspaceError } from './errors';
import {
  EXCHANGE_FORMAT,
  MAX_EXCHANGE_BYTES,
  WORKSPACE_SCHEMA_VERSION,
  type ValidatedWorkspaceImport,
  type WorkspaceExchange,
  type WorkspaceSnapshot,
} from './types';
import {
  assertSafeJsonTree,
  integer,
  object,
  timestamp,
  validateWorkspaceState,
} from './validation';

export interface ExportOptions {
  /** Explicit opt-in: exports omit the local name/email by default. */
  includeProfile?: boolean;
  exportedAt?: string;
}

function checkSize(json: string): void {
  if (new TextEncoder().encode(json).byteLength > MAX_EXCHANGE_BYTES) {
    throw new WorkspaceError('FILE_TOO_LARGE', 'Файл превышает допустимый размер 5 МиБ.');
  }
}

/** A plain JSON exchange file. It has no digital signature and asserts no verified identity. */
export function exportWorkspace(snapshot: WorkspaceSnapshot, options: ExportOptions = {}): string {
  integer(snapshot.revision, '$.revision', 0);
  const state = validateWorkspaceState(snapshot.state);
  if (!options.includeProfile) state.profile = null;
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  timestamp(exportedAt, '$.exportedAt');
  const envelope: WorkspaceExchange = {
    format: EXCHANGE_FORMAT,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    exportedAt,
    revision: snapshot.revision,
    workspace: state,
  };
  const json = `${JSON.stringify(envelope, null, 2)}\n`;
  checkSize(json);
  return json;
}

/** Validates the entire exchange before any persistence. Nothing is written by this function. */
export function validateWorkspaceImport(json: string): ValidatedWorkspaceImport {
  if (typeof json !== 'string') throw new WorkspaceError('INVALID_JSON', 'Ожидался текст JSON.');
  checkSize(json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json);
  } catch (cause) {
    throw new WorkspaceError(
      'INVALID_JSON',
      'Не удалось прочитать JSON. Рабочая тетрадь не изменена.',
      undefined,
      { cause },
    );
  }
  assertSafeJsonTree(parsed);
  const envelope = object(parsed, '$', [
    'format',
    'schemaVersion',
    'exportedAt',
    'revision',
    'workspace',
  ]);
  if (envelope.format !== EXCHANGE_FORMAT)
    throw new WorkspaceError(
      'INVALID_DATA',
      'Это не файл рабочей тетради демографического практикума.',
      '$.format',
    );
  if (envelope.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceError(
      'UNSUPPORTED_VERSION',
      'Версия файла не поддерживается. Требуется версия 1.',
      '$.schemaVersion',
    );
  }
  timestamp(envelope.exportedAt, '$.exportedAt');
  integer(envelope.revision, '$.revision', 0);
  const workspace = validateWorkspaceState(envelope.workspace);
  let verificationResetCount = 0;
  const resetEvidence = (entries: readonly FieldEvidence[]): FieldEvidence[] =>
    entries.map((entry) => {
      if (entry.kind !== 'fragment' || entry.reviewStatus !== 'verified') return entry;
      verificationResetCount++;
      return { ...entry, reviewStatus: 'candidate' as const };
    });
  workspace.linkDecisions = workspace.linkDecisions.map((decision) => {
    if (decision.status === 'verified') verificationResetCount++;
    return {
      ...decision,
      status: decision.status === 'verified' ? 'candidate' : decision.status,
      origin: 'imported',
      fieldEvidence: resetEvidence(decision.fieldEvidence),
      importedStatus: decision.importedStatus ?? decision.status,
    };
  });
  workspace.customCards = workspace.customCards.map((card) => {
    if (card.reviewStatus === 'verified') verificationResetCount++;
    return {
      ...card,
      ...(card.reviewStatus
        ? {
            reviewStatus:
              card.reviewStatus === 'verified' ? ('candidate' as const) : card.reviewStatus,
          }
        : {}),
      ...(card.evidence ? { evidence: resetEvidence(card.evidence) } : {}),
    };
  });
  // The receiving browser has not checked the imported excerpt against its source edition.
  // Retain all edition identifiers, digests, text selectors and explicit contradictory decisions.
  return {
    workspace: validateWorkspaceState(workspace),
    exportedRevision: envelope.revision,
    exportedAt: envelope.exportedAt,
    importedDecisionCount: workspace.linkDecisions.length,
    verificationResetCount,
    containsProfile: workspace.profile !== null,
  };
}
