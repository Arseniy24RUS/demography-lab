import { useDeferredValue, useId, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal } from '@/components/Modal';
import type { BarrierCard } from '../../../../../packages/barriers/types';
import type { FlipchartPublicNote } from '../../../../../packages/flipchart/types';
import { Busy, TaskMessage, useBarrierTask } from './common';
import { isLifecycleStage, lifecycleStageLabels, lifecycleStages } from './lifecycle-stages';
import type { LifecycleStage } from './lifecycle-stages';

type NoteBoard = 'subjective' | 'objective';
type DraftSource = 'own' | NoteBoard;
type Notes = { notes: readonly FlipchartPublicNote[]; loading: boolean; error: string | null };
export type BarrierDraft = { stageIds: LifecycleStage[] } & (
  | { source: 'existing'; text: string; description: string }
  | { source: 'own'; text: string }
  | { source: NoteBoard; noteId: string }
);

export function LifecycleBarrierEditor({ card, initialStage, subjective, objective, onClose, onSave, onRemove }: {
  card?: BarrierCard;
  initialStage: LifecycleStage | null;
  subjective: Notes;
  objective: Notes;
  onClose: () => void;
  onSave: (draft: BarrierDraft) => Promise<unknown>;
  onRemove?: () => Promise<unknown>;
}) {
  const formId = useId();
  const [source, setSource] = useState<DraftSource>('own');
  const [text, setText] = useState(card?.title ?? '');
  const [description, setDescription] = useState(card?.description ?? '');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [noteId, setNoteId] = useState('');
  const [query, setQuery] = useState('');
  const [stageIds, setStageIds] = useState<LifecycleStage[]>(() => card
    ? card.stageIds.filter(isLifecycleStage)
    : initialStage ? [initialStage] : []);
  const task = useBarrierTask();
  const needle = useDeferredValue(query).trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const notes = source === 'objective' ? objective : subjective;
  const available = useMemo(() => source === 'own' ? [] : notes.notes.filter(note =>
    note.status === 'active' && note.kind === 'barrier'), [notes.notes, source]);
  const matches = useMemo(() => available.filter(note =>
    note.text.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(needle)), [available, needle]);
  const selectedNote = available.find(note => note.id === noteId);
  const canManage = Boolean(onRemove);
  const minLength = card?.sourceNoteId ? 1 : 5;
  const hasStage = stageIds.length > 0 || Boolean(card?.stageIds.some(stage => !isLifecycleStage(stage)));
  const draft: BarrierDraft | null = card ? (text.trim().length >= minLength
    ? { source: 'existing', text: canManage ? text.trim() : card.title,
        description: canManage ? description.trim() : card.description, stageIds }
    : null)
    : source === 'own' ? (text.trim().length >= 5 ? { source, text: text.trim(), stageIds } : null)
    : selectedNote ? { source, noteId: selectedNote.id, stageIds } : null;
  const close = () => { if (!task.working) onClose(); };

  if (confirmRemove && card && onRemove) {
    return <Modal title="Удалить барьер?" onClose={close} actions={<>
      <button className="button button-secondary" onClick={() => setConfirmRemove(false)} disabled={task.working}>Отмена</button>
      <button className="button button-danger" onClick={() => void task.run(onRemove, onClose)} disabled={task.working}>
        {task.working ? 'Удаляем…' : 'Удалить'}
      </button>
    </>}>
      <p>{card.title}</p>
      <TaskMessage error={task.error} />
    </Modal>;
  }

  return <Modal title={card ? (canManage ? 'Изменить барьер' : 'Этапы барьера') : 'Добавить барьер'} onClose={close} wide actions={<>
    {onRemove ? <button className="button button-quiet" type="button" onClick={() => setConfirmRemove(true)} disabled={task.working}>
      <Trash2 size={16} aria-hidden="true" />Удалить барьер
    </button> : null}
    <button className="button button-secondary" onClick={close} disabled={task.working}>Отмена</button>
    <button className="button button-primary" type="submit" form={formId}
      disabled={task.working || !draft || !hasStage}>
      {task.working ? 'Сохраняем…' : 'Сохранить барьер'}
    </button>
  </>}>
    <form id={formId} className="lifecycle-barrier-editor" onSubmit={event => {
      event.preventDefault();
      if (draft && hasStage) void task.run(() => onSave(draft), onClose);
    }}>
      {card ? (canManage ? <>
        <label>Текст барьера
          <textarea className="input" rows={3} minLength={minLength} maxLength={240} required disabled={task.working} value={text}
            onChange={event => setText(event.target.value)} />
        </label>
        <label>Пояснение
          <textarea className="input" rows={3} maxLength={4000} disabled={task.working} value={description}
            onChange={event => setDescription(event.target.value)} />
        </label>
      </> : <p>{card.title}</p>) : <>
        <label>Источник барьера
          <select className="input" disabled={task.working} value={source} onChange={event => {
            setSource(event.target.value as DraftSource);
            setNoteId('');
            setQuery('');
          }}>
            <option value="own">Свой барьер</option>
            <option value="subjective">Субъективные факторы</option>
            <option value="objective">Объективные факторы</option>
          </select>
        </label>
        {source === 'own' ? <label>Текст барьера
          <textarea className="input" rows={3} minLength={5} maxLength={240} required disabled={task.working} value={text}
            onChange={event => setText(event.target.value)} />
        </label> : <fieldset disabled={task.working}>
          <legend>Факторы</legend>
          <input className="input" type="search" aria-label="Поиск фактора" placeholder="Найти фактор"
            value={query} onChange={event => setQuery(event.target.value)} />
          {notes.loading ? <Busy>Загружаем факторы…</Busy> : null}
          <TaskMessage error={notes.error} />
          {!notes.loading && !notes.error && !matches.length ? <p className="barrier-muted">Факторы не найдены.</p> : null}
          {matches.length ? <div className="lifecycle-note-choices">
            {matches.map(note => <label key={note.id}>
              <input type="radio" name={`factor-${formId}`} checked={note.id === noteId}
                onChange={() => setNoteId(note.id)} />
              <span>{note.text}</span>
            </label>)}
          </div> : null}
        </fieldset>}
      </>}
      <fieldset disabled={task.working}>
        <legend>Этапы</legend>
        <div className="lifecycle-stage-choices">
          {lifecycleStages.map(stage => <label key={stage}>
            <input type="checkbox" checked={stageIds.includes(stage)} onChange={event => {
              const checked = event.target.checked;
              setStageIds(previous => checked
                ? lifecycleStages.filter(value => value === stage || previous.includes(value))
                : previous.filter(value => value !== stage));
            }} />
            <span>{lifecycleStageLabels[stage]}</span>
          </label>)}
        </div>
      </fieldset>
      <TaskMessage error={task.error} />
    </form>
  </Modal>;
}
