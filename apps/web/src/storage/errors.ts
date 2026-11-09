export type WorkspaceErrorCode =
  | 'INVALID_DATA'
  | 'UNSUPPORTED_VERSION'
  | 'FILE_TOO_LARGE'
  | 'INVALID_JSON'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_BLOCKED'
  | 'STORAGE_CLOSED'
  | 'STORAGE_FAILURE'
  | 'OPERATION_ID_REUSED'
  | 'SOURCE_EDITION_CONFLICT';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly path?: string;

  constructor(code: WorkspaceErrorCode, message: string, path?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceError';
    this.code = code;
    this.path = path;
  }
}
