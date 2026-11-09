import { webcrypto } from 'node:crypto';
import type {
  RoadmapSnapshot,
  RoadmapsIndex,
  RoadmapVersion,
  FrozenRoadmapData,
  RoadmapsProjection,
  RoadmapItem,
} from '../../packages/roadmaps/types';

export const testUuid = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
export const sessionId = testUuid(1),
  userId = testUuid(2),
  roomA = testUuid(3),
  roomB = testUuid(4),
  versionId = testUuid(5);
export const stamp = '2026-11-09T00:00:00.000Z';
export function runtimeSnapshot(room = roomA, cursor = 1): RoadmapSnapshot {
  const common = {
    revision: 1,
    status: 'active' as const,
    createdBy: userId,
    updatedBy: userId,
    createdByName: 'Участник',
    updatedByName: 'Участник',
    createdAt: stamp,
    updatedAt: stamp,
  };
  const items: RoadmapItem[] = [
    {
      ...common,
      id: testUuid(101),
      kind: 'passport',
      data: {
        title: '',
        targetGroup: '',
        partners: '',
        goal: '',
        objectives: [],
        startDate: null,
        endDate: null,
        expectedResult: '',
        defenseDate: null,
        humanResources: '',
        materialResources: '',
        informationResources: '',
      },
    },
    {
      ...common,
      id: testUuid(102),
      kind: 'diagnosis',
      data: { problem: '', causeHypothesis: '', conclusion: '' },
    },
    {
      ...common,
      id: testUuid(103),
      kind: 'monitoring',
      data: {
        frequency: '',
        method: '',
        responsible: '',
        interimReportDate: null,
        finalReportDate: null,
        qualitativeResults: '',
        sustainability: '',
      },
    },
  ];
  return {
    sessionId,
    roadmapId: room,
    cursor,
    sourceCursor: 0,
    revision: cursor,
    territory: {
      key: room === roomA ? 'test-territory-a' : 'test-territory-b',
      name: 'Синтетическая тестовая территория',
      level: 'municipality',
      regionId: 'test-region',
      sourceEditionId: 'test-geography',
      sourceCode: null,
      sourceType: 'municipal_district',
      geographicStatus: 'historical_source_snapshot',
      sourceUrl: 'https://example.test/source',
      boundaryVersion: 'test-geography',
    },
    roomLevel: 'municipality',
    canEdit: true,
    members: [{ userId, fullName: 'Участник' }],
    items,
    basis: [],
    series: [],
    versions: [],
    budget: {
      needCashKopecks: 0,
      inKindKopecks: 0,
      confirmedKopecks: 0,
      expectedKopecks: 0,
      confirmedGapKopecks: 0,
      remainingAfterExpectedKopecks: 0,
      years: [],
    },
  };
}
export function runtimeIndex(cursor = 1, own = roomA): RoadmapsIndex {
  return {
    sessionId,
    cursor,
    sourceCursor: 0,
    configuration: {
      roomLevel: 'municipality',
      revision: 2,
      locked: true,
      dataEditionId: 'test-edition',
    },
    myRoadmapId: own,
    assignmentRevision: 1,
    rooms: [roomA, roomB].map((id) => ({
      id,
      territory: runtimeSnapshot(id).territory,
      revision: cursor,
      memberCount: 1,
      activeItemCount: 3,
      versionCount: 0,
      latestVersionKind: null,
      updatedAt: stamp,
    })),
  };
}
export function runtimeProjection(room: string | null, cursor = 1): RoadmapsProjection {
  const s = room ? runtimeSnapshot(room, cursor) : null;
  return {
    sessionId,
    title: 'Тестовая сессия',
    cursor,
    sourceCursor: 0,
    rooms: runtimeIndex(cursor).rooms,
    selected: s
      ? {
          roadmapId: s.roadmapId,
          revision: s.revision,
          territory: s.territory,
          roomLevel: s.roomLevel,
          items: s.items.map(({ id, kind, data, revision, status }) => ({
            id,
            kind,
            data,
            revision,
            status,
          })) as FrozenRoadmapData['items'],
          basis: [],
          series: [],
          budget: s.budget,
        }
      : null,
  };
}
export async function runtimeVersion(): Promise<RoadmapVersion> {
  const s = runtimeSnapshot();
  const snapshot: FrozenRoadmapData = {
    schemaVersion: 1,
    templateVersion: 'organizers-roadmap-1',
    calculationVersion: 'roadmap-analytics-1',
    territory: s.territory,
    roomLevel: 'municipality',
    roadmapRevision: 1,
    session: { title: 'Тестовая сессия', scope: 'municipality', regionId: 'test-region' },
    teamNames: ['Участник'],
    items: s.items.map(({ id, kind, data, revision, status }) => ({
      id,
      kind,
      data,
      revision,
      status,
    })) as FrozenRoadmapData['items'],
    basis: [],
    series: [],
    evidence: [],
    budget: s.budget,
  };
  const canonicalJson = JSON.stringify(snapshot);
  const sha256 = Array.from(
    new Uint8Array(
      await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  return {
    id: versionId,
    number: 1,
    kind: 'draft',
    title: 'Тестовая версия',
    roadmapRevision: 1,
    sha256,
    createdAt: stamp,
    review: null,
    sessionId,
    roadmapId: roomA,
    canonicalJson,
    snapshot,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
