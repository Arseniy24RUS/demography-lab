import { describe, expect, it, vi } from 'vitest';
import { RoadmapsApi } from '../../apps/web/src/lib/roadmaps-api';
import type { SessionApi } from '../../apps/web/src/lib/session-api';
import { createOrganizationRoadmapInputSchema, joinRoadmapInputSchema, parseRoadmapSnapshot } from '../../packages/roadmaps/schema';
import type { RoadmapTerritory } from '../../packages/roadmaps/types';
import { availableRoadmapReportSections, roadmapReportSections } from '../../packages/export/sections';
import { prepareRoadmapExport } from '../../packages/export/model';
import { assessRoadmapReadiness } from '../../packages/analytics/readiness';
import { roomA, roomB, sessionId, runtimeSnapshot } from './roadmaps-runtime.fixture';
import { makeRoadmapExportFixture, resealFixture } from './roadmap-export.fixture';

const territory: RoadmapTerritory = {
  key: `organization:${roomA}`, name: 'Учебная организация', level: 'organization',
  regionId: null, sourceEditionId: 'custom-organization-v1', sourceCode: null,
  sourceType: 'organization', geographicStatus: 'not-geographic',
  sourceUrl: `urn:demography:organization:${roomA}`, boundaryVersion: null,
};
const organization = (room = roomA) => ({ ...runtimeSnapshot(room), territory, roomLevel: 'organization' as const });

describe('organization teams without fictional geographic data', () => {
  it('accepts only a name/revision for creation and an existing room identity for joining', () => {
    expect(createOrganizationRoadmapInputSchema.parse({ name: 'Организация', expectedAssignmentRevision: 0 }).name).toBe('Организация');
    expect(createOrganizationRoadmapInputSchema.safeParse({ name: ' ', expectedAssignmentRevision: 0 }).success).toBe(false);
    expect(createOrganizationRoadmapInputSchema.safeParse({ name: 'Организация', expectedAssignmentRevision: 0, territory }).success).toBe(false);
    expect(joinRoadmapInputSchema.parse({ roadmapId: roomA, expectedAssignmentRevision: 0 })).toEqual({ roadmapId: roomA, expectedAssignmentRevision: 0 });
    expect(joinRoadmapInputSchema.safeParse({ roadmapId: roomA, territoryKey: 'forged', expectedAssignmentRevision: 0 }).success).toBe(false);
  });

  it('binds the organization join response to the requested room and validates creation type', async () => {
    const transport = (response: unknown) => ({ mutate: vi.fn(async (_name, _args, parse) => parse(response)) }) as unknown as SessionApi;
    const wrong = new RoadmapsApi(transport(organization(roomB)));
    await expect(wrong.join(sessionId, { roadmapId: roomA, expectedAssignmentRevision: 0 })).rejects.toThrow('другой дорожной карте');
    const geo = new RoadmapsApi(transport(runtimeSnapshot()));
    await expect(geo.createOrganization(sessionId, { name: 'Организация', expectedAssignmentRevision: 0 })).rejects.toThrow('другого типа');
    const client = new RoadmapsApi(transport(organization()));
    expect((await client.createOrganization(sessionId, { name: 'Организация', expectedAssignmentRevision: 0 })).territory.level).toBe('organization');
  });

  it('rejects geographic metadata and demographic settings in an organization snapshot', () => {
    expect(parseRoadmapSnapshot(organization()).territory).toEqual(territory);
    expect(() => parseRoadmapSnapshot({ ...organization(), territory: { ...territory, regionId: 'respublika-mordoviia' } })).toThrow();
    expect(() => parseRoadmapSnapshot({ ...organization(), cohortSettings: { revision: 1,
      parameters: { endYear: 2030, fertilityMultiplier: 1, mortalityMultiplier: 1, arrivalsMultiplier: 1, departuresMultiplier: 1 } } })).toThrow();
  });

  it('exports authored planning sections while excluding statistics/forecast even when requested explicitly', async () => {
    const version = await makeRoadmapExportFixture();
    version.snapshot.schemaVersion = 2;
    version.snapshot.territory = territory;
    version.snapshot.roomLevel = 'organization';
    version.snapshot.series = [];
    version.snapshot.statistics = [];
    delete version.snapshot.cohortSettings;
    version.snapshot.items = version.snapshot.items.filter(item => item.kind !== 'scenario' &&
      (item.kind !== 'fact' || item.data.sourceKind === 'external_unverified'));
    for (const item of version.snapshot.items) if (item.kind === 'indicator') item.data.scenarioId = null;
    await resealFixture(version);
    const prepared = await prepareRoadmapExport(version, { sections: roadmapReportSections.map(section => section.id) });
    const headings = prepared.blocks.filter(block => block.kind === 'heading').map(block => block.text).join('\n');
    expect(headings).toContain('Паспорт проекта');
    expect(headings).toContain('Ресурсное обеспечение');
    expect(headings).not.toMatch(/Демографическая статистика|Демографический прогноз/u);
    expect(availableRoadmapReportSections('organization')).toHaveLength(8);
    expect(availableRoadmapReportSections('municipality')).toHaveLength(10);
    const readiness = assessRoadmapReadiness(version.snapshot);
    expect(readiness.sections.flatMap(section => section.checks).map(check => check.id)).not.toContain('diagnosis-facts');
    expect(readiness.sections.find(section => section.id === 'diagnosis')?.checks.map(check => check.id)).toContain('diagnosis-problem');
  });
});
