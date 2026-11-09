import { ArrowUpRight, FileText, CheckCircle2, LogIn, PenLine, Link2 } from 'lucide-react';
import type { WorkspaceState, CustomPracticeCard } from '@/storage';
import type { PracticeVariant, TextAnchor } from '@domain/index';
import { anchorQuote } from '@/lib/workspace-domain';

export function MyWorkView({
  state,
  variants,
  onOpen,
  onOpenCard,
  onEdit,
  saving,
  savedTo,
  signedIn,
  legacyCount,
  onAdoptLegacy,
  onOpenSession,
}: {
  state: WorkspaceState;
  variants: PracticeVariant[];
  onOpen: (a: TextAnchor) => void;
  onOpenCard: (id: string) => void;
  onEdit: (c: CustomPracticeCard) => void;
  saving: boolean;
  savedTo: 'device' | 'cloud' | 'offline';
  signedIn: boolean;
  legacyCount: number;
  onAdoptLegacy: () => void;
  onOpenSession: () => void;
}) {
  return (
    <main id="main-content" className="content-page">
      <div className="work-layout">
        <div>
          <section className="panel work-section">
            <h2>
              Сохранённые цитаты <span className="count-note">{state.annotations.length}</span>
            </h2>
            {state.annotations.length ? (
              state.annotations
                .slice()
                .reverse()
                .map((a) => {
                  const source = state.sourceReferences.find(
                    (s) => s.editionId === a.anchor.versionId,
                  );
                  const links = state.linkDecisions.filter((l) => l.annotationId === a.id);
                  return (
                    <article className="work-item" key={a.id}>
                      <div className="work-item-header">
                        <h3>{source?.title ?? a.anchor.documentId}</h3>
                        <button
                          className="button button-quiet small"
                          onClick={() => onOpen(a.anchor)}
                        >
                          К источнику <ArrowUpRight size={14} />
                        </button>
                      </div>
                      <blockquote>{anchorQuote(a.anchor)}</blockquote>
                      {a.note ? <p>{a.note}</p> : null}
                      <div className="work-meta">
                        <span>{a.anchor.spans.length} фрагм.</span>
                        <span>{new Date(a.createdAt).toLocaleDateString('ru')}</span>
                      </div>
                      {links.map((l) => (
                        <div key={l.id} className="evidence-state-row">
                          <button
                            className="button button-quiet small"
                            onClick={() => onOpenCard(l.practiceId)}
                          >
                            <Link2 size={12} />
                            {variants.find((v) => v.id === l.practiceId)?.title ??
                              'Карточка из импорта'}
                          </button>
                          <span
                            className={`status ${l.status === 'contradicted' ? 'bad' : l.status === 'verified' ? 'blue' : 'warn'}`}
                          >
                            {l.origin === 'imported'
                              ? 'Импорт · проверить'
                              : l.status === 'verified'
                                ? 'Поля проверены'
                                : l.status === 'contradicted'
                                  ? 'Расхождение'
                                  : 'Частичная связь'}
                          </span>
                        </div>
                      ))}
                    </article>
                  );
                })
            ) : (
              <div className="empty-state">
                <div className="empty-icon">
                  <FileText size={25} />
                </div>
                <h3>Здесь будут ваши находки</h3>
                <p>Выберите фрагмент в программе и сохраните цитату или свяжите её с практикой.</p>
              </div>
            )}
          </section>
          <section className="panel work-section" style={{ marginTop: 18 }}>
            <h2>
              Авторские карточки <span className="count-note">{state.customCards.length}</span>
            </h2>
            {state.customCards.map((c) => (
              <article className="work-item" key={c.id}>
                <div className="work-item-header">
                  <h3>{c.title}</h3>
                  <div className="inline-actions">
                    <button className="button button-quiet small" onClick={() => onEdit(c)}>
                      <PenLine size={13} />
                      Изменить
                    </button>
                    <button className="button button-quiet small" onClick={() => onOpenCard(c.id)}>
                      Открыть <ArrowUpRight size={13} />
                    </button>
                  </div>
                </div>
                <p>{c.mechanism}</p>
              </article>
            ))}
            {!state.customCards.length ? (
              <p className="form-hint">
                Новые решения и недостающие варианты можно создавать в модуле документов.
              </p>
            ) : null}
          </section>
        </div>
        <aside>
          <section className="panel profile-panel">
            <h2><CheckCircle2 size={19} aria-hidden="true" /> Сохранение работы</h2>
            <p className="form-hint">
              {signedIn
                ? savedTo === 'offline'
                  ? 'Цитаты, карточки и проверки сохраняются в вашем профиле на Mac преподавателя. Дорожные карты и результаты обсуждения сохраняются там же.'
                  : 'Цитаты, карточки и проверки сохраняются в вашем профиле на платформе. Дорожные карты и результаты обсуждения сохраняются там же.'
                : 'Сейчас заметки доступны в этом браузере. Войдите по email, чтобы сохранять работу в своём профиле и возвращаться к ней с других устройств.'}
            </p>
            {signedIn ? (
              <p className="form-hint" style={{ marginTop: 14 }}>
                Чтобы изменить имя, нажмите на своё ФИО в шапке.
              </p>
            ) : (
              <button className="button button-primary block" onClick={onOpenSession}
                style={{ marginTop: 16 }}>
                <LogIn size={16} /> Войти по email
              </button>
            )}
            <div className="divider" />
            <h2>Готовая дорожная карта</h2>
            <p className="form-hint" style={{ marginBottom: 14 }}>
              В занятии откройте дорожную карту своей территории. В разделе «Проверка и экспорт»
              можно зафиксировать версию и скачать документ в DOCX или PDF.
            </p>
            <button className="button button-secondary block" onClick={onOpenSession}>
              <ArrowUpRight size={16} /> Открыть занятие
            </button>
            {signedIn && legacyCount > 0 ? (
              <>
                <div className="divider" />
                <h2>Ранее начатые заметки</h2>
                <p className="form-hint" style={{ marginBottom: 14 }}>
                  На этом устройстве найдены записи, созданные до входа: {legacyCount}.
                  Если это ваша работа, добавьте её в свой профиль. Совпадающие записи останутся
                  без изменений; прежние проверки будут отмечены для повторного сопоставления.
                </p>
                <button className="button button-secondary block" disabled={saving}
                  onClick={onAdoptLegacy}>Добавить прежние заметки</button>
              </>
            ) : null}
          </section>
        </aside>
      </div>
    </main>
  );
}
