# Playwright Visual Regression Baselines

This directory contains committed screenshot baselines used by `visual.spec.ts`.

## First-time setup (generating baselines)

Baselines must be generated against the live site and committed before the
visual regression tests will pass in CI. Run once from the `tests/` directory:

```bash
cd tests
npm ci
npx playwright install chromium --with-deps

# Generate baselines against the live site
SITE_URL=https://blog.zolty.systems npx playwright test visual --update-snapshots

# Commit the generated snapshots
git add snapshots/
git commit -m "test: add visual regression baselines"
git push
```

## Updating baselines after intentional design changes

If you change the Hugo theme, layout, or CSS intentionally:

```bash
cd tests
SITE_URL=https://blog.zolty.systems npx playwright test visual --update-snapshots
git add snapshots/
git commit -m "test: update visual regression baselines after design change"
```

## How it works

- Each screenshot is taken full-page with animations frozen
- Dynamic content (timestamps, ads) is masked before comparison
- A test fails if >5% of pixels change significantly (`maxDiffPixelRatio: 0.05`)
- The `latest-post.png` snapshot is more lenient (10%) since post content changes
