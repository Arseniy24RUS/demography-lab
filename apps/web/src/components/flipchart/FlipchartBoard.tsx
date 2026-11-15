import {
  useEffect, useId, useMemo, useRef, useState,
  type CSSProperties, type FormEvent, type KeyboardEvent,
} from 'react';
import { BarChart3, Cloud, LoaderCircle, Plus, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import {
  FLIPCHART_MAX_TEXT_LENGTH, normalizeFlipchartText,
  type FlipchartKind, type FlipchartNote, type FlipchartPublicNote, type FlipchartVote,
} from '../../../../../packages/flipchart/types';
import './flipchart.css';
import { SubjectiveTagCloud } from './SubjectiveTagCloud';

const noPending = new Set<string>();
const kinds: readonly { kind: FlipchartKind; question: string; label: string }[] = [
  { kind: 'barrier', question: 'Что мешает?', label: 'Мешает' },
  { kind: 'condition', question: 'Что помогло бы?', label: 'Помогло бы' },
];
const signed = (value: number) => value > 0 ? `+${value}` : String(value);
const noteWord = (value: number) => value % 10 === 1 && value % 100 !== 11 ? 'тезис'
  : value % 10 >= 2 && value % 10 <= 4 && !(value % 100 >= 12 && value % 100 <= 14) ? 'тезиса' : 'тезисов';

type AddNote = (kind: FlipchartKind, text: string) => Promise<boolean>;

export type FlipchartBoardProps = {
  notes: readonly FlipchartNote[];
  onVote(note: FlipchartNote, value: FlipchartVote): Promise<void>;
  onWithdraw(note: FlipchartNote): Promise<void>;
  pendingIds?: ReadonlySet<string>;
  submitting?: boolean;
  loading?: boolean;
  error?: string | null;
} & ({ objective?: boolean; onAdd: AddNote } | { objective: true; onAdd?: never });

export interface FlipchartProjectorProps {
  notes: readonly FlipchartPublicNote[];
  loading?: boolean;
  error?: string | null;
  objective?: boolean;
}

/** Full phrases remain intact: agreement is a vote on one thesis, not a word frequency. */
export function FlipchartBoard({
  notes, onAdd, onVote, onWithdraw, pendingIds = noPending, submitting = false,
  loading = false, error = null, objective = false,
}: FlipchartBoardProps) {
  return (
    <section className="flipchart" aria-label={objective ? 'Объективные факторы' : 'Общий флипчарт'}>
      {!objective && onAdd ? <FlipchartComposer onAdd={onAdd} submitting={submitting} /> : null}
      {error ? <p className="flipchart-error" role="alert">{error}</p> : null}
      <FlipchartSurface notes={notes} loading={loading} pendingIds={pendingIds} objective={objective}
        onVote={onVote} onWithdraw={onWithdraw} />
    </section>
  );
}

export function FlipchartProjector({ notes, loading = false, error = null, objective = false }: FlipchartProjectorProps) {
  return (
    <section className="flipchart flipchart-projector" aria-label={objective ? 'Объективные факторы на проекторе' : 'Флипчарт на проекторе'}>
      {error ? <p className="flipchart-error" role="alert">{error}</p> : null}
      <FlipchartSurface notes={notes} loading={loading} objective={objective} projector />
    </section>
  );
}

function FlipchartComposer({ onAdd, submitting }: { onAdd: AddNote; submitting: boolean }) {
  const id = useId();
  const [kind, setKind] = useState<FlipchartKind>('barrier');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const locked = useRef(false);
  const normalized = normalizeFlipchartText(text);
  const length = Array.from(normalized).length;
  const tooLong = length > FLIPCHART_MAX_TEXT_LENGTH;
  const busy = submitting || sending;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (locked.current || busy || !normalized || tooLong) return;
    locked.current = true;
    setSending(true);
    setLocalError(null);
    const submitted = text;
    try {
      if (await onAdd(kind, normalized)) {
        // A slow connection must not erase a second thesis already being typed.
        setText(current => current === submitted ? '' : current);
        input.current?.focus();
      }
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Не удалось добавить тезис.');
    } finally {
      locked.current = false;
      setSending(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form className="flipchart-composer" data-kind={kind} onSubmit={submit} aria-label="Новый тезис">
      <div className="flipchart-composer-top">
        <div className="flipchart-question-switch" role="group" aria-label="Тип тезиса">
          {kinds.map(item => <button key={item.kind} type="button" data-kind={item.kind}
            aria-pressed={kind === item.kind} onClick={() => { setKind(item.kind); input.current?.focus(); }}>
            <span className="flipchart-kind-dot" aria-hidden="true" />{item.question}
          </button>)}
        </div>
      </div>
      <div className="flipchart-compose-input">
        <textarea ref={input} id={`${id}-text`} aria-label="Короткий тезис" rows={2}
          placeholder="Короткий тезис…"
          value={text} onChange={event => setText(event.currentTarget.value)} onKeyDown={keyDown}
          aria-invalid={tooLong || undefined} aria-describedby={tooLong ? `${id}-limit` : undefined}
          enterKeyHint="send" spellCheck />
        <button type="submit" className="flipchart-add" disabled={busy || !normalized || tooLong}
          aria-label="Добавить">
          {busy ? <LoaderCircle className="flipchart-spinner" size={20} aria-hidden="true" /> : <Plus size={21} aria-hidden="true" />}
          <span>Добавить</span>
        </button>
      </div>
      {length > FLIPCHART_MAX_TEXT_LENGTH - 30 ? <span id={`${id}-limit`}
        className="flipchart-text-limit" data-invalid={tooLong || undefined} role={tooLong ? 'status' : undefined}>
        {length} / {FLIPCHART_MAX_TEXT_LENGTH}
      </span> : null}
      {localError ? <p className="flipchart-error" role="alert">{localError}</p> : null}
    </form>
  );
}

interface SurfaceProps {
  notes: readonly FlipchartPublicNote[];
  loading: boolean;
  projector?: boolean;
  objective?: boolean;
  pendingIds?: ReadonlySet<string>;
  onVote?: FlipchartBoardProps['onVote'];
  onWithdraw?: FlipchartBoardProps['onWithdraw'];
}

function FlipchartSurface({ notes, loading, projector = false, objective = false, pendingIds = noPending, onVote, onWithdraw }: SurfaceProps) {
  const [filter, setFilter] = useState<'all' | FlipchartKind>('all');
  const [view, setView] = useState<'cloud' | 'ranking'>('cloud');
  const arrivals = useArrivals(notes, loading);
  const active = useMemo(() => notes.filter(note => note.status === 'active'), [notes]);
  const counts = useMemo(() => ({
    barrier: active.filter(note => note.kind === 'barrier').length,
    condition: active.filter(note => note.kind === 'condition').length,
  }), [active]);
  const visible = useMemo(() => active.filter(note => objective || filter === 'all' || note.kind === filter).sort(
    (a, b) => {
      if (view !== 'ranking') return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
      const difference = objective
        ? b.support - a.support
        : b.score - a.score || b.support - a.support || a.oppose - b.oppose;
      return difference || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    },
  ), [active, filter, objective, view]);
  const maximum = useMemo(() => Math.max(1, ...active.map(note => objective ? note.support : note.support + note.oppose)), [active, objective]);
  let rank = 0;
  return (
    <div className="flipchart-surface">
      <header className="flipchart-toolbar">
        {!objective ? <div className="flipchart-filters" role="group" aria-label="Тезисы по теме">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            Все<span>{active.length}</span>
          </button>
          {kinds.map(item => <button key={item.kind} type="button" data-kind={item.kind}
            aria-pressed={filter === item.kind} onClick={() => setFilter(item.kind)}>
            <span className="flipchart-kind-dot" aria-hidden="true" />{item.label}<span>{counts[item.kind]}</span>
          </button>)}
        </div> : null}
        <div className="flipchart-view-switch" role="group" aria-label="Вид флипчарта">
          <button type="button" aria-pressed={view === 'cloud'} onClick={() => setView('cloud')}>
            <Cloud size={18} aria-hidden="true" />Облако
          </button>
          <button type="button" aria-pressed={view === 'ranking'} onClick={() => setView('ranking')}>
            <BarChart3 size={18} aria-hidden="true" />Рейтинг
          </button>
        </div>
      </header>
      {!objective && !projector && view === 'cloud' ? <SubjectiveTagCloud /> : null}
      <div className="flipchart-canvas" data-view={view} aria-busy={loading || undefined}>
        {loading && !active.length ? <div className="flipchart-empty" role="status">
          <LoaderCircle className="flipchart-spinner" size={28} aria-hidden="true" /><p>Загружаем доску…</p>
        </div> : !visible.length ? <div className="flipchart-empty">
          <div className="flipchart-empty-shapes" aria-hidden="true"><span /><span /><Plus size={30} /></div>
          <p>{objective ? 'Пока нет факторов' : active.length ? 'В этой теме пока нет тезисов' : 'Пока нет тезисов'}</p>
        </div> : <div className="flipchart-notes" data-view={view}>
          {visible.map((note, index) => {
            if (!objective || visible[index - 1]?.support !== note.support) rank = index + 1;
            return <FlipchartCard key={note.id} note={note} projector={projector} objective={objective}
              ranking={view === 'ranking'} rank={rank} maximum={maximum}
              arrival={arrivals.has(note.id)} pending={pendingIds.has(note.id)}
              onVote={onVote} onWithdraw={onWithdraw} />;
          })}
        </div>}
      </div>
      <span className="flipchart-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {objective
          ? (arrivals.size ? `Новые факторы: ${arrivals.size}.` : `Факторов на доске: ${active.length}.`)
          : (arrivals.size ? `Новые тезисы: ${arrivals.size}.` : `${active.length} ${noteWord(active.length)} на доске.`)}
      </span>
    </div>
  );
}

function FlipchartCard({ note, ranking, rank, maximum, projector, objective, arrival, pending, onVote, onWithdraw }: {
  note: FlipchartPublicNote; ranking: boolean; rank: number; maximum: number;
  projector: boolean; objective: boolean; arrival: boolean; pending: boolean;
  onVote?: FlipchartBoardProps['onVote']; onWithdraw?: FlipchartBoardProps['onWithdraw'];
}) {
  const own = !projector && 'myVote' in note ? note as FlipchartNote : null;
  const category = kinds.find(item => item.kind === note.kind)!;
  const removeLabel = objective ? 'Убрать фактор' : 'Убрать стикер';
  const width = note.text.length < 45 ? 'compact' : note.text.length < 110 ? 'medium' : 'wide';
  const voted = objective ? note.support : note.support + note.oppose;
  const objectiveCount = note.territoryCount ?? 1;
  const neutral = objective && note.territoryCount !== undefined && note.factorKey?.endsWith('-z');
  const correlationLabel = note.territoryCount === undefined ? 'Фактор' : neutral ? 'Нулевая связь'
    : note.kind === 'barrier' ? 'Отрицательная связь' : 'Положительная связь';
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [working, setWorking] = useState(false);
  const busy = pending || working;

  async function act(action: () => Promise<void>) {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setWorking(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить изменение.'); }
    finally { inFlight.current = false; setWorking(false); }
  }

  return (
    <article className="flipchart-note" data-kind={note.kind} data-width={width} data-new={arrival || undefined}
      data-neutral={neutral || undefined} data-popular={(objective ? note.support : note.score) > 0 || undefined}
      aria-label={note.text} data-note-id={note.id}>
      {ranking ? <span className="flipchart-rank" aria-label={`Место ${rank}`}>{rank}</span> : null}
      <div className="flipchart-note-body">
        <header className="flipchart-note-heading">
          <span className="flipchart-note-kind"><span className="flipchart-kind-dot" aria-hidden="true" />{objective ? correlationLabel : category.label}</span>
          {own?.canWithdraw && onWithdraw ? <button type="button" className="flipchart-remove" disabled={busy}
            aria-label={`${removeLabel}: ${note.text}`} title={removeLabel}
            onClick={() => void act(() => onWithdraw(own))}><X size={17} aria-hidden="true" /></button> : null}
        </header>
        <p className="flipchart-note-text">{note.text}</p>
        <footer className="flipchart-note-footer">
          <div className="flipchart-votes" aria-label={objective ? 'Оценки фактора' : 'Оценки тезиса'}>
            {own && onVote ?
              <button type="button" className="flipchart-vote" data-direction="support"
                aria-label={`Поддержать: ${note.text}`} aria-pressed={own.myVote === 1} disabled={busy}
                onClick={() => void act(() => onVote(own, own.myVote === 1 ? null : 1))}>
                <ThumbsUp size={18} aria-hidden="true" /><span>{note.support}</span>
              </button> : <span className="flipchart-vote-total" data-direction="support" aria-label={`За: ${note.support}`}>
                <ThumbsUp size={21} aria-hidden="true" />{note.support}
              </span>}
            {objective ? <span className="flipchart-territory-count" role="img"
              aria-label={`Территорий: ${objectiveCount}`} title={`Территорий: ${objectiveCount}`}>{objectiveCount}</span> : null}
            {own && onVote ?
              <button type="button" className="flipchart-vote" data-direction="oppose"
                aria-label={`Не поддержать: ${note.text}`} aria-pressed={own.myVote === -1} disabled={busy}
                onClick={() => void act(() => onVote(own, own.myVote === -1 ? null : -1))}>
                <ThumbsDown size={18} aria-hidden="true" /><span>{note.oppose}</span>
              </button> : <span className="flipchart-vote-total" data-direction="oppose" aria-label={`Против: ${note.oppose}`}>
                <ThumbsDown size={21} aria-hidden="true" />{note.oppose}
              </span>}
          </div>
          {ranking && !objective ? <span className="flipchart-score" data-positive={note.score > 0 || undefined}
            data-negative={note.score < 0 || undefined} aria-label={`Баланс: ${signed(note.score)}`}>
            {signed(note.score)}
          </span> : null}
        </footer>
        {ranking ? <div className="flipchart-vote-bars" aria-hidden="true"
          style={{ '--flipchart-total': `${100 * voted / maximum}%` } as CSSProperties}>
          <span className="flipchart-vote-bar-track">
            <span data-direction="support" style={{ flexGrow: note.support }} />
            {!objective ? <span data-direction="oppose" style={{ flexGrow: note.oppose }} /> : null}
          </span>
        </div> : null}
        {error ? <p className="flipchart-error" role="alert">{error}</p> : null}
      </div>
    </article>
  );
}

/** Initial history stays still; only notes arriving after the first read animate. */
function useArrivals(notes: readonly FlipchartPublicNote[], loading: boolean) {
  const known = useRef<Set<string> | null>(null);
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(noPending);
  useEffect(() => {
    if (loading) return;
    const ids = new Set(notes.filter(note => note.status === 'active').map(note => note.id));
    if (known.current) {
      const fresh = [...ids].filter(id => !known.current!.has(id));
      if (fresh.length) setArrivals(previous => new Set([...previous, ...fresh]));
    }
    known.current = ids;
  }, [notes, loading]);
  useEffect(() => {
    if (!arrivals.size) return;
    const timer = setTimeout(() => setArrivals(noPending), 1400);
    return () => clearTimeout(timer);
  }, [arrivals]);
  return arrivals;
}
