import { WorkshopArea } from './workshop/WorkshopArea';
import PracticeSelectionCatalog from './workshop/PracticeSelectionCatalog';
import { RegionMap } from './geography/RegionMap';
import { programmeMeasureRegions } from './workshop/workshop-ui';
import type { WorkshopView } from './workshop/workshop-ui';
import type { CorpusManifest } from '@/lib/corpus';
import { readable } from '@/lib/corpus';
import type { SessionAreaActions, SessionAreaState } from '../../../../packages/collaboration/types';
import type { useWorkshop } from '@/hooks/useWorkshop';

export function ConnectedWorkshop({ state, sessionActions, workshop, manifest, view, onOpenDocument }: {
  state: SessionAreaState; sessionActions: SessionAreaActions; workshop: ReturnType<typeof useWorkshop>;
  manifest: CorpusManifest; view: WorkshopView; onOpenDocument: (regionId: string) => void;
}) {
  const { snapshot } = state;
  if (!snapshot || !state.auth.userId) return null;
  const measureRegionIds = programmeMeasureRegions(snapshot.submissions.filter(item => item.status === 'shared'));
  const regions = manifest.documents.map((entry) => ({
    id: entry.regionId, name: entry.territory, hasDocument: readable(entry), documentTitle: entry.title,
  }));
  return <WorkshopArea view={view} hideNavigation sharedWorkspace session={snapshot} snapshot={workshop.snapshot}
    currentUserId={state.auth.userId} regions={regions} busy={workshop.busy || state.busy !== null}
    loading={workshop.loading} error={workshop.error} actions={workshop.actions}
    onOpenSource={sessionActions.openSource} onOpenDocument={onOpenDocument} measureRegionIds={measureRegionIds}
    renderCatalogue={(regionId) => <PracticeSelectionCatalog key={regionId} manifest={manifest} session={snapshot}
      initialRegionId={regionId} onSelect={sessionActions.selectCatalog} onOpenProgramme={onOpenDocument} />}
    renderMap={({ selectedRegionId, onSelect }) => <RegionMap regions={regions} measureRegionIds={measureRegionIds}
      selectedRegionId={selectedRegionId} onSelect={onSelect} />} />;
}
