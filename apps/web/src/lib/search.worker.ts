import { searchDocument } from '@domain/index';
import type { DocumentVersion } from '@domain/index';
let version: DocumentVersion | null = null;
self.onmessage = (event: MessageEvent) => {
  const { type, id, document: doc, query } = event.data;
  if (type === 'document') {
    version = doc;
    return;
  }
  if (type === 'search' && version) {
    try {
      const result = searchDocument(version, query, { limit: 150, foldYo: true });
      self.postMessage({ id, result });
    } catch (e) {
      self.postMessage({ id, error: e instanceof Error ? e.message : 'Ошибка поиска' });
    }
  }
};
