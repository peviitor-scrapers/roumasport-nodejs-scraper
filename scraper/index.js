import fetch from "node-fetch";
import fs from "fs";
import { fileURLToPath } from "url";
import { validateAndGetCompany } from "./company.js";
import { querySOLR, upsertJobs, upsertCompany, deleteJobByUrl } from "./api.js";
import { generateJobsMarkdown } from "./markdown-generator.js";
import { filterValidJobs, assertScrapeYieldedJobs } from "./validate.js";
import { DEFAULT_EXPIRED_KEYWORDS } from "./job-validator.js";
import { locateArticles, firstMatch, regexText, textFromHtml } from "./self-healing.js";
import companyConfig from "./config/company.js";
import scraperConfig, { userAgent } from "./config/scraper.js";

const COMPANY_CIF = companyConfig.id;

const TIMEOUT = scraperConfig.requestTimeoutMs;
const OWN_URL_PREFIX = scraperConfig.ownJobUrlPrefix;
// Bounded parallelism for the per-job HTTP checks. Enough to remove the old
// 1s-per-job delay, small enough not to hammer the careers host.
const MAX_PARALLEL_FETCHES = 5;
// HTML/status of detail pages already downloaded during scrapeCareers().
// dropDeadUrls reuses these so careers jobs are not fetched twice in one run.
const livePageChecks = new Map();

// The path segment that marks an individual job permalink, derived from
// `ownJobUrlPrefix` (e.g. "https://site.com/jobs/" -> "/jobs/"). Used to pick
// job URLs out of the sitemap. Falls back to matching any prefixed URL.
const JOB_PATH = (() => {
  try { return new URL(OWN_URL_PREFIX).pathname.replace(/\/+$/, "") + "/"; }
  catch { return "/"; }
})();

// A short label for where a scraped job came from (the careers host).
const CAREERS_SOURCE = (() => {
  try { return new URL(scraperConfig.sources.listing).host; }
  catch { return "careers-site"; }
})();

let COMPANY_NAME = null;

// Run `worker` over `items` with at most `limit` in flight, preserving the
// input order of the results. A throwing worker rejects the whole batch, so
// callers handle their own per-item errors.
async function mapWithConcurrency(items, worker, limit = MAX_PARALLEL_FETCHES) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isOwnJob = (url) => typeof url === "string" && url.startsWith(OWN_URL_PREFIX);

// ============================================================================
// Slug helpers — join listing titles to canonical job permalinks
// ============================================================================

// Romanian diacritics have no NFD decomposition for ș/ț, so map them explicitly.
const DIACRITICS = {
  "ă": "a", "â": "a", "î": "i",
  "ș": "s", "ş": "s", "ț": "t", "ţ": "t"
};

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[ăâîșşțţ]/g, (c) => DIACRITICS[c] || c)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

// Exact-slug match only. Split out from matchSitemapUrl below so callers can
// run an exact-only pass over every item before any of them is allowed to
// fall back to a fuzzy match -- see the ordering note in scrapeCareers.
function matchSitemapUrlExact(title, sitemapEntries) {
  const slug = slugify(title);
  const exact = sitemapEntries.find((e) => e.slug === slug);
  return exact ? exact.url : null;
}

// Pick the sitemap URL whose slug best matches a listing title. Sitemaps drift
// in the real world (typos, a "-2" disambiguation suffix), so match
// exact → bounded prefix → small edit distance, else return null.
function matchSitemapUrl(title, sitemapEntries) {
  const slug = slugify(title);
  const exact = sitemapEntries.find((e) => e.slug === slug);
  if (exact) return exact.url;

  // Tolerate a trailing "-2"/"-copy" style disambiguation suffix on either side,
  // but only at a "-" boundary so "manager" can't swallow "manager-portofoliu".
  const boundedPrefix = (a, b) => a === b || (a.startsWith(b) && a[b.length] === "-");
  const prefix = sitemapEntries.find(
    (e) => boundedPrefix(e.slug, slug) || boundedPrefix(slug, e.slug)
  );
  if (prefix) return prefix.url;

  let best = null, bestDist = Infinity;
  for (const e of sitemapEntries) {
    const dist = levenshtein(slug, e.slug);
    if (dist < bestDist) { bestDist = dist; best = e; }
  }
  return bestDist <= 2 ? best.url : null;
}

// "30.09.2026" -> "2026-09-30T23:59:59.000Z" (end of the closing day).
// Also accepts an ISO date (schema.org JobPosting `validThrough`).
function parseDeadline(text) {
  if (!text) return undefined;
  const s = String(text);

  const dmy = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd, 23, 59, 59));
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  const iso = s.match(/\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/);
  if (iso) {
    const d = new Date(iso[0]);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  return undefined;
}

// ============================================================================
// Careers listing — the company's own site (config `sources`)
// ============================================================================

async function fetchSitemapJobUrls() {
  const sitemapUrl = scraperConfig.sources.sitemap;
  if (!sitemapUrl || sitemapUrl.startsWith("{{")) return []; // not configured
  try {
    const res = await fetch(sitemapUrl, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { "User-Agent": userAgent }
    });
    if (!res.ok) {
      console.log(`  Sitemap returned ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const entries = [];
    // one path segment past JOB_PATH, e.g. /jobs/<slug>/ but not the /jobs/ index
    const jobUrlRe = new RegExp(`${JOB_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^/]+/?$`);
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const url = m[1].trim();
      if (!jobUrlRe.test(url)) continue;
      const slug = url.replace(/\/$/, "").split("/").pop();
      entries.push({ url, slug });
    }
    console.log(`  Sitemap: ${entries.length} job permalinks`);
    return entries;
  } catch (err) {
    console.log(`  Sitemap error: ${err.message}`);
    return [];
  }
}

async function fetchListing() {
  const res = await fetch(scraperConfig.sources.listing, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { "User-Agent": userAgent }
  });
  if (!res.ok) throw new Error(`listing returned ${res.status}`);
  return res.text();
}

// Strip HTML tags / collapse whitespace, cap at the job-model title limit.
function cleanTitle(raw) {
  const t = textFromHtml(raw);
  if (!t) return null;
  return t.replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

/**
 * Parse the open-positions listing into { title, expirationdate, url } items,
 * self-healing through the selector cascade (default: scraper/config/scraper.json;
 * pass `selectors` explicitly in tests):
 *
 *   article blocks:  CSS list  ->  JSON-LD JobPosting  ->  regex <article>
 *   title:           CSS list  ->  regex <hN>  ->  regex <a>
 *   deadline:        CSS list  ->  date regex over the whole block text
 *   url:             first real <a href> in the block (may be relative; the
 *                     caller resolves it against the listing page)
 *
 * `url` is null when the block has no anchor at all -- the caller then falls
 * back to a sitemap match or a title-slug guess. Prefer this scraped `url`
 * whenever present: guessing a permalink from the title alone breaks on any
 * site whose real URL needs an ID the title can't reproduce.
 *
 * @param {string} html
 * @param {{jobArticle:any, jobTitle:any, jobMeta:any, jobUrl?:any}} [selectors]
 */
function parseListing(html, selectors = scraperConfig.selectors) {
  const { jobTitle, jobMeta, jobArticle, jobUrl } = selectors;
  const { mode, scopes, jsonLd } = locateArticles(html, jobArticle);
  const items = [];
  const strategies = new Set();
  // Dedup key is title+URL, not title alone: a broad fallback selector can
  // match the same block twice (same title AND same URL), but a site is
  // free to post one title open in several locations, each with its own
  // permalink (e.g. "Mecatronist" at both /sighisoara/ and /sovata/) -- that
  // is two real postings, not a selector artifact, and must not be dropped.
  const seenKeys = new Set();
  const dedupeKey = (title, url) => `${title.toLowerCase()}|${url || ""}`;

  if (mode === "jsonld") {
    for (const posting of jsonLd) {
      const title = cleanTitle(posting.title);
      const key = dedupeKey(title || "", posting.url);
      if (!title || seenKeys.has(key)) continue;
      seenKeys.add(key);
      strategies.add("jsonld");
      items.push({ title, expirationdate: parseDeadline(posting.validThrough), url: posting.url || null });
    }
    console.log(`  parseListing: ${items.length} items via JSON-LD JobPosting`);
    return items;
  }

  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i];

    // TITLE — CSS cascade (incl. itemprop/aria hooks), then regex last resort.
    const { value: title, strategy } = firstMatch(`title[${i}]`, [
      { name: "css-cascade", run: () => scope.text(jobTitle).value },
      regexText(scope.raw(), /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i),
      regexText(scope.raw(), /<a\b[^>]*>([\s\S]*?)<\/a>/i)
    ], { silent: true });

    const cleaned = cleanTitle(title);
    if (!cleaned) continue;

    // DEADLINE — meta selectors, then a bare date regex over the whole block.
    const metaText = scope.text(jobMeta).value;
    const deadline = parseDeadline(metaText) || parseDeadline(scope.fullText());

    const url = scope.href(jobUrl).value;
    const key = dedupeKey(cleaned, url);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (strategy) strategies.add(strategy);

    items.push({ title: cleaned, expirationdate: deadline, url });
  }

  console.log(
    `  parseListing: ${items.length} items via ${mode}` +
    (strategies.size ? ` [${[...strategies].join(", ")}]` : "")
  );
  return items;
}

// Light location hint from the title; the transform step still validates against
// the Romanian-city allowlist and falls back to "România".
const RO_CITY_HINTS = [
  "Iași", "Iasi", "București", "Bucuresti", "Cluj", "Timișoara", "Timisoara",
  "Ploiești", "Ploiesti", "Constanța", "Constanta", "Brașov", "Brasov",
  "Craiova", "Sibiu", "Oradea", "Bacău", "Bacau", "Galați", "Galati",
  "Dâmbovița", "Dambovita"
];

function locationFromTitle(title) {
  const hit = RO_CITY_HINTS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(title));
  return hit ? [hit] : scraperConfig.defaultLocation;
}

/**
 * Parse one cariere.decathlon.ro job page: the schema.org JobPosting JSON-LD
 * block gives title, location (addressRegion, else addressLocality) and,
 * when present, validThrough.
 * @param {string} html
 * @returns {{title: string|null, city: string|null, expirationdate: (number|undefined)}}
 */
function parseJobDetail(html) {
  const blocks = [...String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data;
    try { data = JSON.parse(b[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { try { data = JSON.parse(b[1]); } catch { continue; } }
    const jp = Array.isArray(data) ? data.find((d) => d && d['@type'] === 'JobPosting') : data;
    if (!jp || jp['@type'] !== 'JobPosting') continue;
    const decode = (t) => String(t || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const addr = (jp.jobLocation && jp.jobLocation.address) || {};
    const city = decode(addr.addressRegion || addr.addressLocality) || null;
    const title = decode(jp.title) || null;
    let expirationdate;
    if (jp.validThrough) { const t = Date.parse(jp.validThrough); if (!Number.isNaN(t)) expirationdate = t; }
    return { title, city, expirationdate };
  }
  return { title: null, city: null, expirationdate: undefined };
}

async function scrapeCareers() {
  console.log(`Scraping ${scraperConfig.sources.listing} ...`);
  const jobs = [];
  livePageChecks.clear();

  const sitemapEntries = await fetchSitemapJobUrls();

  let listingItems = [];
  try {
    // Decathlon: the career site root is a client-rendered list -- the sitemap is the source
    // of truth, so the generic listing parse (which would match page chrome) is skipped.
    listingItems = [];
    console.log(`  Listing: ${listingItems.length} open positions`);
  } catch (err) {
    console.log(`  Listing error: ${err.message}`);
  }

  if (listingItems.length > 0) {
    // Resolve every item's URL in two passes so an exact sitemap match
    // always wins a shared slug over a fuzzy one, regardless of which title
    // the listing happens to put first:
    //   pass 1 -- the scraped <a href> (ground truth) or an EXACT sitemap
    //             slug match; these are trustworthy, so claim their URLs
    //             immediately.
    //   pass 2 -- only the items pass 1 couldn't resolve try
    //             matchSitemapUrl's fuzzy fallback (bounded prefix, then
    //             small edit distance), and only win an unclaimed URL.
    // Without this ordering, a longer, unrelated title that fuzzy-matches an
    // earlier position in sitemapEntries could claim a sitemap URL before
    // the job that's an exact match for it even gets a turn -- e.g.
    // "Reprezentant Medical si Vanzari - Veterinare" (no sitemap entry of
    // its own, no anchor in the listing) grabbing "reprezentant-medical"
    // ahead of the real "Reprezentant Medical" posting. Two jobs sharing one
    // URL means one silently overwrites the other in SOLR.
    const resolvedUrls = new Array(listingItems.length);
    const claimedSitemapUrls = new Set();
    const unresolved = [];
    listingItems.forEach((item, i) => {
      // The real <a href> scraped from the page is ground truth -- prefer it
      // over guessing. Sites whose permalink needs an ID the title can't
      // reproduce (e.g. "/jobs/jr133930/software-architect/") silently 404
      // under the guess, which nothing else catches until the live
      // validation just before upload.
      if (item.url) {
        resolvedUrls[i] = new URL(item.url, scraperConfig.sources.listing).toString();
        return;
      }
      const exact = matchSitemapUrlExact(item.title, sitemapEntries);
      if (exact) {
        resolvedUrls[i] = exact;
        claimedSitemapUrls.add(exact);
      } else {
        unresolved.push(i);
      }
    });
    for (const i of unresolved) {
      const fuzzy = matchSitemapUrl(listingItems[i].title, sitemapEntries);
      if (fuzzy && !claimedSitemapUrls.has(fuzzy)) {
        resolvedUrls[i] = fuzzy;
        claimedSitemapUrls.add(fuzzy);
      } else {
        // Either no fuzzy match, or it points at a sitemap URL an exact
        // match already claimed this run -- guess instead. A wrong guess
        // 404s and dropDeadUrls removes it: a safe failure (job missing this
        // run) instead of an unsafe one (two jobs merged into one).
        resolvedUrls[i] = `${scraperConfig.sources.jobArchive}${slugify(listingItems[i].title)}/`;
      }
    }
    listingItems.forEach((item, i) => {
      const url = resolvedUrls[i];
      jobs.push({
        url,
        title: item.title,
        location: locationFromTitle(item.title),
        workmode: scraperConfig.defaultWorkmode,
        expirationdate: item.expirationdate,
        source: CAREERS_SOURCE
      });
    });
  } else if (sitemapEntries.length > 0) {
    // Listing unreachable — fall back to sitemap-only, deriving titles from slugs.
    console.log("  Falling back to sitemap-only (titles from slugs)");
    // One detail page per job: schema.org JobPosting JSON-LD (TalentLyft ATS).
    // Fetch a few at a time — the old sequential loop plus a 1s sleep per job
    // made this the dominant cost of a scrape without helping rate limits.
    const details = await mapWithConcurrency(sitemapEntries, async (e) => {
      let detail = { title: null, city: null };
      let html = null;
      let httpStatus = 0;
      try {
        const res = await fetch(e.url, {
          signal: AbortSignal.timeout(TIMEOUT),
          headers: { "User-Agent": userAgent }
        });
        httpStatus = res.status;
        if (!res.ok) {
          console.log(`  ${e.url} -> ${res.status}, skipped`);
        } else {
          html = await res.text();
          detail = parseJobDetail(html);
        }
      } catch (err) {
        console.log(`  detail fetch failed ${e.url}: ${err.message}`);
      }
      livePageChecks.set(e.url, { ok: httpStatus >= 200 && httpStatus < 300, html, httpStatus });
      return detail;
    });
    for (let i = 0; i < sitemapEntries.length; i++) {
      const detail = details[i];
      if (!detail.title) continue;
      jobs.push({
        url: sitemapEntries[i].url,
        title: detail.title,
        location: detail.city ? [detail.city] : scraperConfig.defaultLocation,
        workmode: scraperConfig.defaultWorkmode,
        expirationdate: detail.expirationdate,
        source: CAREERS_SOURCE
      });
    }
  }

  console.log(`  Found ${jobs.length} jobs on ${CAREERS_SOURCE}`);
  return jobs;
}

// ============================================================================
// ANOFM — free public postings by CIF
// ============================================================================

async function searchANOFM(cif) {
  const jobs = [];
  try {
    console.log(`Searching ANOFM by CIF: ${cif}`);
    const payload = {
      current: 1,
      rowCount: 250,
      sort: { created_at: "desc" },
      employer_tax_code: cif
    };
    const res = await fetch("https://mediere.anofm.ro/api/entity/vw_public_job_posting", {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": userAgent
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.log(`  ANOFM returned ${res.status}`);
      return jobs;
    }
    const data = await res.json();
    for (const row of data.rows || []) {
      const locationParts = (row.address_locality_name || "").split(">").map((s) => s.trim());
      const location = locationParts.length > 1 ? locationParts[locationParts.length - 1] : locationParts[0];
      jobs.push({
        url: `https://mediere.anofm.ro/app/module/mediere/job/${row.id}`,
        title: row.occupation,
        location: location ? [location] : undefined,
        source: "ANOFM"
      });
    }
    console.log(`  Found ${jobs.length} jobs on ANOFM`);
  } catch (err) {
    console.log(`  ANOFM error: ${err.message}`);
  }
  return jobs;
}

// ============================================================================
// Job Model
// ============================================================================

function mapToJobModel(rawJob, cif, companyName = COMPANY_NAME) {
  const now = new Date().toISOString();

  const job = {
    url: rawJob.url,
    title: rawJob.title,
    company: companyName,
    cif: cif,
    location: rawJob.location?.length ? rawJob.location : undefined,
    tags: rawJob.tags?.length ? rawJob.tags : undefined,
    workmode: rawJob.workmode || undefined,
    expirationdate: rawJob.expirationdate || undefined,
    date: now,
    status: "scraped"
  };

  Object.keys(job).forEach((k) => job[k] === undefined && delete job[k]);

  return job;
}

const ROMANIAN_CITIES = [
  'Bucharest', 'București', 'Bucuresti', 'Cluj-Napoca', 'Cluj Napoca',
  'Timișoara', 'Timisoara', 'Iași', 'Iasi', 'Brașov', 'Brasov',
  'Constanța', 'Constanta', 'Craiova', 'Bacău', 'Sibiu',
  'Târgu Mureș', 'Targu Mures', 'Oradea', 'Baia Mare', 'Satu Mare',
  'Ploiești', 'Ploiesti', 'Pitești', 'Pitesti', 'Arad', 'Galați', 'Galati',
  'Brăila', 'Braila', 'Drobeta-Turnu Severin', 'Râmnicu Vâlcea', 'Ramnicu Valcea',
  'Buzău', 'Buzau', 'Botoșani', 'Botosani', 'Zalău', 'Zalau', 'Hunedoara', 'Deva',
  'Suceava', 'Bistrița', 'Bistrita', 'Tulcea', 'Călărași', 'Calarasi',
  'Giurgiu', 'Alba Iulia', 'Slatina', 'Piatra Neamț', 'Piatra Neamt', 'Roman',
  'Dumbrăvița', 'Dumbravita', 'Voluntari', 'Popești-Leordeni', 'Popesti-Leordeni',
  'Chitila', 'Mogoșoaia', 'Mogosoaia', 'Otopeni', 'Dâmbovița', 'Dambovita',
  'Sighișoara', 'Sighisoara', 'Sovata', 'Reghin', 'Târnăveni', 'Tarnaveni'
];
const CITY_SET = new Set(ROMANIAN_CITIES.map(c => c.toLowerCase()));

function transformJobsForSOLR(payload) {
  const normalizeWorkmode = (wm) => {
    if (!wm) return undefined;
    const lower = wm.toLowerCase();
    if (lower.includes('remote')) return 'remote';
    if (lower.includes('office') || lower.includes('on-site') || lower.includes('site')) return 'on-site';
    return 'hybrid';
  };

  const transformed = {
    ...payload,
    company: payload.company?.toUpperCase(),
    jobs: payload.jobs.map(job => {
      const validLocations = (job.location || []).filter(loc => {
        const lower = loc.toLowerCase().trim();
        if (lower === 'romania' || lower === 'românia') return true;
        return CITY_SET.has(lower);
      }).map(loc => loc.toLowerCase() === 'romania' ? 'România' : loc);

      return {
        ...job,
        location: validLocations.length > 0 ? validLocations : ['România'],
        workmode: normalizeWorkmode(job.workmode)
      };
    })
  };

  return transformed;
}

// GET-check a URL with a real deadline. Only used for jobs that were not
// fetched during the scrape (e.g. ANOFM) -- careers pages already have HTML.
async function checkJobUrl(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      redirect: "follow"
    });
    const text = await res.text().catch(() => "");
    const lower = text.toLowerCase();
    if (!res.ok || DEFAULT_EXPIRED_KEYWORDS.some(kw => lower.includes(kw))) {
      return { status: "expired", httpStatus: res.status, error: null };
    }
    return { status: "active", httpStatus: res.status, error: null };
  } catch (err) {
    return { status: "error", httpStatus: 0, error: err.message };
  }
}

/**
 * Pre-upload safety net: GET-check every job URL and drop the ones that don't
 * resolve. filterValidJobs only checks URL *shape*; a real GET is needed to
 * tell a live job from a 404 or a soft-404 ("no longer available" on a 200).
 *
 * Uses GET, not HEAD: at least one real careers site (Workday-based) answers
 * every HEAD request with a generic 404 regardless of whether the resource
 * exists -- HEAD-only would have dropped every real job. Careers pages already
 * downloaded during the scrape are checked from cached HTML; only jobs from
 * other sources trigger a new GET. Checks run with bounded concurrency.
 */
async function dropDeadUrls(jobs) {
  const results = await mapWithConcurrency(jobs, async (job) => {
    let result;
    const cached = livePageChecks.get(job.url);
    if (cached) {
      const lower = (cached.html || "").toLowerCase();
      const expired = !cached.ok || DEFAULT_EXPIRED_KEYWORDS.some(kw => lower.includes(kw));
      result = expired
        ? { status: "expired", httpStatus: cached.httpStatus || 0, error: null }
        : { status: "active", httpStatus: cached.httpStatus, error: null };
    } else {
      result = await checkJobUrl(job.url);
    }
    if (result.status === "active") return job;
    console.warn(`  dropped "${job.title}" (${job.url}): live URL check failed — ${result.error || `HTTP ${result.httpStatus}`}`);
    return null;
  });

  const alive = results.filter(Boolean);
  if (alive.length < jobs.length) {
    console.warn(`  ${jobs.length - alive.length}/${jobs.length} job(s) failed live URL validation and were dropped`);
  }
  return alive;
}

// ============================================================================
// MAIN
// ============================================================================

/**
 * `--dry-run` mirrors the Python template's `--dry-run` flag: scrape and
 * validate normally, but make zero real writes -- no company upsert, no job
 * upsert, no job delete of any kind.
 */
async function main(dryRun = process.argv.includes("--dry-run")) {
  try {
    fs.mkdirSync("scraper", { recursive: true });

    console.log("=== Step 1: Get existing jobs from SOLR ===");
    const existingResult = await querySOLR(COMPANY_CIF);
    const existingCount = existingResult.numFound;
    // Every URL under this CIF (used to classify a scraped job as new vs. update).
    const allExistingUrls = new Set(existingResult.docs.map(d => d.url));
    // Only URLs this scraper owns — the same CIF may also carry jobs published
    // by other peviitor scrapers / aggregators. We never touch those, and only
    // these can be reported as "gone from the site".
    const ownExistingUrls = new Set(
      existingResult.docs.map(d => d.url).filter(isOwnJob)
    );
    console.log(`Found ${existingCount} existing jobs in SOLR (${ownExistingUrls.size} ours)`);

    console.log("=== Step 2: Validate company via CUIScan/CUIFirma ===");
    const { company, cif, address } = await validateAndGetCompany();
    COMPANY_NAME = company;

    // On by default: upsertCompany is an idempotent PUT of ANAF-validated facts
    // (name, address, website, career URL), so there's no real downside to
    // keeping the company core in sync -- unlike staleJobDeletion below, this
    // is additive, not destructive. Only turn it off once you've verified
    // another scraper genuinely owns this CIF's company record.
    if (scraperConfig.manageCompany && !dryRun) {
      try {
        await upsertCompany({
          id: cif,
          company,
          brand: companyConfig.brand || undefined,
          status: companyConfig.status || "activ",
          location: address ? [address] : companyConfig.location,
          website: companyConfig.website,
          career: companyConfig.career,
          scraperFile: companyConfig.scraperFile,
          lastScraped: new Date().toISOString().split('T')[0]
        });
      } catch (err) {
        console.log(`Note: Could not upsert company: ${err.message}`);
      }
    } else if (dryRun && scraperConfig.manageCompany) {
      console.log(`Dry-run — would upsert company core for CIF ${cif}`);
    } else {
      console.log(
        "manageCompany=false — leaving company core untouched (explicitly disabled in " +
        "config/scraper.json; only turn this off once you've *verified* another scraper " +
        "actually manages this CIF's company record — an unverified guess here is exactly " +
        "what left a real company entirely missing from peviitor's company core before)"
      );
    }

    console.log("=== Step 3: Scrape jobs ===");
    const rawJobs = [];

    const careerJobs = await scrapeCareers();
    rawJobs.push(...careerJobs);

    const anofmJobs = await searchANOFM(cif);
    const knownUrls = new Set(rawJobs.map(j => j.url));
    for (const job of anofmJobs) {
      if (!knownUrls.has(job.url)) {
        rawJobs.push(job);
        knownUrls.add(job.url);
      }
    }
    console.log(`Jobs from ANOFM: ${anofmJobs.length}`);

    console.log(`Total jobs scraped (careers site + ANOFM): ${rawJobs.length}`);

    // Canary — abort before writing anything if every source came back empty.
    assertScrapeYieldedJobs(rawJobs);

    // Drop jobs with a broken URL / empty title / bad data before publishing.
    const { kept: validJobs } = filterValidJobs(rawJobs);
    assertScrapeYieldedJobs(validJobs); // everything failed validation → also a canary

    const scrapedCount = validJobs.length;
    const jobs = validJobs.map(job => mapToJobModel(job, cif));

    const payload = {
      source: `${CAREERS_SOURCE},anofm.ro`,
      scrapedAt: new Date().toISOString(),
      company: COMPANY_NAME,
      cif: cif,
      jobs
    };

    console.log("Transforming jobs for SOLR...");
    const transformedPayload = transformJobsForSOLR(payload);
    transformedPayload.jobs = await dropDeadUrls(transformedPayload.jobs);
    const validCount = transformedPayload.jobs.filter(j => j.location).length;
    console.log(`Jobs with valid Romanian locations: ${validCount}`);

    fs.writeFileSync("scraper/jobs.json", JSON.stringify(transformedPayload, null, 2), "utf-8");
    console.log("Saved scraper/jobs.json");

    const companyData = {
      id: cif,
      company: transformedPayload.company,
      brand: companyConfig.brand || undefined,
      status: companyConfig.status || "activ",
      location: address ? [address] : companyConfig.location,
      website: companyConfig.website,
      career: companyConfig.career,
      lastScraped: new Date().toISOString().split('T')[0]
    };
    const markdown = generateJobsMarkdown(companyData, transformedPayload.jobs);
    fs.mkdirSync("docs", { recursive: true });
    fs.writeFileSync("docs/jobs.md", markdown, "utf-8");
    console.log("Saved docs/jobs.md");

    // docs/company.json = company identity + the URL prefix the static page uses
    // to show only jobs this scraper manages (not eJobs/BestJobs imports on the
    // same CIF).
    fs.writeFileSync(
      "docs/company.json",
      JSON.stringify({ ...companyConfig, ownJobUrlPrefix: OWN_URL_PREFIX }, null, 2),
      "utf-8"
    );
    console.log("Wrote docs/company.json (+ ownJobUrlPrefix)");

    console.log("\n=== Step 4: Upsert jobs to SOLR ===");
    if (dryRun) {
      console.log(`Dry-run — would upsert ${transformedPayload.jobs.length} jobs`);
    } else if (transformedPayload.jobs.length > 0) {
      await upsertJobs(transformedPayload.jobs);
    } else {
      console.log("No jobs scraped — skipping upsert (API rejects an empty array)");
    }

    // Step 4.5 — stale-job deletion. Disabled by default: if the CIF is shared
    // with another scraper, deleting (even scoped to our own URLs) would fight
    // that scraper on any transient fetch failure. The nightly validate-jobs.js
    // job (scoped to our URLs) handles real 404s instead.
    if (scraperConfig.staleJobDeletion) {
      const scrapedUrls = new Set(transformedPayload.jobs.map(job => job.url));
      const staleUrls = [...ownExistingUrls].filter(url => !scrapedUrls.has(url));
      if (staleUrls.length > 0 && dryRun) {
        console.log(`\n=== Step 4.5: dry-run — would delete ${staleUrls.length} stale job(s) (ours only) ===`);
      } else if (staleUrls.length > 0) {
        console.log(`\n=== Step 4.5: Delete ${staleUrls.length} stale job(s) (ours only) ===`);
        for (const url of staleUrls) {
          try {
            console.log(`  Deleting: ${url}`);
            await deleteJobByUrl(url);
          } catch (delErr) {
            console.warn(`  Failed to delete: ${url} — ${delErr.message}`);
          }
        }
      } else {
        console.log("\nNo stale jobs to delete");
      }
    } else {
      console.log(
        "\nStep 4.5 skipped — staleJobDeletion=false (deliberate: a partial scrape " +
        "failure would otherwise delete real jobs it simply failed to find this run — " +
        "use the deep-validate workflow to actually confirm and clean up dead URLs)"
      );
    }

    console.log("\n=== Step 5: Summary ===");
    await sleep(2000);
    const finalResult = await querySOLR(COMPANY_CIF);

    // Diff this run against what was in SOLR before it.
    const scrapedUrls = new Set(transformedPayload.jobs.map(job => job.url));
    const addedUrls = [...scrapedUrls].filter(url => !allExistingUrls.has(url));
    const updatedUrls = [...scrapedUrls].filter(url => allExistingUrls.has(url));
    const goneUrls = [...ownExistingUrls].filter(url => !scrapedUrls.has(url));

    const preview = (urls, n = 10) =>
      urls.slice(0, n).map(u => `    - ${u}`).join("\n") +
      (urls.length > n ? `\n    … and ${urls.length - n} more` : "");

    console.log(`\n=== SUMMARY ===`);
    console.log(`Jobs in SOLR before scrape:  ${existingCount} (${ownExistingUrls.size} ours)`);
    console.log(`Scraped this run:             ${scrapedCount} (careers site + ANOFM)`);
    console.log(`  new (not in SOLR before):  ${addedUrls.length}`);
    if (addedUrls.length) console.log(preview(addedUrls));
    console.log(`  updated (already in SOLR): ${updatedUrls.length}`);
    console.log(`  gone from site (ours):     ${goneUrls.length}${goneUrls.length && !scraperConfig.staleJobDeletion ? " — kept (staleJobDeletion=false)" : ""}`);
    if (goneUrls.length) console.log(preview(goneUrls));
    console.log(`Jobs in SOLR after scrape:    ${finalResult.numFound}`);
    console.log(`====================`);

    console.log("\n=== DONE ===");
    console.log("Scraper completed successfully!");

  } catch (err) {
    console.error("Scraper failed:", err);
    process.exit(1);
  }
}

export { parseJobDetail, mapToJobModel, transformJobsForSOLR, scrapeCareers, fetchSitemapJobUrls, parseListing, slugify, matchSitemapUrl, matchSitemapUrlExact, parseDeadline, dropDeadUrls };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
