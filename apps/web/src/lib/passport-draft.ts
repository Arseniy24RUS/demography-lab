import type { RoadmapPassportData } from '../../../../packages/roadmaps/types';

type Field = Exclude<keyof RoadmapPassportData, 'defenseDate'>;
export type PassportChanges = Partial<Pick<RoadmapPassportData, Field>>;
export const passportFieldGroups = [
  ['title'], ['targetGroup'], ['partners'], ['goal', 'smartChecks'], ['objectives'],
  ['startDate', 'endDate'], ['expectedResult'], ['normativeResources'], ['managementResources'],
  ['researchResources'], ['humanResources'], ['economicResources'], ['demographicResources'],
  ['materialResources'], ['institutionalResources'], ['informationResources'], ['technologyResources'],
] as const satisfies readonly (readonly Field[])[];

const empty = (value: unknown) => value === undefined || value === '' || (Array.isArray(value) && !value.length);
export const samePassportValue = (a: unknown, b: unknown) => (empty(a) && empty(b)) || JSON.stringify(a) === JSON.stringify(b);

export function reconcilePassport(base: RoadmapPassportData, changes: PassportChanges, latest: RoadmapPassportData) {
  const data = { ...latest };
  const conflicts: Field[] = [];
  const local = { ...base, ...changes };
  for (const group of passportFieldGroups) {
    if (!group.some(field => Object.hasOwn(changes, field) && !samePassportValue(local[field], base[field]))) continue;
    if (group.every(field => samePassportValue(local[field], latest[field]))) continue;
    if (group.some(field => !samePassportValue(base[field], latest[field]))) conflicts.push(group[0]);
    for (const field of group) Object.assign(data, { [field]: local[field] });
  }
  return { data, conflicts };
}
