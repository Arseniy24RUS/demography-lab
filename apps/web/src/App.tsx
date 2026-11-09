import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  HelpCircle,
  Library,
  FileText,
  Link2,
  CheckCircle2,
  AlertCircle,
  X,
  Send,
  Map as MapIcon,
} from 'lucide-react';
import { validateAnchor } from '@domain/index';
import type {
  DocumentVersion,
  PracticeOccurrence,
  PracticeVariant,
  TextAnchor,
} from '@domain/index';
import type { CorpusManifest, PracticeCatalog, CorpusDocument, RichVariant } from './lib/corpus';
import { loadManifest, loadCatalog, loadDocument, readable } from './lib/corpus';
import { loadFamilyCatalog, EXTERNAL_CATALOG_FAMILY } from './lib/family-catalog';
import { useWorkspace, newId } from './hooks/useWorkspace';
import type { CustomPracticeCard } from './storage';
import {
  anchorQuote,
  ensureAnnotation,
  localOccurrences,
  saveLink,
  withLocalEvidence,
} from './lib/workspace-domain';
import type { FieldReview } from './lib/workspace-domain';
import { LibraryPanel } from './components/LibraryPanel';
import { DocumentReader } from './components/DocumentReader';
import { EvidenceInspector } from './components/EvidenceInspector';
import { PracticeCatalogView } from './components/PracticeCatalogView';
import { MyWorkView } from './components/MyWorkView';
import { Modal } from './components/Modal';
import { CardEditor } from './components/CardEditor';
import type { CardForm } from './components/CardEditor';
import { SourceDetails } from './components/SourceDetails';
import { AccountControls } from './components/session/AccountControls';
import { useSession } from './hooks/useSession';
import { useWorkshop } from './hooks/useWorkshop';
import { useBarriers } from './hooks/useBarriers';
import { prepareSharedPractice } from './lib/shared-practice';
import type { SharedPracticeBundle } from '../../../packages/collaboration/types';
import './session.css';
import './account.css';
const SessionArea = lazy(() =>
  import('./components/session/SessionArea').then((m) => ({ default: m.SessionArea })),
);
const ProjectorContainer = lazy(() =>
  import('./components/ProjectorContainer').then((m) => ({ default: m.ProjectorContainer })),
);
const ConnectedWorkshop = lazy(() =>
  import('./components/ConnectedWorkshop').then((m) => ({ default: m.ConnectedWorkshop })),
);
const ConnectedBarriers = lazy(() =>
  import('./components/ConnectedBarriers').then((m) => ({ default: m.ConnectedBarriers })),
);
const ConnectedRoadmaps = lazy(() => import('./components/ConnectedRoadmaps').then(m => ({ default: m.ConnectedRoadmaps })));
const ConnectedSurveyStart = lazy(() => import('./components/ConnectedSurveyStart').then(m => ({ default: m.ConnectedSurveyStart })));
const LivePracticeVoting = lazy(() => import('./components/workshop/LivePracticeVoting').then(m => ({ default: m.LivePracticeVoting })));
const TerritoryExplorer = lazy(() => import('./components/roadmaps/TerritoryExplorer').then(m => ({ default: m.TerritoryExplorer })));
const LocalAtlas = lazy(() =>
  import('./components/geography/LocalAtlas').then((m) => ({ default: m.LocalAtlas })),
);
const sessionLoading = (
  <main id="main-content" className="loading-screen" aria-busy="true">
    <p>Открываем совместную мастерскую…</p>
  </main>
);

type View = 'documents' | 'practices' | 'work' | 'sessions' | 'territories';
type MobilePane = 'library' | 'document' | 'evidence';
type Toast = { message: string; error?: boolean };
export function App() {
  const [manifest, setManifest] = useState<CorpusManifest | null>(null);
  const [catalog, setCatalog] = useState<PracticeCatalog | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [externalCatalog, setExternalCatalog] = useState<RichVariant[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const catalogPending = useRef<Promise<void> | null>(null);
  const [documentId, setDocumentId] = useState('regional-respublika-mordoviia');
  const [doc, setDoc] = useState<CorpusDocument>();
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string>();
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [route] = useState(() => new URLSearchParams(location.hash.slice(1)));
  const [projectorMode, setProjectorMode] = useState(() => route.get('projector') === '1');
  const [view, setView] = useState<View>(() => route.has('documents') ? 'documents' : 'sessions');
  const [mobilePane, setMobilePane] = useState<MobilePane>('document');
  const [selection, setSelection] = useState<TextAnchor | null>(null);
  const [focusAnchor, setFocusAnchor] = useState<TextAnchor | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'help' | 'source' | 'note' | 'atlas' | null>(
    null,
  );
  const [note, setNote] = useState('');
  const [editor, setEditor] = useState<{ card?: CustomPracticeCard } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [shareDraft, setShareDraft] = useState<{
    bundle: SharedPracticeBundle;
    expectedRevision: number | null;
    sessionId: string;
  } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  const fail = useCallback(
    (e: unknown) => notify(e instanceof Error ? e.message : 'Не удалось выполнить действие.', true),
    [notify],
  );
  const session = useSession({
    onOpenSource: (anchor) => {
      void openAnchor(anchor);
    },
    onOpenLocalWork: () => setView('documents'),
    initialSessionId: route.get('session'),
    projectorMode,
  });
  const { snapshot, mutate, saving, error: storageError, workspaceTarget, legacyCount, adoptLegacy,
    reload: reloadWorkspace } = useWorkspace({
      api: session.api,
      userId: session.state.auth.status === 'signed-in' ? session.state.auth.userId : null,
    });
  const state = snapshot?.state;
  const lastWorkspaceUser = useRef<string | null>(null);
  useEffect(() => {
    const user = session.state.auth.userId;
    if (lastWorkspaceUser.current && lastWorkspaceUser.current !== user) {
      setEditor(null);
      setShareDraft(null);
      setNote('');
      setSelection(null);
      setSelectedId(null);
      setDialog(value => value === 'note' ? null : value);
    }
    lastWorkspaceUser.current = user;
  }, [session.state.auth.userId]);
  const workshop = useWorkshop({
    api: session.api,
    sessionId: session.sessionId,
    userId: session.state.auth.userId,
    projector: projectorMode,
    enabled: Boolean(session.state.bootstrap?.profile) && (view === 'sessions' || projectorMode),
  });
  const barriers = useBarriers({
    api: session.api,
    sessionId: session.sessionId,
    userId: session.state.auth.userId,
    projector: projectorMode,
    enabled: Boolean(session.state.bootstrap?.profile) && (view === 'sessions' || projectorMode),
  });
  useEffect(() => {
    const c = new AbortController();
    Promise.all([loadManifest(c.signal), loadCatalog(c.signal)])
      .then(([m, p]) => {
        setManifest(m);
        setCatalog(p);
        const initial = new URLSearchParams(location.hash.slice(1)).get('document');
        if (initial && m.documents.some((d) => d.id === initial)) setDocumentId(initial);
        else if (!m.documents.some((d) => d.id === documentId))
          setDocumentId(m.documents.find(readable)?.id ?? m.documents[0]?.id ?? '');
      })
      .catch((e) => {
        if (!c.signal.aborted) setStartupError(e instanceof Error ? e.message : String(e));
      });
    return () => c.abort();
  }, []);
  const entry = manifest?.documents.find((d) => d.id === documentId) ?? manifest?.documents[0];
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setDoc(undefined);
    setDocError(undefined);
    if (!readable(entry)) {
      setDocError('В исходном корпусе нет подготовленного полного текста для этой записи.');
      setDocLoading(false);
      return;
    }
    setDocLoading(true);
    loadDocument(entry)
      .then((next) => {
        if (!cancelled) {
          setDoc(next);
          setVersions((prev) =>
            [...prev.filter((v) => v.id !== next.version.id), next.version].slice(-5),
          );
        }
      })
      .catch((e) => {
        if (!cancelled) setDocError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setDocLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 10000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const variants = useMemo<RichVariant[]>(
    () =>
      catalog && state
        ? [...catalog.variants, ...externalCatalog, ...state.customCards].map((v) =>
            withLocalEvidence(v, state),
          )
        : (catalog?.variants ?? []),
    [catalog, state, externalCatalog],
  );
  const allFamilies = useMemo(
    () =>
      catalog
        ? [...catalog.families, ...(externalCatalog.length ? [EXTERNAL_CATALOG_FAMILY] : [])]
        : [],
    [catalog, externalCatalog],
  );
  const loadExternal = useCallback(async () => {
    if (!manifest || externalCatalog.length) return;
    if (catalogPending.current) return catalogPending.current;
    setCatalogBusy(true);
    const pending = loadFamilyCatalog(manifest)
      .then((items) => {
        setExternalCatalog(items);
      })
      .catch((e) => {
        fail(e);
        throw e;
      })
      .finally(() => {
        setCatalogBusy(false);
        catalogPending.current = null;
      });
    catalogPending.current = pending;
    return pending;
  }, [manifest, externalCatalog.length, fail]);
  const needsCatalog = Boolean(
    state?.linkDecisions.some((l) => l.practiceId.startsWith('catalog-')),
  );
  useEffect(() => {
    if (manifest && needsCatalog && !externalCatalog.length && !catalogPending.current)
      void loadExternal().catch(() => {});
  }, [manifest, needsCatalog, loadExternal]);
  const occurrences = useMemo(
    () => [...(catalog?.occurrences ?? []), ...(state ? localOccurrences(state) : [])],
    [catalog, state],
  );
  const selected = variants.find((v) => v.id === selectedId) ?? null;
  function selectDocument(id: string) {
    setDocumentId(id);
    setSelection(null);
    setFocusAnchor(null);
    setSelectedId(null);
    setMobilePane('document');
    history.replaceState(null, '', `#document=${encodeURIComponent(id)}`);
  }
  async function openAnchor(anchor: TextAnchor, pane: MobilePane = 'document') {
    if (!manifest) return;
    const target = manifest.documents.find((d) => d.id === anchor.documentId);
    if (!target) {
      notify(
        'Источник отсутствует в текущем корпусе. Сохранённая цитата остаётся в рабочей тетради.',
        true,
      );
      return;
    }
    try {
      const material = await loadDocument(target);
      const checked = validateAnchor(material.version, anchor);
      if (!checked.valid)
        throw new Error(
          'Цитата относится к другой редакции или не совпадает с текстом. Исходная запись сохранена; автоматическая подмена запрещена.',
        );
      setDocumentId(target.id);
      setFocusAnchor(anchor);
      setFocusNonce((n) => n + 1);
      setSelection(anchor);
      setView('documents');
      setMobilePane(pane);
      history.replaceState(null, '', `#document=${encodeURIComponent(target.id)}`);
    } catch (e) {
      fail(e);
    }
  }
  async function openCard(id: string) {
    const variant = variants.find((v) => v.id === id);
    if (!variant) return;
    setSelectedId(id);
    setSelection(null);
    setView('documents');
    setMobilePane('evidence');
    const o = occurrences.find((x) => variant.occurrenceIds.includes(x.id));
    if (o) await openAnchor(o.anchor, 'evidence');
    else {
      const target = manifest?.documents.find((d) => d.regionId === variant.regionId);
      if (target) setDocumentId(target.id);
    }
  }
  async function saveEvidence(review: FieldReview, rationale: string) {
    if (!doc || !selection || !selected) return;
    try {
      await mutate((draft) => {
        if (selected.regionId !== doc.entry.regionId)
          throw new Error('Для другого региона создайте отдельный вариант практики.');
        saveLink(draft, doc, selection, selected, review, rationale);
      });
      setSelection(null);
      notify('Связь и проверка выбранных полей сохранены.');
    } catch (e) {
      fail(e);
    }
  }
  async function saveQuotation() {
    if (!doc || !selection) return;
    try {
      await mutate((draft) => ensureAnnotation(draft, doc, selection, note));
      setDialog(null);
      setNote('');
      notify('Цитата сохранена в разделе «Моя работа».');
    } catch (e) {
      fail(e);
    }
  }
  async function saveCardForm(form: CardForm) {
    if (!entry || !editor) return;
    try {
      const id = editor.card?.id ?? newId('practice');
      const now = new Date().toISOString();
      await mutate((draft) => {
        const anchor =
          selection && doc && selection.versionId === doc.version.id ? selection : null;
        const annotation = anchor && doc ? ensureAnnotation(draft, doc, anchor) : null;
        if (editor.card) {
          const index = draft.customCards.findIndex((c) => c.id === editor.card!.id);
          if (index < 0) throw new Error('Карточка уже изменена или удалена.');
          draft.customCards[index] = {
            ...draft.customCards[index],
            ...form,
            reviewStatus: 'candidate',
            updatedAt: now,
          };
        } else {
          const card: CustomPracticeCard = {
            id,
            familyId: selected?.familyId ?? 'author-proposals',
            regionId: entry.regionId,
            ...form,
            occurrenceIds: annotation ? [annotation.id] : [],
            evidence: [],
            reviewStatus: 'candidate',
            createdAt: now,
            updatedAt: now,
          };
          draft.customCards.push(card);
        }
      });
      setEditor(null);
      setSelectedId(id);
      setView('documents');
      setMobilePane('evidence');
      notify('Карточка сохранена. Проверьте документальные основания её полей.');
    } catch (e) {
      fail(e);
    }
  }
  async function editCard(card: CustomPracticeCard) {
    const target = manifest?.documents.find((d) => d.regionId === card.regionId);
    if (target && target.id !== documentId) {
      setDocumentId(target.id);
      setSelection(null);
    }
    setEditor({ card });
  }
  async function beginShare() {
    if (!selected || !manifest) return;
    const shared = session.state.snapshot;
    if (!shared || !session.state.auth.userId) {
      setView('sessions');
      notify('Войдите, чтобы добавить карточку на общую доску.');
      return;
    }
    if (
      shared.session.role === 'observer'
    ) {
      notify(
        'Для этой сохранённой работы доступно только чтение.',
        true,
      );
      return;
    }
    setShareBusy(true);
    try {
      const existing = shared.submissions.find(
        (s) => s.localKey === selected.id && s.authorId === session.state.auth.userId,
      );
      if (existing?.status === 'withdrawn')
        throw new Error(
          'Эта публикация снята с показа. Преподаватель может восстановить её на общей доске.',
        );
      const bundle = await prepareSharedPractice(
        selected,
        occurrences,
        manifest,
        existing?.bundle.note ?? '',
      );
      setShareDraft({
        bundle,
        expectedRevision: existing?.revision ?? null,
        sessionId: shared.session.id,
      });
    } catch (e) {
      fail(e);
    } finally {
      setShareBusy(false);
    }
  }
  async function sendSharedPractice() {
    if (!shareDraft) return;
    if (shareDraft.sessionId !== session.state.snapshot?.session.id) {
      notify('Выбрано другое занятие. Откройте отправку карточки заново.', true);
      return;
    }
    try {
      await session.actions.publish(
        shareDraft.bundle,
        shareDraft.bundle.practice.id,
        shareDraft.expectedRevision,
      );
      history.replaceState(null, '', `${location.pathname}#sessions=1`);
      setShareDraft(null);
      setView('sessions');
      notify('Практика с цитатами сохранена в общей работе.');
    } catch (e) {
      fail(e);
    }
  }
  if (startupError || (!snapshot && storageError))
    return (
      <main className="error-screen">
        <div className="error-box">
          <h1>Не удалось открыть мастерскую</h1>
          <p>{startupError ?? storageError}</p>
          <p>
            Запустите проект через HTTP на localhost или через HTTPS. Сохранённые данные не
            удаляются.
          </p>
          <button className="button button-primary" onClick={() => location.reload()}>
            Повторить загрузку
          </button>
        </div>
      </main>
    );
  if (!manifest || !catalog || !snapshot || !state || !entry)
    return (
      <main className="loading-screen" aria-busy="true">
        <div>
          <BookOpen size={36} color="#123c73" />
          <h1 style={{ fontSize: 24, margin: '18px 0' }}>Демографическая мастерская</h1>
          <p className="muted">Подготовка библиотеки и рабочей тетради…</p>
          <div className="skeleton wide" />
        </div>
      </main>
    );
  const titles = {
    documents: ['Документы и практики', 'Найдите фрагмент и проверьте основание меры'],
    practices: ['Региональные практики', 'Сравните механизмы, условия и документальные основания'],
    work: ['Моя работа', 'Цитаты, авторские карточки и результаты проверки'],
    territories: ['Территории и сценарии', 'Муниципальные данные, сопоставления и условные траектории'],
    sessions: [
      'Совместная мастерская',
      'Исследуйте документы, представляйте практики и обсуждайте основания',
    ],
  };
  if (
    projectorMode &&
    session.state.auth.status === 'signed-in' &&
    session.state.bootstrap?.profile
  ) {
    return (
      <Suspense fallback={sessionLoading}>
        <ProjectorContainer
          session={session}
          workshop={workshop}
          barriers={barriers}
          manifest={manifest}
          onExit={() => {
            setProjectorMode(false);
            setView('sessions');
            history.replaceState(
              null,
              '',
              `${location.pathname}#sessions=1`,
            );
          }}
        />
      </Suspense>
    );
  }
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Перейти к рабочей области
      </a>
      <header className="topbar">
        <div className="brand">
          <img className="institute-logo" src={`${import.meta.env.BASE_URL}favicon.svg`}
            width={48} height={48} alt="Институт социальной демографии ФНИСЦ РАН" />
          <span>Демографическая мастерская</span>
        </div>
        <nav className="topnav" aria-label="Основная навигация">
          {(
            [
              ['sessions', 'Мастерская'],
              ['documents', 'Документы'],
              ['practices', 'Практики'],
              ['territories', 'Территории'],
              ['work', 'Моя работа'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`nav-button ${view === key ? 'active' : ''}`}
              aria-current={view === key ? 'page' : undefined}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <button
            className="icon-button"
            aria-label="Как работать с источниками"
            onClick={() => setDialog('help')}
          >
            <HelpCircle size={19} />
          </button>

        </div>
        <AccountControls state={session.state} actions={session.actions}
          onOpenEntry={() => {
            setView('sessions');
            history.replaceState(null, '', `${location.pathname}#sessions=1`);
          }}
          onSignedOut={() => {
            setView('sessions');
            history.replaceState(null, '', `${location.pathname}#sessions=1`);
          }}
          onError={fail} />
      </header>
      {view !== 'sessions' ? (
        <section className="page-intro">
          <div>
            <h1>{titles[view][0]}</h1>
            <p>{titles[view][1]}</p>
          </div>
          {view === 'documents' ? (
            <button className="button button-secondary" onClick={() => setDialog('atlas')}>
              <MapIcon size={17} />
              Карта программ
            </button>
          ) : null}
        </section>
      ) : null}
      {storageError ? (
        <div className="notice error" role="alert" style={{ margin: '0 20px 16px' }}>
          {storageError}
          <button className="button button-quiet" onClick={() => void reloadWorkspace()}>
            Повторить загрузку работы
          </button>
        </div>
      ) : null}
      {view === 'documents' ? (
        <>
          <nav className="mobile-tabs" aria-label="Панели рабочей области">
            {(
              [
                ['library', 'Библиотека', Library],
                ['document', 'Документ', FileText],
                ['evidence', 'Связь', Link2],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                className={mobilePane === key ? 'active' : ''}
                aria-current={mobilePane === key ? 'true' : undefined}
                onClick={() => setMobilePane(key)}
              >
                <Icon size={16} />
                {label}
                {key === 'evidence' && selection ? (
                  <span className="link-counter">{selection.spans.length}</span>
                ) : null}
              </button>
            ))}
          </nav>
          <main id="main-content" className={`workspace mobile-${mobilePane}`}>
            <LibraryPanel
              manifest={manifest}
              selected={entry}
              onSelect={selectDocument}
              onDetails={() => setDialog('source')}
            />
            <DocumentReader
              entry={entry}
              document={doc}
              loading={docLoading}
              error={docError}
              selection={selection}
              onSelection={setSelection}
              onLink={() => setMobilePane('evidence')}
              onSaveNote={() => {
                setNote('');
                setDialog('note');
              }}
              focusAnchor={focusAnchor}
              focusNonce={focusNonce}
              onDetails={() => setDialog('source')}
            />
            <EvidenceInspector
              doc={doc}
              entry={entry}
              selection={selection}
              variants={variants}
              occurrences={occurrences}
              versions={versions}
              selected={selected}
              onSelect={setSelectedId}
              onOpenCitation={(o: PracticeOccurrence) => {
                void openAnchor(o.anchor);
              }}
              onSave={saveEvidence}
              comparisons={catalog.catalogComparisons}
              catalogLoaded={externalCatalog.length > 0}
              catalogBusy={catalogBusy}
              onLoadCatalog={loadExternal}
              onCreate={() => setEditor({})}
              onShare={() => {
                void beginShare();
              }}
              shareBusy={shareBusy || Boolean(session.state.busy)}
              busy={saving}
            />
          </main>
        </>
      ) : view === 'practices' ? (
        <PracticeCatalogView
          variants={variants}
          families={allFamilies}
          manifest={manifest}
          catalogLoaded={externalCatalog.length > 0}
          catalogBusy={catalogBusy}
          onLoadCatalog={loadExternal}
          onOpen={(id) => {
            void openCard(id);
          }}
          onCreate={() => setEditor({})}
        />
      ) : view === 'territories' ? (
        <Suspense fallback={<main id="main-content" className="loading-screen" aria-busy="true"><p>Открываем территории…</p></main>}><TerritoryExplorer onOpenSession={() => setView('sessions')} /></Suspense>
      ) : view === 'sessions' ? (
        <Suspense fallback={sessionLoading}>
          <SessionArea
            state={session.state}
            actions={session.actions}
            renderSurvey={(onContinue) => session.state.snapshot && session.state.auth.userId ? (
              <Suspense fallback={<p aria-busy="true">Открываем опрос…</p>}>
                <ConnectedSurveyStart api={session.api} session={session.state.snapshot.session}
                  userId={session.state.auth.userId} onContinue={onContinue}>
                  {session.state.snapshot.session.role === 'host' ? <ConnectedBarriers
                    state={session.state} sessionActions={session.actions} barriers={barriers}
                    manifest={manifest} api={session.api} surveyOnly /> : null}
                </ConnectedSurveyStart>
              </Suspense>
            ) : null}
            renderLiveVotes={() => (
              <Suspense fallback={<p aria-busy="true">Открываем рейтинг…</p>}>
                <LivePracticeVoting state={session.state} api={session.api} workshop={workshop}
                  onOpenSource={session.actions.openSource} manifest={manifest} />
              </Suspense>
            )}
            renderRoadmaps={() => (
              <Suspense fallback={<p aria-busy="true">Открываем дорожные карты…</p>}>
                <ConnectedRoadmaps key={`${session.sessionId}:${session.state.auth.userId}`} state={session.state} sessionActions={session.actions} api={session.api} barriers={barriers} manifest={manifest} />
              </Suspense>
            )}
            renderBarriers={() => (
              <Suspense fallback={<p aria-busy="true">Открываем барьеры и решения…</p>}>
                <ConnectedBarriers
                  state={session.state}
                  sessionActions={session.actions}
                  barriers={barriers}
                  manifest={manifest}
                  api={session.api}
                />
              </Suspense>
            )}
            renderWorkshop={(workshopView) => (
              <Suspense fallback={<p aria-busy="true">Открываем этап…</p>}>
                <ConnectedWorkshop
                  state={session.state}
                  sessionActions={session.actions}
                  workshop={workshop}
                  manifest={manifest}
                  view={workshopView}
                  onOpenDocument={(regionId) => {
                    const target = manifest.documents.find((item) => item.regionId === regionId);
                    if (target) {
                      selectDocument(target.id);
                      setView('documents');
                    }
                  }}
                />
              </Suspense>
            )}
            regions={manifest.documents
              .map((d) => ({ id: d.regionId, name: d.territory }))
              .filter((d, i, all) => all.findIndex((x) => x.id === d.id) === i)
              .sort((a, b) => a.name.localeCompare(b.name, 'ru'))}
          />
        </Suspense>
      ) : (
        <MyWorkView
          state={state}
          variants={variants}
          onOpen={(a) => {
            setSelectedId(null);
            void openAnchor(a);
          }}
          onOpenCard={(id) => {
            void openCard(id);
          }}
          onEdit={(c) => {
            void editCard(c);
          }}
          saving={saving}
          savedTo={workspaceTarget}
          signedIn={session.state.auth.status === 'signed-in'}
          legacyCount={legacyCount}
          onAdoptLegacy={() => void adoptLegacy().catch(fail)}
          onOpenSession={() => setView('sessions')}
        />
      )}
      <footer className="workspace-footer">
        <span className="save-status" aria-live="polite">
          <span className={`save-dot ${storageError ? 'error' : saving ? 'busy' : ''}`} />
          {storageError
            ? 'Сохранение не подтверждено — проверьте сообщение'
            : saving
              ? 'Сохраняем работу…'
              : workspaceTarget === 'offline'
                ? 'Работа сохраняется на Mac преподавателя'
                : workspaceTarget === 'cloud'
                  ? 'Работа сохраняется в вашем профиле'
                  : 'Заметки в этом браузере · войдите для сохранения в профиле'}
        </span>
        <span className="footer-version">Версия 0.9.0</span>
      </footer>
      {dialog === 'source' ? (
        <SourceDetails entry={entry} doc={doc} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'atlas' ? (
        <Modal title="Карта региональных программ" wide onClose={() => setDialog(null)}>
          <Suspense fallback={<p aria-busy="true">Открываем карту…</p>}>
            <LocalAtlas
              manifest={manifest}
              initialRegionId={entry.regionId}
              onOpen={(id) => {
                selectDocument(id);
                setView('documents');
                setDialog(null);
              }}
            />
          </Suspense>
        </Modal>
      ) : null}
      {dialog === 'help' ? (
        <Modal
          title="Как проверить практику"
          onClose={() => setDialog(null)}
          actions={
            <button className="button button-primary" onClick={() => setDialog(null)}>
              Начать работу
            </button>
          }
        >
          <div className="help-steps">
            <div className="help-step">
              <span>
                <strong>Откройте программу.</strong> В библиотеке доступны все подготовленные
                тексты. Поиск внутри программы работает по всем страницам.
              </span>
            </div>
            <div className="help-step">
              <span>
                <strong>Выберите цитату.</strong> Можно выделить точную фразу или выбрать несколько
                блоков кнопками под текстом.
              </span>
            </div>
            <div className="help-step">
              <span>
                <strong>Сопоставьте карточку.</strong> Выберите предложенную практику или создайте
                новую. Для получателей, суммы и условий укажите характер подтверждения.
              </span>
            </div>
            <div className="help-step">
              <span>
                <strong>Продолжайте работу.</strong> После входа цитаты и карточки сохраняются
                в вашем профиле. Готовую дорожную карту можно скачать в DOCX или PDF.
              </span>
            </div>
          </div>
          <div className="notice info">
            Для совместной работы откройте «Занятия» и введите email. Если вы здесь впервые,
            следующим шагом укажите ФИО. Кнопка «Отправить в занятие» передаёт выбранную карточку
            с её цитатами на общую доску.
          </div>
          <p className="modal-intro">
            Подготовленный текст и редакция программы доступны для исследования. Действие норм на
            дату занятия проверяется по официальным источникам. Отметка «Проверено по цитате»
            фиксирует вашу проверку конкретного поля.
          </p>
        </Modal>
      ) : null}
      {dialog === 'note' && selection ? (
        <Modal
          title="Сохранить цитату"
          onClose={() => setDialog(null)}
          actions={
            <>
              <button className="button button-secondary" onClick={() => setDialog(null)}>
                Отмена
              </button>
              <button
                className="button button-primary"
                disabled={saving}
                onClick={() => void saveQuotation()}
              >
                Сохранить
              </button>
            </>
          }
        >
          <blockquote className="quote-panel" style={{ marginBottom: 18 }}>
            <div className="quote-text">{anchorQuote(selection)}</div>
          </blockquote>
          <div className="form-field">
            <label htmlFor="quote-note">Комментарий к фрагменту</label>
            <textarea
              id="quote-note"
              className="input"
              maxLength={3000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Почему этот фрагмент важен для вашей задачи?"
            />
          </div>
        </Modal>
      ) : null}
      {editor ? (
        <CardEditor
          entry={entry}
          anchor={selection}
          initial={editor.card}
          onClose={() => setEditor(null)}
          onSave={saveCardForm}
          busy={saving}
        />
      ) : null}
      {shareDraft ? (
        <Modal
          title="Отправить практику в занятие"
          onClose={() => {
            if (!session.state.busy) setShareDraft(null);
          }}
          actions={
            <>
              <button
                className="button button-secondary"
                disabled={Boolean(session.state.busy)}
                onClick={() => setShareDraft(null)}
              >
                Отмена
              </button>
              <button
                className="button button-primary"
                disabled={Boolean(session.state.busy)}
                onClick={() => void sendSharedPractice()}
              >
                <Send size={16} />
                {session.state.busy ? 'Отправка…' : 'Опубликовать в занятии'}
              </button>
            </>
          }
        >
          <p className="eyebrow">{session.state.snapshot?.session.title}</p>
          <h3>{shareDraft.bundle.practice.title}</h3>
          <p>{shareDraft.bundle.practice.mechanism}</p>
          <p className="muted">
            Точных цитат: {shareDraft.bundle.occurrences.length}. Сервер сверит их с канонической
            редакцией. Содержание карточки станет доступно участникам занятия.
          </p>
          <div className="form-field">
            <label htmlFor="share-comment">Комментарий для обсуждения</label>
            <textarea
              id="share-comment"
              className="input"
              maxLength={4000}
              value={shareDraft.bundle.note}
              onChange={(e) =>
                setShareDraft((d) =>
                  d ? { ...d, bundle: { ...d.bundle, note: e.target.value } } : d,
                )
              }
              placeholder="Почему вы предлагаете обсудить эту практику?"
            />
          </div>
          {session.state.error ? (
            <p className="notice error" role="alert">
              {session.state.error}
            </p>
          ) : null}
        </Modal>
      ) : null}
      {toast ? (
        <div
          className={`toast ${toast.error ? 'error' : ''}`}
          role={toast.error ? 'alert' : 'status'}
        >
          {toast.error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
          <span>{toast.message}</span>
          <button
            aria-label="Закрыть уведомление"
            style={{ border: 0, background: 'transparent', color: 'white', padding: 3 }}
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
