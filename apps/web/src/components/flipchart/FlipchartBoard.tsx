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

const noPending = new Set<string>();
const kinds: readonly { kind: FlipchartKind; question: string; label: string }[] = [
  { kind: 'barrier', question: 'Что мешает?', label: 'Мешает' },
  { kind: 'condition', question: 'Что помогло бы?', label: 'Помогло бы' },
];
const signed = (value: number) => value > 0 ? `+${value}` : String(value);
const noteWord = (value: number) => value % 10 === 1 && value % 100 !== 11 ? 'тезис'
  : value % 10 >= 2 && value % 10 <= 4 && !(value % 100 >= 12 && value % 100 <= 14) ? 'тезиса' : 'тезисов';

export interface FlipchartBoardProps {
  notes: readonly FlipchartNote[];
  onAdd(kind: FlipchartKind, text: string): Promise<boolean>;
  onVote(note: FlipchartNote, value: FlipchartVote): Promise<void>;
  onWithdraw(note: FlipchartNote): Promise<void>;
  pendingIds?: ReadonlySet<string>;
  submitting?: boolean;
  loading?: boolean;
  error?: string | null;
}

export interface FlipchartProjectorProps {
  notes: readonly FlipchartPublicNote[];
  loading?: boolean;
  error?: string | null;
}

/** Full phrases remain intact: agreement is a vote on one thesis, not a word frequency. */
export function FlipchartBoard({
  notes, onAdd, onVote, onWithdraw, pendingIds = noPending, submitting = false,
  loading = false, error = null,
}: FlipchartBoardProps) {
  return (
    <section className="flipchart" aria-label="Общий флипчарт">
      <FlipchartComposer onAdd={onAdd} submitting={submitting} />
      {error ? <p className="flipchart-error" role="alert">{error}</p> : null}
      <FlipchartSurface notes={notes} loading={loading} pendingIds={pendingIds}
        onVote={onVote} onWithdraw={onWithdraw} />
    </section>
  );
}

export function FlipchartProjector({ notes, loading = false, error = null }: FlipchartProjectorProps) {
  return (
    <section className="flipchart flipchart-projector" aria-label="Флипчарт на проекторе">
      {error ? <p className="flipchart-error" role="alert">{error}</p> : null}
      <FlipchartSurface notes={notes} loading={loading} projector />
    </section>
  );
}

function FlipchartComposer({ onAdd, submitting }: Pick<FlipchartBoardProps, 'onAdd'> & { submitting: boolean }) {
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
  pendingIds?: ReadonlySet<string>;
  onVote?: FlipchartBoardProps['onVote'];
  onWithdraw?: FlipchartBoardProps['onWithdraw'];
}

function FlipchartSurface({ notes, loading, projector = false, pendingIds = noPending, onVote, onWithdraw }: SurfaceProps) {
  const [filter, setFilter] = useState<'all' | FlipchartKind>('all');
  const [view, setView] = useState<'cloud' | 'ranking'>('cloud');
  const arrivals = useArrivals(notes, loading);
  const active = useMemo(() => notes.filter(note => note.status === 'active'), [notes]);
  const counts = useMemo(() => ({
    barrier: active.filter(note => note.kind === 'barrier').length,
    condition: active.filter(note => note.kind === 'condition').length,
  }), [active]);
  const visible = useMemo(() => active.filter(note => filter === 'all' || note.kind === filter).sort(
    view === 'ranking'
      ? (a, b) => b.score - a.score || b.support - a.support || a.oppose - b.oppose
        || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      : (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  ), [active, filter, view]);
  const maximum = useMemo(() => Math.max(1, ...active.map(note => note.support + note.oppose)), [active]);
  return (
    <div className="flipchart-surface">
      <header className="flipchart-toolbar">
        <div className="flipchart-filters" role="group" aria-label="Тезисы по теме">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            Все<span>{active.length}</span>
          </button>
          {kinds.map(item => <button key={item.kind} type="button" data-kind={item.kind}
            aria-pressed={filter === item.kind} onClick={() => setFilter(item.kind)}>
            <span className="flipchart-kind-dot" aria-hidden="true" />{item.label}<span>{counts[item.kind]}</span>
          </button>)}
        </div>
        <div className="flipchart-view-switch" role="group" aria-label="Вид флипчарта">
          <button type="button" aria-pressed={view === 'cloud'} onClick={() => setView('cloud')}>
            <Cloud size={18} aria-hidden="true" />Облако
          </button>
          <button type="button" aria-pressed={view === 'ranking'} onClick={() => setView('ranking')}>
            <BarChart3 size={18} aria-hidden="true" />Рейтинг
          </button>
        </div>
      </header>
      <div className="flipchart-canvas" data-view={view} aria-busy={loading || undefined}>
        {loading && !active.length ? <div className="flipchart-empty" role="status">
          <LoaderCircle className="flipchart-spinner" size={28} aria-hidden="true" /><p>Загружаем доску…</p>
        </div> : !visible.length ? <div className="flipchart-empty">
          <div className="flipchart-empty-shapes" aria-hidden="true"><span /><span /><Plus size={30} /></div>
          <p>{active.length ? 'В этой теме пока нет тезисов' : 'Пока нет тезисов'}</p>
        </div> : <div className="flipchart-notes" data-view={view}>
          {visible.map((note, index) => <FlipchartCard key={note.id} note={note} projector={projector}
            ranking={view === 'ranking'} rank={index + 1} maximum={maximum}
            arrival={arrivals.has(note.id)} pending={pendingIds.has(note.id)}
            onVote={onVote} onWithdraw={onWithdraw} />)}
        </div>}
      </div>
      <span className="flipchart-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {arrivals.size ? `Новые тезисы: ${arrivals.size}.` : `${active.length} ${noteWord(active.length)} на доске.`}
      </span>
    </div>
  );
}

function FlipchartCard({ note, ranking, rank, maximum, projector, arrival, pending, onVote, onWithdraw }: {
  note: FlipchartPublicNote; ranking: boolean; rank: number; maximum: number;
  projector: boolean; arrival: boolean; pending: boolean;
  onVote?: FlipchartBoardProps['onVote']; onWithdraw?: FlipchartBoardProps['onWithdraw'];
}) {
  const own = !projector && 'myVote' in note ? note as FlipchartNote : null;
  const category = kinds.find(item => item.kind === note.kind)!;
  const width = note.text.length < 45 ? 'compact' : note.text.length < 110 ? 'medium' : 'wide';
  const voted = note.support + note.oppose;
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
      data-popular={note.score > 0 || undefined} aria-label={note.text} data-note-id={note.id}>
      {ranking ? <span className="flipchart-rank" aria-label={`Место ${rank}`}>{rank}</span> : null}
      <div className="flipchart-note-body">
        <header className="flipchart-note-heading">
          <span className="flipchart-note-kind"><span className="flipchart-kind-dot" aria-hidden="true" />{category.label}</span>
          {own?.canWithdraw && onWithdraw ? <button type="button" className="flipchart-remove" disabled={busy}
            aria-label={`Убрать стикер: ${note.text}`} title="Убрать стикер"
            onClick={() => void act(() => onWithdraw(own))}><X size={17} aria-hidden="true" /></button> : null}
        </header>
        <p className="flipchart-note-text">{note.text}</p>
        <footer className="flipchart-note-footer">
          <div className="flipchart-votes" aria-label="Оценки тезиса">
            {own && onVote ? <>
              <button type="button" className="flipchart-vote" data-direction="support"
                aria-label={`Поддержать: ${note.text}`} aria-pressed={own.myVote === 1} disabled={busy}
                onClick={() => void act(() => onVote(own, own.myVote === 1 ? null : 1))}>
                <ThumbsUp size={18} aria-hidden="true" /><span>{note.support}</span>
              </button>
              <button type="button" className="flipchart-vote" data-direction="oppose"
                aria-label={`Не поддержать: ${note.text}`} aria-pressed={own.myVote === -1} disabled={busy}
                onClick={() => void act(() => onVote(own, own.myVote === -1 ? null : -1))}>
                <ThumbsDown size={18} aria-hidden="true" /><span>{note.oppose}</span>
              </button>
            </> : <>
              <span className="flipchart-vote-total" data-direction="support" aria-label={`За: ${note.support}`}>
                <ThumbsUp size={21} aria-hidden="true" />{note.support}
              </span>
              <span className="flipchart-vote-total" data-direction="oppose" aria-label={`Против: ${note.oppose}`}>
                <ThumbsDown size={21} aria-hidden="true" />{note.oppose}
              </span>
            </>}
          </div>
          {ranking ? <span className="flipchart-score" data-positive={note.score > 0 || undefined}
            data-negative={note.score < 0 || undefined} aria-label={`Баланс: ${signed(note.score)}`}>
            {signed(note.score)}
          </span> : null}
        </footer>
        {ranking ? <div className="flipchart-vote-bars" aria-hidden="true"
          style={{ '--flipchart-total': `${100 * voted / maximum}%` } as CSSProperties}>
          <span className="flipchart-vote-bar-track">
            <span data-direction="support" style={{ flexGrow: note.support }} />
            <span data-direction="oppose" style={{ flexGrow: note.oppose }} />
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
