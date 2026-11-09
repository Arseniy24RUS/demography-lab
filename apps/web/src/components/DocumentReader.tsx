import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Link2,
  Check,
  Plus,
  X,
  Bookmark,
  FileSearch,
  ArrowDown,
} from 'lucide-react';
import { codePointLength, createAnchor } from '@domain/index';
import type { TextAnchor, SearchHit } from '@domain/index';
import type { CorpusDocument, CorpusEntry } from '@/lib/corpus';
import { useOriginalDocumentUrl } from '@/hooks/useOriginalDocumentUrl';
import { anchorForBlocks, anchorFromDomSelection } from '@/lib/selection';
import { useDocumentSearch } from '@/hooks/useDocumentSearch';
import { HighlightedText } from './HighlightedText';

export function DocumentReader({
  entry,
  document: doc,
  loading,
  error,
  selection,
  onSelection,
  onLink,
  onSaveNote,
  focusAnchor,
  focusNonce,
  onDetails,
}: {
  entry: CorpusEntry;
  document?: CorpusDocument;
  loading: boolean;
  error?: string;
  selection: TextAnchor | null;
  onSelection: (anchor: TextAnchor | null) => void;
  onLink: () => void;
  onSaveNote: () => void;
  focusAnchor: TextAnchor | null;
  focusNonce: number;
  onDetails: () => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [expanded, setExpanded] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showResults, setShowResults] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const currentDocId = doc?.version.id;
  const { result, pending } = useDocumentSearch(doc?.version, query);
  const maxPage = Math.max(1, entry.pageCount);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [page, currentDocId]);
  const goPage = (n: number) => {
    const next = Math.max(1, Math.min(maxPage, Math.floor(n) || 1));
    setPage(next);
    setPageDraft(String(next));
    setExpanded(false);
  };
  useEffect(() => {
    setQuery('');
    setPage(1);
    setPageDraft('1');
    setExpanded(false);
    setPicked(new Set());
  }, [entry.id]);
  useEffect(() => {
    if (!doc || !focusAnchor || focusAnchor.versionId !== doc.version.id) return;
    const block = doc.version.blocks.find((b) => b.id === focusAnchor.spans[0]?.blockId);
    if (!block) return;
    const target = block.pageStart ?? 1;
    setPage(target);
    setPageDraft(String(target));
    setExpanded(
      focusAnchor.spans.some(
        (s) => (doc.version.blocks.find((b) => b.id === s.blockId)?.pageStart ?? target) > target,
      ),
    );
    setShowResults(false);
    const t = setTimeout(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(
        `[data-block-container="${CSS.escape(block.id)}"]`,
      );
      el?.scrollIntoView({
        block: 'center',
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
    }, 50);
    return () => clearTimeout(t);
  }, [currentDocId, focusAnchor, focusNonce, doc]);
  const pages = expanded && page < maxPage ? [page, page + 1] : [page];
  const visible = useMemo(
    () => doc?.version.blocks.filter((b) => pages.includes(b.pageStart ?? 1)) ?? [],
    [doc, page, expanded],
  );
  const focus =
    selection?.versionId === currentDocId
      ? selection
      : focusAnchor?.versionId === currentDocId
        ? focusAnchor
        : null;
  function captureSelection() {
    if (!doc || !bodyRef.current) return;
    try {
      const a = anchorFromDomSelection(bodyRef.current, doc.version, window.getSelection());
      if (a) {
        setPicked(new Set());
        onSelection(a);
      }
    } catch {
      /* A browser range interrupted by navigation is ignored; stored selections remain. */
    }
  }
  function toggleBlock(id: string) {
    if (!doc) return;
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
    onSelection(anchorForBlocks(doc.version, next));
    window.getSelection()?.removeAllRanges();
  }
  function pickHit(hit: SearchHit) {
    if (!doc) return;
    const a = createAnchor(doc.version, [{ blockId: hit.blockId, start: hit.start, end: hit.end }]);
    onSelection(a);
    setPicked(new Set());
    goPage(hit.pageStart ?? 1);
    setShowResults(false);
    setTimeout(
      () =>
        bodyRef.current
          ?.querySelector<HTMLElement>(`[data-block-container="${CSS.escape(hit.blockId)}"]`)
          ?.scrollIntoView({ block: 'center' }),
      30,
    );
  }
  const original = useOriginalDocumentUrl(entry);
  return (
    <section className="panel reader-panel" aria-label="Полный текст программы">
      <header className="reader-top">
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
              disabled={!doc}
            />
          </div>
          <div className="page-picker">
            <button
              className="icon-button"
              aria-label="Предыдущая страница"
              disabled={page <= 1 || !doc}
              onClick={() => goPage(page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <label htmlFor="reader-page" className="sr-only">
              Номер страницы
            </label>
            <input
              id="reader-page"
              className="input"
              inputMode="numeric"
              aria-label="Номер страницы"
              value={pageDraft}
              onChange={(e) => setPageDraft(e.target.value.replace(/\D/g, ''))}
              onBlur={() => goPage(Number(pageDraft))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') goPage(Number(pageDraft));
              }}
              disabled={!doc}
            />
            <span>из {maxPage}</span>
            <button
              className="icon-button"
              aria-label="Следующая страница"
              disabled={page >= maxPage || !doc}
              onClick={() => goPage(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
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
                    ? `Найдено ${result.totalMatches}${result.truncated ? ' · первые 150' : ''}`
                    : 'Совпадений нет'}
              </span>
              {result && result.totalMatches > 0 ? (
                <button
                  className="button button-quiet small"
                  onClick={() => setShowResults(!showResults)}
                >
                  {showResults ? 'Скрыть' : 'Результаты'}
                </button>
              ) : null}
            </div>
            {showResults && result && result.hits.length > 0 ? (
              <div className="search-results" aria-label="Результаты поиска по всему документу">
                {result.hits.map((hit) => (
                  <button key={hit.id} className="search-result" onClick={() => pickHit(hit)}>
                    <strong>Страница {hit.pageStart ?? '—'}</strong>
                    <span>
                      {hit.before}
                      <mark className="text-highlight search">{hit.exact}</mark>
                      {hit.after}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>
      {loading ? (
        <div className="document-pages" aria-busy="true" aria-label="Загрузка текста">
          <div className="skeleton heading" />
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className={`skeleton ${i % 3 ? 'wide' : 'short'}`} />
          ))}
        </div>
      ) : error ? (
        <div className="empty-document">
          <FileSearch size={32} color="#7f9cbd" />
          <h2>Материал пока недоступен</h2>
          <p>{error}</p>
          {original ? (
            <a className="button button-secondary" href={original} target="_blank" rel="noreferrer">
              <ExternalLink size={15} />
              Открыть исходный файл
            </a>
          ) : null}
          <button className="button button-quiet" onClick={onDetails}>
            Посмотреть паспорт
          </button>
        </div>
      ) : doc ? (
        <>
          <div
            ref={bodyRef}
            className="document-pages"
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
            onTouchEnd={() => setTimeout(captureSelection, 80)}
          >
            {pages.map((p) => (
              <article className="document-page" key={p} aria-label={`Страница ${p}`}>
                <div className="page-label">Страница {p}</div>
                {visible
                  .filter((b) => (b.pageStart ?? 1) === p)
                  .map((b) => (
                    <div
                      key={b.id}
                      className={`document-block ${b.kind} ${picked.has(b.id) ? 'selected' : ''}`}
                      data-block-container={b.id}
                    >
                      <div className="block-text" data-source-text="true" data-block-id={b.id}>
                        <HighlightedText
                          text={b.text}
                          spans={focus?.spans.filter((s) => s.blockId === b.id) ?? []}
                          hits={result?.hits.filter((h) => h.blockId === b.id) ?? []}
                        />
                      </div>
                      <div className="block-tools">
                        <button
                          className="block-action"
                          aria-pressed={picked.has(b.id)}
                          aria-label={`${picked.has(b.id) ? 'Убрать' : 'Выбрать'} фрагмент ${b.order + 1}`}
                          onClick={() => toggleBlock(b.id)}
                        >
                          {picked.has(b.id) ? <Check size={12} /> : <Plus size={12} />}{' '}
                          {picked.has(b.id) ? 'Выбран' : 'Выбрать фрагмент'}
                        </button>
                        <span className="block-id">
                          {codePointLength(b.text).toLocaleString('ru')} знаков
                        </span>
                      </div>
                    </div>
                  ))}
                {!visible.some((b) => (b.pageStart ?? 1) === p) ? (
                  <p className="notice">
                    На странице нет извлечённого текста. Проверьте оригинальный PDF: здесь может
                    находиться изображение или скан.
                  </p>
                ) : null}
              </article>
            ))}
            {page < maxPage && !expanded ? (
              <button
                className="button button-secondary small next-page"
                onClick={() => setExpanded(true)}
              >
                <ArrowDown size={14} />
                Показать следующую страницу рядом
              </button>
            ) : null}
          </div>
          {selection && selection.versionId === currentDocId ? (
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
                    onSelection(null);
                    setPicked(new Set());
                    window.getSelection()?.removeAllRanges();
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
