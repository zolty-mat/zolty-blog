/**
 * links.spec.ts — Broken link and HTTP error detection for blog.zolty.systems
 *
 * Strategy:
 *  1. Parse /sitemap.xml to get every published URL.
 *  2. HEAD each URL — fail on 4xx/5xx.
 *  3. For a subset of pages, collect all <a href> links and HEAD each one.
 *  4. Report all failures together so a single test run shows all broken links.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';

const MAX_PAGES_TO_CRAWL = 30;         // Full sitemap check (status codes only)
const MAX_LINKS_PER_PAGE = 50;         // Max outbound links to check per page
const MAX_CRAWL_PAGES_FOR_LINKS = 10;  // Pages to deep-crawl for <a href> links
const IGNORE_PATTERNS: RegExp[] = [
  /^mailto:/,
  /^tel:/,
  /^javascript:/,
  /#.*$/,
  /linkedin\.com/,
  /twitter\.com|x\.com/,
  /amazon\.com/,
  /reddit\.com\/submit/,
  /news\.ycombinator\.com\/submitlink/,
  /facebook\.com\/sharer/,
  /threads\.net\/intent/,
  /wa\.me\//,
  /t\.co\//,
];

function shouldCheck(url: string): boolean {
  return !IGNORE_PATTERNS.some((p) => p.test(url));
}

/** Fetch the sitemap and return all <loc> URLs */
async function getSitemapUrls(request: APIRequestContext): Promise<string[]> {
  const resp = await request.get('/sitemap.xml');
  if (!resp.ok()) {
    throw new Error(`sitemap.xml returned ${resp.status()}`);
  }
  const text = await resp.text();
  const urls = [...text.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)].map((m) => m[1]);
  return urls;
}

test('[links] sitemap.xml is valid and reachable', async ({ request }) => {
  const resp = await request.get('/sitemap.xml');
  expect(resp.status(), 'sitemap.xml must return 200').toBe(200);

  const text = await resp.text();
  expect(text).toContain('<urlset');
  expect(text).toContain('<loc>');

  const urls = [...text.matchAll(/<loc>/g)];
  expect(urls.length, 'sitemap must contain at least 5 URLs').toBeGreaterThan(5);
  console.log(`sitemap.xml contains ${urls.length} URLs`);
});

test('[links] robots.txt is present and allows indexing', async ({ request }) => {
  const resp = await request.get('/robots.txt');
  expect(resp.status()).toBe(200);

  const text = await resp.text();
  // Should NOT disallow all crawlers (would kill SEO)
  expect(text).not.toMatch(/Disallow:\s+\/\s*$/m);
  // Sitemap declaration should be present
  expect(text).toContain('Sitemap:');
});

test('[links] all sitemap pages return 200', async ({ request }) => {
  const urls = await getSitemapUrls(request);
  const toCheck = urls.slice(0, MAX_PAGES_TO_CRAWL);

  console.log(`Checking ${toCheck.length} of ${urls.length} sitemap URLs...`);

  const failures: string[] = [];
  const skipped: string[] = [];

  for (const url of toCheck) {
    try {
      const resp = await request.head(url, { failOnStatusCode: false, timeout: 15_000 });
      if (resp.status() >= 400) {
        failures.push(`HTTP ${resp.status()} — ${url}`);
      }
    } catch (e) {
      failures.push(`TIMEOUT/ERROR — ${url}: ${(e as Error).message}`);
      skipped.push(url);
    }
  }

  if (skipped.length > 0) {
    console.warn(`\nSkipped (timeout/error): ${skipped.length} URLs`);
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} broken page(s) found:\n` + failures.map((f) => `  ✗ ${f}`).join('\n')
    );
  }

  console.log(`✓ All ${toCheck.length} sitemap pages returned 2xx/3xx`);
});

test('[links] no broken outbound links on key pages', async ({ page, request }) => {
  const urls = await getSitemapUrls(request);

  // Sample a spread of pages: home + first N posts
  const pagesToCrawl = [
    urls[0], // home
    ...urls.filter((u) => u.includes('/posts/')).slice(0, MAX_CRAWL_PAGES_FOR_LINKS - 1),
  ].slice(0, MAX_CRAWL_PAGES_FOR_LINKS);

  const allFailures: string[] = [];
  const checked = new Set<string>();

  for (const pageUrl of pagesToCrawl) {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Collect all links on this page
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((a) => (a as HTMLAnchorElement).href)
        .filter(Boolean)
    );

    const links = hrefs
      .filter(shouldCheck)
      .filter((u) => !checked.has(u))
      .slice(0, MAX_LINKS_PER_PAGE);

    console.log(`  ${pageUrl}: checking ${links.length} links`);

    for (const link of links) {
      if (checked.has(link)) continue;
      checked.add(link);

      try {
        let resp = await request.head(link, { failOnStatusCode: false, timeout: 12_000 });

        // Some servers don't support HEAD — fall back to GET
        if (resp.status() === 405) {
          resp = await request.get(link, { failOnStatusCode: false, timeout: 12_000 });
        }

        if (resp.status() >= 400 && resp.status() !== 429) {
          // 429 = rate limited (expected for some external sites) — skip
          const isExternal = !link.includes('blog.zolty.systems');
          if (isExternal && resp.status() === 405) {
            // External sites refusing HEAD/GET = their restriction, not our bug
            continue;
          }
          allFailures.push(`HTTP ${resp.status()} — ${link}  (found on ${pageUrl})`);
        }
      } catch {
        // Network errors for external links are warnings, not failures
        console.warn(`  WARN: could not reach ${link}`);
      }
    }
  }

  console.log(`\nChecked ${checked.size} unique links across ${pagesToCrawl.length} pages`);

  if (allFailures.length > 0) {
    throw new Error(
      `${allFailures.length} broken link(s) found:\n` +
        allFailures.map((f) => `  ✗ ${f}`).join('\n')
    );
  }

  console.log(`✓ No broken links detected`);
});

test('[links] critical content assets are reachable', async ({ request }) => {
  const criticalPaths = [
    '/',
    '/index.json',    // Search index
    '/index.xml',     // RSS feed
    '/sitemap.xml',
    '/robots.txt',
    '/404.html',
  ];

  const failures: string[] = [];

  for (const path of criticalPaths) {
    const resp = await request.get(path, { failOnStatusCode: false });
    if (['/404.html'].includes(path)) {
      // 404 page returns 404 — that's correct
      if (resp.status() !== 404 && resp.status() !== 200) {
        failures.push(`${path}: expected 404 or 200, got ${resp.status()}`);
      }
    } else {
      if (resp.status() !== 200) {
        failures.push(`${path}: expected 200, got ${resp.status()}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error('Critical assets missing:\n' + failures.map((f) => `  ✗ ${f}`).join('\n'));
  }
});

test('[links] search index is valid JSON', async ({ request }) => {
  const resp = await request.get('/index.json');
  expect(resp.status(), 'Search index (/index.json) must return 200').toBe(200);

  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Search index is not valid JSON');
  }

  expect(Array.isArray(parsed), 'Search index must be a JSON array').toBe(true);
  const arr = parsed as unknown[];
  expect(arr.length, 'Search index must have at least 1 entry').toBeGreaterThan(0);

  const first = arr[0] as Record<string, unknown>;
  expect(first).toHaveProperty('title');
  expect(first).toHaveProperty('permalink');
});
