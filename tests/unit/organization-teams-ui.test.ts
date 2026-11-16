// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoadmapRoomSummary } from '../../packages/roadmaps/types';
import { OrganizationTeams } from '../../apps/web/src/components/roadmaps/OrganizationTeams';

function room(id: string, name: string, organization = true): RoadmapRoomSummary {
  return {
    id, territory: {
      key: organization ? `organization:${id}` : `territory:${id}`, name,
      level: organization ? 'organization' : 'municipality', regionId: null,
      sourceEditionId: 'custom-organizations-v1', sourceCode: null, sourceType: organization ? 'organization' : 'municipality',
      geographicStatus: organization ? 'not-applicable' : 'unknown', sourceUrl: 'https://example.test/', boundaryVersion: null,
    },
    revision: 1, memberCount: 7, activeItemCount: 3, versionCount: 0,
    latestVersionKind: null, updatedAt: '2026-11-17T00:00:00Z',
  };
}
const props = () => ({
  rooms: [room('org-z', 'Школа № 12'), room('geo', 'Саранск', false), room('org-a', 'Детский сад № 3')],
  presenceCounts: new Map([['org-z', 2], ['org-a', 4]]), selectedId: null,
  canJoin: true, busy: false, onCreate: vi.fn(async (_name: string) => {}), onJoin: vi.fn(async (_id: string) => {}),
});
afterEach(cleanup);

describe('organization roadmap teams', () => {
  it('shows all organization teams with live attendance and joins the selected roadmap', () => {
    const actions = props();
    render(createElement(OrganizationTeams, actions));
    const panel = screen.getByRole('region', { name: 'Команды организаций' });
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(rows.map(row => row.textContent)).toEqual(['Детский сад № 34', 'Школа № 122']);
    expect(within(panel).queryByText('Саранск')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Школа № 12' }));
    expect(actions.onJoin).toHaveBeenCalledExactlyOnceWith('org-z');
  });

  it('lets a member name a team and preserves that name when creation fails', async () => {
    const actions = props();
    actions.onCreate.mockRejectedValueOnce(new Error('Сохранение временно недоступно'));
    render(createElement(OrganizationTeams, actions));
    fireEvent.click(screen.getByRole('button', { name: 'Создать команду организации' }));
    const dialog = screen.getByRole('dialog', { name: 'Создать команду организации' });
    const input = within(dialog).getByRole('textbox', { name: 'Название организации' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  Школа № 5  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать команду' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('временно недоступно'));
    expect(input.value).toBe('  Школа № 5  ');
    expect(actions.onCreate).toHaveBeenCalledExactlyOnceWith('Школа № 5');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать команду' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Создать команду организации' })).toBeNull());
    expect(actions.onCreate).toHaveBeenCalledTimes(2);
  });

  it('keeps read access for observers and disables team writes while another operation runs', () => {
    const actions = props();
    const mounted = render(createElement(OrganizationTeams, { ...actions, canJoin: false }));
    expect(screen.queryByRole('button', { name: 'Создать команду организации' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Школа № 12' }));
    expect(actions.onJoin).toHaveBeenCalledOnce();
    mounted.rerender(createElement(OrganizationTeams, { ...actions, busy: true }));
    expect((screen.getByRole('button', { name: 'Школа № 12' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Создать команду организации' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
