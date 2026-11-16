import { useMemo, useState } from 'react';
import { Save, FileText } from 'lucide-react';
import { codePointLength } from '@domain/index';
import type { PracticeVariant, TextAnchor } from '@domain/index';
import type { CorpusEntry } from '@/lib/corpus';
import { anchorQuote } from '@/lib/workspace-domain';
import { Modal } from './Modal';
export interface CardForm {
  title: string;
  mechanism: string;
  eligibility: string;
  amount: string;
  conditions: string[];
}
export function CardEditor({
  entry,
  anchor,
  initial,
  onClose,
  onSave,
  busy,
}: {
  entry: CorpusEntry;
  anchor: TextAnchor | null;
  initial?: PracticeVariant;
  onClose: () => void;
  onSave: (form: CardForm) => Promise<void>;
  busy: boolean;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const { sourceQuote, sourceTooLong } = useMemo(() => {
    const quote = anchor ? anchorQuote(anchor) : '';
    return { sourceQuote: quote, sourceTooLong: codePointLength(quote) > 4000 };
  }, [anchor]);
  const [mechanism, setMechanism] = useState(initial?.mechanism ?? (sourceTooLong ? '' : sourceQuote));
  const [eligibility, setEligibility] = useState(initial?.eligibility ?? '');
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [conditions, setConditions] = useState(initial?.conditions?.join('\n') ?? '');
  const enabled = title.trim().length >= 5 && mechanism.trim().length >= 10;
  return (
    <Modal
      title={initial ? 'Редактирование карточки' : 'Новая карточка по документу'}
      onClose={onClose}
      wide
      actions={
        <>
          <button className="button button-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="button button-primary"
            disabled={!enabled || busy}
            onClick={() =>
              onSave({
                title: title.trim(),
                mechanism: mechanism.trim(),
                eligibility: eligibility.trim(),
                amount: amount.trim(),
                conditions: conditions
                  .split('\n')
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          >
            <Save size={15} />
            {busy ? 'Сохранение…' : 'Сохранить карточку'}
          </button>
        </>
      }
    >
      <p className="modal-intro">
        Регион: <strong>{entry.territory}</strong>. Назовите карточку и отредактируйте её содержание:
        можно пересказать выбранный текст своими словами. Исходные цитаты сохранятся отдельно без изменений.
      </p>
      {anchor ? (
        <blockquote className="quote-panel" style={{ marginBottom: 20 }}>
          {anchor.spans.map((span, index) => <div key={`${span.blockId}:${span.start}:${span.end}`}
            style={{ marginTop: index ? 12 : 0 }}>
            <div className="quote-text" style={{ maxHeight: 'none', overflow: 'visible' }}>{span.exact}</div>
          </div>)}
          <footer>
            <FileText size={12} />
            {anchor.spans.length} фрагм. · Исходные цитаты сохранятся вместе с карточкой
          </footer>
        </blockquote>
      ) : (
        <div className="notice info">
          {initial ? 'Ранее сохранённые исходные цитаты останутся у карточки.'
            : 'Карточка будет сохранена как авторский черновик без исходных цитат.'}
        </div>
      )}
      {!initial && sourceTooLong ? <p className="form-hint">В выбранном тексте больше 4000 знаков.
        Кратко изложите содержание карточки своими словами; исходные цитаты сохранятся целиком.</p> : null}
      <div className="card-editor-grid">
        <div className="form-field full">
          <label htmlFor="card-title">Название практики</label>
          <input
            id="card-title"
            className="input"
            maxLength={300}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Что предлагается семье?"
          />
        </div>
        <div className="form-field full">
          <label htmlFor="card-mechanism">Содержание карточки</label>
          <textarea
            id="card-mechanism"
            className="input"
            maxLength={4000}
            value={mechanism}
            onChange={(e) => setMechanism(e.target.value)}
            placeholder="Опишите выбранную меру и то, как она работает"
          />
        </div>
        <div className="form-field">
          <label htmlFor="card-eligibility">Получатели</label>
          <textarea
            id="card-eligibility"
            className="input"
            maxLength={3000}
            value={eligibility}
            onChange={(e) => setEligibility(e.target.value)}
            placeholder="Категория семей, возраст, очерёдность рождения"
          />
        </div>
        <div className="form-field">
          <label htmlFor="card-amount">Размер и объём</label>
          <textarea
            id="card-amount"
            className="input"
            maxLength={2000}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Сумма, периодичность, объём услуги — если указаны"
          />
        </div>
        <div className="form-field full">
          <label htmlFor="card-conditions">Условия предоставления</label>
          <textarea
            id="card-conditions"
            className="input"
            maxLength={5000}
            value={conditions}
            onChange={(e) => setConditions(e.target.value)}
            placeholder="Каждое условие с новой строки"
          />
        </div>
      </div>
      {initial ? (
        <p className="form-hint">
          Изменения сохранятся в карточке. Ранее сохранённые исходные цитаты останутся неизменными.
        </p>
      ) : null}
    </Modal>
  );
}
