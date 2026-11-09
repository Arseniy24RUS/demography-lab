import { useEffect, useState } from 'react';
import { loadCloudConfiguration, type CloudConfig } from '../lib/cloud-config';
import { LOCAL_ADDRESS_EVENT, localShareUrl, readLocalShareAddress } from '../lib/offline-share';
import { isLoopbackHost } from '../lib/local-network';

/** Auth stays on localhost; only invitations are displayed with the reachable classroom address. */
export function useOfflineShareUrl(value: string | null, includeNetwork = false): string | null {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    void loadCloudConfiguration().then(({ config }) => { if (active) setConfig(config); });
    const change = () => refresh((previous) => previous + 1);
    window.addEventListener(LOCAL_ADDRESS_EVENT, change);
    window.addEventListener('storage', change);
    return () => { active = false; window.removeEventListener(LOCAL_ADDRESS_EVENT, change); window.removeEventListener('storage', change); };
  }, []);
  if (!value || !config?.offline || !isLoopbackHost(location.hostname)) return value;
  const address = readLocalShareAddress(config.offlineInstanceId!);
  return address ? localShareUrl(value, address, includeNetwork) : null;
}
