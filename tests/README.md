# Site Scanning Tests

Dynamic site scanning for [blog.zolty.systems](https://blog.zolty.systems) — runs after every deploy.

## What's checked

| File | What it tests |
|------|--------------|
| `visual.spec.ts` | **Visual regression** — full-page screenshots compared to committed baselines. Fails if >5% of pixels change, catching layout breaks, missing CSS, or wiped content. |
| `links.spec.ts` | **Broken links & errors** — validates all sitemap URLs return 2xx, crawls key pages for dead outbound links, verifies critical assets (RSS, search index, robots.txt). |
| `security.spec.ts` | **OWASP header security** — checks HTTPS enforcement, HSTS max-age, X-Frame-Options, X-Content-Type-Options, mixed content, sensitive file exposure, no version disclosure. |

The CI workflow (`site-scan.yml`) also runs **nuclei** with OWASP Top 10 templates for network-level active scanning.

## Running locally

```bash
cd tests
npm ci
npx playwright install chromium --with-deps

# Run all tests against live site
SITE_URL=https://blog.zolty.systems npx playwright test

# Run individual test files
npx playwright test visual.spec.ts
npx playwright test links.spec.ts
npx playwright test security.spec.ts

# Open the HTML report
npx playwright show-report playwright-report
```

## Visual baseline setup (first time only)

Before visual tests pass in CI, generate and commit baselines:

```bash
SITE_URL=https://blog.zolty.systems npx playwright test visual --update-snapshots
git add snapshots/
git commit -m "test: add visual regression baselines"
```

## CI integration

The `site-scan.yml` workflow triggers automatically after `Deploy Blog` succeeds on `main`.
It can also be triggered manually via `workflow_dispatch` with an optional custom `SITE_URL`.

Artifacts uploaded per run:
- `playwright-report-{run_id}` — full HTML report (14-day retention)
- `playwright-screenshots-{run_id}` — failure screenshots (7-day retention)
- `nuclei-results-{run_id}` — JSON security scan results (30-day retention)
