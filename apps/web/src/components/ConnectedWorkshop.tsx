import { WorkshopArea } from './workshop/WorkshopArea';
import PracticeSelectionCatalog from './workshop/PracticeSelectionCatalog';
import { RegionMap } from './geography/RegionMap';
import { programmeMeasureRegions } from './workshop/workshop-ui';
import type { WorkshopView } from './workshop/workshop-ui';
import type { CorpusManifest } from '@/lib/corpus';
import { useProgrammeRegions } from '@/hooks/useProgrammeRegions';
import type { SessionAreaActions, SessionAreaState } from '../../../../packages/collaboration/types';
import type { useWorkshop } from '@/hooks/useWorkshop';

export function ConnectedWorkshop({ state, sessionActions, workshop, manifest, view, onOpenDocument }: {
  state: SessionAreaState; sessionActions: SessionAreaActions; workshop: ReturnType<typeof useWorkshop>;
  manifest: CorpusManifest; view: WorkshopView; onOpenDocument: (regionId: string) => void;
}) {
  const { snapshot } = state;
  const catalogue = useProgrammeRegions(manifest, view === 'regions');
  const { regions } = catalogue;
  if (!snapshot || !state.auth.userId) return null;
  const measureRegionIds = programmeMeasureRegions(snapshot.submissions.filter(item => item.status === 'shared'));
  return <>
    {view === 'regions' && catalogue.loading ? <p role="status">Проверяем наличие карточек мер…</p> : null}
    {view === 'regions' && catalogue.error ? <div role="alert" className="session-message" data-tone="error">
      <p>{catalogue.error}</p><button className="button button-secondary" onClick={catalogue.retry}>Повторить</button>
    </div> : null}
    <WorkshopArea view={view} hideNavigation sharedWorkspace session={snapshot} snapshot={workshop.snapshot}
    currentUserId={state.auth.userId} regions={regions} busy={workshop.busy || state.busy !== null}
    loading={workshop.loading} error={workshop.error} actions={workshop.actions}
    onOpenSource={sessionActions.openSource} onOpenDocument={onOpenDocument} measureRegionIds={measureRegionIds}
    renderCatalogue={(regionId) => <PracticeSelectionCatalog key={regionId} manifest={manifest} session={snapshot}
      initialRegionId={regionId} onSelect={sessionActions.selectCatalog} onOpenProgramme={onOpenDocument} />}
    renderMap={({ selectedRegionId, onSelect }) => <RegionMap regions={regions} measureRegionIds={measureRegionIds}
      selectedRegionId={selectedRegionId} onSelect={onSelect} />} />
  </>;
}
