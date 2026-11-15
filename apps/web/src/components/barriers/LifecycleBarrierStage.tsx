import { useMemo, useState } from 'react';
import { Pencil, Plus, Search, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useFlipchart } from '@/hooks/useFlipchart';
import type { SessionApi } from '@/lib/session-api';
import { noteTone } from '@/lib/workshop-note';
import type { BarrierCard, BarriersSnapshot } from '../../../../../packages/barriers/types';
import type { SessionSummary } from '../../../../../packages/collaboration/types';
import type { BarrierActions } from './barriers-ui';
import { barrierInput } from './barriers-ui';
import { Busy, canEditCard, TaskMessage, useBarrierTask } from './common';
import { LifecycleStageTrack } from './LifecycleStageTrack';
import { LifecycleBarrierEditor } from './LifecycleBarrierEditor';
import type { BarrierDraft } from './LifecycleBarrierEditor';
import { isLifecycleStage, lifecycleStageLabels } from './lifecycle-stages';
import type { LifecycleStage } from './lifecycle-stages';
import './lifecycle-stage.css';
import '../../workshop-notes.css';

export function LifecycleBarrierStage({ api, session, userId, snapshot, actions, onImport, onRefresh, loading, error }: {
  api: SessionApi;
  session: SessionSummary;
  userId: string;
  snapshot: BarriersSnapshot | null;
  actions: Pick<BarrierActions, 'saveBarrier' | 'vote'>;
  onImport: (draft: Extract<BarrierDraft, { noteId: string }>) => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
  loading: boolean;
  error: string | null;
}) {
  const [selected, setSelected] = useState<LifecycleStage | null>(null);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<BarrierCard | 'new' | null>(null);
  const voteTask = useBarrierTask();
  const flipchartOptions = { api, sessionId: session.id, userId, enabled: editor === 'new' };
  const subjective = useFlipchart(flipchartOptions);
  const objective = useFlipchart({ ...flipchartOptions, board: 'objective' });
  const cards = useMemo(() => snapshot?.barriers.filter(card => card.status === 'active') ?? [], [snapshot]);
  const counts = useMemo(() => {
    const result = new Map<LifecycleStage, number>();
    for (const card of cards) {
      for (const stage of card.stageIds) {
        if (isLifecycleStage(stage)) result.set(stage, (result.get(stage) ?? 0) + 1);
      }
    }
    return result;
  }, [cards]);
  const scoped = selected ? cards.filter(card => card.stageIds.some(stage => stage === selected)) : cards;
  const needle = query.trim().toLocaleLowerCase('ru');
  const visible = needle ? scoped.filter(card => `${card.title} ${card.description}`.toLocaleLowerCase('ru').includes(needle)) : scoped;
  const editable = session.status === 'open' && session.role !== 'observer';
  const isHost = session.role === 'host';

  async function save(draft: BarrierDraft) {
    const primary = draft.stageIds[0];
    if (!primary) throw new Error('Выберите хотя бы один этап.');
    if (draft.source === 'subjective' || draft.source === 'objective') {
      await onImport(draft);
    } else if (draft.source === 'existing' && editor && editor !== 'new') {
      const previousPrimary = editor.primaryStage;
      await actions.saveBarrier({
        ...barrierInput(editor),
        primaryStage: isLifecycleStage(previousPrimary) && draft.stageIds.includes(previousPrimary) ? previousPrimary : primary,
        stageIds: draft.stageIds,
      });
    } else if (draft.source === 'own') {
      await actions.saveBarrier({
        barrierId: null,
        expectedRevision: 0,
        title: draft.text,
        description: '',
        primaryStage: primary,
        stageIds: draft.stageIds,
        evidenceKind: 'observation',
        status: 'active',
        priority: false,
      });
    } else {
      throw new Error('Барьер недоступен. Обновите данные занятия.');
    }
    setSelected(stage => stage && !draft.stageIds.includes(stage) ? primary : stage);
    if (editor === 'new') setQuery('');
  }

  return <section className="lifecycle-stage" aria-label="Барьеры по этапам жизни">
    <TaskMessage error={editor ? null : error} />
    <header className="lifecycle-barrier-header">
      <div><h2>Барьеры</h2><p>Что мешает на этом этапе?</p></div>
      {snapshot && editable ? <button className="button button-primary" onClick={() => setEditor('new')}>
        <Plus size={18} aria-hidden="true" />Добавить барьер
      </button> : null}
    </header>
    <LifecycleStageTrack counts={counts} selected={selected}
      onSelect={stage => setSelected(value => value === stage ? null : stage)} />
    {snapshot ? <>
      <div className="lifecycle-barrier-tools">
        <h3>{selected ? lifecycleStageLabels[selected] : 'Все барьеры'}</h3>
        <div className="lifecycle-barrier-filters">
          <label className="workshop-note-search">
            <Search size={17} aria-hidden="true" />
            <input type="search" aria-label="Поиск по барьерам" placeholder="Поиск по барьерам" value={query}
              onChange={event => setQuery(event.target.value)} />
          </label>
          {selected ? <button className="button button-quiet" onClick={() => setSelected(null)}>Все барьеры</button> : null}
        </div>
      </div>
      <TaskMessage error={voteTask.error} />
      {visible.length ? <div className="lifecycle-barrier-cards">
        {visible.map(card => {
          const stages = card.stageIds.filter(isLifecycleStage);
          return <article className="workshop-note lifecycle-barrier-card" key={card.id} aria-label={card.title}
            data-note-tone={noteTone(card.id)}>
            <h4>{card.title}</h4>
            {card.description ? <p>{card.description}</p> : null}
            <div className="lifecycle-card-stages">
              {stages.length ? stages.map(stage => <span className="lifecycle-stage-chip" key={stage}>
                {lifecycleStageLabels[stage]}
              </span>) : <span className="lifecycle-stage-chip">Этап не уточнён</span>}
            </div>
            <div className="lifecycle-note-footer">
              <div className="lifecycle-note-votes" role="group" aria-label={`Значимость: ${card.title}`}>
                {([1, -1] as const).map(value => {
                  const VoteIcon = value === 1 ? ThumbsUp : ThumbsDown;
                  const count = value === 1 ? card.totals.support : card.totals.oppose;
                  return <button type="button" key={value} disabled={!editable || voteTask.working}
                    aria-label={`${value === 1 ? 'Значимый барьер' : 'Не приоритетен'}: ${count}`}
                    aria-pressed={card.myVote === value}
                    onClick={() => void voteTask.run(() => actions.vote({
                      barrierId: card.id, expectedRevision: card.myVoteRevision, value: card.myVote === value ? null : value,
                    }))}><VoteIcon size={16} aria-hidden="true" />{count}</button>;
                })}
              </div>
              {canEditCard(card, userId, isHost, editable) ? <button type="button" className="button button-quiet small"
                onClick={() => setEditor(card)}><Pencil size={14} aria-hidden="true" />
                {stages.length ? 'Изменить этапы' : 'Уточнить этап'}</button> : null}
            </div>
          </article>;
        })}
      </div> : <p className="lifecycle-note-empty">{needle ? 'По этому запросу барьеров нет.' : selected ? 'На этом этапе пока нет барьеров.' : 'Барьеры пока не добавлены.'}</p>}
    </> : loading || !error ? <Busy>Загружаем барьеры…</Busy> : <button className="button button-secondary"
      onClick={() => void onRefresh()}>Обновить барьеры</button>}
    {editor ? <LifecycleBarrierEditor
      card={editor === 'new' ? undefined : editor} initialStage={selected} subjective={subjective} objective={objective}
      onClose={() => setEditor(null)} onSave={save} /> : null}
  </section>;
}
