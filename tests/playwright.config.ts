import { defineConfig, devices } from '@playwright/test';

/**
 * Site scanning configuration for blog.zolty.systems
 * Runs visual regression, broken-link detection, and OWASP security header checks.
 *
 * Set SITE_URL env var to override the target (e.g., staging URL during CI).
 */

const BASE_URL = process.env.SITE_URL || 'https://blog.zolty.systems';

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    // Annotates GitHub Actions with inline pass/fail markers
    ...(process.env.GITHUB_ACTIONS ? [['github' as const]] : []),
  ],

  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Ignore HTTPS errors for staging/preview scanning
    ignoreHTTPSErrors: false,
    extraHTTPHeaders: {
      // Identify our scanner in logs
      'User-Agent': 'zolty-blog-scanner/1.0 (+https://blog.zolty.systems)',
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Snapshot directory committed alongside tests
  snapshotDir: './snapshots',
  snapshotPathTemplate: '{snapshotDir}/{testFilePath}/{arg}{ext}',
});
