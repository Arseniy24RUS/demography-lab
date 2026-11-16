import { useEffect, useMemo, useState } from 'react';
import { readable } from '@/lib/corpus';
import type { CorpusManifest } from '@/lib/corpus';
import { isFamilyCatalogVariant, loadFamilyCatalog } from '@/lib/family-catalog';

/** Catalogue coverage is independent of full programme texts and participants' selections. */
export function useProgrammeRegions(manifest: CorpusManifest, enabled: boolean) {
  const [coverage, setCoverage] = useState<{ manifest: CorpusManifest; ids: ReadonlySet<string> } | null>(null);
  const [failure, setFailure] = useState<{ manifest: CorpusManifest; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setFailure(null);
    void loadFamilyCatalog(manifest).then(cards => {
      if (active) setCoverage({ manifest, ids: new Set(cards.filter(isFamilyCatalogVariant)
        .filter(card => card.scope === 'regional').map(card => card.regionId)) });
    }).catch(() => {
      if (active) setFailure({ manifest, message: 'Не удалось проверить наличие карточек мер.' });
    });
    return () => { active = false; };
  }, [manifest, enabled, attempt]);
  const ids = coverage?.manifest === manifest ? coverage.ids : undefined;
  const error = failure?.manifest === manifest ? failure.message : null;
  const regions = useMemo(() => manifest.documents.map(entry => ({
    id: entry.regionId, name: entry.territory, hasDocument: readable(entry), documentTitle: entry.title,
    hasMeasures: ids?.has(entry.regionId),
  })), [manifest, ids]);
  return { regions, loading: enabled && !ids && !error, error, retry: () => setAttempt(value => value + 1) };
}
