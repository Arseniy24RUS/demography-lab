import { useEffect, useState } from 'react';
import { assetUrl, safeExternalUrl, type CorpusEntry } from '../lib/corpus';
import { loadCloudConfiguration } from '../lib/cloud-config';

/** Local copies keep the source SHA and edition unchanged; only the delivery address changes. */
export function useOriginalDocumentUrl(entry: CorpusEntry): string | undefined {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let active = true;
    void loadCloudConfiguration().then(({ config }) => {
      if (active) setOffline(config?.offline === true);
    });
    return () => { active = false; };
  }, []);
  return offline && /^[a-f\d]{64}$/u.test(entry.source.sha256 ?? '')
    ? assetUrl(`data/originals/${entry.source.sha256}.pdf`)
    : safeExternalUrl(entry.source.pdfUrl ?? entry.source.sourceUrl);
}
