import type { ReactNode } from 'react';
import type { TextAnchor } from '@domain/index';
import type { SessionSnapshot } from '../../../../../packages/collaboration/types';
import type {
  CastVoteInput,
  OpenRoundInput,
  RegionWork,
  RegionWorkInput,
  SaveFamilyInput,
  VotingRound,
  WorkshopSnapshot,
} from '../../../../../packages/workshop/types';

export type WorkshopView = 'regions' | 'families' | 'voting';

export interface WorkshopRegionOption {
  id: string;
  name: string;
  hasDocument: boolean;
  documentTitle?: string;
  /** Source completeness and text extraction are separate from the group's progress. */
  documentHint?: string;
}

export interface WorkshopActions {
  regionWork(input: RegionWorkInput): Promise<void>;
  saveFamily(input: SaveFamilyInput): Promise<void>;
  deleteFamily(familyId: string, expectedBoardRevision: number): Promise<void>;
  openRound(input: OpenRoundInput): Promise<void>;
  closeRound(roundId: string, expectedRevision: number): Promise<void>;
  castVote(input: CastVoteInput): Promise<void>;
  loadRound(roundId: string): Promise<VotingRound>;
  refresh(): Promise<void>;
}

export interface RegionMapRenderProps {
  selectedRegionId: string | null;
  onSelect: (regionId: string) => void;
}

export interface WorkshopAreaProps {
  session: SessionSnapshot;
  snapshot: WorkshopSnapshot | null;
  currentUserId: string;
  regions: WorkshopRegionOption[];
  busy: boolean;
  loading: boolean;
  error: string | null;
  actions: WorkshopActions;
  renderMap: (selection: RegionMapRenderProps) => ReactNode;
  onOpenSource: (anchor: TextAnchor) => void;
  onOpenDocument: (regionId: string) => void;
  view?: WorkshopView;
  onViewChange?: (view: WorkshopView) => void;
  hideNavigation?: boolean;
}

export type ReadyWorkshopProps = Omit<WorkshopAreaProps, 'snapshot'> & {
  snapshot: WorkshopSnapshot;
};

export const regionWorkLabels = {
  available: 'Свободна',
  in_progress: 'В работе',
  completed: 'Отбор завершён',
  unavailable: 'Нет текста',
} as const;

export function leaseExpired(
  work: Pick<RegionWork, 'status' | 'leaseExpiresAt'> | undefined,
  now: number,
): boolean {
  return Boolean(
    work?.status === 'in_progress' && work.leaseExpiresAt && Date.parse(work.leaseExpiresAt) <= now,
  );
}

export function visibleRegionStatus(
  available: boolean,
  work: Pick<RegionWork, 'status' | 'leaseExpiresAt'> | undefined,
  now: number,
): keyof typeof regionWorkLabels {
  if (!available) return 'unavailable';
  if (leaseExpired(work, now)) return 'available';
  return work?.status ?? 'available';
}

export function workshopError(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'Не удалось сохранить изменение. Повторите действие.';
}

export function regionName(regions: WorkshopRegionOption[], id: string): string {
  return (
    regions.find((region) => region.id === id)?.name ??
    (id === 'federal' ? 'Федеральный уровень' : id)
  );
}

export function numberLabel(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value);
}

export function percentLabel(value: number | null, signed = false): string {
  if (value === null || !Number.isFinite(value)) return 'Нет оценки';
  return new Intl.NumberFormat('ru-RU', {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(value);
}

export function dateTimeLabel(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
