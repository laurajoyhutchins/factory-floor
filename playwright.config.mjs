import process from 'node:process';
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.FACTORY_FLOOR_BROWSER_BASE_URL;
if (!baseURL) {
  throw new Error('FACTORY_FLOOR_BROWSER_BASE_URL is required');
}

const desktopViewport = { width: 1440, height: 900 };
const mobileViewport = { width: 390, height: 844 };

export default defineConfig({
  testDir: './tests/browser',
  tsconfig: './tests/browser/tsconfig.json',
  outputDir: '.factory-floor/browser-smoke/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
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
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: desktopViewport,
      },
    },
    {
      name: 'firefox-desktop',
      use: {
        ...devices['Desktop Firefox'],
        viewport: desktopViewport,
      },
    },
    {
      name: 'webkit-desktop',
      use: {
        ...devices['Desktop Safari'],
        viewport: desktopViewport,
      },
    },
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 5'],
        viewport: mobileViewport,
      },
    },
    {
      name: 'webkit-mobile',
      use: {
        ...devices['iPhone 13'],
        viewport: mobileViewport,
      },
    },
  ],
});
