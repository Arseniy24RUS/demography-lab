import { modernLifeStages } from '../../../../../packages/barriers/types';

export const lifecycleStages = modernLifeStages;
export type LifecycleStage = (typeof lifecycleStages)[number];
export const mainLifecycleStages = ['education', 'work', 'first_child', 'second_child', 'third_plus_child'] as const satisfies readonly LifecycleStage[];
export const firstChildStages = ['conception', 'pregnancy', 'early_childhood', 'preschool', 'school'] as const satisfies readonly LifecycleStage[];

export const lifecycleStageLabels: Record<LifecycleStage, string> = {
  education: 'Обучение в вузе/сузе',
  work: 'Работа',
  first_child: 'Первый ребёнок',
  second_child: 'Второй ребёнок',
  third_plus_child: 'Третий ребёнок и следующие',
  conception: 'Зачатие',
  pregnancy: 'Беременность',
  early_childhood: '1–3 года',
  preschool: 'Дошкольный возраст',
  school: 'Школьный возраст',
};

export function isLifecycleStage(stage: string): stage is LifecycleStage {
  return lifecycleStages.some(item => item === stage);
}
