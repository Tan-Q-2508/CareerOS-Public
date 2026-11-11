const cheerio = require('cheerio');
const tunables = require('../tunables.json');
const { dedupKey } = require('./dedup');
const { buildSearchUrl } = require('./apifyAdapter');

// BYO Scraper sourcing via ScraperAPI (spec 2.0/4.2/13.2) — a generic HTML-
// proxy provider, the alternative to Apify's actor-based approach. Unlike
// Apify's LinkedIn actor (which returns already-structured job data),
// ScraperAPI just proxies a raw page fetch — this adapter owns its own
// LinkedIn-HTML parsing (the "one shared parsing module" spec 2.0 describes;
// the markup is identical regardless of which proxy fetched it, so this same
// module would serve ScrapingBee/Bright Data too if added later). Same
// contract as apifyAdapter.js: sourceJobs({...}) -> NormalizedJob[].
//
// Two-tier fetch, unavoidable for a generic proxy: the search-results page
// only carries title/company/location/link, never the full JD text a
// structured actor would return in one call — so each survivor gets a second
// proxied fetch to its own detail page. This costs more ScraperAPI credits
// per job than Apify's actor, but that cost is the user's own BYOK spend
// (13.4), never COS.

const PROXY_BASE = 'https://api.scraperapi.com/';

function isConfigured() {
  return true; // pure BYOK — always "configured", per-actor key is required at call time
}

async function fetchViaProxy(apiKey, targetUrl) {
  const params = new URLSearchParams({ api_key: apiKey, url: targetUrl });
  const resp = await fetch(`${PROXY_BASE}?${params.toString()}`);
  if (!resp.ok) {
    throw Object.assign(new Error(`ScraperAPI proxy HTTP ${resp.status} for ${targetUrl}`), { status: resp.status });
  }
  return resp.text();
}

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Parse LinkedIn's public jobs-search results page into job-card summaries.
function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const cards = [];
  $('li div.base-card, div.base-search-card').each((_, el) => {
    const card = $(el);
    const link = card.find('a.base-card__full-link, a.base-search-card__title-link').first().attr('href') || null;
    const title = card.find('.base-search-card__title').first().text().trim() || null;
    const companyName = card.find('.base-search-card__subtitle').first().text().trim() || null;
    const location = card.find('.job-search-card__location').first().text().trim() || null;
    const postedAt = toIso(card.find('time').first().attr('datetime'));
    const urn = card.attr('data-entity-urn') || '';
    const idMatch = urn.match(/(\d{6,})$/);
    if (title && link) {
      cards.push({ id: idMatch ? idMatch[1] : null, title, companyName, location, link: link.split('?')[0], postedAt });
    }
  });
  return cards;
}

// Parse a LinkedIn job detail page for the full description text (best-effort
// — LinkedIn's markup for this section is not guaranteed stable).
function parseJobDetail(html) {
  const $ = cheerio.load(html);
  const descriptionText =
    $('.show-more-less-html__markup').first().text().trim() ||
    $('.description__text').first().text().trim() ||
    null;
  const employmentType = $('.description__job-criteria-text').eq(1).text().trim() || null;
  const seniorityLevel = $('.description__job-criteria-text').eq(0).text().trim() || null;
  return { descriptionText, employmentType, seniorityLevel };
}

/**
 * Source jobs via a saved ScraperAPI actor (spec 4.2 — multi-actor BYOK).
 * @param actor { token } — the user's own ScraperAPI key
 */
async function sourceJobs({ actor = {}, title, location, keywords, count, postedWithinDays }) {
  const token = actor.token;
  if (!token) throw new Error('ScraperAPI actor is missing its key');

  const searchUrl = buildSearchUrl({ title, location, keywords, postedWithinDays });
  const listHtml = await fetchViaProxy(token, searchUrl);
  const cards = parseSearchResults(listHtml).slice(0, count || tunables.ldJobCount.default);

  const jobs = [];
  for (const card of cards) {
    try {
      const detailHtml = await fetchViaProxy(token, card.link);
      const detail = parseJobDetail(detailHtml);
      jobs.push({
        source: 'byo',
        title: card.title,
        companyName: card.companyName,
        location: card.location,
        postedAt: card.postedAt,
        link: card.link,
        descriptionText: detail.descriptionText,
        seniorityLevel: detail.seniorityLevel,
        employmentType: detail.employmentType,
        salaryMin: null,
        salaryMax: null,
        dedupKey: dedupKey({ id: card.id, link: card.link, title: card.title, companyName: card.companyName, location: card.location }),
      });
    } catch (e) {
      console.error(`scraperApiAdapter: detail fetch failed for "${card.title}":`, e.message || e);
    }
  }
  return jobs.filter((j) => j.descriptionText); // a job with no extractable JD text can't be prefiltered/scored
}

// Test-call for Settings' "connect a scraper" flow (mirrors apifyAdapter's
// fetchSample). Unlike an arbitrary Apify actor's raw JSON, this adapter owns
// its own fixed parsing — there's no user-configurable field mapping — so the
// "sample" is already a fully-normalized job, not raw keys to map.
async function fetchSample({ token, title = 'analyst', location, maxItems = 1 }) {
  if (!token) throw new Error('fetchSample: token is required');
  const jobs = await sourceJobs({ actor: { token }, title, location, count: maxItems, postedWithinDays: tunables.postedWithinDays });
  return jobs.slice(0, maxItems);
}

module.exports = { sourceJobs, isConfigured, fetchSample, parseSearchResults, parseJobDetail };
