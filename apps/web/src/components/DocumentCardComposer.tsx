import { useMemo } from 'react';
import { FileText, Pencil, Plus, Send } from 'lucide-react';
import { validateAnchor } from '@domain/index';
import type { PracticeOccurrence, TextAnchor } from '@domain/index';
import type { CorpusDocument, CorpusEntry, RichVariant } from '@/lib/corpus';

export interface DocumentCardComposerProps {
  doc?: CorpusDocument;
  entry: CorpusEntry;
  selection: TextAnchor | null;
  selected: RichVariant | null;
  occurrences: PracticeOccurrence[];
  onCreate: () => void;
  onEdit?: () => void;
  onOpenCitation: (occurrence: PracticeOccurrence) => void;
  onShare?: () => void;
  shareBusy?: boolean;
  busy: boolean;
}

/** An author's editable card and its unchanged source excerpts are separate materials. */
export function DocumentCardComposer({
  doc, entry, selection, selected, occurrences, onCreate, onEdit, onOpenCitation,
  onShare, shareBusy = false, busy,
}: DocumentCardComposerProps) {
  const anchorValid = useMemo(() => Boolean(selection && doc && doc.entry.id === entry.id
    && validateAnchor(doc.version, selection).valid), [doc, entry.id, selection]);
  const linked = selected ? occurrences.filter(occurrence => selected.occurrenceIds.includes(occurrence.id)) : [];
  const fields = selected ? [
    ['Получатели', selected.eligibility],
    ['Размер и объём', selected.amount],
    ['Условия предоставления', selected.conditions?.join('\n')],
  ].filter((field): field is [string, string] => Boolean(field[1])) : [];

  return <aside className="panel inspector document-card-composer" aria-label="Карточка по документу">
    <h2>Карточка по документу</h2>
    <p className="inspector-hint">Регион: <strong>{entry.territory}</strong></p>
    {selected ? <>
      <article aria-label="Сохранённая карточка">
        <h3>{selected.title}</h3>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.mechanism}</p>
        {fields.length ? <dl>
          {fields.map(([label, value]) => <div key={label}>
            <dt><strong>{label}</strong></dt>
            <dd style={{ margin: '4px 0 12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</dd>
          </div>)}
        </dl> : null}
      </article>
      <div className="inspector-actions">
        {onEdit ? <button type="button" className="button button-secondary" disabled={busy} onClick={onEdit}>
          <Pencil size={16} aria-hidden="true" />Редактировать карточку
        </button> : null}
        {onShare ? <button type="button" className="button button-primary" disabled={busy || shareBusy || !linked.length} onClick={onShare}>
          <Send size={16} aria-hidden="true" />{shareBusy ? 'Проверка…' : 'Отправить в занятие'}
        </button> : null}
      </div>
      <h3>Исходные цитаты · {linked.reduce((count, occurrence) => count + occurrence.anchor.spans.length, 0)} фрагм.</h3>
      {linked.length ? linked.map((occurrence, occurrenceIndex) => <section key={occurrence.id}
        aria-label={`Цитата ${occurrenceIndex + 1}`}>
        {occurrence.anchor.spans.map((span, spanIndex) => <blockquote className="quote-panel"
          style={{ marginBottom: 12 }} key={`${span.blockId}:${span.start}:${span.end}`}>
          <div className="quote-text" style={{ maxHeight: 'none', overflow: 'visible' }}>{span.exact}</div>
          <footer><FileText size={12} aria-hidden="true" />Фрагмент {spanIndex + 1} из {occurrence.anchor.spans.length}</footer>
        </blockquote>)}
        <button type="button" className="button button-quiet small" disabled={busy}
          onClick={() => onOpenCitation(occurrence)}>Открыть цитату {occurrenceIndex + 1}</button>
      </section>) : <p className="inspector-hint">У этой карточки пока нет сохранённых цитат.</p>}
    </> : selection ? <>
      <p className="inspector-hint">Выбрано фрагментов: <strong>{selection.spans.length}</strong></p>
      {selection.spans.map((span, index) => <blockquote className="quote-panel" style={{ marginBottom: 12 }}
        key={`${span.blockId}:${span.start}:${span.end}`}>
        <div className="quote-text" style={{ maxHeight: 'none', overflow: 'visible' }}>{span.exact}</div>
        <footer><FileText size={12} aria-hidden="true" />{entry.territory} · Фрагмент {index + 1} из {selection.spans.length}</footer>
      </blockquote>)}
      {!anchorValid ? <p className="notice warning" role="alert">{doc
        ? 'Выделение не совпадает с открытой редакцией. Выберите фрагменты заново.'
        : 'Дождитесь загрузки документа, чтобы создать карточку.'}</p> : null}
      <p className="inspector-hint">При создании карточки можно изменить название и содержание. Исходные цитаты сохранятся целиком.</p>
      <div className="inspector-actions">
        <button type="button" className="button button-primary" disabled={busy || !anchorValid} onClick={onCreate}>
          <Plus size={16} aria-hidden="true" />Создать карточку
        </button>
      </div>
    </> : <>
      <div className="no-selection-tip"><strong>Начните с документа</strong>Соберите цитаты, на основе которых хотите написать карточку.</div>
      <div className="help-steps">
        <div className="help-step"><span><strong>Найдите нужное место.</strong> Поиск охватывает весь документ.</span></div>
        <div className="help-step"><span><strong>Выберите один или несколько фрагментов.</strong> Можно выделить текст или добавить абзацы в подборку.</span></div>
        <div className="help-step"><span><strong>Создайте карточку.</strong> Задайте название и отредактируйте содержание; исходные цитаты сохранятся отдельно.</span></div>
      </div>
      <div className="inspector-actions"><button type="button" className="button button-primary" disabled>
        <Plus size={16} aria-hidden="true" />Создать карточку
      </button></div>
    </>}
  </aside>;
}
