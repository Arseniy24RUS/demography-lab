import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useFlipchart } from '@/hooks/useFlipchart';
import type { SessionApi } from '@/lib/session-api';
import type { BarrierCard, BarriersSnapshot } from '../../../../../packages/barriers/types';
import type { SessionSummary } from '../../../../../packages/collaboration/types';
import type { BarrierActions } from './barriers-ui';
import { barrierInput } from './barriers-ui';
import { Busy, canEditCard, TaskMessage } from './common';
import { LifecycleStageTrack } from './LifecycleStageTrack';
import { LifecycleBarrierEditor } from './LifecycleBarrierEditor';
import type { BarrierDraft } from './LifecycleBarrierEditor';
import { isLifecycleStage, lifecycleStageLabels } from './lifecycle-stages';
import type { LifecycleStage } from './lifecycle-stages';
import './lifecycle-stage.css';

export function LifecycleBarrierStage({ api, session, userId, snapshot, actions, onImport, onRefresh, loading, error }: {
  api: SessionApi;
  session: SessionSummary;
  userId: string;
  snapshot: BarriersSnapshot | null;
  actions: Pick<BarrierActions, 'saveBarrier'>;
  onImport: (draft: Extract<BarrierDraft, { noteId: string }>) => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
  loading: boolean;
  error: string | null;
}) {
  const [selected, setSelected] = useState<LifecycleStage | null>(null);
  const [editor, setEditor] = useState<BarrierCard | 'new' | null>(null);
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
  const visible = selected ? cards.filter(card => card.stageIds.some(stage => stage === selected)) : cards;
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
  }

  return <section className="lifecycle-stage" aria-label="Барьеры по этапам жизни">
    <TaskMessage error={editor ? null : error} />
    <LifecycleStageTrack counts={counts} selected={selected}
      onSelect={stage => setSelected(value => value === stage ? null : stage)} />
    {snapshot ? <>
      <div className="lifecycle-barrier-tools">
        <h2>{selected ? lifecycleStageLabels[selected] : 'Все барьеры'}</h2>
        <div className="lifecycle-card-stages">
          {selected ? <button className="button button-quiet" onClick={() => setSelected(null)}>Все барьеры</button> : null}
          {editable ? <button className="button button-primary" onClick={() => setEditor('new')}>
            <Plus size={17} aria-hidden="true" />Добавить барьер
          </button> : null}
        </div>
      </div>
      {visible.length ? <div className="lifecycle-barrier-cards">
        {visible.map(card => {
          const stages = card.stageIds.filter(isLifecycleStage);
          return <article className="lifecycle-barrier-card" key={card.id} aria-label={card.title}>
            <h3>{card.title}</h3>
            {card.description ? <p>{card.description}</p> : null}
            <div className="lifecycle-card-stages">
              {stages.length ? stages.map(stage => <span className="lifecycle-stage-chip" key={stage}>
                {lifecycleStageLabels[stage]}
              </span>) : <span className="lifecycle-stage-chip">Этап не уточнён</span>}
            </div>
            {canEditCard(card, userId, isHost, editable) ? <button type="button" className="button button-quiet small"
              onClick={() => setEditor(card)}>{stages.length ? 'Изменить этапы' : 'Уточнить этап'}</button> : null}
          </article>;
        })}
      </div> : <p className="barrier-muted">{selected ? 'На этом этапе пока нет барьеров.' : 'Барьеры пока не добавлены.'}</p>}
    </> : loading || !error ? <Busy>Загружаем барьеры…</Busy> : <button className="button button-secondary"
      onClick={() => void onRefresh()}>Обновить барьеры</button>}
    {editor ? <LifecycleBarrierEditor
      card={editor === 'new' ? undefined : editor} initialStage={selected} subjective={subjective} objective={objective}
      onClose={() => setEditor(null)} onSave={save} /> : null}
  </section>;
}
