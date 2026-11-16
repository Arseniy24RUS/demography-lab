import { startWorkshopPolling } from '../lib/workshop-polling';
import { useEffect, useRef, useState } from 'react';
import { randomUuid } from '../../../../packages/security/crypto.mjs';
import type { RoadmapsApi } from '../lib/roadmaps-api';

type Counts = ReadonlyMap<string, number>;

export function useRoadmapPresence(
  client: RoadmapsApi | null,
  sessionId: string | null,
  roadmapId: string | null,
) {
  const room = useRef(roadmapId);
  room.current = roadmapId;
  const report = useRef<((id: string | null) => void) | null>(null);
  const [snapshot, setSnapshot] = useState<{ client: RoadmapsApi; sessionId: string; counts: Counts | null } | null>(null);

  useEffect(() => {
    if (!client || !sessionId) return;
    const api = client;
    const session = sessionId;
    let viewId: string | null = null;
    let revision = 0;
    let sequence = 0;
    let registered = false;
    let active = true;
    let hidden = false;

    function send(id: string | null) {
      if (id && !viewId) viewId = randomUuid();
      const view = id || registered ? viewId : null;
      registered = id !== null;
      const request = ++sequence;
      return api.presence(session, view, id, view ? ++revision : 1).then((value) => {
        if (!active || request !== sequence) return;
        setSnapshot({ client: api, sessionId: session, counts: new Map(value.counts.map(({ roadmapId, count }) => [roadmapId, count])) });
      }).catch(() => {
        if (active && request === sequence) setSnapshot({ client: api, sessionId: session, counts: null });
      });
    }

    report.current = (id) => { if (!hidden) send(id); };
    const refresh = () => { if (!hidden) return send(room.current); };
    const depart = () => { if (registered) send(null); };
    const pagehide = () => { hidden = true; depart(); };
    const pageshow = () => { hidden = false; refresh(); };
    const stopPolling = startWorkshopPolling(7000, refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', pageshow);
    window.addEventListener('pagehide', pagehide);
    return () => {
      active = false;
      report.current = null;
      stopPolling();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('pageshow', pageshow);
      window.removeEventListener('pagehide', pagehide);
      depart();
    };
  }, [client, sessionId]);

  useEffect(() => {
    report.current?.(roadmapId);
  }, [client, sessionId, roadmapId]);

  return snapshot?.client === client && snapshot.sessionId === sessionId ? snapshot.counts : null;
}
