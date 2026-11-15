import { ArrowRight, Baby, BookOpen, BriefcaseBusiness, GraduationCap, Heart, HeartPulse, School, Shapes, Users, UsersRound } from 'lucide-react';
import { firstChildStages, lifecycleStageLabels, mainLifecycleStages } from './lifecycle-stages';
import type { LifecycleStage } from './lifecycle-stages';

const icons = {
  education: GraduationCap, work: BriefcaseBusiness, first_child: Baby,
  second_child: Users, third_plus_child: UsersRound, conception: Heart,
  pregnancy: HeartPulse, early_childhood: Shapes, preschool: School, school: BookOpen,
};

export function LifecycleStageTrack({ counts, selected, onSelect }: {
  counts: ReadonlyMap<LifecycleStage, number>;
  selected: LifecycleStage | null;
  onSelect: (stage: LifecycleStage) => void;
}) {
  function row(stages: readonly LifecycleStage[], label: string, branch = false) {
    return <ol className={`lifecycle-track${branch ? ' lifecycle-track-branch' : ''}`} role="list" aria-label={label}>
      {stages.map((stage, index) => {
        const count = counts.get(stage) ?? 0;
        const Icon = icons[stage];
        return <li key={stage}>
          <button type="button" aria-label={lifecycleStageLabels[stage]} aria-pressed={selected === stage}
            aria-description={count ? `Барьеров: ${count}` : undefined} onClick={() => onSelect(stage)}>
            <Icon size={19} aria-hidden="true" />
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
      <p className="lifecycle-branch-label">Первый ребёнок: от зачатия до школы</p>
      {row(firstChildStages, 'Этапы, связанные с первым ребёнком', true)}
    </div>
  </div>;
}
