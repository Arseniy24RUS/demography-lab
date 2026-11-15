import { Check, Plus } from 'lucide-react';
import type { useCatalogSelection } from '@/hooks/useCatalogSelection';

export function CatalogSelectButton({ id, selection }: { id: string; selection: ReturnType<typeof useCatalogSelection> }) {
  const selected = selection.chosen.has(id);
  if (!selection.canSelect && !selected) return null;

  return <button type="button" className={`button ${selected ? 'button-secondary' : 'button-primary'} small`}
    aria-pressed={selected} aria-disabled={selected || selection.saving !== null}
    onClick={() => void selection.select(id)}>
    {selected ? <Check size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
    {selected ? 'Мера отобрана' : selection.saving === id ? 'Сохраняем…' : 'Отобрать меру'}
  </button>;
}
