import { useId, useState } from 'react';
import { Building2, Plus } from 'lucide-react';
import type { RoadmapRoomSummary } from '../../../../../packages/roadmaps/types';
import { Modal } from '../Modal';
import { SectionHeading } from './common';

export function OrganizationTeams({ rooms, presenceCounts, selectedId, canJoin, busy, onCreate, onJoin }: {
  rooms: RoadmapRoomSummary[];
  presenceCounts: ReadonlyMap<string, number> | null;
  selectedId: string | null;
  canJoin: boolean;
  busy: boolean;
  onCreate(name: string): Promise<void>;
  onJoin(roadmapId: string): Promise<void>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const organizations = rooms.filter(room => room.territory.level === 'organization')
    .sort((a, b) => a.territory.name.localeCompare(b.territory.name, 'ru'));
  const pending = busy || working;
  async function create() {
    if (pending || !name.trim()) return;
    setWorking(true);
    setError(null);
    try {
      await onCreate(name.trim());
      setOpen(false);
      setName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось создать команду. Повторите попытку.');
    } finally {
      setWorking(false);
    }
  }
  return <section className="rm-section rm-organization-teams" aria-label="Команды организаций">
    <SectionHeading title="Команды организаций">
      Создайте команду для своей организации или присоединитесь к существующей.
    </SectionHeading>
    {canJoin ? <div className="rm-actions">
      <button type="button" className="button button-secondary" disabled={pending} onClick={() => {
        setError(null);
        setOpen(true);
      }}><Plus size={17} aria-hidden="true" />Создать команду организации</button>
    </div> : null}
    {organizations.length ? <div className="rm-table-scroll">
      <table>
        <thead><tr><th>Организация</th><th>Сейчас в команде</th></tr></thead>
        <tbody>{organizations.map(room => <tr key={room.id} data-selected={room.id === selectedId}>
          <th><button type="button" className="rm-table-select" disabled={pending}
            onClick={() => void onJoin(room.id)}><Building2 size={16} aria-hidden="true" />{room.territory.name}</button></th>
          <td className="rm-live-count">{presenceCounts ? presenceCounts.get(room.id) ?? 0 : '—'}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="rm-empty">Команд организаций пока нет.</p>}
    {open ? <Modal title="Создать команду организации" onClose={() => { if (!pending) setOpen(false); }}
      actions={<>
        <button type="button" className="button button-secondary" disabled={pending} onClick={() => setOpen(false)}>Отмена</button>
        <button type="submit" form={`${id}-form`} className="button button-primary" disabled={pending || !name.trim()}>
          {pending ? 'Создаём команду…' : 'Создать команду'}
        </button>
      </>}>
      <form id={`${id}-form`} onSubmit={event => { event.preventDefault(); void create(); }}>
        <label className="rm-field" htmlFor={`${id}-name`}>
          <span>Название организации</span>
          <input id={`${id}-name`} autoComplete="organization" maxLength={200} value={name} disabled={pending}
            onChange={event => { setName(event.target.value); setError(null); }} placeholder="Например, школа или предприятие" />
        </label>
        <p className="rm-muted">Участники этой мастерской увидят команду и смогут присоединиться.</p>
        {error ? <p className="session-message" data-tone="error" role="alert">{error}</p> : null}
      </form>
    </Modal> : null}
  </section>;
}
