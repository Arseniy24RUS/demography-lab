import { useId, useState } from 'react';
import { GitBranch, Lightbulb, MessageSquareText, Route } from 'lucide-react';
import type { BarrierAreaProps, BarrierBoardContext } from './barriers-ui';
import { Busy, TaskMessage } from './common';
import { LifecycleBoard } from './LifecycleBoard';
import { ConnectionWorkbench } from './ConnectionWorkbench';
import { SolutionWorkbench } from './SolutionWorkbench';
import { SurveyHostView } from './SurveyHostView';
import '../../barriers.css';

type BarrierTab = 'path' | 'links' | 'solutions' | 'survey';
const tabs = [
  { id: 'path', label: 'Путь родительства', icon: Route },
  { id: 'links', label: 'Связи с практиками', icon: GitBranch },
  { id: 'solutions', label: 'Авторские решения', icon: Lightbulb },
  { id: 'survey', label: 'Опрос', icon: MessageSquareText },
] as const;
export function BarrierArea(props: BarrierAreaProps) {
  const [tab, setTab] = useState<BarrierTab>('path');
  const [focusBarrier, setFocusBarrier] = useState<string | null>(null);
  const id = useId();
  const isHost = props.session.role === 'host';
  const available = tabs.filter((item) => item.id !== 'survey' || isHost);
  const selected = available.some((item) => item.id === tab) ? tab : 'path';
  const context: BarrierBoardContext | null = props.snapshot
    ? {
        ...props,
        snapshot: props.snapshot,
        isHost,
        editable: props.session.status === 'open' && props.session.role !== 'observer',
      }
    : null;
  return (
    <div className="barrier-area">
      <div className="barrier-navigation" role="tablist" aria-label="Разделы барьеров и решений">
        {available.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${id}-${item.id}`}
            aria-selected={selected === item.id}
            aria-controls={`${id}-panel`}
            tabIndex={selected === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? available.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) %
                      available.length;
              setTab(available[next].id);
              document.getElementById(`${id}-${available[next].id}`)?.focus();
            }}
          >
            <item.icon size={17} />
            {item.label}
          </button>
        ))}
      </div>
      <TaskMessage error={props.error} />
      {props.loading && !context ? <Busy>Загружаем совместную доску…</Busy> : null}
      {!context && !props.loading ? (
        <div className="barrier-empty">
          <h3>Доска пока недоступна</h3>
          <p>Попробуйте обновить данные занятия.</p>
          {props.onRefresh ? (
            <button className="button button-secondary" onClick={() => void props.onRefresh?.()}>
              Обновить доску
            </button>
          ) : null}
        </div>
      ) : null}
      {context ? (
        <div
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-${selected}`}
          className="barrier-panel"
        >
          {!context.editable ? (
            <p className="barrier-readonly">
              {props.session.role === 'observer'
                ? 'Режим наблюдателя: доступно чтение карточек, связей и оснований.'
                : props.session.status === 'paused'
                  ? 'Занятие приостановлено. Доска доступна для просмотра.'
                  : 'Занятие завершено. Сохранённые результаты доступны для просмотра.'}
            </p>
          ) : null}
          {selected === 'path' ? (
            <LifecycleBoard
              context={context}
              onConnections={(barrierId) => {
                setFocusBarrier(barrierId);
                setTab('links');
              }}
            />
          ) : selected === 'links' ? (
            <ConnectionWorkbench context={context} initialBarrierId={focusBarrier} />
          ) : selected === 'solutions' ? (
            <SolutionWorkbench context={context} />
          ) : (
            <SurveyHostView key={context.snapshot.survey?.id ?? 'none'} context={context} />
          )}
        </div>
      ) : null}
    </div>
  );
}
