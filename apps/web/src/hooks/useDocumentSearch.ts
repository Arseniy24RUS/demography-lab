import { useEffect, useRef, useState } from 'react';
import { searchDocument } from '@domain/index';
import type { DocumentVersion, SearchResult } from '@domain/index';
export function useDocumentSearch(version: DocumentVersion | undefined, query: string) {
  const queryRef = useRef(query);
  queryRef.current = query;
  const worker = useRef<Worker | null>(null);
  const sequence = useRef(0);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!version) {
      setResult(null);
      return;
    }
    let w: Worker | null = null;
    try {
      w = new Worker(new URL('../lib/search.worker.ts', import.meta.url), { type: 'module' });
      worker.current = w;
      w.postMessage({ type: 'document', document: version });
      w.onmessage = (e) => {
        if (e.data.id === sequence.current) {
          setResult(e.data.result ?? null);
          setPending(false);
        }
      };
      w.onerror = () => {
        worker.current = null;
        w?.terminate();
        const current = queryRef.current;
        if (current.trim().length >= 2)
          setResult(searchDocument(version, current, { limit: 150, foldYo: true }));
        setPending(false);
      };
    } catch {
      worker.current = null;
    }
    return () => {
      w?.terminate();
      worker.current = null;
    };
  }, [version]);
  useEffect(() => {
    const id = ++sequence.current;
    if (!version || query.trim().length < 2) {
      setResult(null);
      setPending(false);
      return;
    }
    setPending(true);
    const t = setTimeout(() => {
      if (worker.current) worker.current.postMessage({ type: 'search', id, query });
      else {
        setResult(searchDocument(version, query, { limit: 150, foldYo: true }));
        setPending(false);
      }
    }, 160);
    return () => clearTimeout(t);
  }, [version, query]);
  return { result, pending };
}
