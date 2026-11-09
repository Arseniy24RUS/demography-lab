import { useState } from 'react';
import { ArrowUpRight, FileText, Upload, Download, Save, PenLine, Link2 } from 'lucide-react';
import type { WorkspaceState, LocalProfile, CustomPracticeCard } from '@/storage';
import type { PracticeVariant, TextAnchor } from '@domain/index';
import { anchorQuote } from '@/lib/workspace-domain';

export function MyWorkView({
  state,
  variants,
  onOpen,
  onOpenCard,
  onEdit,
  onProfile,
  onExport,
  onImport,
  busy,
}: {
  state: WorkspaceState;
  variants: PracticeVariant[];
  onOpen: (a: TextAnchor) => void;
  onOpenCard: (id: string) => void;
  onEdit: (c: CustomPracticeCard) => void;
  onProfile: (p: LocalProfile) => Promise<void>;
  onExport: () => void;
  onImport: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState(state.profile?.displayName ?? '');
  const [email, setEmail] = useState(state.profile?.email ?? '');
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
            <h2>Автор заметок</h2>
            <p className="form-hint" style={{ marginBottom: 16 }}>
              Необязательно. Сведения хранятся на этом устройстве. Архив работы по умолчанию не
              содержит имя и email.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onProfile({
                  displayName: name.trim(),
                  ...(email.trim() ? { email: email.trim() } : {}),
                });
              }}
            >
              <div className="profile-fields">
                <div className="form-field">
                  <label htmlFor="profile-name">ФИО</label>
                  <input
                    id="profile-name"
                    className="input"
                    value={name}
                    maxLength={180}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="profile-email">Email</label>
                  <input
                    id="profile-email"
                    className="input"
                    type="email"
                    value={email}
                    maxLength={254}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="button button-secondary block"
                disabled={!name.trim() || busy}
              >
                <Save size={15} />
                Сохранить сведения
              </button>
            </form>
            <div className="divider" />
            <h2>Перенос работы</h2>
            <p className="form-hint" style={{ marginBottom: 14 }}>
              Сохраните цитаты, карточки и решения в ZIP. На другом устройстве архив можно добавить
              к текущей тетради. Импортированные проверки потребуют подтверждения.
            </p>
            <div className="inspector-actions">
              <button className="button button-primary block" onClick={onExport}>
                <Download size={15} />
                Сохранить архив
              </button>
              <button className="button button-secondary block" onClick={onImport}>
                <Upload size={15} />
                Импортировать работу
              </button>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
