import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import {
  createEmptyWorkspace,
  EXCHANGE_FORMAT,
  exportWorkspace,
  MAX_EXCHANGE_BYTES,
  openWorkspaceStore,
  validateWorkspaceImport,
  validateWorkspaceState,
  type WorkspaceSnapshot,
  type WorkspaceState,
  type WorkspaceStore,
  type WorkspaceStoreOptions,
} from './index';

const date = '2026-11-08T12:00:00.000Z';
const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

async function open(options: WorkspaceStoreOptions = {}): Promise<WorkspaceStore> {
  const store = await openWorkspaceStore({
    indexedDB: new IDBFactory(),
    channelFactory: null,
    clock: () => date,
    ...options,
  });
  stores.push(store);
  return store;
}

function fixture(): WorkspaceState {
  const state = createEmptyWorkspace('workbook');
  state.profile = { displayName: 'Тестовый участник', email: 'participant@example.test' };
  state.sourceReferences = [
    {
      sourceId: 'document-1',
      editionId: 'edition-1',
      title: 'Программа',
      normalizationVersion: 'unicode-nfc-lf-v1',
      sha256: 'a'.repeat(64),
      sourceUrl: 'https://example.test/programme.pdf',
      regionId: 'ru-13',
    },
  ];
  state.annotations = [
    {
      id: 'annotation-1',
      note: 'Требуется проверка условий',
      createdAt: date,
      updatedAt: date,
      anchor: {
        id: 'anchor-1',
        documentId: 'document-1',
        versionId: 'edition-1',
        normalizationVersion: 'unicode-nfc-lf-v1',
        spans: [
          { blockId: 'block-1', start: 4, end: 10, exact: 'семья👪', prefix: 'Для ', suffix: '' },
          { blockId: 'block-2', start: 0, end: 7, exact: 'пособие', prefix: '', suffix: '.' },
        ],
      },
    },
  ];
  state.practiceProposals = [
    {
      id: 'proposal-1',
      title: 'Поддержка семьи',
      summary: 'Кандидат для обсуждения',
      annotationIds: ['annotation-1'],
      catalogPracticeId: 'catalog-1',
      createdAt: date,
      updatedAt: date,
    },
  ];
  state.linkDecisions = [
    {
      id: 'decision-1',
      annotationId: 'annotation-1',
      practiceId: 'catalog-1',
      status: 'verified',
      rationale: 'Ручное сопоставление фрагмента с названием.',
      decidedAt: date,
      origin: 'local',
      fieldEvidence: [
        {
          kind: 'fragment',
          field: 'title',
          occurrenceId: 'annotation-1',
          relation: 'supports',
          reviewStatus: 'verified',
          reviewedValue: 'Поддержка семьи',
        },
      ],
    },
  ];
  state.customCards = [
    {
      id: 'custom-1',
      familyId: 'family-1',
      regionId: 'ru-13',
      title: 'Моя карточка',
      mechanism: 'Выплата',
      eligibility: 'Семьи',
      amount: '100 000 рублей',
      conditions: ['Условия проверяются'],
      occurrenceIds: ['annotation-1'],
      createdAt: date,
      updatedAt: date,
    },
  ];
  state.readingTasks = [
    {
      id: 'reading-1',
      sourceEditionId: 'edition-1',
      status: 'fragment-reviewed',
      reviewedBlockIds: ['block-1', 'block-2'],
      annotationIds: ['annotation-1'],
      note: 'Проверены только указанные фрагменты.',
      updatedAt: date,
    },
  ];
  return state;
}

function snapshot(state = fixture()): WorkspaceSnapshot {
  return { state, revision: 4, updatedAt: date };
}
function envelope(state: unknown = fixture()): string {
  return JSON.stringify({
    format: EXCHANGE_FORMAT,
    schemaVersion: 1,
    exportedAt: date,
    revision: 4,
    workspace: state,
  });
}

const op = (state: WorkspaceState, operationId = 'op-1', expectedRevision = 0) => ({
  workspaceId: state.id,
  operationId,
  expectedRevision,
  state,
});

describe('durable local workspace', () => {
  it('restores exact multiblock anchors, fields, sources and local profile after reopening', async () => {
    const factory = new IDBFactory();
    const first = await open({ indexedDB: factory });
    const state = fixture();
    expect((await first.commit(op(state))).kind).toBe('committed');
    state.annotations[0].note = 'This mutation must not reach storage';
    first.close();
    const second = await open({ indexedDB: factory });
    const restored = await second.read('workbook');
    expect(restored?.revision).toBe(1);
    expect(restored?.state).toEqual(fixture());
  });

  it('allows exactly one competing write from two tabs at the same revision', async () => {
    const factory = new IDBFactory();
    const a = await open({ indexedDB: factory });
    const b = await open({ indexedDB: factory });
    const stateA = fixture();
    const stateB = fixture();
    stateB.title = 'Другой заголовок';
    const results = await Promise.all([a.commit(op(stateA, 'op-a')), b.commit(op(stateB, 'op-b'))]);
    expect(results.filter((result) => result.kind === 'committed')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'conflict')).toHaveLength(1);
    const conflict = results.find((result) => result.kind === 'conflict');
    expect(conflict).toMatchObject({ actualRevision: 1, expectedRevision: 0 });
    expect((await a.read('workbook'))?.revision).toBe(1);
  });

  it('replays a retry once, preserves newer state and rejects changed payloads under one operation ID', async () => {
    const store = await open();
    const original = fixture();
    await store.commit(op(original));
    const changed = fixture();
    changed.title = 'Следующая версия';
    await store.commit(op(changed, 'op-2', 1));
    const replay = await store.commit(op(original));
    expect(replay).toMatchObject({
      kind: 'committed',
      revision: 1,
      replayed: true,
      snapshot: { revision: 2, state: { title: 'Следующая версия' } },
    });
    await expect(store.commit(op(changed, 'op-1'))).rejects.toMatchObject({
      code: 'OPERATION_ID_REUSED',
    });
    expect((await store.read('workbook'))?.revision).toBe(2);
  });

  it('rolls back both state and receipt if the receipt write fails', async () => {
    const store = await open();
    const originalPut = FakeObjectStore.prototype.put;
    const spy = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === 'operations')
        throw new DOMException('Simulated quota error', 'QuotaExceededError');
      return originalPut.call(this, value, key);
    });
    await expect(store.commit(op(fixture()))).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    spy.mockRestore();
    expect(await store.read('workbook')).toBeNull();
    expect(await store.commit(op(fixture()))).toMatchObject({
      kind: 'committed',
      revision: 1,
      replayed: false,
    });
  });

  it('keeps edition identity immutable even after references disappear from the current workspace', async () => {
    const store = await open();
    await store.commit(op(fixture()));
    await store.commit(op(createEmptyWorkspace('workbook'), 'clear', 1));
    const tampered = fixture();
    tampered.sourceReferences[0].sha256 = 'b'.repeat(64);
    await expect(store.commit(op(tampered, 'import', 2))).rejects.toMatchObject({
      code: 'SOURCE_EDITION_CONFLICT',
    });
    expect((await store.read('workbook'))?.revision).toBe(2);
    expect(await store.commit(op(fixture(), 'import', 2))).toMatchObject({
      kind: 'committed',
      revision: 3,
    });
  });

  it('keeps browser stores independent', async () => {
    const firstBrowser = await open();
    const secondBrowser = await open();
    await firstBrowser.commit(op(fixture()));
    expect(await secondBrowser.read('workbook')).toBeNull();
  });

  it('emits only a reload hint between local tabs, after commit', async () => {
    const factory = new IDBFactory();
    type Channel = ReturnType<NonNullable<WorkspaceStoreOptions['channelFactory']>>;
    const channels = new Set<Channel>();
    const messages: unknown[] = [];
    const channelFactory = (): Channel => {
      const channel: Channel = {
        onmessage: null,
        postMessage(message: unknown) {
          messages.push(message);
          for (const peer of channels)
            if (peer !== channel)
              queueMicrotask(() =>
                peer.onmessage?.call(
                  peer as BroadcastChannel,
                  new MessageEvent('message', { data: message }),
                ),
              );
        },
        close() {
          channels.delete(channel);
        },
      };
      channels.add(channel);
      return channel;
    };
    const a = await open({ indexedDB: factory, channelFactory });
    const b = await open({ indexedDB: factory, channelFactory });
    const notices: unknown[] = [];
    const unsubscribe = b.subscribe('workbook', (notice) => notices.push(notice));
    await a.commit(op(fixture()));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notices).toEqual([{ workspaceId: 'workbook', revision: 1, source: 'other-tab' }]);
    expect(JSON.stringify(messages)).not.toContain('participant@example.test');
    expect(JSON.stringify(messages)).not.toContain('семья');
    expect((await b.read('workbook'))?.revision).toBe(1);
    unsubscribe();
    const next = fixture();
    next.title = 'Обновлено';
    await a.commit(op(next, 'op-2', 1));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(notices).toHaveLength(1);
  });

  it('does not pretend to retain data after closure', async () => {
    const store = await open();
    store.close();
    await expect(store.commit(op(fixture()))).rejects.toMatchObject({ code: 'STORAGE_CLOSED' });
  });
});

describe('versioned, unsigned JSON exchange', () => {
  it('preserves exact source editions and anchors while resetting imported verifications', () => {
    const json = exportWorkspace(snapshot(), { exportedAt: date });
    const imported = validateWorkspaceImport(json);
    expect(imported.workspace.profile).toBeNull();
    expect(imported.workspace.sourceReferences).toEqual(fixture().sourceReferences);
    expect(imported.workspace.annotations).toEqual(fixture().annotations);
    expect(imported.workspace.customCards[0]).toMatchObject({
      amount: '100 000 рублей',
      conditions: ['Условия проверяются'],
    });
    expect(imported.workspace.linkDecisions[0]).toMatchObject({
      status: 'candidate',
      importedStatus: 'verified',
      origin: 'imported',
      fieldEvidence: [{ reviewStatus: 'candidate', reviewedValue: 'Поддержка семьи' }],
    });
    expect(imported.verificationResetCount).toBe(2);
    expect(imported.exportedRevision).toBe(4);
    expect(json).not.toContain('signature');
  });

  it('includes the profile only on explicit request and never fabricates field evidence', () => {
    const state = fixture();
    state.linkDecisions = [];
    const imported = validateWorkspaceImport(
      exportWorkspace(snapshot(state), { includeProfile: true }),
    );
    expect(imported.containsProfile).toBe(true);
    expect(imported.workspace.profile?.email).toBe('participant@example.test');
    expect(imported.workspace.linkDecisions).toEqual([]);
    expect(imported.verificationResetCount).toBe(0);
  });

  it('rejects malformed JSON, future schemas and oversized files before persistence', () => {
    expect(() => validateWorkspaceImport('{bad')).toThrow(
      expect.objectContaining({ code: 'INVALID_JSON' }),
    );
    expect(() =>
      validateWorkspaceImport(envelope().replace('"schemaVersion":1', '"schemaVersion":2')),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_VERSION' }));
    expect(() => validateWorkspaceImport(' '.repeat(MAX_EXCHANGE_BYTES + 1))).toThrow(
      expect.objectContaining({ code: 'FILE_TOO_LARGE' }),
    );
  });

  it('rejects prototype-pollution keys, unsafe URLs and fabricated whole-document completion', () => {
    const polluted = envelope().replace(
      '"workspace":{',
      '"workspace":{"__proto__":{"polluted":true},',
    );
    expect(() => validateWorkspaceImport(polluted)).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA' }),
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    const unsafe = fixture();
    unsafe.sourceReferences[0].sourceUrl = 'javascript:alert(1)';
    expect(() => validateWorkspaceImport(envelope(unsafe))).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA' }),
    );
    expect(() =>
      validateWorkspaceImport(envelope().replace('fragment-reviewed', 'completed')),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DATA' }));
  });

  it('rejects mismatched editions, forged offsets, dangling occurrences and unbound field reviews', () => {
    const mismatch = fixture();
    (mismatch.annotations[0].anchor as { versionId: string }).versionId = 'missing';
    expect(() => validateWorkspaceState(mismatch)).toThrow();
    const offset = fixture();
    (offset.annotations[0].anchor.spans[0] as { end: number }).end = 11; // UTF-16, not code points.
    expect(() => validateWorkspaceState(offset)).toThrow();
    const dangling = fixture();
    dangling.practiceProposals[0].annotationIds = ['missing'];
    expect(() => validateWorkspaceState(dangling)).toThrow();
    const field = JSON.parse(JSON.stringify(fixture()));
    delete field.linkDecisions[0].fieldEvidence[0].reviewedValue;
    expect(() => validateWorkspaceState(field)).toThrow();
  });

  it('treats prose as plain text but refuses object getters and invalid Unicode', () => {
    const text = fixture();
    text.annotations[0].note = '<img src=x onerror=alert(1)> — это текст.';
    expect(validateWorkspaceImport(envelope(text)).workspace.annotations[0].note).toBe(
      text.annotations[0].note,
    );
    const object = fixture();
    const getter = vi.fn(() => 'Injected');
    Object.defineProperty(object, 'title', { get: getter, enumerable: true });
    expect(() => validateWorkspaceState(object)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const unicode = fixture();
    unicode.title = '\ud800';
    expect(() => validateWorkspaceState(unicode)).toThrow();
  });

  it('does not change a committed workspace when an import fails validation', async () => {
    const store = await open();
    await store.commit(op(fixture()));
    expect(() =>
      validateWorkspaceImport(envelope().replace('"fieldEvidence"', '"unexpectedEvidence"')),
    ).toThrow();
    expect((await store.read('workbook'))?.state).toEqual(fixture());
    expect((await store.read('workbook'))?.revision).toBe(1);
  });
});
