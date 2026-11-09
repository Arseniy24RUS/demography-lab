import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@domain': fileURLToPath(new URL('./packages/domain', import.meta.url)),
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  build: {
    target: ['chrome109', 'firefox115', 'safari16.4'],
    sourcemap: false,
    chunkSizeWarningLimit: 500,
    rolldownOptions: {
      input: {
        classroom: fileURLToPath(new URL('./index.html', import.meta.url)),
        survey: fileURLToPath(new URL('./survey.html', import.meta.url)),
      },
    },
  },
  server: { port: 4173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
