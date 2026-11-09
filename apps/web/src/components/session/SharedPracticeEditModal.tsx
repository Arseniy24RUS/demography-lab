import { useId, useState } from 'react';
import { Copy, Save } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { fieldLabels, fieldValue } from '@/lib/workspace-domain';
import type { PracticeField, PracticeVariant } from '@domain/index';
import type {
  SessionAreaActions,
  SharedPracticeBundle,
  SharedSubmission,
} from '../../../../../packages/collaboration/types';
import { messageFromError } from './session-ui';

type Draft = Record<PracticeField | 'note', string>;
const editableFields: PracticeField[] = [
  'title',
  'mechanism',
  'eligibility',
  'amount',
  'conditions',
];

function toDraft(submission: SharedSubmission): Draft {
  const { practice } = submission.bundle;
  return {
    title: practice.title,
    mechanism: practice.mechanism,
    eligibility: practice.eligibility ?? '',
    amount: practice.amount ?? '',
    conditions: (practice.conditions ?? []).join('\n'),
    note: submission.bundle.note,
  };
}

/** Invalidate only the field-value assertions changed by this edit. */
export function editedSharedBundle(base: SharedPracticeBundle, draft: Draft): SharedPracticeBundle {
  const next: PracticeVariant = {
    ...base.practice,
    title: draft.title.trim(),
    mechanism: draft.mechanism.trim(),
    eligibility: draft.eligibility.trim() || undefined,
    amount: draft.amount.trim() || undefined,
    conditions: draft.conditions
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
  };
  const changed = new Set(
    editableFields.filter((field) => fieldValue(next, field) !== fieldValue(base.practice, field)),
  );
  const evidence = base.practice.evidence?.map((entry) => {
    if (entry.kind !== 'fragment' || !changed.has(entry.field)) return entry;
    const { reviewedValue: _oldValue, ...remaining } = entry;
    return { ...remaining, reviewStatus: 'candidate' as const };
  });
  return {
    ...base,
    practice: {
      ...next,
      evidence,
      ...(changed.size ? { reviewStatus: 'candidate' as const } : {}),
    },
    note: draft.note.trim(),
  };
}

export function SharedPracticeEditModal({
  submission,
  canEdit,
  busy,
  actions,
  onClose,
}: {
  submission: SharedSubmission;
  canEdit: boolean;
  busy: boolean;
  actions: SessionAreaActions;
  onClose: () => void;
}) {
  const id = useId();
  // The base revision is captured when the editor opens, never substituted on submit.
  const [base, setBase] = useState(() => structuredClone(submission));
  const [draft, setDraft] = useState(() => toDraft(submission));
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<'close' | 'reload' | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const changedRemotely = submission.revision !== base.revision;
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(base));
  const disabled = busy || working;

  async function save() {
    setWorking(true);
    setError('');
    try {
      await actions.publish(editedSharedBundle(base.bundle, draft), base.localKey, base.revision);
      onClose();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setWorking(false);
    }
  }

  function reload() {
    setBase(structuredClone(submission));
    setDraft(toDraft(submission));
    setConfirmDiscard(null);
    setError('');
    setCopyMessage('');
  }

  async function copyDraft() {
    const text = [
      ...editableFields.map((field) => `${fieldLabels[field]}\n${draft[field]}`),
      `Комментарий автора\n${draft.note}`,
    ].join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(
        'Черновик скопирован. Его можно сохранить отдельно перед загрузкой новой версии.',
      );
    } catch {
      setCopyMessage(
        'Копирование недоступно. Выделите и сохраните нужные поля перед заменой черновика.',
      );
    }
  }

  return (
    <Modal
      title="Редактировать публикацию"
      wide
      onClose={() => {
        if (!disabled) {
          if (dirty) setConfirmDiscard('close');
          else onClose();
        }
      }}
    >
      <p className="modal-intro">
        Изменения появятся на общей доске после сохранения. При изменении поля его прежняя проверка
        по цитате потребует повторного сопоставления.
      </p>
      {changedRemotely ? (
        <div className="session-message" data-tone="warning" role="status">
          <div>
            <p>На доске уже есть более новая версия. Ваш черновик сохранён в этом окне.</p>
            <details className="session-conflict-comparison">
              <summary>Сравнить с версией на доске</summary>
              <dl>
                {editableFields
                  .filter((field) => fieldValue(submission.bundle.practice, field) !== draft[field])
                  .flatMap((field) => [
                    <dt key={`${field}-label`}>{fieldLabels[field]} · на доске</dt>,
                    <dd key={field}>
                      {fieldValue(submission.bundle.practice, field) || 'Не указано'}
                    </dd>,
                  ])}
              </dl>
              {submission.bundle.note !== draft.note ? (
                <p>Комментарий на доске: {submission.bundle.note || 'не указан'}</p>
              ) : null}
            </details>
            <div className="session-action-row">
              <button
                type="button"
                className="button button-secondary"
                disabled={disabled}
                onClick={() => setConfirmDiscard('reload')}
              >
                Загрузить версию с доски
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => void copyDraft()}
              >
                <Copy size={15} />
                Скопировать черновик
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {!canEdit ? (
        <p className="session-message" data-tone="warning">
          Изменение сейчас недоступно. Черновик остаётся в этом окне; его можно скопировать.
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {editableFields.map((field) => (
          <div className="session-field" key={field}>
            <label htmlFor={`${id}-${field}`}>{fieldLabels[field]}</label>
            {field === 'title' ? (
              <input
                id={`${id}-${field}`}
                className="session-input"
                value={draft[field]}
                required
                minLength={3}
                maxLength={500}
                disabled={disabled}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [field]: event.target.value }))
                }
              />
            ) : (
              <textarea
                id={`${id}-${field}`}
                className="session-input"
                value={draft[field]}
                rows={field === 'mechanism' ? 4 : 3}
                maxLength={12000}
                required={field === 'mechanism'}
                disabled={disabled}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [field]: event.target.value }))
                }
                aria-describedby={field === 'conditions' ? `${id}-conditions-hint` : undefined}
              />
            )}
            {field === 'conditions' ? (
              <p id={`${id}-conditions-hint`} className="session-hint">
                Каждое условие — с новой строки.
              </p>
            ) : null}
          </div>
        ))}
        <div className="session-field">
          <label htmlFor={`${id}-note`}>Комментарий автора</label>
          <textarea
            id={`${id}-note`}
            className="session-input"
            value={draft.note}
            rows={3}
            maxLength={4000}
            disabled={disabled}
            onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
            aria-describedby={`${id}-note-hint`}
          />
          <p id={`${id}-note-hint`} className="session-hint">
            Комментарий доступен всей группе. Точные цитаты и редакции документов сохраняются без
            изменений.
          </p>
        </div>
        {error ? (
          <p className="session-form-error" role="alert">
            {error}
          </p>
        ) : null}
        {copyMessage ? (
          <p className="session-hint session-form-footer" role="status">
            {copyMessage}
          </p>
        ) : null}
        <div className="session-action-row">
          <button
            className="button button-primary"
            type="submit"
            disabled={
              disabled || !canEdit || draft.title.trim().length < 3 || !draft.mechanism.trim()
            }
          >
            <Save size={16} />
            Сохранить изменения
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={disabled}
            onClick={() => (dirty ? setConfirmDiscard('close') : onClose())}
          >
            Отмена
          </button>
          {!canEdit ? (
            <button className="button button-quiet" type="button" onClick={() => void copyDraft()}>
              <Copy size={15} />
              Скопировать черновик
            </button>
          ) : null}
        </div>
        {confirmDiscard ? (
          <div className="session-message session-form-footer" data-tone="warning" role="alert">
            <div>
              <p>
                {confirmDiscard === 'reload'
                  ? 'Загрузка версии с доски заменит введённый здесь текст.'
                  : 'Введённые здесь изменения ещё не опубликованы.'}
              </p>
              <div className="session-action-row">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={disabled}
                  onClick={() => (confirmDiscard === 'reload' ? reload() : onClose())}
                >
                  {confirmDiscard === 'reload' ? 'Заменить черновик' : 'Закрыть без сохранения'}
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={disabled}
                  onClick={() => setConfirmDiscard(null)}
                >
                  Вернуться к черновику
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
