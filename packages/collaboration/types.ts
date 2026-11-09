import type { PracticeOccurrence, PracticeVariant, TextAnchor } from '../domain/index';

/** Stage 2 wire contract. Author identity is always supplied by the server. */
export type SessionRole = 'host' | 'participant' | 'observer';
export type SessionScope = 'municipality' | 'region' | 'federal';
export type SessionStatus = 'open' | 'paused' | 'closed';
export type SessionPhase = 'reading' | 'review' | 'discussion';
export interface SessionProfile {
  userId: string;
  fullName: string;
  revision: number;
}
export interface SessionSummary {
  id: string;
  title: string;
  scope: SessionScope;
  regionId: string | null;
  status: SessionStatus;
  phase: SessionPhase;
  role: SessionRole;
  revision: number;
  joinOpen: boolean;
  focusSubmissionId: string | null;
  projectorShowAuthors: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SessionMember {
  userId: string;
  fullName: string;
  role: SessionRole;
  joinedAt: string;
  revision: number;
}
export interface SharedSourceReference {
  sourceId: string;
  editionId: string;
  title: string;
  sha256?: string;
  normalizationVersion: string;
  sourceUrl?: string;
  regionId?: string;
}
export interface SharedPracticeBundle {
  schemaVersion: 1;
  practice: PracticeVariant;
  occurrences: PracticeOccurrence[];
  sources: SharedSourceReference[];
  note: string;
}
export interface SharedSubmission {
  id: string;
  sessionId: string;
  authorId: string;
  authorName: string;
  localKey: string;
  bundle: SharedPracticeBundle;
  revision: number;
  status: 'shared' | 'withdrawn';
  createdAt: string;
  updatedAt: string;
}
export interface SessionSnapshot {
  session: SessionSummary;
  members: SessionMember[];
  submissions: SharedSubmission[];
  /** A server-monotonic cursor; reject delayed responses with an older cursor. */
  cursor: number;
}
export interface BootstrapResult {
  profile: SessionProfile | null;
  canCreateSession: boolean;
  sessions: SessionSummary[];
}
export interface SessionPatch {
  title?: string;
  status?: SessionStatus;
  phase?: SessionPhase;
  joinOpen?: boolean;
  focusSubmissionId?: string | null;
  projectorShowAuthors?: boolean;
}
export interface SessionInvitation {
  code: string;
  revision: number;
}
export type ConnectionStatus =
  'unconfigured' | 'connecting' | 'live' | 'polling' | 'offline' | 'error';
export interface SessionAuthState {
  status: 'loading' | 'signed-out' | 'awaiting-code' | 'signed-in';
  email: string | null;
  userId: string | null;
  resendAvailableAt: number;
}
export interface SessionAreaState {
  configured: boolean;
  configurationError: string | null;
  testEnvironment: boolean;
  offline?: { instanceId: string; url: string; hostAvailable: boolean };
  auth: SessionAuthState;
  bootstrap: BootstrapResult | null;
  snapshot: SessionSnapshot | null;
  invitation: SessionInvitation | null;
  connection: ConnectionStatus;
  busy: string | null;
  error: string | null;
  notice: string | null;
  initialJoinCode: string;
  lastSyncedAt: string | null;
}
export interface SessionAreaActions {
  localRegister?(input: { email: string; fullName: string; joinCode: string; recoverySecret: string }): Promise<void>;
  localRecover?(recoverySecret: string): Promise<void>;
  localHost?(): Promise<void>;
  localServerStatus?(): Promise<{
    instanceId: string; joinCode: string; port: number; surveyPort: number;
    counts: Record<string, number>; lanHosts: string[]; queueDepth: number;
    lastBackup: null | { createdAt: string; path: string; bytes: number };
  }>;
  localBackup?(): Promise<void>;
  sendCode(email: string): Promise<void>;
  verifyCode(token: string): Promise<void>;
  changeEmail(): void;
  signOut(): Promise<void>;
  saveProfile(fullName: string): Promise<void>;
  createSession(input: {
    title: string;
    scope: SessionScope;
    regionId: string | null;
  }): Promise<void>;
  joinSession(code: string): Promise<void>;
  openSession(id: string): Promise<void>;
  closeSessionView(): void;
  updateSession(patch: SessionPatch, expectedRevision: number): Promise<void>;
  rotateInvitation(expectedRevision: number): Promise<void>;
  refresh(): Promise<void>;
  publish(
    bundle: SharedPracticeBundle,
    localKey: string,
    expectedRevision: number | null,
  ): Promise<void>;
  moderateSubmission(id: string, revision: number, status: 'shared' | 'withdrawn'): Promise<void>;
  setMemberRole(userId: string, revision: number, role: 'participant' | 'observer'): Promise<void>;
  revokeMember(userId: string, revision: number): Promise<void>;
  openSource(anchor: TextAnchor): void;
  openProjector(): void;
  openLocalWork(): void;
  clearError(): void;
}
export interface SessionRegionOption {
  id: string;
  name: string;
}
/** The projection deliberately carries neither account email nor membership identifiers. */
export interface ProjectionSession {
  title: string;
  phase: SessionPhase;
  status: SessionStatus;
  focusSubmissionId: string | null;
  projectorShowAuthors: boolean;
  participantCount: number;
  submissions: Array<
    Pick<SharedSubmission, 'id' | 'bundle' | 'revision' | 'updatedAt'> & { authorName?: string }
  >;
  cursor: number;
}
