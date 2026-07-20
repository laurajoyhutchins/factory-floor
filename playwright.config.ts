import { defineConfig } from '@playwright/test';

const baseURL = process.env.FACTORY_FLOOR_BROWSER_BASE_URL;
if (!baseURL) {
  throw new Error('FACTORY_FLOOR_BROWSER_BASE_URL is required');
}

export default defineConfig({
  testDir: './tests/browser',
  outputDir: '.factory-floor/browser-smoke/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['line'],
    [
      'junit',
      { outputFile: '.factory-floor/test-results/playwright-browser.xml' },
    ],
    [
      'html',
      {
        outputFolder: '.factory-floor/browser-smoke/report',
        open: 'never',
      },
    ],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium-mobile',
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
