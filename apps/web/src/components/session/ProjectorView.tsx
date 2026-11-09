import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  RefreshCw,
} from 'lucide-react';
import { anchorQuote } from '@/lib/workspace-domain';
import type {
  ConnectionStatus,
  ProjectionSession,
} from '../../../../../packages/collaboration/types';
import { SessionConnection } from './SessionConnection';
import { initials, messageFromError, phaseLabels, statusLabels, timeLabel } from './session-ui';

/** Exact text is paginated at whitespace; pagination never rewrites the source. */
function textPages(value: string, limit: number): string[] {
  const points = Array.from(value);
  const pages: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    let end = Math.min(offset + limit, points.length);
    if (end < points.length) {
      const lowerBound = offset + Math.floor(limit * 0.65);
      for (let index = end; index > lowerBound; index--) {
        if (/\s/.test(points[index] ?? '')) {
          end = index + 1;
          break;
        }
      }
    }
    pages.push(points.slice(offset, end).join(''));
    offset = end;
  }
  return pages.length ? pages : [''];
}

export function ProjectorView({
  projection,
  connection,
  onExit,
  onRefresh,
  lastSyncedAt,
  error,
}: {
  projection: ProjectionSession | null;
  connection: ConnectionStatus;
  onExit: () => void;
  onRefresh: () => Promise<void>;
  lastSyncedAt: string | null;
  error: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quoteIndex, setQuoteIndex] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [mechanismIndex, setMechanismIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState('');
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [announcement, setAnnouncement] = useState('');
  const lastFocus = useRef<string | null>(null);
  const lastCursor = useRef<number | null>(null);
  const selected =
    projection?.submissions.find((item) => item.id === selectedId) ??
    projection?.submissions.find((item) => item.id === projection.focusSubmissionId) ??
    projection?.submissions[0];
  const selectedIndex = projection?.submissions.findIndex((item) => item.id === selected?.id) ?? -1;
  const currentQuoteIndex = selected
    ? Math.min(quoteIndex, selected.bundle.occurrences.length - 1)
    : 0;
  const occurrence = selected?.bundle.occurrences[Math.max(0, currentQuoteIndex)];
  const source = selected?.bundle.sources.find(
    (entry) =>
      entry.sourceId === occurrence?.documentId && entry.editionId === occurrence?.versionId,
  );
  const quotePages = useMemo(
    () => textPages(occurrence ? anchorQuote(occurrence.anchor) : '', 720),
    [occurrence],
  );
  const mechanismPages = useMemo(
    () => textPages(selected?.bundle.practice.mechanism ?? '', 380),
    [selected?.bundle.practice.mechanism],
  );
  const currentPage = Math.min(pageIndex, quotePages.length - 1);
  const currentMechanism = Math.min(mechanismIndex, mechanismPages.length - 1);

  useEffect(() => {
    const focus = projection?.focusSubmissionId ?? null;
    if (focus && focus !== lastFocus.current) setSelectedId(focus);
    lastFocus.current = focus;
  }, [projection?.focusSubmissionId]);

  useEffect(() => {
    setQuoteIndex(0);
    setPageIndex(0);
    setMechanismIndex(0);
  }, [selected?.id]);

  useEffect(() => {
    if (!projection) return;
    if (lastCursor.current !== null && projection.cursor > lastCursor.current) {
      setAnnouncement(`Материалы обновлены. На доске практик: ${projection.submissions.length}.`);
    }
    lastCursor.current = projection.cursor;
  }, [projection]);

  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  async function refresh() {
    setRefreshing(true);
    setLocalError('');
    try {
      await onRefresh();
    } catch (cause) {
      setLocalError(messageFromError(cause));
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleFullscreen() {
    setLocalError('');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setLocalError(
        'Браузер не открыл полноэкранный режим. Можно использовать его штатную команду.',
      );
    }
  }

  const totalQuotes =
    projection?.submissions.reduce((count, item) => count + item.bundle.occurrences.length, 0) ?? 0;
  return (
    <main className="projector-view" aria-label="Экран проектора">
      <header className="projector-header">
        <div>
          <div className="projector-brand">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} width={32} height={32}
              alt="Институт социальной демографии ФНИСЦ РАН" />
            Демографическая мастерская
          </div>
          <p className="projector-session">{projection?.title ?? 'Подключение к занятию'}</p>
        </div>
        <div className="projector-header-actions">
          <SessionConnection connection={connection} lastSyncedAt={lastSyncedAt} />
          <button
            className="icon-button"
            aria-label="Обновить материалы проектора"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw size={18} className={refreshing ? 'session-spinner' : undefined} />
          </button>
          {document.fullscreenEnabled ? (
            <button
              className="icon-button"
              aria-label={
                fullscreen ? 'Выйти из полноэкранного режима' : 'Развернуть на весь экран'
              }
              onClick={() => void toggleFullscreen()}
            >
              {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          ) : null}
          <button className="button button-secondary" onClick={onExit}>
            <ArrowLeft size={16} />К занятию
          </button>
        </div>
      </header>
      <p className="session-sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {error || localError ? (
        <p className="session-message projector-message" data-tone="error" role="alert">
          {localError || error}
        </p>
      ) : null}
      {connection === 'offline' ? (
        <p className="session-message projector-message" data-tone="warning">
          Связь прервана. Показаны последние полученные материалы.
        </p>
      ) : null}
      <div className="projector-main">
        {!projection ? (
          <div className="projector-empty">
            <h1>Открываем общую доску</h1>
            <p>
              {error
                ? 'Проверьте подключение и повторите обновление.'
                : 'Материалы появятся после подключения к занятию.'}
            </p>
          </div>
        ) : selected ? (
          <>
            <div className="projector-scene-meta">
              <span>{phaseLabels[projection.phase]}</span>
              <span>{statusLabels[projection.status]}</span>
            </div>
            <h1 className="projector-practice-title">{selected.bundle.practice.title}</h1>
            <p className="projector-practice-mechanism">{mechanismPages[currentMechanism]}</p>
            {mechanismPages.length > 1 ? (
              <div className="session-action-row projector-mechanism-pagination">
                <button
                  className="icon-button"
                  aria-label="Предыдущая часть описания практики"
                  disabled={currentMechanism === 0}
                  onClick={() => setMechanismIndex(currentMechanism - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <span>
                  Описание · часть {currentMechanism + 1} из {mechanismPages.length}
                </span>
                <button
                  className="icon-button"
                  aria-label="Следующая часть описания практики"
                  disabled={currentMechanism === mechanismPages.length - 1}
                  onClick={() => setMechanismIndex(currentMechanism + 1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            ) : null}
            {occurrence ? (
              <section className="projector-source-scene" aria-label="Цитата из документа">
                <blockquote>{quotePages[currentPage]}</blockquote>
                <div className="projector-source-context">
                  <h2>Основание в документе</h2>
                  <p>{source?.title ?? 'Региональная программа'}</p>
                  <div className="session-action-row">
                    <button
                      className="icon-button"
                      aria-label="Предыдущая цитата или часть"
                      disabled={currentQuoteIndex <= 0 && currentPage === 0}
                      onClick={() => {
                        if (currentPage > 0) setPageIndex(currentPage - 1);
                        else {
                          setQuoteIndex(currentQuoteIndex - 1);
                          setPageIndex(0);
                        }
                      }}
                    >
                      <ChevronLeft size={18} />
                    </button>
                    <span>
                      Цитата {currentQuoteIndex + 1} из {selected.bundle.occurrences.length}
                      {quotePages.length > 1 ? (
                        <small className="projector-quote-page">
                          Часть {currentPage + 1} из {quotePages.length}
                        </small>
                      ) : null}
                    </span>
                    <button
                      className="icon-button"
                      aria-label="Следующая цитата или часть"
                      disabled={
                        currentQuoteIndex >= selected.bundle.occurrences.length - 1 &&
                        currentPage >= quotePages.length - 1
                      }
                      onClick={() => {
                        if (currentPage < quotePages.length - 1) setPageIndex(currentPage + 1);
                        else {
                          setQuoteIndex(currentQuoteIndex + 1);
                          setPageIndex(0);
                        }
                      }}
                    >
                      <ChevronRight size={18} />
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <p className="projector-no-evidence">
                К этой публикации пока не приложены точные цитаты.
              </p>
            )}
            {projection.projectorShowAuthors && selected.authorName ? (
              <div className="projector-author">
                <span className="session-avatar" aria-hidden="true">
                  {initials(selected.authorName)}
                </span>
                <div>
                  {selected.authorName}
                  <small>Автор публикации</small>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="projector-empty">
            <h1>От источника — к практике</h1>
            <p>
              {projection.status === 'closed'
                ? 'Занятие завершено. На общей доске нет опубликованных практик.'
                : 'Откройте региональную программу, найдите сильное решение и поделитесь его документальным основанием.'}
            </p>
          </div>
        )}
      </div>
      <footer className="projector-footer">
        <p>
          {projection
            ? `Участников: ${projection.participantCount} · Практик: ${projection.submissions.length} · Цитат: ${totalQuotes}`
            : 'Ожидаем материалы занятия'}
          {lastSyncedAt ? (
            <span className="projector-sync-time">Обновлено в {timeLabel(lastSyncedAt)}</span>
          ) : null}
        </p>
        {projection && selected ? (
          <div className="projector-pagination">
            <button
              className="button button-secondary"
              disabled={selectedIndex <= 0}
              onClick={() => setSelectedId(projection.submissions[selectedIndex - 1].id)}
            >
              <ArrowLeft size={17} />
              Предыдущая
            </button>
            <span>
              {selectedIndex + 1} / {projection.submissions.length}
            </span>
            <button
              className="button button-primary"
              disabled={selectedIndex >= projection.submissions.length - 1}
              onClick={() => setSelectedId(projection.submissions[selectedIndex + 1].id)}
            >
              Следующая <ArrowRight size={17} />
            </button>
          </div>
        ) : null}
      </footer>
    </main>
  );
}
