import { useEffect, useState } from 'react';
import { ArrowUpRight, FileText } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { PracticeDetails } from '@/components/workshop/PracticeDetails';
import type { BarrierEvidence } from '../../../../../packages/barriers/types';
import type { FrozenVariant } from '../../../../../packages/workshop/types';
import type { BarrierBoardContext } from './barriers-ui';
import { Busy, errorText, TaskMessage } from './common';

export function EvidenceDialog({
  context,
  evidenceId,
  onClose,
}: {
  context: BarrierBoardContext;
  evidenceId: string;
  onClose: () => void;
}) {
  const [evidence, setEvidence] = useState<BarrierEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [variant, setVariant] = useState<FrozenVariant | null>(null);
  useEffect(() => {
    let active = true;
    setError(null);
    setEvidence(null);
    void context.actions.readEvidence(evidenceId).then(
      (value) => {
        if (active) setEvidence(value);
      },
      (cause) => {
        if (active) setError(errorText(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [evidenceId, retry, context.actions.readEvidence]);
  if (variant)
    return (
      <PracticeDetails
        variant={{
          id: variant.submissionId,
          revision: variant.submissionRevision,
          bundle: variant.bundle,
        }}
        regions={context.regions}
        onClose={() => setVariant(null)}
        onOpenSource={(anchor) => {
          onClose();
          context.onOpenSource(anchor);
        }}
      />
    );
  return (
    <Modal title="Сохранённые основания связи" onClose={onClose} wide>
      <div className="barrier-evidence">
        <p className="barrier-note">
          Это сохранённая редакция семейства и исходных карточек на момент подтверждения связи.
          Последующие изменения документов или карточек её не подменяют.
        </p>
        {!evidence && !error ? <Busy>Загружаем точные основания…</Busy> : null}
        <TaskMessage error={error} />
        {error ? (
          <button
            className="button button-secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            Повторить загрузку
          </button>
        ) : null}
        {evidence ? (
          <>
            <h3>{evidence.title}</h3>
            <p>{evidence.mechanism}</p>
            {evidence.rationale ? <p className="barrier-muted">{evidence.rationale}</p> : null}
            <p className="barrier-muted">
              Редакция семейства {evidence.familyRevision} · региональных вариантов: {evidence.variants.length}
            </p>
            <div className="barrier-evidence-variants">
              {evidence.variants.map((item) => (
                <button
                  className="barrier-evidence-variant"
                  key={item.submissionId}
                  onClick={() => setVariant(item)}
                >
                  <FileText size={21} />
                  <span>
                    <strong>{item.bundle.practice.title}</strong>
                    <small>
                      {context.regions.find((region) => region.id === item.bundle.practice.regionId)
                        ?.name ?? item.bundle.practice.regionId}{' '}
                      · редакция {item.submissionRevision} · цитат: {item.bundle.occurrences.length}
                    </small>
                  </span>
                  <ArrowUpRight size={18} />
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
