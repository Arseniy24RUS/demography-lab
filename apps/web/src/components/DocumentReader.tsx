import { useEffect, useRef, useState } from 'react';
import { Search, ExternalLink, Link2, X, Bookmark, FileSearch } from 'lucide-react';
import { codePointLength } from '@domain/index';
import type { TextAnchor } from '@domain/index';
import { loadDocument } from '@/lib/corpus';
import type { CorpusDocument, CorpusEntry } from '@/lib/corpus';
import { useOriginalDocumentUrl } from '@/hooks/useOriginalDocumentUrl';
import { anchorForBlocks, captureDomSelection, anchorFromSelectionSnapshot } from '@/lib/selection';
import { openReader } from '@/lib/readerCorpus';
import type { ReaderUnit } from '@/lib/readerCorpus';

type Handle = Awaited<ReturnType<typeof openReader>>;
type Controller = InstanceType<Handle['controllerClass']>;
type SearchResult = {
  hits: { id: string; text: string; label?: string; locator?: string }[];
  total: number;
  page: number;
  pages: number;
};
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

// Presentation adapter only: the scrolling, loading and search algorithms are the
// unchanged RUDN modules. Canonical source text remains exactly inside its wrapper.
function markedText(text: string, spans: readonly { start: number; end: number }[], query: string) {
  const chars = Array.from(text),
    bounds = [...new Set([0, chars.length, ...spans.flatMap((s) => [s.start, s.end])])].sort(
      (a, b) => a - b,
    );
  const words = [...new Set(query.trim().split(/\s+/).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = words.length
    ? new RegExp(
        '(' +
          words
            .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/gi, '[её]'))
            .join('|') +
          ')',
        'giu',
      )
    : null;
  return bounds
    .slice(0, -1)
    .map((start, i) => {
      const end = bounds[i + 1],
        value = chars.slice(start, end).join('');
      const html = pattern
        ? value
            .split(pattern)
            .map((part, j) =>
              j % 2 ? `<mark class="text-highlight search">${escape(part)}</mark>` : escape(part),
            )
            .join('')
        : escape(value);
      return spans.some((s) => s.start < end && s.end > start)
        ? `<mark class="text-highlight focus">${html}</mark>`
        : html;
    })
    .join('');
}

export function DocumentReader(props: {
  entry: CorpusEntry;
  document?: CorpusDocument;
  loading: boolean;
  error?: string;
  selection: TextAnchor | null;
  onSelection: (anchor: TextAnchor | null) => void;
  onDocumentLoaded: (document: CorpusDocument) => void;
  onLink: () => void;
  onSaveNote: () => void;
  focusAnchor: TextAnchor | null;
  focusNonce: number;
  onDetails: () => void;
}) {
  const { entry, selection, focusAnchor, focusNonce, onDetails, onLink, onSaveNote } = props;
  const latest = useRef(props);
  latest.current = props;
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [pageDraft, setPageDraft] = useState('1');
  const [picked, setPicked] = useState<Set<string>>(new Set()),
    [showResults, setShowResults] = useState(true);
  const [result, setResult] = useState<SearchResult | null>(null),
    [pending, setPending] = useState(false);
  const [ready, setReady] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string>();
  const [emptyPage, setEmptyPage] = useState<number | null>(null);
  const readerRef = useRef<HTMLElement>(null),
    bodyRef = useRef<HTMLDivElement>(null),
    quoteOperation = useRef(0);
  const active = useRef<{ handle: Handle; controller: Controller } | null>(null),
    generation = useRef(0);
  const ui = useRef({ query, picked, selection, focusAnchor });
  ui.current = { query, picked, selection, focusAnchor };
  const original = useOriginalDocumentUrl(entry);

  function currentPage() {
    const value = active.current;
    if (!value) return;
    const id = value.controller.capture()?.anchor?.id;
    const unit = id ? value.handle.corpus.loadedUnits().get(id) : undefined;
    if (unit?.pageStart) {
      setPage(unit.pageStart);
      setPageDraft(String(unit.pageStart));
    }
  }
  function refresh() {
    const value = active.current;
    if (!value) return;
    const { selection, focusAnchor, picked, query } = ui.current;
    const focus =
      selection?.versionId === entry.versionId
        ? selection
        : focusAnchor?.versionId === entry.versionId
          ? focusAnchor
          : null;
    for (const element of bodyRef.current?.querySelectorAll<HTMLElement>('[data-unit]') ?? []) {
      const unit = value.handle.corpus.loadedUnits().get(element.dataset.unit!);
      if (!unit) continue;
      const chosen = picked.has(unit.id);
      element.classList.toggle('selected', chosen);
      element.setAttribute('aria-pressed', String(chosen));
      const button = element.querySelector<HTMLButtonElement>('.block-action');
      if (button) {
        button.setAttribute('aria-pressed', String(chosen));
        button.setAttribute(
          'aria-label',
          `${chosen ? 'Убрать' : 'Выбрать'} фрагмент ${unit.order + 1}`,
        );
        button.textContent = chosen ? '✓ Выбран' : '+ Выбрать фрагмент';
      }
      const target = element.querySelector<HTMLElement>('[data-source-text]');
      if (target)
        target.innerHTML = markedText(
          unit.text,
          focus?.spans.filter((s) => s.blockId === unit.id) ?? [],
          query,
        );
    }
  }
  useEffect(() => {
    const token = ++generation.current,
      abort = new AbortController();
    let handle: Handle | undefined, controller: Controller | undefined;
    setLoading(true);
    setError(undefined);
    setQuery('');
    setResult(null);
    setPending(false);
    setPicked(new Set());
    setPage(1);
    setPageDraft('1');
    setEmptyPage(null);
    void openReader(entry, { signal: abort.signal })
      .then((next) => {
        handle = next;
        if (abort.signal.aborted) {
          next.corpus.release();
          return;
        }
        const sourcePositions = new Map(
          next.descriptor.units.map((unit, index) => [unit.id, index]),
        );
        const renderBlock = (block: { units: ReaderUnit[] }) => {
          let html = '',
            previousPage: number | undefined;
          for (const unit of block.units) {
            const p = unit.pageStart ?? 1;
            if (next.descriptor.pageUnits[p] === unit.id) {
              const position = sourcePositions.get(unit.id) ?? 0,
                previous = next.descriptor.units[position - 1]?.pageStart ?? 0;
              for (const gap of next.descriptor.emptyPages.filter((n) => n > previous && n < p))
                html += `<p class="notice">На странице ${gap} нет извлечённого текста. Проверьте оригинальный PDF.</p>`;
            }
            if (p !== previousPage) {
              if (previousPage !== undefined) html += '</article>';
              html += `<article class="document-page" aria-label="Страница ${p}"><div class="page-label">Страница ${p}</div>`;
              previousPage = p;
            }
            const chosen = ui.current.picked.has(unit.id),
              focus =
                ui.current.selection?.versionId === entry.versionId
                  ? ui.current.selection
                  : ui.current.focusAnchor?.versionId === entry.versionId
                    ? ui.current.focusAnchor
                    : null;
            html += `<div class="document-block ${escape(unit.kind)} ${chosen ? 'selected' : ''}" data-unit="${escape(unit.id)}" data-block-container="${escape(unit.id)}" tabindex="-1" aria-pressed="${chosen}"><div class="block-text" data-source-text="true" data-block-id="${escape(unit.id)}">${markedText(unit.text, focus?.spans.filter((s) => s.blockId === unit.id) ?? [], ui.current.query)}</div><div class="block-tools"><button type="button" class="block-action" data-pick-block="${escape(unit.id)}" aria-pressed="${chosen}" aria-label="${chosen ? 'Убрать' : 'Выбрать'} фрагмент ${unit.order + 1}">${chosen ? '✓ Выбран' : '+ Выбрать фрагмент'}</button><span class="block-id">${codePointLength(unit.text).toLocaleString('ru')} знаков</span></div><span class="ll-check" aria-hidden="true" hidden>${chosen ? '✓' : ''}</span></div>`;
          }
          return html + (previousPage !== undefined ? '</article>' : '');
        };
        const app = {
          state: { reader: {} },
          corpus: next.corpus,
          isLocked: () => false,
          fail: (reason: unknown) => {
            if (!abort.signal.aborted)
              setError(reason instanceof Error ? reason.message : String(reason));
          },
        };
        controller = new next.controllerClass(app, readerRef.current!, {
          descriptor: next.descriptor,
          selected: [],
          correctIds: [],
          review: false,
          readonly: false,
          renderBlock,
          afterRender: () => currentPage(),
        });
        active.current = { handle: next, controller };
        return controller.initialize(null).then(() => {
          if (!abort.signal.aborted) {
            setLoading(false);
            setReady((n) => n + 1);
          }
        });
      })
      .catch((reason) => {
        if (!abort.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setLoading(false);
        }
      });
    const paper = bodyRef.current!;
    let frame = 0;
    paper.addEventListener(
      'scroll',
      () => {
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (token === generation.current) currentPage();
          });
      },
      { passive: true, signal: abort.signal },
    );
    return () => {
      generation.current++;
      quoteOperation.current++;
      abort.abort();
      cancelAnimationFrame(frame);
      controller?.destroy();
      handle?.corpus.release();
      if (active.current?.handle === handle) active.current = null;
    };
  }, [entry.id, entry.versionId]);
  useEffect(() => {
    refresh();
  }, [picked, selection, focusAnchor, query, ready]);
  useEffect(() => {
    const value = active.current;
    if (!value || !focusAnchor || focusAnchor.versionId !== entry.versionId) return;
    setShowResults(false);
    setEmptyPage(null);
    void value.controller
      .navigate(focusAnchor.spans[0].blockId, { focus: false })
      .then(() => currentPage())
      .catch((reason) => setError(String(reason)));
  }, [focusAnchor, focusNonce, ready, entry.versionId]);
  useEffect(() => {
    const value = active.current;
    if (!value || query.trim().length < 2) {
      value?.controller.cancelSearch();
      setResult(null);
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    const timer = setTimeout(() => {
      void value.controller
        .search(query, 0)
        .then((found) => {
          if (!cancelled) {
            setResult(found);
            setPending(false);
          }
        })
        .catch((reason) => {
          if (!cancelled) {
            setError(String(reason));
            setPending(false);
          }
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      value.controller.cancelSearch();
    };
  }, [query, ready]);
  async function material() {
    const token = generation.current,
      current = latest.current;
    const next =
      current.document?.entry.id === current.entry.id
        ? current.document
        : await loadDocument(current.entry);
    if (token !== generation.current) return null;
    latest.current.onDocumentLoaded(next);
    return next;
  }
  async function captureSelection() {
    if (!bodyRef.current) return;
    const token = generation.current,
      operation = ++quoteOperation.current;
    try {
      const snapshot = captureDomSelection(bodyRef.current, window.getSelection());
      if (!snapshot) return;
      const doc = await material();
      if (!doc || operation !== quoteOperation.current) return;
      const anchor = anchorFromSelectionSnapshot(doc.version, snapshot);
      if (anchor) {
        ui.current.picked = new Set();
        setPicked(new Set());
        latest.current.onSelection(anchor);
      }
    } catch (reason) {
      if (token === generation.current && operation === quoteOperation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function toggleBlock(id: string) {
    const token = generation.current,
      operation = ++quoteOperation.current,
      next = new Set(ui.current.picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    ui.current.picked = next;
    setPicked(next);
    try {
      const doc = await material();
      if (!doc || operation !== quoteOperation.current) return;
      latest.current.onSelection(anchorForBlocks(doc.version, next));
      window.getSelection()?.removeAllRanges();
    } catch (reason) {
      if (token === generation.current && operation === quoteOperation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function navigate(id: string) {
    setEmptyPage(null);
    setShowResults(false);
    try {
      await active.current?.controller.navigate(id, { focus: false });
      currentPage();
    } catch (reason) {
      setError(String(reason));
    }
  }
  function goPage(raw: number) {
    const next = Math.max(1, Math.min(Math.max(1, entry.pageCount), Math.floor(raw) || 1));
    setPage(next);
    setPageDraft(String(next));
    const value = active.current;
    if (!value) return;
    const id = value.handle.descriptor.pageUnits[next];
    if (id) void navigate(id);
    else setEmptyPage(next);
  }
  async function searchPage(next: number) {
    const value = active.current;
    if (!value) return;
    setPending(true);
    try {
      const found = await value.controller.search(query, next);
      if (active.current === value) setResult(found);
    } catch (reason) {
      setError(String(reason));
    } finally {
      if (active.current === value) setPending(false);
    }
  }
  return (
    <section
      ref={readerRef}
      className="panel reader-panel continuous-reader"
      aria-label="Полный текст программы"
    >
      <header className="reader-top ll-reader-dock">
        <p className="reader-region">
          {entry.territory}
          {entry.status === 'review-required' ? (
            <span className="status warn">Проверьте страницы без текста</span>
          ) : null}
          {entry.quality === 'partial' ? (
            <span className="status warn">Частичный источник</span>
          ) : null}
        </p>
        <h2 className="reader-title">
          {entry.source.period?.label
            ? `Программа повышения рождаемости ${entry.source.period.label.replace(/ годы| год/g, '')}`
            : 'Программа повышения рождаемости'}
        </h2>
        <p className="reader-subtitle">{entry.source.act ?? entry.title}</p>
        <div className="reader-toolbar">
          <div className="search-field reader-search">
            <Search size={16} />
            <input
              className="input"
              aria-label="Поиск в полном тексте"
              placeholder="Поиск в документе"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowResults(true);
              }}
              disabled={loading}
            />
          </div>
          <div className="page-picker">
            <label htmlFor="reader-page">Стр.</label>
            <input
              id="reader-page"
              className="input"
              inputMode="numeric"
              aria-label="Номер страницы"
              title="Перейти к странице оригинала"
              value={pageDraft}
              onChange={(e) => setPageDraft(e.target.value.replace(/\D/g, ''))}
              onBlur={() => goPage(Number(pageDraft))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              disabled={loading}
            />
            <span>из {entry.pageCount}</span>
          </div>
          {original ? (
            <a
              className="reader-source"
              href={`${original}#page=${page}`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={14} />
              Оригинал
            </a>
          ) : null}
        </div>
        {query.trim().length >= 2 ? (
          <div>
            <div className="search-summary">
              <span aria-live="polite">
                {pending
                  ? 'Поиск по всему документу…'
                  : result
                    ? `Найдено ${result.total}`
                    : 'Совпадений нет'}
              </span>
              {result?.total ? (
                <button
                  className="button button-quiet small"
                  onClick={() => setShowResults(!showResults)}
                >
                  {showResults ? 'Скрыть' : 'Результаты'}
                </button>
              ) : null}
            </div>
            {showResults && result?.hits.length ? (
              <div className="search-results" aria-label="Результаты поиска по всему документу">
                {result.hits.map((hit) => (
                  <button
                    key={hit.id}
                    className="search-result"
                    onClick={() => void navigate(hit.id)}
                  >
                    <strong>{hit.label || hit.locator}</strong>
                    <span>{hit.text}</span>
                  </button>
                ))}
                {result.pages > 1 ? (
                  <div className="inline-actions">
                    <button
                      className="button small"
                      disabled={!result.page || pending}
                      onClick={() => void searchPage(result.page - 1)}
                    >
                      Назад
                    </button>
                    <span>
                      {result.page + 1} / {result.pages}
                    </span>
                    <button
                      className="button small"
                      disabled={result.page + 1 >= result.pages || pending}
                      onClick={() => void searchPage(result.page + 1)}
                    >
                      Далее
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {emptyPage ? (
          <p className="notice">
            На странице {emptyPage} нет извлечённого текста. Проверьте оригинальный PDF: здесь может
            находиться изображение или скан.
          </p>
        ) : null}
      </header>
      {loading ? (
        <div className="reader-loading" aria-busy="true" aria-label="Загрузка текста">
          <div className="skeleton heading" />
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton wide" />
          ))}
        </div>
      ) : null}
      {error || props.error ? (
        <div className="empty-document" role="alert">
          <FileSearch size={24} />
          <p>{error || props.error}</p>
          <button className="button button-quiet" onClick={onDetails}>
            Посмотреть паспорт
          </button>
        </div>
      ) : null}
      <div
        ref={bodyRef}
        className="document-pages ll-paper"
        tabIndex={0}
        aria-label="Текст документа"
        onMouseUp={() => void captureSelection()}
        onKeyUp={() => void captureSelection()}
        onTouchEnd={() => setTimeout(() => void captureSelection(), 80)}
        onClick={(e) => {
          const button = (e.target as Element).closest<HTMLElement>('[data-pick-block]');
          if (button) void toggleBlock(button.dataset.pickBlock!);
        }}
      />
      {selection && selection.versionId === entry.versionId ? (
        <div className="selection-toolbar">
          <div>
            <strong>Выбрано фрагментов: {selection.spans.length}</strong>
            <span>Цитата привязана к редакции источника</span>
          </div>
          <div className="inline-actions">
            <button
              className="icon-button"
              aria-label="Сохранить цитату без карточки"
              title="Сохранить цитату без карточки"
              onClick={onSaveNote}
            >
              <Bookmark size={16} />
            </button>
            <button className="button button-primary small" onClick={onLink}>
              <Link2 size={14} />
              Связать
            </button>
            <button
              className="icon-button"
              aria-label="Снять выделение"
              onClick={() => {
                props.onSelection(null);
                setPicked(new Set());
                window.getSelection()?.removeAllRanges();
              }}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
