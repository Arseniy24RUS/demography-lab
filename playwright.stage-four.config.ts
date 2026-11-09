import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const baseURL = 'http://127.0.0.1:4173';
const gatewayURL = 'http://127.0.0.1:54321';
const surveyOrigin = 'http://127.0.0.1:4174';
const surveyURL = `${surveyOrigin}/survey.html`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const secret = process.env.WORKSHOP_TEST_ADMIN_SECRET ?? randomBytes(32).toString('hex');
// Workers inherit this runner credential; it is never a VITE_ variable or a browser asset.
process.env.WORKSHOP_TEST_ADMIN_SECRET = secret;

export default defineConfig({
  testDir: './tests/collaboration',
  testMatch: '**/stage-four.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir:
    process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? resolve(tmpdir(), 'demography-workshop-stage-four'),
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'UTC',
    contextOptions: { reducedMotion: 'reduce' },
    actionTimeout: 15_000,
    navigationTimeout: 25_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  },
  // All children must share the runner's network namespace. No remote account is used.
  webServer: [
    {
      command: 'node scripts/test-collaboration-gateway.mjs',
      url: `${gatewayURL}/health`,
      env: {
        WORKSHOP_TEST_GATEWAY: '1',
        WORKSHOP_TEST_ADMIN_SECRET: secret,
        WORKSHOP_TEST_APP_ORIGIN: baseURL,
        WORKSHOP_TEST_SURVEY_ORIGIN: surveyOrigin,
      },
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
      url: baseURL,
      env: {
        VITE_SUPABASE_URL: gatewayURL,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_workshop_fixture_only',
        VITE_WORKSHOP_TEST_MODE: 'true',
        VITE_WORKSHOP_REALTIME: 'false',
        VITE_WORKSHOP_SURVEY_URL: surveyURL,
        VITE_WORKSHOP_CLASSROOM_ORIGIN: baseURL,
      },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort',
      url: surveyURL,
      env: {
        VITE_SUPABASE_URL: gatewayURL,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_workshop_fixture_only',
        VITE_WORKSHOP_TEST_MODE: 'true',
        VITE_WORKSHOP_REALTIME: 'false',
        VITE_WORKSHOP_SURVEY_URL: surveyURL,
        VITE_WORKSHOP_CLASSROOM_ORIGIN: baseURL,
      },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
