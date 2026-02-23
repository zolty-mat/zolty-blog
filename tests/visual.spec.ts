/**
 * visual.spec.ts — Visual regression tests for blog.zolty.systems
 *
 * Takes full-page screenshots of key pages and compares them against committed
 * baselines. A test fails when MORE than 5% of pixels change dramatically,
 * catching layout breaks, CSS regressions, missing images, or wiped content.
 *
 * FIRST RUN: baselines don't exist yet. Run:
 *   cd tests && npx playwright test visual --update-snapshots
 * then commit the generated snapshots/ directory.
 *
 * Update baselines intentionally after design changes:
 *   npm run update-snapshots
 */

import { test, expect } from '@playwright/test';

/** Pages that must look visually consistent across deployments */
const KEY_PAGES = [
  { name: 'home', path: '/' },
  { name: 'posts-index', path: '/posts/' },
  { name: 'about', path: '/about/' },
  { name: 'gear', path: '/gear/' },
  { name: 'search', path: '/search/' },
];

/**
 * Freeze animations and ads so screenshots are deterministic.
 * Google Ads and dynamic date-based content are masked.
 */
async function prepareForScreenshot(page: import('@playwright/test').Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        animation-duration: 0s !important;
        transition-duration: 0s !important;
        transition: none !important;
      }
      /* Mask ad iframes — they change every load */
      ins.adsbygoogle, iframe[src*="google"], .adsbygoogle { visibility: hidden !important; }
    `,
  });
}

for (const pageConfig of KEY_PAGES) {
  test(`[visual] ${pageConfig.name} page — no dramatic changes`, async ({ page }) => {
    const response = await page.goto(pageConfig.path, { waitUntil: 'networkidle' });

    // The page must actually load
    expect(response?.status(), `${pageConfig.path} returned non-200`).toBeLessThan(400);

    // Ensure the page has meaningful content (not a blank/error page)
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length, 'Page body is empty — possible render failure').toBeGreaterThan(100);

    await prepareForScreenshot(page);

    // Compare full-page screenshot against committed baseline.
    // maxDiffPixelRatio: 0.05 = fail if >5% of pixels changed significantly.
    // threshold: 0.2 = pixel-level color change sensitivity (0=strict, 1=loose).
    await expect(page).toHaveScreenshot(`${pageConfig.name}.png`, {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
      threshold: 0.2,
      // Mask elements that legitimately change (timestamps, random article cards)
      mask: [
        page.locator('time'),
        page.locator('.post-meta time'),
        page.locator('[data-nosnippet]'),
      ],
    });
  });
}

/** Spot-check: the most recent post should always render a visible hero/title */
test('[visual] latest post page renders correctly', async ({ page }) => {
  // Fetch the RSS feed to find the latest post URL
  const rssResp = await page.request.get('/index.xml');
  expect(rssResp.status()).toBe(200);

  const rssText = await rssResp.text();
  const match = rssText.match(/<link>(?!https:\/\/blog\.zolty\.systems\/(?:tags|categories|series))(https:\/\/blog\.zolty\.systems\/posts\/[^<]+)<\/link>/);

  if (!match) {
    test.skip(true, 'Could not find a post link in RSS feed');
    return;
  }

  const latestPostUrl = match[1];
  console.log(`Checking latest post: ${latestPostUrl}`);

  const response = await page.goto(latestPostUrl, { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);

  // Title must be visible
  const title = page.locator('h1').first();
  await expect(title).toBeVisible();

  // Post must have real article content
  const articleText = await page.locator('article').innerText().catch(() => '');
  expect(articleText.length).toBeGreaterThan(200);

  await prepareForScreenshot(page);

  await expect(page).toHaveScreenshot('latest-post.png', {
    fullPage: true,
    maxDiffPixelRatio: 0.10, // More lenient — content changes each deploy
    threshold: 0.2,
    mask: [page.locator('time'), page.locator('ins.adsbygoogle')],
  });
});
