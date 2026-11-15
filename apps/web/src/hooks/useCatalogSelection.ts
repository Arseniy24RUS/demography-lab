import { useMemo, useState } from 'react';
import type { SessionSnapshot } from '../../../../packages/collaboration/types';

export function useCatalogSelection(session: SessionSnapshot | undefined, onSelect: (id: string) => Promise<void>) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const submissions = session?.submissions;
  const chosen = useMemo(() => new Set(submissions?.flatMap(({ bundle, status }) =>
    status === 'shared' && bundle.catalogSource ? [bundle.catalogSource.id] : [])), [submissions]);
  const canSelect = session?.session.status === 'open' && session.session.role !== 'observer';

  async function select(id: string) {
    if (!canSelect || saving || chosen.has(id)) return;
    setError('');
    setSaving(id);
    try {
      await onSelect(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отобрать меру. Повторите попытку.');
    } finally {
      setSaving(null);
    }
  }

  return { chosen, saving, error, canSelect, select };
}
