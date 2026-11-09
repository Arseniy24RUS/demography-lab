import type {
  FrozenRoadmapData,
  FrozenRoadmapItem,
  RoadmapDataMap,
  RoadmapItemKind,
  RoadmapVersion,
} from '../../packages/roadmaps/types';
import type { BarrierEvidence } from '../../packages/barriers/types';
import type { SharedPracticeBundle } from '../../packages/collaboration/types';
import type { CanonicalMunicipalSeries } from '../../packages/territories/types';
import { computeRoadmapBudget } from '../../packages/analytics/readiness';
import { sha256Text } from '../../packages/export/model';

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function frozenItem<K extends RoadmapItemKind>(
  n: number,
  kind: K,
  data: RoadmapDataMap[K],
  status: 'active' | 'archived' = 'active',
): FrozenRoadmapItem<K> {
  return { id: uuid(n), kind, data, status, revision: 1 } as FrozenRoadmapItem<K>;
}
function exampleBundle(region: string, amount: string, condition: string): SharedPracticeBundle {
  const quote = `Семьям с детьми до трёх лет предоставляются дополнительные часы присмотра. Размер компенсации составляет ${amount}. ${condition}`;
  const documentId = `example-programme-${region}`;
  const versionId = `example-edition-${region}`;
  const occurrenceId = `example-occurrence-${region}`;
  return {
    schemaVersion: 1,
    practice: {
      id: `example-practice-${region}`,
      familyId: 'example-care',
      regionId: region,
      title: 'Дополнительные часы присмотра за детьми',
      mechanism: 'Предоставление услуги присмотра по удобному для семьи графику',
      eligibility: 'Семьи с детьми до трёх лет',
      amount,
      conditions: [condition],
      occurrenceIds: [occurrenceId],
      reviewStatus: 'candidate',
      evidence: [
        {
          kind: 'fragment',
          field: 'amount',
          occurrenceId,
          relation: 'supports',
          reviewStatus: 'verified',
          reviewedValue: amount,
          note: 'Учебная проверка формулировки, без вывода об актуальном праве.',
        },
      ],
    },
    occurrences: [
      {
        id: occurrenceId,
        documentId,
        versionId,
        reviewStatus: 'verified',
        note: 'Синтетический фрагмент для проверки экспорта.',
        anchor: {
          id: `example-anchor-${region}`,
          documentId,
          versionId,
          normalizationVersion: 'unicode-nfc-lf-v1',
          spans: [
            {
              blockId: 'block-1',
              start: 0,
              end: [...quote].length,
              exact: quote,
              prefix: '',
              suffix: 'Порядок обращения определяется отдельно.',
            },
          ],
        },
      },
    ],
    sources: [
      {
        sourceId: documentId,
        editionId: versionId,
        title: `Учебная программа региона ${region}`,
        sha256: region === '13' ? 'd'.repeat(64) : 'e'.repeat(64),
        normalizationVersion: 'unicode-nfc-lf-v1',
        sourceUrl: `https://example.test/programme/${region}`,
        regionId: region,
      },
    ],
    note: 'Искусственный материал для проверки экспортера. Не является действующей мерой.',
  };
}
export async function makeRoadmapExportFixture(): Promise<RoadmapVersion> {
  const series: CanonicalMunicipalSeries = {
    id: 'example-series-births',
    territoryKey: 'example-municipality',
    metricId: 'births_total',
    title: 'Число родившихся в учебном ряду',
    unit: 'persons',
    semanticType: 'flow',
    valueDomain: 'nonnegative',
    aggregation: 'sum',
    decimals: 0,
    reference: 'calendar_year',
    sourceEditionId: 'example-source-v1',
    sourceUrl: 'https://example.test/statistics',
    sourcePath: 'example/municipal-data.parquet',
    sourceSha256: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    sourceKind: 'source_reported',
    provenanceStatus: 'incomplete_primary',
    sourceMunicipalityKey: 'example-key',
    geographyEditionId: 'example-geography-v1',
    geographyComparability: 'not_verified',
    comparabilityNote: 'Все числа и названия в этом образце синтетические. Границы условны.',
    fingerprint: 'c'.repeat(64),
    points: [
      { year: 2015, value: 220 },
      { year: 2016, value: 217 },
      { year: 2017, value: 209 },
      { year: 2018, value: 204 },
      { year: 2019, value: 199 },
      { year: 2020, value: 193 },
      { year: 2021, value: 189 },
      { year: 2022, value: 184 },
      { year: 2023, value: null },
    ],
  };
  const evidence: BarrierEvidence = {
    id: uuid(80),
    sessionId: uuid(900),
    familyId: uuid(81),
    fingerprint: 'f'.repeat(64),
    familyRevision: 2,
    title: 'Гибкое время присмотра за детьми',
    mechanism: 'Согласование режима услуги с семейным расписанием',
    rationale: 'Общий механизм при разных размерах и условиях.',
    variants: [
      {
        submissionId: uuid(82),
        submissionRevision: 1,
        bundle: exampleBundle('13', '200 рублей за час', 'Условие А: предварительная запись.'),
      },
      {
        submissionId: uuid(83),
        submissionRevision: 2,
        bundle: exampleBundle(
          '16',
          '350 рублей за час',
          'Условие Б: индивидуальное согласование графика.',
        ),
      },
    ],
  };
  const barrier = {
    id: uuid(70),
    title: 'График присмотра не совпадает с рабочим временем',
    description:
      'Участники сообщили о сложностях согласования времени занятости и ухода за ребёнком.',
    stageIds: ['early_childhood', 'next_child'],
    evidenceKind: 'hypothesis' as const,
    contentRevision: 1,
    status: 'active' as const,
  };
  const snapshot: FrozenRoadmapData = {
    schemaVersion: 1,
    templateVersion: 'organizers-roadmap-1',
    calculationVersion: 'roadmap-analytics-1',
    roadmapRevision: 23,
    territory: {
      key: 'example-municipality',
      name: 'Учебный муниципальный округ',
      level: 'municipality',
      regionId: '13',
      sourceEditionId: 'example-geography-v1',
      sourceCode: null,
      sourceType: 'municipal_okrug',
      geographicStatus: 'historical_source_snapshot',
      sourceUrl: 'https://example.test/geography',
      boundaryVersion: 'example-geography-v1',
    },
    roomLevel: 'municipality',
    session: {
      title: 'Учебная мастерская демографических проектов',
      scope: 'municipality',
      regionId: '13',
    },
    teamNames: ['Иванова Мария Петровна', 'Сидоров Павел Сергеевич'],
    items: [
      frozenItem(1, 'passport', {
        title: 'Доступное время присмотра за детьми',
        targetGroup: 'Семьи с детьми от одного до трёх лет',
        partners: 'Учебное учреждение социальной сферы и объединение работодателей',
        goal: 'К концу 2027 года предоставить 600 дополнительных часов присмотра и сократить долю неудовлетворённых запросов семей до 20 процентов.',
        objectives: [
          { id: uuid(101), title: 'Уточнить потребность семей и утвердить режим работы' },
          { id: uuid(102), title: 'Организовать дополнительные часы присмотра' },
          { id: uuid(103), title: 'Оценить доступность и устойчивость услуги' },
        ],
        startDate: '2027-01-01',
        endDate: '2027-12-31',
        expectedResult:
          'Семьи получают услугу в согласованное время; проводится учёт спроса и причин отказов.',
        defenseDate: '2026-11-10',
        humanResources: 'Координатор проекта и два специалиста по присмотру.',
        materialResources: 'Помещение учреждения, оборудование для детей и средства связи.',
        informationResources: 'Публичное описание услуги и обезличенный журнал обращений.',
      }),
      frozenItem(2, 'diagnosis', {
        problem: 'Семьям трудно получить присмотр в часы завершения рабочего дня.',
        causeHypothesis:
          'Предполагается, что стандартный график услуги не учитывает часть рабочих расписаний. Эту гипотезу требуется проверить по обращениям.',
        conclusion:
          'Провести диагностику спроса, согласовать расширенный график и проверить результат пилотного периода.',
      }),
      frozenItem(3, 'monitoring', {
        frequency: 'Ежемесячно; промежуточная оценка через шесть месяцев.',
        method:
          'Журнал часов услуги и обезличенные обращения; сопоставление предоставленных часов, отказов и причин неудовлетворённых запросов.',
        responsible: 'Координатор проекта',
        interimReportDate: '2027-06-30',
        finalReportDate: '2027-12-31',
        qualitativeResults:
          'Удобство графика, понятность записи и причины отказов по сообщениям семей.',
        sustainability:
          'Решение о включении дополнительных часов в постоянное расписание после оценки спроса и ресурсной обеспеченности.',
      }),
      frozenItem(10, 'fact', {
        sourceKind: 'registry',
        title: series.title,
        interpretation: 'Учебный ряд описывает контекст, а не результат услуг присмотра.',
        year: 2022,
        value: 184,
        unit: 'persons',
        sourceReference: series.sourceUrl,
        sourceDate: null,
        seriesId: series.id,
        seriesFingerprint: series.fingerprint,
        metricId: series.metricId,
      }),
      frozenItem(11, 'fact', {
        sourceKind: 'external_unverified',
        title: 'Предоставленные дополнительные часы до запуска',
        interpretation: 'В исходном учебном реестре дополнительные часы не предоставлялись.',
        year: 2026,
        value: 0,
        unit: 'часов',
        sourceReference: 'Синтетический учебный реестр предоставления услуги',
        sourceDate: '2026-10-01',
        seriesId: null,
        seriesFingerprint: null,
        metricId: null,
      }),
      frozenItem(20, 'indicator', {
        title: 'Предоставленные дополнительные часы',
        definition: 'Сумма часов фактически предоставленной услуги за календарный год.',
        kind: 'output',
        unit: 'часов',
        semanticType: 'flow',
        valueDomain: 'nonnegative',
        numeratorDefinition: '',
        denominatorDefinition: '',
        baselineValue: 0,
        baselineYear: 2026,
        annualTargets: [{ year: 2027, value: 600 }],
        sourceReference: 'Журнал предоставления услуги',
        frequency: 'Ежемесячно',
        responsible: 'Координатор',
        limitations: 'Количество часов не является показателем демографического эффекта.',
        scenarioId: null,
      }),
      frozenItem(21, 'indicator', {
        title: 'Доля неудовлетворённых запросов',
        definition:
          'Доля запросов на присмотр, по которым услуга не предоставлена в согласованное время.',
        kind: 'family_outcome',
        unit: '%',
        semanticType: 'share',
        valueDomain: 'percent',
        numeratorDefinition: 'Число неудовлетворённых запросов за месяц.',
        denominatorDefinition:
          'Все содержательные запросы за тот же месяц; при нуле запросов показатель отсутствует.',
        baselineValue: 45,
        baselineYear: 2026,
        annualTargets: [{ year: 2027, value: 20 }],
        sourceReference: 'Обезличенный журнал обращений',
        frequency: 'Ежемесячно',
        responsible: 'Ответственный за обращения',
        limitations:
          'Изменение состава обращающихся может влиять на долю; показатель проверяется вместе с числом запросов.',
        scenarioId: null,
      }),
      frozenItem(22, 'indicator', {
        title: 'Число родившихся как контекст',
        definition:
          'Число зарегистрированных рождений за календарный год в учебном статистическом ряду.',
        kind: 'demographic_context',
        unit: 'человек',
        semanticType: 'flow',
        valueDomain: 'nonnegative',
        numeratorDefinition: '',
        denominatorDefinition: '',
        baselineValue: 184,
        baselineYear: 2022,
        annualTargets: [{ year: 2027, value: 176 }],
        sourceReference: series.sourceUrl,
        frequency: 'Ежегодно',
        responsible: 'Аналитик',
        limitations: 'Плановая величина не приписывается причинному эффекту мероприятия.',
        scenarioId: uuid(30),
      }),
      frozenItem(30, 'scenario', {
        title: 'Учебная траектория числа родившихся',
        seriesId: series.id,
        seriesFingerprint: series.fingerprint,
        assumptions:
          'Линейное продолжение учебного ряда и плановая разница 20 человек к 2027 году. Допущение не оценивает результат конкретных мер.',
        parameters: {
          metricId: 'births_total',
          historyStartYear: 2015,
          historyEndYear: 2023,
          endYear: 2027,
          baselineMethod: 'linear',
          targetMode: 'absolute_delta_end',
          targetValue: 20,
        },
      }),
      ...[
        {
          id: 40,
          title: 'Диагностика потребности и согласование графика',
          objective: 101,
          start: '2027-01-10',
          end: '2027-02-28',
          stage: 'preparation' as const,
          result: 'Описание спроса и согласованный график',
          predecessor: null,
        },
        {
          id: 41,
          title: 'Предоставление дополнительных часов присмотра',
          objective: 102,
          start: '2027-03-01',
          end: '2027-10-31',
          stage: 'implementation' as const,
          result: '600 часов услуги по журналу учёта',
          predecessor: 40,
        },
        {
          id: 42,
          title: 'Оценка результата и подготовка решения о продолжении',
          objective: 103,
          start: '2027-11-01',
          end: '2027-12-20',
          stage: 'evaluation' as const,
          result: 'Отчёт о предоставленных услугах и доступности',
          predecessor: 41,
        },
      ].map((row) =>
        frozenItem(row.id, 'activity', {
          title: row.title,
          description:
            'Совместная работа учреждения, координатора и представителей семей с документированием решений.',
          objectiveId: uuid(row.objective),
          targetGroup: 'Семьи с детьми от одного до трёх лет',
          scale: 'Одно учебное учреждение; 40 семей в пилотном наборе.',
          startDate: row.start,
          endDate: row.end,
          responsible: 'Координатор проекта',
          partners: 'Учреждение и объединение работодателей',
          deliverable: row.result,
          completionCriterion: 'Подписанный документ и запись в журнале результатов.',
          authorityLevel: 'municipal',
          legalBasis:
            'Учебное основание для проверки структуры; реального правового акта не представлено.',
          approvalStatus: 'requires_decision',
          responsibleBody: 'Профильное подразделение администрации',
          necessaryDecision:
            'Проверить полномочие, согласовать режим работы учреждения и финансовое обеспечение.',
          indicatorIds: [uuid(20), uuid(21)],
          dependencies: row.predecessor
            ? [{ predecessorId: uuid(row.predecessor), lagDays: 0 }]
            : [],
          stage: row.stage,
          stageLabel: '',
          progressStatus: 'planned',
        }),
      ),
      frozenItem(50, 'cost', {
        activityId: uuid(41),
        year: 2027,
        title: 'Работа специалистов по присмотру',
        unit: 'час',
        quantity: '600',
        unitPriceKopecks: 120000,
        periods: 1,
        cashKind: 'cash',
        priceStatus: 'estimated',
        priceSource: 'Учебная оценка стоимости часа, не коммерческое предложение.',
        priceDate: '2026-11-01',
      }),
      frozenItem(51, 'cost', {
        activityId: uuid(41),
        year: 2027,
        title: 'Использование помещения учреждения',
        unit: 'месяц',
        quantity: '8',
        unitPriceKopecks: 250000,
        periods: 1,
        cashKind: 'in_kind',
        priceStatus: 'estimated',
        priceSource: 'Учебная оценка неденежного вклада.',
        priceDate: '2026-11-01',
      }),
      frozenItem(52, 'funding', {
        costLineId: uuid(50),
        sourceName: 'Учебное муниципальное финансирование',
        sourceKind: 'municipal_budget',
        amountKopecks: 50000000,
        status: 'confirmed',
        sourceReference:
          'Синтетический финансовый документ №1 для теста; реального ассигнования не создаёт.',
        sourceDate: '2026-11-01',
        originReference: 'Условные собственные доходы учебного бюджета.',
      }),
      frozenItem(53, 'funding', {
        costLineId: uuid(50),
        sourceName: 'Учебная грантовая заявка',
        sourceKind: 'grant',
        amountKopecks: 22000000,
        status: 'application',
        sourceReference: 'Заявка в учебном примере, решение не принято.',
        sourceDate: '2026-11-02',
        originReference: 'Не определено до решения грантодателя.',
      }),
      frozenItem(60, 'risk', {
        title: 'Недостаток специалистов в нужное время',
        mitigation: 'Сформировать резерв специалистов и согласовать замены заранее.',
        owner: 'Координатор учреждения',
        trigger: 'Не закрыты две последовательные смены по графику.',
        contingency: 'Согласовать временный альтернативный график с семьями.',
      }),
      frozenItem(61, 'risk', {
        title: 'Ожидаемое финансирование не поступит',
        mitigation: 'Подготовить минимальный режим на подтверждённых ресурсах.',
        owner: 'Финансовый координатор',
        trigger: 'Нет решения по заявке к началу пилотного предоставления услуги.',
        contingency: 'Пересмотреть масштаб и целевые значения с фиксацией новой версии.',
      }),
      frozenItem(
        90,
        'risk',
        {
          title: 'Архивный пример риска',
          mitigation: 'Ранее обсуждавшаяся мера',
          owner: 'Учебная команда',
          trigger: 'Условный признак',
          contingency: 'Условное действие',
        },
        'archived',
      ),
    ],
    basis: [
      {
        id: uuid(71),
        sourceKind: 'link',
        sourceId: uuid(72),
        sourceRevision: 1,
        fingerprint: '1'.repeat(64),
        material: {
          kind: 'link',
          source: {
            id: uuid(72),
            relationship: 'needs_adaptation',
            explanation:
              'Гибкий график может уменьшить несоответствие времени услуги потребностям; требуется проверка спроса.',
            prerequisites: 'Наличие специалистов, помещения и согласованного финансирования.',
            revision: 1,
            status: 'active',
            barrier,
            evidenceId: evidence.id,
            familyTitle: evidence.title,
            familyFingerprint: evidence.fingerprint,
          },
        },
        rationale: 'Практика предлагает проверяемое организационное решение указанного барьера.',
        status: 'active',
        revision: 1,
        staleReasons: [],
        createdAt: '2026-11-08T12:00:00.000Z',
        updatedAt: '2026-11-08T12:00:00.000Z',
      },
    ],
    series: [series],
    evidence: [evidence],
    budget: {
      needCashKopecks: 0,
      inKindKopecks: 0,
      confirmedKopecks: 0,
      expectedKopecks: 0,
      confirmedGapKopecks: 0,
      remainingAfterExpectedKopecks: 0,
      years: [],
    },
  };
  const calculated = computeRoadmapBudget(snapshot);
  snapshot.budget = { ...calculated.totals, years: calculated.years };
  const canonicalJson = JSON.stringify(snapshot);
  return {
    id: uuid(901),
    number: 1,
    kind: 'draft',
    title: 'Учебная версия проекта',
    roadmapRevision: snapshot.roadmapRevision,
    sha256: await sha256Text(canonicalJson),
    createdAt: '2026-11-08T12:00:00.000Z',
    review: null,
    sessionId: uuid(900),
    roadmapId: uuid(902),
    canonicalJson,
    snapshot,
  };
}

export async function resealFixture(version: RoadmapVersion): Promise<RoadmapVersion> {
  version.canonicalJson = JSON.stringify(version.snapshot);
  version.sha256 = await sha256Text(version.canonicalJson);
  return version;
}
