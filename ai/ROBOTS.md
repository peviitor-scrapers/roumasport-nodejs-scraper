# Robots.txt & scraping policy

Checked per derived company. See the robots.txt result below — it needs an
owner decision before further live runs.

## What this scraper reads

| Path | Role |
|---|---|
| `https://cariere.decathlon.ro/` | Public list of open positions (server-rendered HTML) |
| `https://cariere.decathlon.ro/sitemap.xml` | Job sitemap — canonical `https://cariere.decathlon.ro/jobs/<slug>/` permalinks |
| `https://cariere.decathlon.ro/jobs/<slug>/` | Individual job pages (only referenced, not fully crawled) |
| ANOFM | `POST https://mediere.anofm.ro/api/entity/vw_public_job_posting` filtered by CIF |

## robots.txt check (2026-11-19)

`https://cariere.decathlon.ro/robots.txt` currently returns:

```
User-agent: *
Disallow: /
```

That disallows the careers listing, sitemap and job detail pages for a general
crawler — the exact paths this scraper reads. `https://www.decathlon.ro/robots.txt`
is a different host and does not grant permission for `cariere.decathlon.ro`.
Continuing live scraping therefore needs an explicit owner decision (site
permission or a different source); this document records the finding, it does
not silently override it.

## Politeness (current behavior)

| Measure | Value | Where |
|---|---|---|
| Requests | max 5 in flight | `scraper/index.js` — `MAX_PARALLEL_FETCHES` |
| Delay between pages | none (former 1000 ms sleep removed) | `scraper/index.js` |
| Timeout | `requestTimeoutMs` (10000 ms) via `AbortSignal.timeout` | `scraper/config/scraper.json`, `scraper/index.js` |
| User-Agent | `job_seeker_ro_spider` | identifies the scraper in server logs |
| Volume | listing + sitemap + ANOFM + one GET per job detail page (89 in the last run) | each careers page is fetched once and its HTML reused for URL validation |

No assets downloaded, no JS rendered, no links followed outside the job-URL
prefix. Never bypass a login or authentication wall.
