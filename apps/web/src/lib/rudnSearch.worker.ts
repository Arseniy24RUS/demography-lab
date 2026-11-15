import { sha256 } from '@noble/hashes/sha2.js';

// This compatibility wrapper changes no search algorithm or integrity pin.
// Native WebCrypto is only exposed on secure contexts; classroom LAN HTTP uses
// the same SHA-256 from the application's existing cryptographic dependency.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: {
      async digest(algorithm: string | { name: string }, bytes: ArrayBuffer | ArrayBufferView) {
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
        if (name.toUpperCase() !== 'SHA-256') throw new Error('Unsupported digest');
        const input = ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes);
        return sha256(input).buffer;
      },
    },
  });
}
const queued: unknown[] = [];
let loading = false;
self.onmessage = async (event: MessageEvent) => {
  if (event.data?.type !== 'rudn-bootstrap') {
    queued.push(event.data);
    return;
  }
  if (loading) return;
  loading = true;
  try {
    const url = new URL(event.data.url);
    if (
      url.origin !== self.location.origin ||
      !url.pathname.endsWith('/vendor/rudn-reader/site/apps/legal-lab/lib/reader-search-worker.mjs')
    )
      throw new Error('Invalid worker source');
    await import(/* @vite-ignore */ url.href);
    const deliver = self.onmessage;
    for (const data of queued.splice(0)) deliver?.call(self, new MessageEvent('message', { data }));
  } catch {
    self.postMessage({ type: 'error', code: 'reader/search-load' });
  }
};
