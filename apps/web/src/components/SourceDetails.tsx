import { ExternalLink } from 'lucide-react';
import type { CorpusDocument, CorpusEntry } from '@/lib/corpus';
import { safeExternalUrl } from '@/lib/corpus';
import { Modal } from './Modal';
export function SourceDetails({
  entry,
  doc,
  onClose,
}: {
  entry: CorpusEntry;
  doc?: CorpusDocument;
  onClose: () => void;
}) {
  const original = safeExternalUrl(entry.source.pdfUrl ?? entry.source.sourceUrl),
    official = safeExternalUrl(entry.source.officialUrl);
  return (
    <Modal
      title="Паспорт источника"
      onClose={onClose}
      wide
      actions={
        <button className="button button-secondary" onClick={onClose}>
          Закрыть
        </button>
      }
    >
      <p className="modal-intro">{entry.title}</p>
      <dl className="source-detail">
        <dt>Территория</dt>
        <dd>{entry.territory}</dd>
        <dt>Документ</dt>
        <dd>{entry.source.act ?? 'Не указан'}</dd>
        <dt>Редакция</dt>
        <dd>{entry.source.edition || 'Дата редакции в паспорте не указана'}</dd>
        <dt>Период</dt>
        <dd>{entry.source.period?.label ?? 'Не указан'}</dd>
        <dt>Объём</dt>
        <dd>
          {entry.pageCount} страниц
          {entry.blockCount ? `, ${entry.blockCount} текстовых блоков` : ''}
        </dd>
        <dt>Идентификатор</dt>
        <dd className="tiny-code">{entry.versionId ?? 'Текст не подготовлен'}</dd>
        <dt>SHA-256</dt>
        <dd className="tiny-code">{entry.source.sha256 ?? 'Контрольная сумма отсутствует'}</dd>
        <dt>Полнота</dt>
        <dd>
          {entry.quality === 'full'
            ? 'Полный файл в исходном корпусе'
            : entry.quality === 'partial'
              ? 'Частичный файл в исходном корпусе'
              : 'Смотрите сведения о доступности'}
        </dd>
      </dl>
      <div className="notice info">
        {entry.source.legalCurrencyNote ??
          'Сохранена редакция исходного корпуса. Действие норм на текущую дату требует отдельной проверки.'}
      </div>
      {doc?.extraction?.note ? <p className="modal-intro">{doc.extraction.note}</p> : null}
      {entry.extractionWarnings?.length ? (
        <p className="notice">
          {entry.emptyPages?.length
            ? `Извлечённый текст отсутствует на страницах PDF: ${entry.emptyPages.join(', ')}. Для этих страниц откройте оригинал.`
            : 'Качество извлечённого текста требует проверки по оригиналу.'}
        </p>
      ) : null}
      {entry.source.qualityNote ? <p className="modal-intro">{entry.source.qualityNote}</p> : null}
      <p className="modal-intro">
        Ссылки на фрагменты относятся к неизменяемому тексту этой редакции. Номер страницы
        соответствует порядку страниц PDF. Табличные условия и примечания проверяются по оригиналу.
      </p>
      <div className="inline-actions">
        {original ? (
          <a className="button button-primary" href={original} target="_blank" rel="noreferrer">
            <ExternalLink size={15} />
            Исходный PDF
          </a>
        ) : null}
        {official ? (
          <a className="button button-secondary" href={official} target="_blank" rel="noreferrer">
            Официальная публикация
          </a>
        ) : null}
      </div>
    </Modal>
  );
}
