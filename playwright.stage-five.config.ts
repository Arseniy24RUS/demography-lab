import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const baseURL = 'http://127.0.0.1:4173';
const gatewayURL = 'http://127.0.0.1:54321';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const secret = process.env.WORKSHOP_TEST_ADMIN_SECRET ?? randomBytes(32).toString('hex');
process.env.WORKSHOP_TEST_ADMIN_SECRET = secret;

export default defineConfig({
  testDir: './tests/collaboration',
  testMatch: '**/stage-five.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? resolve(tmpdir(), 'demography-workshop-stage-five'),
  use: {
    baseURL, browserName: 'chromium', headless: true,
    viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', timezoneId: 'UTC',
    contextOptions: { reducedMotion: 'reduce' }, actionTimeout: 15_000, navigationTimeout: 25_000,
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  },
  webServer: [
    {
      command: 'node scripts/test-collaboration-gateway.mjs', url: `${gatewayURL}/health`,
      env: { WORKSHOP_TEST_GATEWAY: '1', WORKSHOP_TEST_ADMIN_SECRET: secret, WORKSHOP_TEST_APP_ORIGIN: baseURL },
      reuseExistingServer: false, timeout: 90_000, stdout: 'pipe', stderr: 'pipe',
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort', url: baseURL,
      env: {
        VITE_SUPABASE_URL: gatewayURL,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_workshop_fixture_only',
        VITE_WORKSHOP_TEST_MODE: 'true', VITE_WORKSHOP_REALTIME: 'false',
        VITE_WORKSHOP_CLASSROOM_ORIGIN: baseURL,
      },
      reuseExistingServer: false, timeout: 60_000, stdout: 'ignore', stderr: 'pipe',
    },
  ],
});
