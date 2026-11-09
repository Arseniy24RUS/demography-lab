import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['scripts/ingest/corpus-integrity.test.ts'] } });
