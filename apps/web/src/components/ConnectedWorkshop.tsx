import { WorkshopArea } from './workshop/WorkshopArea';
import { RegionMap } from './geography/RegionMap';
import type { WorkshopView } from './workshop/workshop-ui';
import type { CorpusManifest } from '@/lib/corpus';
import { readable } from '@/lib/corpus';
import type { SessionAreaActions, SessionAreaState } from '../../../../packages/collaboration/types';
import type { useWorkshop } from '@/hooks/useWorkshop';

export function ConnectedWorkshop({ state, sessionActions, workshop, manifest, view, onOpenDocument }: {
  state: SessionAreaState; sessionActions: SessionAreaActions; workshop: ReturnType<typeof useWorkshop>;
  manifest: CorpusManifest; view: WorkshopView; onOpenDocument: (regionId: string) => void;
}) {
  if (!state.snapshot || !state.auth.userId) return null;
  const regions = manifest.documents.map((entry) => ({
    id: entry.regionId, name: entry.territory, hasDocument: readable(entry), documentTitle: entry.title,
    documentHint: entry.quality === 'partial' ? 'Исходный документ содержит только часть программы.'
      : entry.extractionWarnings?.length ? 'В извлечении текста есть ограничения; проверьте паспорт источника.'
        : readable(entry) ? `${entry.pageCount} страниц в подготовленной редакции.` : 'Полный текст пока не подготовлен.',
  }));
  return <WorkshopArea view={view} hideNavigation sharedWorkspace session={state.snapshot} snapshot={workshop.snapshot}
    currentUserId={state.auth.userId} regions={regions} busy={workshop.busy || state.busy !== null}
    loading={workshop.loading} error={workshop.error} actions={workshop.actions}
    onOpenSource={sessionActions.openSource} onOpenDocument={onOpenDocument}
    renderMap={({ selectedRegionId, onSelect }) => <RegionMap regions={regions} work={workshop.snapshot?.regionWork}
      selectedRegionId={selectedRegionId} onSelect={onSelect} />} />;
}
