---
title: "Building a TCG Price Tracker with Selenium and Kubernetes"
date: 2026-03-12T20:00:00-06:00
draft: false
author: "zolty"
description: "How I built Cardboard -- a trading card game price tracker that monitors 10 TCGs across TCGPlayer and eBay using a three-tier scraping strategy, runs on k3s, and displays historical price data on a Chart.js dashboard."
tags: ["scraping", "selenium", "python", "flask", "tcg", "pokemon", "homelab"]
categories: ["Applications"]
cover:
  image: "/images/covers/applications.svg"
  alt: "TCG price tracker"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

Cardboard is a TCG price tracker that monitors sealed product prices across 10 trading card games. It scrapes TCGPlayer and eBay using a three-tier strategy: pure API calls for bulk data, headless Selenium for product pages, and non-headless Selenium with a virtual display for sites that actively detect headless browsers. The scrapers run as Kubernetes Jobs on the same k3s cluster from [Cluster Genesis](/posts/2026-02-08-cluster-genesis/). A Flask dashboard with Chart.js renders historical price data, profit/loss calculations, and portfolio tracking. All scraping is intentionally rate-limited to match normal human browsing patterns -- the goal is polite data collection, not stress testing someone else's infrastructure.

Source code will be published to GitHub when the project is ready.

## Why Build It

I have been accumulating sealed TCG products for a few years -- Pokemon booster boxes, Magic: The Gathering collector packs, some Disney Lorcana first edition boxes. These are speculative investments. Sealed product from popular sets tends to appreciate over time, especially after a set rotates out of print. But tracking whether my collection is actually gaining value required manually checking TCGPlayer every few days, mentally noting prices, and hoping I remembered what I paid.

The existing tools are not great for this use case. TCGPlayer has price history for individual cards, but not a clean view of sealed product trends across games. eBay's sold listings tell you what things actually sell for, but there is no historical aggregation. Third-party trackers either focus on single cards (not sealed product), cover only one or two games, or charge a subscription fee for historical data.

What I wanted was simple: track the market price of specific items I own across all the TCGs I care about, compute profit/loss against what I paid, and visualize trends over time. So I built it.

## Supported Games

Cardboard tracks 10 trading card games. Priority determines scraping order -- higher priority games get scraped first in each run.

| Game | Priority |
|------|----------|
| Pokemon | 1 |
| Magic: The Gathering | 2 |
| Yu-Gi-Oh! | 3 |
| Disney Lorcana | 4 |
| One Piece | 5 |
| Weiss Schwarz | 6 |
| Flesh and Blood | 7 |
| Star Wars: Unlimited | 8 |
| Digimon | 9 |
| Cardfight!! Vanguard | 10 |

Pokemon and MTG get the highest priority because that is where most of the money is. The lower-priority games still get scraped every cycle -- priority just determines the order in case a job gets killed before finishing.

## Architecture Overview

The application has three main components:

```text
┌────────────────────────────────────────────┐
│  Flask Web App (port 5555)                 │
│  Gunicorn, 2 workers                       │
│  Chart.js dashboards                       │
│  Prometheus metrics on /metrics            │
├────────────────────────────────────────────┤
│  PostgreSQL (production)                   │
│  SQLite (local dev)                        │
│  6 tables, 7 indexes                       │
├────────────────────────────────────────────┤
│  4 Specialized Scrapers                    │
│  Run as K8s Jobs / CronJobs                │
│  TCGPlayer API, TCGPlayer Selenium,        │
│  TCGPlayer History, eBay Selenium          │
└────────────────────────────────────────────┘
```

Everything runs in the `cardboard` namespace on k3s. The web app is a standard Deployment with a Service and IngressRoute. The scrapers are ephemeral -- they run as Jobs, do their work, write results to the database, and exit.

## The Three-Tier Scraping Strategy

This is the core of Cardboard. Different data sources require different scraping techniques, and I ended up with three tiers based on how aggressively each target detects and blocks automated requests.

### Tier 1: API-Only (No Browser Needed)

TCGPlayer exposes internal JSON APIs that their frontend uses. These are not documented or officially supported, but they are stable and return structured data that is far more reliable than parsing rendered HTML.

**Set discovery** uses a `GET` endpoint that returns catalog set names with pagination. Each page returns up to 500 sets. The scraper pages through all results to build a complete set list for each game:

```python
def discover_sets(game_name, category_id):
    """Page through TCGPlayer's internal set catalog API."""
    all_sets = []
    offset = 0
    limit = 500

    while True:
        response = session.get(
            SET_CATALOG_URL,
            params={
                "categoryId": category_id,
                "limit": limit,
                "offset": offset,
            },
            headers=build_headers(),
        )
        data = response.json()
        sets = data.get("results", [])
        all_sets.extend(sets)

        if len(sets) < limit:
            break
        offset += limit
        time.sleep(BASE_DELAY + random.uniform(0, JITTER_MAX))

    return all_sets
```

**Price search** uses a `POST` endpoint with filters for product line, set name, and product type. This returns current market prices, listed median, and listing counts without ever touching a browser:

```python
def search_prices(product_line, set_name, product_type="Sealed Products"):
    """Query TCGPlayer's price search API directly."""
    payload = {
        "filters": {
            "productLineName": product_line,
            "setName": set_name,
            "productTypeName": product_type,
        },
        "sort": {"field": "market-price", "order": "desc"},
    }
    response = session.post(
        PRICE_SEARCH_URL,
        json=payload,
        headers=build_headers(),
    )
    return response.json()
```

No Selenium overhead, no browser memory consumption, no rendering delays. Tier 1 handles the bulk of data collection and is by far the fastest and most reliable approach.

Rate limiting is straightforward: a fixed delay between requests plus random jitter between 0 and 1.5 seconds. On errors, exponential backoff kicks in -- the wait time doubles on each retry up to 3 attempts.

### Tier 2: Headless Selenium (TCGPlayer Product Pages)

For individually tracked items with specific product URLs, I need to visit the actual product page to extract the current market price. TCGPlayer renders prices client-side with JavaScript, so a simple HTTP request returns an empty price container.

Chrome runs in headless mode inside the container. The scraper navigates to each product URL and waits for the "Market Price" text to appear:

```python
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

def scrape_product_price(driver, url):
    """Extract market price from a TCGPlayer product page."""
    driver.get(url)

    # Wait up to 10 seconds for price data to render
    WebDriverWait(driver, 10).until(
        EC.text_to_be_present_in_element(
            (By.TAG_NAME, "body"), "Market Price"
        )
    )

    # Try three extraction strategies in order
    price = try_regex_extraction(driver)
    if not price:
        price = try_css_class_extraction(driver)
    if not price:
        price = try_json_ld_extraction(driver)

    return price
```

Three price extraction strategies are tried in order of reliability:

1. **Regex search**: Scan the full page text for market price patterns. This is the most resilient to DOM structure changes.
2. **CSS class-based search**: Look for specific price elements by their CSS classes. Faster but breaks when TCGPlayer redesigns the page.
3. **JSON-LD structured data**: Extract pricing from the structured data `<script>` tags that TCGPlayer includes for SEO. This is a fallback -- the data is sometimes stale or missing for sealed products.

The inter-request delay between product pages is fixed at several seconds. Headless Chrome consumes more memory than pure API calls, but it is necessary when the data only exists in the rendered DOM.

### Tier 3: Non-Headless Selenium with Virtual Display (eBay)

eBay is the hardest target. Headless Chrome requests to eBay return empty search results, CAPTCHA pages, or redirect loops. eBay actively fingerprints the browser environment and blocks requests that look automated.

The solution is to run Chrome in non-headless mode -- a real desktop browser with a full GUI -- but display it on a virtual framebuffer instead of a physical monitor. Xvfb (X Virtual Framebuffer) provides this:

```python
from xvfbwrapper import Xvfb

def scrape_ebay_sold_listings(search_term):
    """Scrape eBay sold listings using a non-headless browser."""
    # Start virtual display at 1920x1080, 24-bit color
    vdisplay = Xvfb(width=1920, height=1080, colordepth=24)
    vdisplay.start()

    try:
        options = webdriver.ChromeOptions()
        # No --headless flag -- this is the key difference
        driver = webdriver.Chrome(options=options)

        # Navigate and extract sold listing data
        driver.get(build_ebay_search_url(search_term, sold=True))
        listings = extract_sold_listings(driver, max_results=30)

        # Also grab active listings for comparison
        driver.get(build_ebay_search_url(search_term, sold=False))
        active = extract_active_listings(driver, max_results=15)

        return compute_price_stats(listings, active)
    finally:
        driver.quit()
        vdisplay.stop()
```

The Xvfb display runs at 1920x1080x24 inside the container -- a resolution that matches a standard desktop monitor. To eBay's detection systems, this looks like a real person opening Chrome on their desktop.

From the sold listings, Cardboard computes several price signals:

- **Median sold price** -- the primary signal, less influenced by outliers than mean
- **Mean sold price** -- useful for comparison
- **Min and max sold prices** -- shows the range of what buyers actually pay
- Statistics from up to 30 sold listings and 15 active listings per item

{{< ad >}}

## Anti-Detection Approach

I want to be clear about the philosophy here: the goal is not to "defeat" anti-bot systems in an adversarial way. The goal is to make requests that look like a normal person browsing the site, because the request volume and pattern genuinely is comparable to a normal person browsing the site.

The practical measures are straightforward:

- **Disable automation indicator flags** in Chrome that explicitly announce "this is a bot." These flags serve no purpose for a legitimate use case like periodic price checking.
- **Override browser properties** that differ between automated and manual Chrome instances. Out of the box, Selenium-controlled Chrome has several JavaScript-observable differences from a manually opened Chrome window.
- **Virtual display** for sites that check whether a display is attached. This is the Tier 3 approach -- running a real browser on a virtual screen instead of using headless mode.

I am deliberately not publishing the specific flags, properties, or configuration strings in this post. The techniques are well-documented elsewhere, and including the exact fingerprint would just make it easier for someone to copy-paste a scraping setup without understanding the responsibility that comes with it.

The most important anti-detection measure is not technical at all -- it is keeping request rates on par with a human browsing the site. A few requests per minute with natural delays between them. The goal is to be a polite visitor, not to stress infrastructure.

## Rate Limiting and Respectful Scraping

This is the section I feel most strongly about. Scraping is a privilege, not a right. If your scraper is making life harder for the site's actual users or operations team, you are doing it wrong.

Cardboard's rate limiting strategy:

1. **Fixed delays between requests**: Multiple seconds between each request. Not milliseconds -- seconds.
2. **Random jitter**: A random additional delay (up to 1.5 seconds) added on top of the fixed delay. Fixed-interval requests create a detectable metronome pattern. Jitter makes the timing look natural.
3. **Exponential backoff on errors**: If a request fails, the wait time doubles before retrying. First retry waits 2x the base delay, second retry waits 4x, third retry waits 8x. After 3 failures, the scraper moves on to the next item.
4. **Session management**: On certain error codes, the scraper clears all session cookies and starts fresh. This prevents a "poisoned" session from causing cascading failures.
5. **Sequential execution only**: Every request happens one at a time, sequentially. No parallel requests, no concurrent browser sessions, no thread pools hammering the server. One request, wait, one request, wait.

The total daily request volume across all scrapers is comparable to a single person manually checking prices on their lunch break. That is by design.

```python
# Simplified rate limiting pattern used across all scrapers
import time
import random

BASE_DELAY = 3.0        # seconds between requests
JITTER_MAX = 1.5        # random additional delay
MAX_RETRIES = 3
BACKOFF_FACTOR = 2.0

def rate_limited_request(session, url, retries=0):
    """Make a request with rate limiting and exponential backoff."""
    try:
        response = session.get(url, headers=build_headers(), timeout=30)
        response.raise_for_status()

        # Success -- wait before next request
        delay = BASE_DELAY + random.uniform(0, JITTER_MAX)
        time.sleep(delay)

        return response
    except requests.RequestException as e:
        if retries >= MAX_RETRIES:
            logger.warning(f"Max retries reached for {url}: {e}")
            return None

        # Exponential backoff
        backoff = BASE_DELAY * (BACKOFF_FACTOR ** (retries + 1))
        jitter = random.uniform(0, JITTER_MAX)
        logger.info(f"Retry {retries + 1}, waiting {backoff + jitter:.1f}s")
        time.sleep(backoff + jitter)

        return rate_limited_request(session, url, retries + 1)
```

## Historical Price Data

TCGPlayer product pages include interactive price charts that show price and volume history over different time periods. This data is valuable -- it tells you not just what something costs today, but how its price has moved over weeks, months, and years.

The history scraper navigates to each product page with Selenium, then clicks through the time period buttons to capture data for different windows:

```python
TIME_PERIODS = ["1M", "3M", "1Y", "ALL"]

def scrape_price_history(driver, product_url):
    """Extract chart data across multiple time periods."""
    driver.get(product_url)
    history = {}

    for period in TIME_PERIODS:
        # Click the time period button
        button = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable(
                (By.XPATH, f"//button[text()='{period}']")
            )
        )
        button.click()
        time.sleep(1)  # Wait for chart to re-render

        # Extract chart data via in-browser fetch
        chart_data = extract_chart_data(driver, period)
        if chart_data:
            history[period] = chart_data

    return history
```

The extraction is where it gets interesting. Once the browser has loaded the page and established a session, the scraper uses in-browser `fetch()` calls to hit the same chart data APIs that the frontend JavaScript calls. Because the `fetch()` runs inside the browser context, it automatically includes the session cookies and headers that the page already has -- no need to reverse-engineer cookie flows or session tokens:

```python
def extract_chart_data(driver, period):
    """Try multiple strategies to get chart data."""
    # Strategy 1: In-browser fetch using the page's own session
    data = driver.execute_script("""
        try {
            const response = await fetch(arguments[0], {
                credentials: 'include'
            });
            return await response.json();
        } catch(e) {
            return null;
        }
    """, build_chart_api_url(period))

    if data:
        return data

    # Strategy 2: Intercept network logs for chart data requests
    data = check_network_logs(driver)
    if data:
        return data

    # Strategy 3: Extract from page state / embedded data
    return extract_page_state(driver)
```

From the chart data, Cardboard captures price snapshots including: low sale price, high sale price, total number sold, and average daily sold volume. These snapshots build a time series that powers the dashboard's historical charts.

## Running Scrapers on Kubernetes

Scrapers are a natural fit for Kubernetes Jobs. They are ephemeral workloads -- start up, do work, save results, shut down. There is no need for a long-running process sitting idle between scraping cycles.

The Flask web dashboard can trigger scraper Jobs on-demand via the Kubernetes API. Click a button in the UI, and a new Job spins up in the `cardboard` namespace:

```python
from kubernetes import client, config

def trigger_scraper_job(scraper_type):
    """Create a K8s Job for the specified scraper."""
    config.load_incluster_config()
    batch_v1 = client.BatchV1Api()

    job = client.V1Job(
        metadata=client.V1ObjectMeta(
            name=f"{scraper_type}-{int(time.time())}",
            namespace="cardboard",
        ),
        spec=client.V1JobSpec(
            template=client.V1PodTemplateSpec(
                spec=client.V1PodSpec(
                    containers=[
                        client.V1Container(
                            name=scraper_type,
                            image=f"{ECR_REPO}/cardboard-scraper:latest",
                            args=[f"--scraper={scraper_type}"],
                            resources=get_resource_limits(scraper_type),
                        )
                    ],
                    restart_policy="Never",
                    node_selector={"kubernetes.io/arch": "amd64"},
                )
            ),
            backoff_limit=1,
        ),
    )
    batch_v1.create_namespaced_job("cardboard", job)
```

CronJobs handle the automated schedule. Different scrapers run at different intervals based on how frequently prices change and how expensive the scraping operation is.

Resource limits vary by scraper type. The API-only scraper (Tier 1) needs minimal resources -- 256Mi of memory is plenty. The Selenium scrapers (Tier 2 and 3) need significantly more because Chrome is a memory hog:

| Scraper | Memory Request | Memory Limit |
|---------|---------------|--------------|
| API scraper | 128Mi | 256Mi |
| TCGPlayer Selenium | 512Mi | 1Gi |
| eBay Selenium (Xvfb) | 1Gi | 3Gi |
| History scraper | 512Mi | 1.5Gi |

All scraper Jobs use `nodeSelector: kubernetes.io/arch: amd64` because Chrome only runs on amd64. The cluster has both amd64 and arm64 nodes, and without the selector, a Selenium job scheduled on an ARM node would fail immediately.

## The Dashboard

The web dashboard uses Chart.js for all visualizations. Eight different chart types cover the various ways I want to look at the data.

### Chart Types

1. **Individual item price history** -- a line chart showing market price over time for a single item. The most frequently used view.
2. **All items overlay** -- every tracked item on one line chart with vertical annotations marking each item's release date. Good for spotting market-wide trends.
3. **Profit/Loss** -- a bar chart showing P/L per item, calculated from purchase price vs. current market value. Green bars for gains, red for losses.
4. **Portfolio value over time** -- a line chart of total portfolio value across all tracked items. The "am I winning?" chart.
5. **Set value history** -- aggregate line chart showing the total value of all tracked items in a set over time.
6. **Sparkline mini-charts** -- tiny 30-day trend lines displayed inline in the item table. At a glance, you can see which items are trending up, down, or flat without clicking into individual charts.
7. **Card price history** -- line chart for individual card prices (not just sealed product).
8. **Time range filters** -- all charts support 1W, 1M, 3M, 6M, 1Y, and ALL time ranges.

### Additional Features

- **Normalize to purchase price**: Toggle between absolute dollar values and percentage return. When normalized, the Y-axis shows "+12%" instead of "$142.50" -- useful for comparing the performance of items at very different price points.
- **CSV export**: Export portfolio data in a format that Monarch Money can import for financial tracking alongside traditional investments.

```javascript
// Chart.js configuration for the portfolio value chart
const portfolioChart = new Chart(ctx, {
    type: 'line',
    data: {
        datasets: [{
            label: 'Portfolio Value',
            data: portfolioData,
            borderColor: '#4CAF50',
            fill: false,
            tension: 0.1,
        }]
    },
    options: {
        responsive: true,
        scales: {
            x: {
                type: 'time',
                time: { unit: 'day' },
            },
            y: {
                ticks: {
                    callback: value => '$' + value.toFixed(2)
                }
            }
        },
        plugins: {
            annotation: {
                annotations: releaseDateAnnotations
            }
        }
    }
});
```

## Database Schema

The database is straightforward -- 6 tables tracking games, sets, items, and their price histories.

```sql
-- Core tables
card_games          -- 10 rows, one per supported TCG
card_sets           -- All sets discovered by Tier 1 scraper
items               -- Individually tracked sealed products
price_history       -- Daily price snapshots per item
set_price_history   -- Aggregate set pricing over time
card_price_snapshots -- Individual card price data from chart scraper
```

All inserts use `ON CONFLICT DO NOTHING` for idempotency. If a scraper runs twice on the same day, it does not create duplicate price entries:

```sql
INSERT INTO price_history (item_id, date, market_price, source)
VALUES (%s, %s, %s, %s)
ON CONFLICT (item_id, date, source) DO NOTHING;
```

Seven indexes cover the common query patterns -- primarily lookups by item ID + date range and aggregations by game/set. The database is small enough that query performance is not a concern, but proper indexing keeps dashboard page loads under 200ms even as the history table grows.

The application supports dual backends: PostgreSQL in production (on the k3s cluster) and SQLite for local development. The SQL is straightforward enough that it works on both without an ORM -- just a few dialect-specific adjustments for date functions and upsert syntax.

## Future Plans

### Statistical Analysis of Pokemon and MTG Markets

The historical data is accumulating, and there are patterns waiting to be found. Planned analysis includes rolling averages to smooth out daily noise, trend detection to identify when an item's price is consistently moving in one direction, and seasonal pattern identification. Prices often spike around set release dates and holidays (especially Pokemon around Christmas). Being able to predict those spikes would help time purchases.

### Sealed Product Investment Tracking

Sealed product -- booster boxes, packs, bundles, ETBs -- tends to appreciate after a set goes out of print. The rate of appreciation varies wildly by game and set. The goal is to build enough historical data to identify which types of sealed product are the best holds and when the optimal buy/hold points are.

### Market Correlation Analysis

Do Pokemon prices correlate with MTG? When one TCG market dips, do the others follow? Or do they move independently? Cross-game market signals could be valuable for timing purchases across all 10 games. This requires more data -- at least 6-12 months of daily price history across all games before the correlations become meaningful.

## Lessons Learned

1. **eBay blocks headless Chrome.** Always test with a non-headless browser first when scraping a new site. If it works in non-headless but not headless, the site is fingerprinting the browser mode. Xvfb solves this cleanly.

2. **TCGPlayer's internal APIs are more reliable than scraping rendered pages.** The JSON responses are structured, versioned, and consistent. The rendered HTML changes every time they A/B test a new layout. Prefer APIs when they exist.

3. **In-browser `fetch()` calls can access APIs that block external requests.** By executing JavaScript inside the Selenium-controlled browser, you reuse the session cookies and headers that the page already has. This sidesteps the entire authentication/session problem.

4. **Rate limiting with jitter is essential.** Fixed delays create a detectable metronome pattern -- 3.0s, 3.0s, 3.0s. Adding random jitter (3.2s, 3.8s, 3.1s, 4.4s) makes the timing indistinguishable from a human clicking through pages.

5. **Kubernetes Jobs are the right abstraction for scraping workloads.** They are ephemeral, resource-bounded, and automatically cleaned up. A long-running scraper process that sleeps for 6 hours between runs wastes cluster resources. A CronJob that spins up, scrapes, and exits uses resources only when doing work.

6. **Dual database backend makes local development painless.** PostgreSQL for production, SQLite for local dev. No need to run a local Postgres instance just to test a dashboard change. The SQL is simple enough to work on both dialects with minimal conditional logic.
