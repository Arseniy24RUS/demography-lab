import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Link2,
  FileText,
  Plus,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ShieldCheck,
  Search,
  Send,
} from 'lucide-react';
import {
  evaluatePracticeEvidence,
  rankPracticeCandidates,
  PRACTICE_FIELDS,
  validateAnchor,
} from '@domain/index';
import type {
  PracticeVariant,
  PracticeOccurrence,
  DocumentVersion,
  TextAnchor,
  PracticeField,
} from '@domain/index';
import type { CorpusDocument, CorpusEntry, RichVariant, CatalogComparison } from '@/lib/corpus';
import { anchorQuote, emptyReview, fieldLabels, fieldValue } from '@/lib/workspace-domain';
import { implementationLabel } from '@/lib/practice-status';
import { isFamilyCatalogVariant } from '@/lib/family-catalog';
import { safeExternalUrl } from '@/lib/corpus';
import { CatalogComparisonView } from './CatalogComparisonView';
import type { FieldReview } from '@/lib/workspace-domain';

const statusLabel = {
  unknown: 'Не заполнено',
  unsupported: 'Требует проверки',
  partial: 'Частичное основание',
  supported: 'Проверено по цитате',
  contradicted: 'Есть расхождение',
};
const statusClass = {
  unknown: 'neutral',
  unsupported: 'neutral',
  partial: 'warn',
  supported: 'good',
  contradicted: 'bad',
};
export function EvidenceInspector({
  doc,
  entry,
  selection,
  variants,
  occurrences,
  versions,
  selected,
  onSelect,
  onOpenCitation,
  onSave,
  onCreate,
  busy,
  comparisons,
  catalogLoaded,
  catalogBusy,
  onLoadCatalog,
  onShare,
  shareBusy,
}: {
  doc?: CorpusDocument;
  entry: CorpusEntry;
  selection: TextAnchor | null;
  variants: RichVariant[];
  occurrences: PracticeOccurrence[];
  versions: DocumentVersion[];
  selected: RichVariant | null;
  onSelect: (id: string | null) => void;
  onOpenCitation: (o: PracticeOccurrence) => void;
  onSave: (review: FieldReview, note: string) => Promise<void>;
  onCreate: () => void;
  busy: boolean;
  comparisons: CatalogComparison[];
  catalogLoaded: boolean;
  catalogBusy: boolean;
  onLoadCatalog: () => Promise<void>;
  onShare?: () => void;
  shareBusy?: boolean;
}) {
  const inspectorRef = useRef<HTMLElement>(null);
  const [filter, setFilter] = useState('');
  const [review, setReview] = useState<FieldReview>({ ...emptyReview });
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setReview({ ...emptyReview });
    setNote('');
    setConfirmed(false);
    if (inspectorRef.current) inspectorRef.current.scrollTop = 0;
  }, [selection?.id, selected?.id]);
  const candidates = useMemo(
    () =>
      selection && doc
        ? rankPracticeCandidates(doc.version, selection, variants, occurrences, {
            limit: 12,
            expected: { regionId: entry.regionId },
          })
        : [],
    [doc, selection, variants, occurrences, entry.regionId],
  );
  const fallback = useMemo(
    () => variants.filter((v) => v.regionId === entry.regionId),
    [variants, entry.regionId],
  );
  const filtered = useMemo(
    () =>
      filter.trim()
        ? variants
            .filter((v) =>
              `${v.title} ${v.mechanism}`
                .toLocaleLowerCase('ru')
                .includes(filter.toLocaleLowerCase('ru')),
            )
            .slice(0, 30)
        : selection
          ? candidates.map((c) => c.variant)
          : fallback.slice(0, 12),
    [variants, filter, selection, candidates, fallback],
  );
  const assessment = selected
    ? evaluatePracticeEvidence(selected, { occurrences, versions })
    : null;
  const linked = selected ? occurrences.filter((o) => selected.occurrenceIds.includes(o.id)) : [];
  const anchorValid = selection && doc ? validateAnchor(doc.version, selection).valid : false;
  const wrongRegion = Boolean(selection && selected && selected.regionId !== entry.regionId);
  const reviewedFields = selected
    ? PRACTICE_FIELDS.filter((f) => review[f] !== 'none' && fieldValue(selected, f))
    : [];
  const requiresNote = reviewedFields.some(
    (f) => review[f] === 'contradicts' || review[f] === 'partial',
  );
  const canSave = Boolean(
    selection &&
    selected &&
    anchorValid &&
    !wrongRegion &&
    confirmed &&
    reviewedFields.length &&
    (!requiresNote || note.trim().length >= 5),
  );
  return (
    <aside ref={inspectorRef} className="panel inspector" aria-label="Связь цитаты и практики">
      {selected && onShare ? (
        <button
          className="button button-secondary share-practice-button"
          disabled={shareBusy || linked.length === 0}
          onClick={onShare}
        >
          <Send size={16} />
          {shareBusy ? 'Проверка…' : 'Отправить в занятие'}
        </button>
      ) : null}
      <div className="detail-heading">
        <h2 style={{ marginBottom: 0 }}>Связь с практикой</h2>
        {selected ? (
          <button
            className="icon-button"
            aria-label="Вернуться к подбору карточки"
            onClick={() => onSelect(null)}
          >
            <ChevronLeft size={17} />
          </button>
        ) : null}
      </div>
      {selection ? (
        <>
          <blockquote className="quote-panel">
            <div className="quote-text">{anchorQuote(selection)}</div>
            <footer>
              <FileText size={12} />
              {entry.territory} · {selection.spans.length} фрагм.
            </footer>
          </blockquote>
          <p className="anchor-note">
            {anchorValid ? (
              <>
                <ShieldCheck size={12} /> Текст и позиции совпадают с выбранной редакцией
              </>
            ) : (
              'Цитата требует проверки по исходному тексту'
            )}
          </p>
        </>
      ) : !selected ? (
        <>
          <div className="no-selection-tip">
            <strong>Начните с документа</strong>Выделите текст мышью или нажмите «Выбрать фрагмент»
            под абзацем. Можно собрать цитату из нескольких блоков.
          </div>
          <div className="help-steps">
            <div className="help-step">
              <span>
                <strong>Найдите меру.</strong> Поиск охватывает весь документ.
              </span>
            </div>
            <div className="help-step">
              <span>
                <strong>Проверьте карточку.</strong> Для суммы, получателей и условий сохраняются
                отдельные основания.
              </span>
            </div>
            <div className="help-step">
              <span>
                <strong>Сохраните связь.</strong> Из карточки можно вернуться к точному фрагменту.
              </span>
            </div>
          </div>
        </>
      ) : (
        <p className="inspector-hint">
          У каждого поля карточки своё документальное основание. Откройте цитату, чтобы проверить
          контекст.
        </p>
      )}
      {selected ? (
        <>
          {selection ? <div className="evidence-connector" aria-hidden="true" /> : null}
          <div className="linked-card">
            <h3>{selected.title}</h3>
            <p className="card-category">
              {isFamilyCatalogVariant(selected)
                ? selected.scope === 'federal'
                  ? 'Федеральная мера · исходный каталог'
                  : 'Исходный каталог мер'
                : 'Региональный вариант практики'}
            </p>
            {implementationLabel(selected) ? (
              <p
                className={`implementation-status ${selected.implementationStatus === 'described-existing' ? '' : 'proposed'}`}
              >
                {implementationLabel(selected)}
              </p>
            ) : null}
            {isFamilyCatalogVariant(selected) ? (
              <div className="catalog-origin">
                <p>
                  Источник: {selected.provenance.sourceName}. Снимок{' '}
                  {new Date(selected.provenance.fetchedAt).toLocaleDateString('ru-RU')}.
                </p>
                <p>Документальные основания полей ещё нужно установить.</p>
                {safeExternalUrl(selected.sourceUrl) ? (
                  <a
                    href={safeExternalUrl(selected.sourceUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Открыть исходную карточку
                  </a>
                ) : null}
                {Array.isArray(selected.snapshot.detail?.notes) ? (
                  <details>
                    <summary>Примечания исходного каталога</summary>
                    {selected.snapshot.detail.notes
                      .filter((n: unknown) => typeof n === 'string')
                      .map((n: unknown, i: number) => (
                        <p key={i}>{String(n)}</p>
                      ))}
                  </details>
                ) : null}
              </div>
            ) : null}
            {PRACTICE_FIELDS.filter((f) => f !== 'title').map((field) => (
              <div className="field-row" key={field}>
                <div className="field-heading">
                  <strong>{fieldLabels[field]}</strong>
                  {assessment ? (
                    <span className={`status ${statusClass[assessment[field].status]}`}>
                      {statusLabel[assessment[field].status]}
                    </span>
                  ) : null}
                </div>
                <p>{fieldValue(selected, field) || 'Не заполнено'}</p>
                {selection && fieldValue(selected, field) ? (
                  <div className="field-controls">
                    <select
                      className="field-select"
                      aria-label={`Проверка поля ${fieldLabels[field]}`}
                      value={review[field]}
                      onChange={(e) => {
                        setReview({ ...review, [field]: e.target.value });
                        setConfirmed(false);
                      }}
                    >
                      <option value="none">Цитата: ещё не проверено</option>
                      <option value="supports">Подтверждает поле</option>
                      <option value="partial">Подтверждает частично</option>
                      <option value="contradicts">Есть противоречие</option>
                    </select>
                  </div>
                ) : null}
                {assessment?.[field].validOccurrenceIds.length ? (
                  <button
                    className="field-evidence-action"
                    onClick={() => {
                      const o = occurrences.find(
                        (x) => x.id === assessment[field].validOccurrenceIds[0],
                      );
                      if (o) onOpenCitation(o);
                    }}
                  >
                    Открыть основание поля <ArrowUpRight size={11} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {comparisons
            .filter((c) => c.variantId === selected.id)
            .map((c) => (
              <CatalogComparisonView key={c.catalogId} comparison={c} />
            ))}
          {isFamilyCatalogVariant(selected)
            ? variants
                .filter((v) => !isFamilyCatalogVariant(v) && v.catalogId === selected.catalogId)
                .map((v) => (
                  <button key={v.id} className="candidate" onClick={() => onSelect(v.id)}>
                    <strong>Вариант по тексту программы</strong>
                    <small>{v.title}. Условия сохранены отдельно от каталога.</small>
                  </button>
                ))
            : null}
          {wrongRegion ? (
            <div className="notice">
              Карточка относится к другому региону. Создайте вариант для {entry.territory}, сохранив
              общий механизм. Региональные условия потребуют самостоятельной проверки.
            </div>
          ) : null}
          {selection && !wrongRegion ? (
            <>
              <label className="field-label" htmlFor="link-note">
                Обоснование связи{requiresNote ? ' · обязательно' : ''}
              </label>
              <textarea
                id="link-note"
                className="input"
                style={{ width: '100%', minHeight: 75, resize: 'vertical' }}
                maxLength={2000}
                placeholder="Что именно подтверждает цитата? Какие условия остаются неясными?"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <label className="text-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>Сопоставил выбранные поля с цитатой и её контекстом</span>
              </label>
              <div className="inspector-actions">
                <button
                  className="button button-primary block"
                  disabled={!canSave || busy}
                  onClick={() => onSave(review, note)}
                >
                  <Link2 size={16} />
                  {busy ? 'Сохранение…' : 'Подтвердить связь'}
                </button>
                <button className="button button-secondary block" onClick={onCreate}>
                  <Plus size={16} />
                  Создать свою карточку
                </button>
              </div>
            </>
          ) : (
            <div className="inspector-actions">
              <button className="button button-secondary block" onClick={onCreate}>
                <Plus size={16} />
                {wrongRegion ? 'Создать региональный вариант' : 'Создать карточку'}
              </button>
            </div>
          )}
          {linked.length ? (
            <>
              <div className="candidate-heading">
                Документальные фрагменты <span className="count-note">{linked.length}</span>
              </div>
              <div className="evidence-list">
                {linked.map((o) => (
                  <div className="evidence-item" key={o.id}>
                    <button onClick={() => onOpenCitation(o)}>
                      <FileText size={13} />
                      Открыть точную цитату <ArrowUpRight size={12} />
                    </button>
                    <p>
                      {anchorQuote(o.anchor).slice(0, 180)}
                      {anchorQuote(o.anchor).length > 180 ? '…' : ''}
                    </p>
                    <div className="meta">
                      <span
                        className={`status ${o.reviewStatus === 'verified' ? 'blue' : 'neutral'}`}
                      >
                        {o.reviewStatus === 'verified' ? 'Цитата подготовлена' : 'Нужна проверка'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="inspector-hint">
              У карточки ещё нет сохранённого фрагмента. Найдите основание в документе и добавьте
              связь.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="candidate-heading">
            {selection ? 'Подходящие карточки' : 'Практики этого региона'}
            <span className="count-note">{filtered.length}</span>
          </div>
          <div className="search-field" style={{ marginBottom: 12 }}>
            <Search size={14} />
            <input
              className="input"
              aria-label="Найти карточку практики"
              placeholder="Найти карточку"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {filtered.map((v) => {
            const c = candidates.find((x) => x.variantId === v.id);
            return (
              <button className="candidate" key={v.id} onClick={() => onSelect(v.id)}>
                <strong>{v.title}</strong>
                <small>
                  {c?.evidenceOccurrenceIds.length
                    ? 'Есть фрагмент в этой редакции'
                    : c
                      ? 'Совпадают значимые формулировки'
                      : v.mechanism.slice(0, 110)}
                  {c?.reasons.includes('different_region_variant') ? ' · другой регион' : ''}
                </small>
              </button>
            );
          })}
          {!filtered.length ? (
            <div className="empty-state" style={{ padding: '12px 4px' }}>
              <p>
                {selection
                  ? 'Подходящего варианта пока нет. Можно создать карточку по выделенному фрагменту.'
                  : 'Подготовленные карточки для региона пока отсутствуют. Создайте их по первоисточнику.'}
              </p>
            </div>
          ) : null}
          {selection ? (
            <p className="inspector-hint">
              Подбор предлагает варианты для проверки. Условия и размер поддержки сопоставляются
              отдельно.
            </p>
          ) : null}
          <div className="inspector-actions">
            {!catalogLoaded ? (
              <button
                className="button button-secondary block"
                disabled={catalogBusy}
                onClick={() => void onLoadCatalog().catch(() => {})}
              >
                {catalogBusy ? 'Загрузка каталога…' : 'Подключить полный каталог мер'}
              </button>
            ) : null}
            <button className="button button-secondary block" onClick={onCreate}>
              <Plus size={16} />
              Создать карточку
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
