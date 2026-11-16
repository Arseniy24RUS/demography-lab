import { useId } from 'react';
import type { SaveFamilyInput } from '../../../../../packages/workshop/types';
import { Modal } from '../Modal';

export interface PracticeGroupDraft extends SaveFamilyInput {
  mode: 'merge' | 'edit' | 'split';
  cardKeys: string[];
  labels: string[];
  originalMechanism: string;
}

export function PracticeGroupDialog({ draft, busy, stale, unavailable, error, onChange, onClose, onSave, onRefresh }: {
  draft: PracticeGroupDraft;
  busy: boolean;
  stale: boolean;
  unavailable: boolean;
  error: string | null;
  onChange(patch: Pick<PracticeGroupDraft, 'title'> | Pick<PracticeGroupDraft, 'mechanism'>): void;
  onClose(): void;
  onSave(): void;
  onRefresh(): void;
}) {
  const id = useId();
  return <Modal title={draft.mode === 'edit' ? 'Изменить группу' : draft.mode === 'split' ? 'Отдельная карточка' : 'Группировать карточки'}
    onClose={() => { if (!busy) onClose(); }}
    actions={<>
      <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Отмена</button>
      <button type="submit" form={`${id}-form`} className="button button-primary"
        disabled={busy || stale || unavailable || !draft.title.trim() || !draft.mechanism.trim() || !draft.submissionIds.length}>
        {busy ? 'Сохраняем…' : 'Сохранить группу'}
      </button>
    </>}>
    <form id={`${id}-form`} className="practice-group-form" onSubmit={event => { event.preventDefault(); onSave(); }}>
      <label htmlFor={`${id}-title`}>Название группы</label>
      <input id={`${id}-title`} className="input" value={draft.title} maxLength={300} disabled={busy}
        onChange={event => onChange({ title: event.target.value })} />
      <label htmlFor={`${id}-mechanism`}>Общий механизм</label>
      <textarea id={`${id}-mechanism`} className="input" rows={4} value={draft.mechanism} maxLength={4000} disabled={busy}
        onChange={event => onChange({ mechanism: event.target.value })} />
      <p className="form-hint">Опишите, что объединяет выбранные меры. Исходные карточки, условия и цитаты сохранятся отдельно.</p>
      <p className="form-hint">После изменения группы её нужно оценить заново.</p>
      <details className="practice-group-members">
        <summary>Исходных вариантов: {draft.submissionIds.length}</summary>
        <ul>{draft.labels.map((label, index) => <li key={`${index}:${label}`}>{label}</li>)}</ul>
      </details>
      {stale ? <div className="session-message" data-tone="error" role="alert">
        <p>Состав доски изменился. Проверьте выбранные карточки перед сохранением.</p>
        <button type="button" className="button button-secondary" disabled={busy} onClick={onRefresh}>Обновить состав</button>
      </div> : null}
      {unavailable ? <p className="session-message" data-tone="error" role="alert">Выбранные карточки изменились или сняты с доски. Верните снятые варианты или уточните выбор перед изменением группы.</p> : null}
      {error ? <p className="session-message" data-tone="error" role="alert">{error}</p> : null}
    </form>
  </Modal>;
}
