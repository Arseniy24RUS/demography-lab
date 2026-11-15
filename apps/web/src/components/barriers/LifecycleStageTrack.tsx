import { ArrowRight } from 'lucide-react';
import { firstChildStages, lifecycleStageLabels, mainLifecycleStages } from './lifecycle-stages';
import type { LifecycleStage } from './lifecycle-stages';

export function LifecycleStageTrack({ counts, selected, onSelect }: {
  counts: ReadonlyMap<LifecycleStage, number>;
  selected: LifecycleStage | null;
  onSelect: (stage: LifecycleStage) => void;
}) {
  function row(stages: readonly LifecycleStage[], label: string) {
    return <ol className="lifecycle-track" role="list" aria-label={label}>
      {stages.map((stage, index) => {
        const count = counts.get(stage) ?? 0;
        return <li key={stage}>
          <button type="button" aria-label={lifecycleStageLabels[stage]} aria-pressed={selected === stage}
            aria-description={count ? `Барьеров: ${count}` : undefined} onClick={() => onSelect(stage)}>
            <span>{lifecycleStageLabels[stage]}</span>
            {count ? <span className="lifecycle-stage-count" aria-hidden="true">{count}</span> : null}
          </button>
          {index < stages.length - 1 ? <ArrowRight className="lifecycle-stage-arrow" size={16} aria-hidden="true" /> : null}
        </li>;
      })}
    </ol>;
  }

  return <div className="lifecycle-track-scroll" role="group" aria-label="Этапы жизни семьи" tabIndex={0}>
    <div className="lifecycle-diagram">
      {row(mainLifecycleStages, 'Основной путь')}
      <div className="lifecycle-branch-stem" aria-hidden="true"><span /></div>
      {row(firstChildStages, 'Этапы, связанные с первым ребёнком')}
    </div>
  </div>;
}
