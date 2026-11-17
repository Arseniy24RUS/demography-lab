// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityWorkbench } from '../../apps/web/src/components/roadmaps/ActivityWorkbench';
import { ConnectedRoadmaps } from '../../apps/web/src/components/ConnectedRoadmaps';
import { useRoadmaps } from '../../apps/web/src/hooks/useRoadmaps';
import type { CaptureRoadmapBasisInput, RoadmapBasis, RoadmapBasisMaterial } from '../../packages/roadmaps/types';
import { runtimeIndex, runtimeSnapshot, stamp, testUuid, roomB } from './roadmaps-runtime.fixture';

vi.mock('../../apps/web/src/hooks/useRoadmaps', () => ({ useRoadmaps: vi.fn() }));
vi.mock('../../apps/web/src/components/roadmaps/TerritoryPanel', () => ({
  TerritoryPanel: () => null, useTerritoryDataset: () => ({}),
}));
vi.mock('../../apps/web/src/components/roadmaps/PassportWorkbench', () => ({ PassportWorkbench: () => null }));

type Props = ComponentProps<typeof ActivityWorkbench>;
const removeLabel = 'Убрать из дорожной карты';
const dialogTitle = 'Убрать основание из дорожной карты?';
const barrier = {
  id: testUuid(201), title: 'Трудно совместить работу и уход за ребёнком',
  description: 'Сохранённое командой описание барьера.', stageIds: [],
  evidenceKind: 'observation' as const, contentRevision: 3, status: 'active' as const,
};
function basis(kind: RoadmapBasis['sourceKind'] = 'barrier'): RoadmapBasis {
  let material: RoadmapBasisMaterial;
  switch (kind) {
    case 'barrier': material = { kind, source: barrier }; break;
    case 'link': material = { kind, source: {
      id: barrier.id, relationship: 'potential', explanation: 'Объяснение связи', prerequisites: '',
      revision: 3, status: 'active', barrier, evidenceId: testUuid(202),
      familyTitle: 'Практика', familyFingerprint: 'f'.repeat(64),
    } }; break;
    case 'solution': material = { kind, source: {
      id: barrier.id, title: 'Решение', targetGroup: '', mechanism: 'Механизм', firstStep: '',
      responsible: '', resources: '', successIndicator: '', risks: '', revision: 3,
      status: 'active', barriers: [barrier],
    } }; break;
    case 'factor': material = { kind, source: {
      id: barrier.id, title: 'Предложение', board: 'objective', revision: 3,
      status: 'active', barriers: [barrier],
    } }; break;
  }
  return {
    id: testUuid(203), sourceKind: kind, sourceId: barrier.id, sourceRevision: 3,
    fingerprint: 'f'.repeat(64), material, rationale: 'Сохранённое обоснование команды',
    status: 'active', revision: 7, staleReasons: [], createdAt: stamp, updatedAt: stamp,
  };
}
function harness(value = basis()) {
  const snapshot = runtimeSnapshot();
  snapshot.basis = [value];
  const diagnosis = snapshot.items.find(item => item.kind === 'diagnosis')!;
  if (diagnosis.kind === 'diagnosis') diagnosis.data.problem = 'Самостоятельный текст проблемы и барьеров команды';
  const actions = {
    captureBasis: vi.fn(async (_input: CaptureRoadmapBasisInput) => snapshot), saveItem: vi.fn(), importWorkshop: vi.fn(),
  };
  const props = {
    snapshot, editable: true, onEdit: vi.fn(), barriers: null,
    readEvidence: vi.fn(), onOpenSource: vi.fn(), regions: [],
    controller: { busy: false, actions },
  } as unknown as Props;
  const mounted = render(createElement(ActivityWorkbench, props));
  return { props, actions, diagnosis, ...mounted };
}
function openRemoval() {
  fireEvent.click(screen.getByRole('button', { name: removeLabel }));
  return screen.getByRole('dialog', { name: dialogTitle });
}
afterEach(cleanup);

describe('roadmap-local barrier controls preserve saved work until an explicit action', () => {
  it('viewing, opening and cancelling leave all saved data untouched', () => {
    const { props, actions } = harness();
    const original = JSON.stringify(props.snapshot);
    expect(actions.captureBasis).not.toHaveBeenCalled();
    const dialog = openRemoval();
    expect(within(dialog).getByText(barrier.title)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Оставить' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(actions.captureBasis).not.toHaveBeenCalled();
    expect(actions.saveItem).not.toHaveBeenCalled();
    expect(actions.importWorkshop).not.toHaveBeenCalled();
    expect(JSON.stringify(props.snapshot)).toBe(original);
  });

  it.each(['barrier', 'link', 'solution'] as const)('archives only the selected %s basis with its saved revisions', async kind => {
    const saved = basis(kind);
    saved.staleReasons = ['source_missing'];
    const { props, actions } = harness(saved);
    const original = JSON.stringify(props.snapshot);
    const dialog = openRemoval();
    fireEvent.click(within(dialog).getByRole('button', { name: removeLabel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(actions.captureBasis).toHaveBeenCalledExactlyOnceWith({
      roadmapId: props.snapshot.roadmapId, basisId: saved.id,
      expectedRevision: 7, sourceKind: kind, sourceId: saved.sourceId,
      expectedSourceRevision: 3, rationale: saved.rationale, status: 'archived',
    });
    expect(actions.saveItem).not.toHaveBeenCalled();
    expect(actions.importWorkshop).not.toHaveBeenCalled();
    expect(JSON.stringify(props.snapshot)).toBe(original);
  });

  it('keeps the selected revision after a team update and displays a conflict instead of retrying with new data', async () => {
    const saved = basis();
    const { props, actions, rerender } = harness(saved);
    actions.captureBasis.mockRejectedValue(new Error('Конфликт редакций: обновите данные.'));
    const dialog = openRemoval();
    const updated = { ...props.snapshot, revision: 9, basis: [{ ...saved, revision: 8, sourceRevision: 4, rationale: 'Новая правка другого участника' }] };
    rerender(createElement(ActivityWorkbench, { ...props, snapshot: updated }));
    fireEvent.click(within(dialog).getByRole('button', { name: removeLabel }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('Конфликт редакций'));
    expect(actions.captureBasis).toHaveBeenCalledTimes(1);
    expect(actions.captureBasis.mock.calls[0][0]).toMatchObject({ expectedRevision: 7, expectedSourceRevision: 3, rationale: saved.rationale });
    expect(screen.getByRole('dialog', { name: dialogTitle })).toBe(dialog);
    expect(updated.basis[0].status).toBe('active');
    expect(actions.saveItem).not.toHaveBeenCalled();
  });

  it('opens the existing local problem editor without editing or recapturing the global barrier', () => {
    const { props, actions, diagnosis } = harness();
    fireEvent.click(screen.getByRole('button', { name: 'Редактировать описание барьеров' }));
    expect(props.onEdit).toHaveBeenCalledExactlyOnceWith({ kind: 'diagnosis', id: diagnosis.id });
    expect(actions.captureBasis).not.toHaveBeenCalled();
    expect(actions.saveItem).not.toHaveBeenCalled();
  });

  it('does not offer unsupported factor archiving or controls in read-only roadmaps', () => {
    const { props, rerender, actions } = harness(basis('factor'));
    expect(screen.queryByRole('button', { name: removeLabel })).toBeNull();
    rerender(createElement(ActivityWorkbench, { ...props, editable: false, snapshot: { ...props.snapshot, basis: [basis()] } }));
    expect(screen.queryByRole('button', { name: removeLabel })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Редактировать описание барьеров' })).toBeNull();
    expect(actions.captureBasis).not.toHaveBeenCalled();
    expect(actions.saveItem).not.toHaveBeenCalled();
  });

  it('blocks a pending confirmation when editing permission is lost', () => {
    const { props, rerender, actions } = harness();
    const dialog = openRemoval();
    rerender(createElement(ActivityWorkbench, { ...props, editable: false }));
    const confirm = within(dialog).getByRole('button', { name: removeLabel }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(actions.captureBasis).not.toHaveBeenCalled();
  });

  it('dismisses a selected basis confirmation when the connected workspace changes rooms', async () => {
    const first = runtimeSnapshot();
    first.basis = [basis()];
    const index = runtimeIndex();
    index.rooms[0].exampleLabel = 'Тестовый пример';
    const actions = { select: vi.fn(), refresh: vi.fn(), captureBasis: vi.fn(), saveItem: vi.fn() };
    let controller = { index, snapshot: first, busy: false, actions } as unknown as ReturnType<typeof useRoadmaps>;
    vi.mocked(useRoadmaps).mockImplementation(() => controller);
    const props = {
      state: { auth: { userId: testUuid(2), status: 'signed-in' }, snapshot: {
        session: { id: first.sessionId, status: 'open', role: 'host', regionId: null },
      } },
      sessionActions: { openSource: vi.fn() }, api: null,
      barriers: { snapshot: null, actions: { readEvidence: vi.fn() } }, manifest: { documents: [] },
    } as unknown as ComponentProps<typeof ConnectedRoadmaps>;
    const mounted = render(createElement(ConnectedRoadmaps, props));
    fireEvent.click(screen.getByRole('button', { name: /Тестовый пример/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Мероприятия' }));
    await screen.findByRole('heading', { name: 'Основания выбранного решения' });
    openRemoval();
    const next = runtimeSnapshot(roomB);
    next.basis = [{ ...basis(), id: testUuid(204) }];
    controller = { ...controller, snapshot: next };
    mounted.rerender(createElement(ConnectedRoadmaps, props));
    expect(screen.queryByRole('dialog', { name: dialogTitle })).toBeNull();
    expect(screen.getByRole('button', { name: removeLabel })).toBeTruthy();
    expect(actions.captureBasis).not.toHaveBeenCalled();
    expect(actions.saveItem).not.toHaveBeenCalled();
  });
});
