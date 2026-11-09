import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const baseURL = 'http://127.0.0.1:4173';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/stage-one.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: [['list']],
  // Screenshots, traces and downloaded workspaces are evidence, not source files.
  outputDir: process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? resolve(tmpdir(), 'demography-workshop-playwright'),
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'UTC',
    contextOptions: { reducedMotion: 'reduce' },
    acceptDownloads: true,
    actionTimeout: 12_000,
    navigationTimeout: 25_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  },
  // The app and browser must share this invocation's network namespace.
  // An existing server in another exec session may be unreachable.
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: `${baseURL}/`,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
