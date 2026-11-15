export type FactorStage = 'flipchart' | 'objective';
export type WorkshopStage = FactorStage | 'barriers' | 'regions' | 'board' | 'solutions' | 'roadmaps';
export type ReferenceView = 'documents' | 'practices' | 'territories' | 'work';

export const isFactorStage = (stage: WorkshopStage): stage is FactorStage =>
  stage === 'flipchart' || stage === 'objective';

export function readWorkshopStage(stage: string | null): WorkshopStage {
  switch (stage) {
    case 'objective': case 'barriers': case 'regions': case 'board': case 'solutions': case 'roadmaps':
      return stage;
    default:
      return 'flipchart';
  }
}
