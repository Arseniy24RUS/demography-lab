import { continueHistoricalTrend, historicalTrend } from './historical-trend';

export interface SexPair<T> { male: T; female: T }
export interface CohortHistory {
  year: number;
  /** Observed headcount at the beginning of the year when comparable to the base. */
  population?: number | null;
  births: number | null;
  deaths: number | null;
  arrivals: number | null;
  departures: number | null;
}
export interface CohortAssumption {
  year: number;
  fertilityRate: number;
  lifeExpectancy: SexPair<number>;
  arrivalsPerPerson: number;
  departuresPerPerson: number;
}
export interface CohortInput {
  territoryKey: string;
  name: string;
  baseYear: number;
  /** Single ages 0–79 followed by the open 80+ interval. */
  base: SexPair<number[]>;
  /** Fractions of total fertility in seven five-year groups starting at age 15. */
  fertilityShares: number[];
  /** Male live births per 100 female live births. */
  sexRatioAtBirth: number;
  /** Relative gross flow weights by sex and 17 five-year age bands, including 80+. */
  migrationProfile: { arrivals: SexPair<number[]>; departures: SexPair<number[]> };
  history: CohortHistory[];
  /** Annual age-cohort assumptions estimated in the original Spectrum preparation. */
  assumptions: CohortAssumption[];
  source: { summary: string; baseDate: string; citations: { label: string; url: string }[]; notes: string[] };
}
export interface CohortOptions {
  endYear: number;
  fertilityMultiplier?: number;
  mortalityMultiplier?: number;
  arrivalsMultiplier?: number;
  departuresMultiplier?: number;
}
export interface CohortYear extends SexPair<number[]> {
  /** Population at the beginning of this year and flows during the previous calendar year. */
  year: number;
  population: number;
  componentYear: number | null;
  births: number | null;
  deaths: number | null;
  arrivals: number | null;
  departures: number | null;
  netMigration: number | null;
  naturalChange: number | null;
  unrealizedDepartures: number;
}
export interface CohortProjection { baseYear: number; endYear: number; points: CohortYear[] }

const sexes = ['male', 'female'] as const;
const components = ['births', 'deaths', 'arrivals', 'departures'] as const;
type CohortComponent = typeof components[number];
const oldest = 80;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const pairSum = (values: SexPair<number[]>) => sum(values.male) + sum(values.female);

function multiplier(value = 1): number {
  if (!Number.isFinite(value) || value < 0 || value > 3)
    throw new Error('Коэффициенты должны быть в диапазоне от 0 до 3.');
  return value;
}

function bisect(low: number, high: number, increasingToTarget: (value: number) => boolean) {
  for (let iteration = 0; iteration < 44; iteration += 1) {
    const middle = (low + high) / 2;
    if (increasingToTarget(middle)) high = middle;
    else low = middle;
  }
  return (low + high) / 2;
}

/** Siler-like child and Kannisto adult hazard from the Mordovia model's local control. */
function mortalityTemplate(sex: (typeof sexes)[number], expectation: number): number[] {
  const ages = Array.from({ length: 121 }, (_, age) => {
    const adult = 1 / (1 + Math.exp(-(age - (sex === 'male' ? 88 : 92)) * .095));
    const infant = age === 0 ? (sex === 'male' ? .0035 : .0028) : 0;
    return adult + .00018 + .0004 * Math.exp(-age / 3) + infant;
  });
  const life = (intensity: number) => {
    let population = 1, years = 0;
    for (const [age, hazard] of ages.entries()) {
      const q = age === ages.length - 1 ? 1 : -Math.expm1(-hazard * intensity);
      years += population * (1 - (age === 0 ? .9 : .5) * q);
      population *= 1 - q;
    }
    return years;
  };
  const intensity = bisect(.001, 1000, value => life(value) <= expectation);
  let survivors = 1, openExposure = 0, openDeaths = 0;
  for (const [age, hazard] of ages.entries()) {
    const q = age === ages.length - 1 ? 1 : -Math.expm1(-hazard * intensity);
    if (age >= oldest) {
      openExposure += survivors;
      openDeaths += survivors * q;
    }
    survivors *= 1 - q;
  }
  return [...ages.slice(0, oldest).map(hazard => hazard * intensity), -Math.log1p(-openDeaths / openExposure)];
}

const deathProbability = (hazard: number, intensity: number) => -Math.expm1(-hazard * intensity);

function mortalityCount(population: SexPair<number[]>, hazards: SexPair<number[]>, births: SexPair<number>, intensity: number) {
  let total = 0;
  for (const sex of sexes) {
    total += births[sex] * deathProbability(hazards[sex][0]!, intensity);
    for (const [age, count] of population[sex].entries())
      total += count * deathProbability(hazards[sex][age]!, intensity);
  }
  return total;
}

function intensityForDeaths(population: SexPair<number[]>, hazards: SexPair<number[]>, births: SexPair<number>, target: number) {
  if (target <= 0) return 0;
  return bisect(0, 1000, scale => mortalityCount(population, hazards, births, scale) >= target);
}

function ageMigrationWeights(profile: SexPair<number[]>, population: SexPair<number[]>) {
  const weights: SexPair<number[]> = { male: [], female: [] };
  for (const sex of sexes) {
    for (const [group, weight] of profile[sex].entries()) {
      const band = population[sex].slice(group * 5, group * 5 + 5);
      const exposure = sum(band);
      for (const value of band) weights[sex].push(weight * (exposure ? value / exposure : 1 / band.length));
    }
  }
  const total = pairSum(weights);
  for (const sex of sexes) weights[sex] = weights[sex].map(weight => weight / total);
  return weights;
}

function completeOutflow(population: SexPair<number[]>, weights: SexPair<number[]>, requested: number) {
  if (!requested) return { male: Array(81).fill(0) as number[], female: Array(81).fill(0) as number[] };
  const distribute = (scale: number) => ({
    male: weights.male.map((weight, age) => Math.min(population.male[age]!, weight * scale)),
    female: weights.female.map((weight, age) => Math.min(population.female[age]!, weight * scale)),
  });
  const direct = distribute(requested);
  if (pairSum(direct) >= requested - 1e-9) return direct;

  let scaleLimit = 0, available = 0;
  for (const sex of sexes) {
    for (const [age, weight] of weights[sex].entries()) {
      if (!weight) continue;
      const capacity = population[sex][age]!;
      scaleLimit = Math.max(scaleLimit, capacity / weight);
      available += capacity;
    }
  }
  const target = Math.min(requested, available);
  if (target >= available) return distribute(scaleLimit);
  // Move a shortfall to other ages in the same direction profile while respecting stock capacity.
  const distributedCount = (scale: number) => sexes.reduce((total, sex) =>
    weights[sex].reduce((count, weight, age) => count + Math.min(population[sex][age]!, weight * scale), total), 0);
  return distribute(bisect(requested, scaleLimit, scale => distributedCount(scale) >= target));
}

const clampCount = (value: number) => Math.max(0, value);

/** Classroom projection. Years are calendar years and stock dates are 1 January. */
export function projectCohorts(input: CohortInput, options: CohortOptions): CohortProjection {
  const { base, baseYear, history } = input;
  const { endYear } = options;
  if (!Number.isInteger(endYear) || endYear <= baseYear || endYear > 2100)
    throw new Error(`Последний год должен быть целым от ${baseYear + 1} до 2100.`);
  const fertility = multiplier(options.fertilityMultiplier);
  const mortality = multiplier(options.mortalityMultiplier);
  const inflow = multiplier(options.arrivalsMultiplier);
  const outflow = multiplier(options.departuresMultiplier);
  const trends = Object.fromEntries(components.map(component => [
    component,
    historicalTrend(history.filter(row => row.year <= baseYear && row[component] !== null)
      .map(row => ({ year: row.year, value: row[component]! })).sort((a, b) => a.year - b.year)),
  ])) as Record<CohortComponent, ReturnType<typeof historicalTrend>>;
  const countAt = (component: CohortComponent, year: number) => {
    const trend = trends[component];
    const start = continueHistoricalTrend(trend, baseYear);
    const continued = continueHistoricalTrend(trend, year);
    // Preserve the adjacent count level and direction. A multiplicative continuation
    // keeps a declining component positive while it converges to modeled rates.
    if (year > baseYear && start > 0 && continued < start)
      return start * Math.exp((continued - start) / start);
    return clampCount(continued);
  };
  const exposure = (population: SexPair<number[]>) =>
    input.fertilityShares.reduce((total, weight, index) =>
      total + sum(population.female.slice(15 + index * 5, 20 + index * 5)) * weight / 5, 0);
  const splitBirths = (total: number) => ({
    male: total * input.sexRatioAtBirth / (100 + input.sexRatioAtBirth),
    female: total * 100 / (100 + input.sexRatioAtBirth),
  });
  const baseTotal = pairSum(base);
  if (!Number.isFinite(baseTotal) || baseTotal <= 0)
    throw new Error('Исходная численность для прогноза должна быть положительной.');
  const assumptions = new Map(input.assumptions.map((entry) => [entry.year, entry]));
  const points: CohortYear[] = [{
    year: baseYear, population: baseTotal, male: [...base.male], female: [...base.female],
    componentYear: null, births: null, deaths: null, arrivals: null, departures: null,
    netMigration: null, naturalChange: null, unrealizedDepartures: 0,
  }];
  for (let year = baseYear; year < endYear; year += 1) {
    const previous = points.at(-1)!;
    const assumption = assumptions.get(year);
    if (!assumption) throw new Error(`Отсутствуют возрастные параметры прогноза на ${year} год.`);
    // Continue the local history at the boundary, then approach the calibrated
    // TFR, longevity and population-relative migration rates from the Spectrum preparation.
    const historyWeight = Math.exp(-(year - baseYear) / 5);
    const blend = (historical: number, demographic: number) =>
      historyWeight * historical + (1 - historyWeight) * demographic;
    const fertilityExposure = exposure(previous);
    const baselineBirths = fertilityExposure > 0
      ? blend(countAt('births', year), fertilityExposure * assumption.fertilityRate) : 0;
    const births = baselineBirths * fertility;
    const baselineBirthShares = splitBirths(baselineBirths);
    const hazards = {
      male: mortalityTemplate('male', assumption.lifeExpectancy.male),
      female: mortalityTemplate('female', assumption.lifeExpectancy.female),
    };
    const expectedDeaths = mortalityCount(previous, hazards, baselineBirthShares, 1);
    const deathIntensity = intensityForDeaths(previous, hazards, baselineBirthShares,
      blend(countAt('deaths', year), expectedDeaths)) * mortality;
    const newborn = splitBirths(births);
    const deaths = mortalityCount(previous, hazards, newborn, deathIntensity);
    const current: SexPair<number[]> = { male: [], female: [] };
    for (const sex of sexes) {
      const survivors = previous[sex].map((count, age) => count * (1 - deathProbability(hazards[sex][age]!, deathIntensity)));
      current[sex] = [newborn[sex] * (1 - deathProbability(hazards[sex][0]!, deathIntensity)), ...survivors.slice(0, oldest)];
      current[sex][oldest]! += survivors[oldest]!;
    }
    const arrivals = blend(countAt('arrivals', year), assumption.arrivalsPerPerson * previous.population) * inflow;
    const requestedDepartures = blend(countAt('departures', year), assumption.departuresPerPerson * previous.population) * outflow;
    const arrivalsWeights = ageMigrationWeights(input.migrationProfile.arrivals, current);
    const departuresWeights = ageMigrationWeights(input.migrationProfile.departures, current);
    const out = completeOutflow(current, departuresWeights, requestedDepartures);
    const departures = pairSum(out);
    for (const sex of sexes)
      current[sex] = current[sex].map((value, age) => value - out[sex][age]! + arrivalsWeights[sex][age]! * arrivals);
    points.push({
      year: year + 1, ...current, population: pairSum(current), componentYear: year,
      births, deaths, arrivals, departures, netMigration: arrivals - departures,
      naturalChange: births - deaths, unrealizedDepartures: Math.max(0, requestedDepartures - departures),
    });
  }
  return { baseYear, endYear, points };
}
