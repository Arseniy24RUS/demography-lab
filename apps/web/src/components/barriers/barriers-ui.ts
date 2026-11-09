import type { TextAnchor } from '@domain/index';
import type { SessionSummary } from '../../../../../packages/collaboration/types';
import type {
  AuthorSolution,
  BarrierCard,
  BarrierEvidence,
  BarrierVoteInput,
  BarriersProjection,
  BarriersSnapshot,
  SaveBarrierInput,
  SaveBarrierLinkInput,
  SaveSolutionInput,
  SurveyActionInput,
  SurveyConfigInput,
  SurveyHostState,
  SurveyOwnResponse,
  SurveyPublicManifest,
  SurveyResponseInput,
} from '../../../../../packages/barriers/types';
import type { WorkshopRegionOption } from '../workshop/workshop-ui';

export interface BarrierActions {
  saveBarrier(input: SaveBarrierInput): Promise<unknown>;
  vote(input: BarrierVoteInput): Promise<unknown>;
  saveLink(input: SaveBarrierLinkInput): Promise<unknown>;
  saveSolution(input: SaveSolutionInput): Promise<unknown>;
  readEvidence(evidenceId: string): Promise<BarrierEvidence>;
  saveSurvey(input: SurveyConfigInput): Promise<unknown>;
  manageSurvey(input: SurveyActionInput): Promise<unknown>;
  readSurvey(surveyId: string): Promise<SurveyHostState>;
  exportResearch(surveyId: string): Promise<void>;
}
export interface BarrierAreaProps {
  surveyOnly?: boolean;
  session: SessionSummary;
  snapshot: BarriersSnapshot | null;
  userId: string;
  regions: WorkshopRegionOption[];
  actions: BarrierActions;
  onOpenSource(anchor: TextAnchor): void;
  loading?: boolean;
  error?: string | null;
  onRefresh?(): Promise<unknown> | void;
  /** The host client owns the invitation capability and its local storage. */
  surveyInvitationUrl?: string | null;
  surveyInvitationError?: string | null;
}
export interface BarrierBoardContext extends Omit<BarrierAreaProps, 'snapshot'> {
  snapshot: BarriersSnapshot;
  editable: boolean;
  isHost: boolean;
}
export interface BarrierProjectionViewProps {
  snapshot: BarriersProjection;
  mode?: 'path' | 'links' | 'solutions';
}
/** This component is safe to import from the independent anonymous entry. No account SDK. */
export interface ParticipantSurveyProps {
  manifest: SurveyPublicManifest | null;
  response: SurveyOwnResponse | null;
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  secretPresent: boolean;
  onSave(input: SurveyResponseInput): Promise<SurveyOwnResponse>;
  onWithdraw(expectedRevision: number): Promise<SurveyOwnResponse>;
  onRefresh(): Promise<unknown>;
  onRestoreSecret(secret: string): Promise<unknown>;
  onRevealSecret(): string | null;
  onDownloadReceipt(): void;
}
export function barrierInput(card: BarrierCard): SaveBarrierInput {
  return {
    barrierId: card.id,
    expectedRevision: card.revision,
    title: card.title,
    description: card.description,
    primaryStage: card.primaryStage,
    stageIds: [...card.stageIds],
    evidenceKind: card.evidenceKind,
    status: card.status,
    priority: card.priority,
  };
}
export function solutionInput(card: AuthorSolution): SaveSolutionInput {
  return {
    solutionId: card.id,
    expectedRevision: card.revision,
    barrierIds: [...card.barrierIds],
    title: card.title,
    targetGroup: card.targetGroup,
    mechanism: card.mechanism,
    firstStep: card.firstStep,
    responsible: card.responsible,
    resources: card.resources,
    successIndicator: card.successIndicator,
    risks: card.risks,
    status: card.status,
  };
}
