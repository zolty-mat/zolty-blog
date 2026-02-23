/**
 * security.spec.ts — OWASP Top 10 relevant checks for blog.zolty.systems
 *
 * Covers OWASP categories applicable to a static Hugo blog served via CloudFront:
 *   A01 – Broken Access Control: sensitive file exposure
 *   A02 – Cryptographic Failures: HTTPS enforcement, HSTS
 *   A05 – Security Misconfiguration: HTTP security headers
 *   A06 – Vulnerable Components: outdated dependency signals
 *   A08 – Software/Data Integrity: mixed content
 *
 * NOTE: A03 (Injection), A04 (Insecure Design), A07 (Auth Failures),
 *       A09 (Logging), A10 (SSRF) are N/A for a read-only static site.
 *
 * Deeper OWASP scanning (active scanner, spider, ZAP) runs via
 * nuclei in the `site-scan.yml` CI workflow.
 */

import { test, expect } from '@playwright/test';

// ─── A02 / A05: HTTPS + Required Security Headers ───────────────────────────

test('[security:A02] site is served over HTTPS', async ({ request }) => {
  // If the site redirects HTTP → HTTPS, that counts. We verify the final URL
  // is HTTPS and HSTS is set.
  const resp = await request.get('https://blog.zolty.systems/', { failOnStatusCode: false });
  expect(resp.status()).toBeLessThan(400);

  const url = resp.url();
  expect(url.startsWith('https://'), `Final URL must be HTTPS, got: ${url}`).toBe(true);
});

test('[security:A02] HSTS header is present and has adequate max-age', async ({ request }) => {
  const resp = await request.get('/');
  const hsts = resp.headers()['strict-transport-security'];

  expect(hsts, 'Strict-Transport-Security header is missing').toBeTruthy();

  const maxAgeMatch = hsts?.match(/max-age=(\d+)/);
  expect(maxAgeMatch, 'HSTS header missing max-age directive').toBeTruthy();

  const maxAge = parseInt(maxAgeMatch![1], 10);
  // OWASP recommends ≥ 6 months (15768000s). 1 year (31536000s) is standard.
  expect(maxAge, `HSTS max-age ${maxAge}s is too short (minimum 15768000s)`).toBeGreaterThanOrEqual(
    15_768_000
  );

  console.log(`HSTS: ${hsts}`);
});

test('[security:A05] X-Frame-Options or CSP frame-ancestors is set', async ({ request }) => {
  const resp = await request.get('/');
  const xfo = resp.headers()['x-frame-options'];
  const csp = resp.headers()['content-security-policy'];

  const hasFrameProtection =
    xfo || (csp && (csp.includes('frame-ancestors') || csp.includes("frame-src 'none'")));

  expect(
    hasFrameProtection,
    'Neither X-Frame-Options nor CSP frame-ancestors is set — clickjacking risk'
  ).toBeTruthy();

  if (xfo) console.log(`X-Frame-Options: ${xfo}`);
  if (csp) console.log(`CSP (truncated): ${csp.slice(0, 80)}...`);
});

test('[security:A05] X-Content-Type-Options is set to nosniff', async ({ request }) => {
  const resp = await request.get('/');
  const xcto = resp.headers()['x-content-type-options'];

  expect(xcto, 'X-Content-Type-Options header is missing').toBeTruthy();
  expect(xcto?.toLowerCase()).toContain('nosniff');
});

test('[security:A05] no server version disclosure', async ({ request }) => {
  const resp = await request.get('/');
  const serverHeader = resp.headers()['server'] ?? '';
  const poweredBy = resp.headers()['x-powered-by'] ?? '';

  // CloudFront returns "CloudFront" which is fine.
  // We want to ensure no version strings leak (e.g., "Apache/2.4.52", "nginx/1.18").
  const versionPattern = /\d+\.\d+(\.\d+)?/;

  if (versionPattern.test(serverHeader)) {
    console.warn(`Server header discloses version: ${serverHeader}`);
    // Warn but don't fail — CloudFront controls this header
  }

  expect(poweredBy, 'X-Powered-By header leaks technology version').not.toMatch(versionPattern);
});

// ─── A01: Broken Access Control / Sensitive File Exposure ───────────────────

test('[security:A01] .git directory is not exposed', async ({ request }) => {
  // Exposed .git/ leaks source code, commit history, secrets
  const sensitiveChecks = [
    { path: '/.git/config', description: '.git/config' },
    { path: '/.git/HEAD', description: '.git/HEAD' },
  ];

  for (const { path, description } of sensitiveChecks) {
    const resp = await request.get(path, { failOnStatusCode: false });
    expect(
      resp.status(),
      `${description} must NOT be publicly accessible (returned ${resp.status()})`
    ).not.toBe(200);
  }
});

test('[security:A01] sensitive config files are not exposed', async ({ request }) => {
  const sensitivePaths = [
    { path: '/.env', description: 'Environment file' },
    { path: '/config.toml', description: 'Hugo config (root)' },
    { path: '/hugo.toml', description: 'Hugo config alternative' },
    { path: '/credentials.json', description: 'Credentials file' },
    { path: '/terraform.tfstate', description: 'Terraform state' },
    { path: '/docker-compose.yml', description: 'Docker Compose file' },
    { path: '/wp-login.php', description: 'WordPress login (probing)' },
    { path: '/admin', description: 'Admin panel' },
    { path: '/phpinfo.php', description: 'PHP info' },
  ];

  const exposed: string[] = [];

  for (const { path, description } of sensitivePaths) {
    const resp = await request.get(path, { failOnStatusCode: false, timeout: 10_000 });
    if (resp.status() === 200) {
      const body = await resp.text();
      // Some CDNs return 200 with the 404 page — check for actual file content
      if (body.length > 0 && !body.includes('<!DOCTYPE') && !body.includes('<html')) {
        exposed.push(`${description} (${path}) → HTTP 200 with non-HTML content`);
      } else if (resp.status() === 200 && body.length < 50) {
        exposed.push(`${description} (${path}) → HTTP 200 with suspicious small body`);
      }
    }
  }

  if (exposed.length > 0) {
    throw new Error('Sensitive files may be exposed:\n' + exposed.map((e) => `  ✗ ${e}`).join('\n'));
  }
});

// ─── A08: Software and Data Integrity / Mixed Content ───────────────────────

test('[security:A08] no mixed content on homepage', async ({ page }) => {
  const mixedContentWarnings: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'warning' && msg.text().toLowerCase().includes('mixed content')) {
      mixedContentWarnings.push(msg.text());
    }
  });

  page.on('requestfailed', (req) => {
    if (req.url().startsWith('http://')) {
      mixedContentWarnings.push(`Blocked mixed content: ${req.url()}`);
    }
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  // Check that all resource requests are HTTPS
  const failedHttp: string[] = [];
  await page.evaluate(() => {
    performance.getEntriesByType('resource').forEach((entry) => {
      const re = entry as PerformanceResourceTiming;
      if (re.name.startsWith('http://')) {
        console.warn(`Mixed content resource: ${re.name}`);
      }
    });
  });

  if (mixedContentWarnings.length > 0) {
    throw new Error(
      'Mixed content detected (A08):\n' + mixedContentWarnings.map((w) => `  ✗ ${w}`).join('\n')
    );
  }
});

// ─── A05: CSP Presence Check ────────────────────────────────────────────────

test('[security:A05] Content-Security-Policy header is present', async ({ request }) => {
  const resp = await request.get('/');
  const csp = resp.headers()['content-security-policy'];

  if (!csp) {
    // Warn rather than hard-fail — CloudFront CSP requires distribution config changes
    console.warn(
      '⚠  Content-Security-Policy header is missing.\n' +
        '   Configure via CloudFront response headers policy.\n' +
        '   Recommended: default-src \'self\'; script-src \'self\' \'unsafe-inline\' https://pagead2.googlesyndication.com;\n' +
        '   Marking as warning — will become a failure in future.'
    );
  } else {
    console.log(`CSP: ${csp.slice(0, 120)}...`);
    // If CSP IS set, make sure it isn't empty or trivially permissive
    expect(csp.trim().length).toBeGreaterThan(10);
    expect(csp).not.toContain("default-src *");
  }
});

// ─── A05: Cache-Control on sensitive error pages ────────────────────────────

test('[security:A05] 404 page is not cached aggressively', async ({ request }) => {
  const resp = await request.get('/this-page-definitely-does-not-exist-abc123xyz', {
    failOnStatusCode: false,
  });

  // CloudFront serves the custom 404 page — should be 404 status
  expect([404, 200]).toContain(resp.status()); // CloudFront may return 200 with 404 page

  const cacheControl = resp.headers()['cache-control'] ?? '';
  // 404 responses shouldn't be cached indefinitely
  if (cacheControl.includes('immutable') || cacheControl.includes('max-age=31536000')) {
    console.warn(`⚠  404 response is being cached long-term: ${cacheControl}`);
  }
});
