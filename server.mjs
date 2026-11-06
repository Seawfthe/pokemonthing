#!/usr/bin/env node
/**
 * HoloDex server
 * ------------------------------------------------------------------
 *  node server.mjs            -> http://localhost:4310   (site)
 *                                 http://localhost:4310/admin (admin panel)
 *  PORT=8080 node server.mjs
 *  POKEMONTCG_API_KEY=xxx node server.mjs  (optional, raises rate limit)
 *  ADMIN_USER=... ADMIN_PASS=... node server.mjs  (override admin login)
 *
 * What it does:
 *   1. Serves the static site + admin panel from this folder.
 *   2. Proxies + caches the Pokémon TCG API (/api/v2/*) with retries,
 *      because the public API occasionally answers 500/502.
 *   3. Scrapes SNKRDUNK (Japanese marketplace) for per-card JPY market
 *      prices + live listing counts (/api/snkrdunk/card?cardId=...).
 *   4. Persists the curated catalog / price overrides in data/site-config.json
 *      and exposes admin-authenticated endpoints for editing it.
 *   5. Serves live HKD/EUR FX rates (/api/fx) with a disk cache + fallback.
 * No external npm dependencies. Node 18+.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || '127.0.0.1';
const TCG_KEY = process.env.POKEMONTCG_API_KEY || '';
const TCG_UPSTREAM = 'https://api.pokemontcg.io/v2';
const WD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/* Admin credentials. Override with env vars if you don't like the defaults. */
const ADMIN_USER = process.env.ADMIN_USER || 'skibiditoilet577';
const ADMIN_PASS = process.env.ADMIN_PASS || 'ilikemen123';
const SESSION_TTL = 24 * 3600e3;
const sessions = new Map(); // token -> { user, expiresAt }

const CACHE_DIR = path.join(ROOT, '.cache');
const TCG_CACHE = path.join(CACHE_DIR, 'poketcg');
const SNK_CACHE = path.join(CACHE_DIR, 'snkrdunk');
const TCGDEX_CACHE = path.join(CACHE_DIR, 'tcgdex');
const TRANSLATE_CACHE = path.join(CACHE_DIR, 'translate');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'site-config.json');
const FX_CACHE_FILE = path.join(CACHE_DIR, 'fx.json');
for (const dir of [CACHE_DIR, TCG_CACHE, SNK_CACHE, TCGDEX_CACHE, TRANSLATE_CACHE, DATA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const CARD_SELECT = 'id,name,number,rarity,supertype,types,images,set,tcgplayer,cardmarket';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashKey = (s) => crypto.createHash('sha1').update(s).digest('hex');

function json(res, status, body, headers = {}, cors = true) {
  const raw = JSON.stringify(body);
  const head = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
    ...headers,
  };
  if (cors) head['Access-Control-Allow-Origin'] = '*';
  res.writeHead(status, head);
  res.end(raw);
}

function log(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...args);
}

async function readDiskCache(file, ttl) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.at < ttl) return parsed.value;
  } catch { /* miss */ }
  return null;
}

async function writeDiskCache(file, value) {
  try {
    await fsp.writeFile(file, JSON.stringify({ at: Date.now(), value }));
  } catch (err) {
    log('cache write failed', err.message);
  }
}

async function fetchText(url, opts = {}, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': WD,
        'Accept-Language': 'ja,en;q=0.8',
        ...opts.headers,
      },
    });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function readBodyJson(req, limit = 60000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* site config (curated catalog + price overrides)                     */
/* ------------------------------------------------------------------ */
let siteConfig = { mode: 'all', cards: [], updatedAt: null };

function sanitizeConfig(input) {
  const mode = input && input.mode === 'curated' ? 'curated' : 'all';
  const seen = new Set();
  const cards = [];
  const rawCards = Array.isArray(input && input.cards) ? input.cards : [];
  for (const raw of rawCards.slice(0, 300)) {
    if (!raw || typeof raw.id !== 'string') continue;
    const id = raw.id.trim().slice(0, 80);
    if (!/^[A-Za-z0-9._-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    let priceHKD = null;
    if (raw.priceHKD !== null && raw.priceHKD !== undefined && raw.priceHKD !== '') {
      const amount = Number(raw.priceHKD);
      if (Number.isFinite(amount) && amount > 0 && amount <= 50000000) {
        priceHKD = Math.round(amount * 100) / 100;
      }
    }
    cards.push({
      id,
      priceHKD,
      addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : new Date().toISOString(),
    });
  }
  return { mode, cards, updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : null };
}

function loadSiteConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return sanitizeConfig(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') log('site-config read failed:', err.message);
    return { mode: 'all', cards: [], updatedAt: null };
  }
}

function saveSiteConfig(next) {
  const config = sanitizeConfig(next);
  config.updatedAt = new Date().toISOString();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  siteConfig = config;
  return config;
}

function publicSiteConfig() {
  const overrides = {};
  for (const entry of siteConfig.cards) {
    if (entry.priceHKD !== null) overrides[entry.id] = entry.priceHKD;
  }
  return {
    mode: siteConfig.mode,
    count: siteConfig.cards.length,
    updatedAt: siteConfig.updatedAt,
    overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Pokémon TCG API (retry + disk cache, shared by proxy + admin)       */
/* ------------------------------------------------------------------ */
const tcgMem = new Map();
const tcgInflight = new Map(); // de-dupe concurrent identical upstream calls

function tcgDefaultTtl(pathAndQuery) {
  if (pathAndQuery.startsWith('/sets')) return 24 * 3600e3;
  if (/^\/cards\/[^?]+/.test(pathAndQuery)) return 15 * 60e3;
  return 10 * 60e3;
}

async function tcgRequest(pathAndQuery, opts = {}) {
  const ttl = opts.ttl || tcgDefaultTtl(pathAndQuery);
  const cacheKey = hashKey(pathAndQuery);
  const file = path.join(TCG_CACHE, cacheKey + '.json');

  const disk = await readDiskCache(file, ttl);
  if (disk) return { status: disk.status, body: disk.body, cache: 'disk' };

  const mem = tcgMem.get(cacheKey);
  if (mem && Date.now() - mem.at < ttl) {
    return { status: 200, body: mem.value, cache: 'memory' };
  }

  if (tcgInflight.has(cacheKey)) return tcgInflight.get(cacheKey);

  const task = (async () => {
    const url = TCG_UPSTREAM + pathAndQuery;
    const headers = { Accept: 'application/json' };
    if (TCG_KEY) headers['X-Api-Key'] = TCG_KEY;
    let lastStatus = 502;
    let lastBody = { error: { message: 'Upstream Pokémon TCG API is unavailable.' } };

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await fetchText(url, { headers }, 30000);
        let body;
        try {
          body = JSON.parse(r.text);
        } catch {
          body = { error: { message: `Upstream returned an unreadable response (HTTP ${r.status}).` } };
        }
        if (r.status === 200) {
          tcgMem.set(cacheKey, { at: Date.now(), value: body });
          if (tcgMem.size > 400) tcgMem.delete(tcgMem.keys().next().value);
          writeDiskCache(file, { status: 200, body });
          return { status: 200, body, cache: 'miss' };
        }
        lastStatus = r.status;
        lastBody = body;
        if (r.status !== 429 && r.status < 500) break;
        await sleep(350 * 2 ** attempt + Math.random() * 250);
      } catch (err) {
        lastBody = { error: { message: 'Could not reach the Pokémon TCG API.', detail: err.message } };
        await sleep(350 * 2 ** attempt + Math.random() * 250);
      }
    }
    // The public API is flaky. Before giving up, serve a stale disk copy if
    // we have one — a price from 20 minutes ago beats an error page.
    const stale = await readDiskCache(file, 30 * 24 * 3600e3);
    if (stale && stale.status === 200 && stale.body) {
      log(`tcg ${lastStatus} ${pathAndQuery.slice(0, 60)} → serving stale cache`);
      return { status: 200, body: stale.body, cache: 'stale' };
    }
    log(`tcg ${lastStatus} ${pathAndQuery.slice(0, 80)}`);
    return { status: lastStatus === 200 ? 502 : lastStatus, body: lastBody, cache: 'miss' };
  })().finally(() => tcgInflight.delete(cacheKey));

  tcgInflight.set(cacheKey, task);
  return task;
}

async function proxyTcg(pathAndQuery, res) {
  const result = await tcgRequest(pathAndQuery);
  return json(res, result.status, result.body, { 'X-Proxy-Cache': result.cache });
}

async function fetchCardData(id) {
  const query = '/cards/' + encodeURIComponent(id) + '?select=' + encodeURIComponent(CARD_SELECT);
  const result = await tcgRequest(query);
  if (result.status === 200 && result.body && result.body.data) return result.body.data;
  return null;
}

async function fetchCardsForIds(ids, concurrency = 4) {
  const results = [];
  const queue = ids.slice();
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      let card = null;
      try {
        card = await fetchCardData(id);
      } catch { /* leave null */ }
      results.push({ id, card });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, ids.length)) }, worker));
  return results;
}

async function siteCardsPayload() {
  const entries = siteConfig.cards;
  const fetched = await fetchCardsForIds(entries.map((entry) => entry.id));
  const byId = new Map(fetched.map((item) => [item.id, item.card]));
  const priceById = new Map(entries.map((entry) => [entry.id, entry.priceHKD]));
  const cards = [];
  for (const entry of entries) {
    const card = byId.get(entry.id);
    if (!card) continue;
    const price = priceById.get(entry.id);
    if (price !== null) card.sitePriceHKD = price;
    cards.push(card);
  }
  return { mode: 'curated', updatedAt: siteConfig.updatedAt, cards };
}

async function adminConfigPayload() {
  const entries = siteConfig.cards;
  const fetched = await fetchCardsForIds(entries.map((entry) => entry.id));
  const byId = new Map(fetched.map((item) => [item.id, item.card]));
  const cards = entries.map((entry) => ({
    id: entry.id,
    priceHKD: entry.priceHKD,
    addedAt: entry.addedAt,
    card: byId.get(entry.id) || null,
  }));
  return {
    mode: siteConfig.mode,
    updatedAt: siteConfig.updatedAt,
    cards,
    fx: await getFxRates(),
  };
}

/* ------------------------------------------------------------------ */
/* FX rates (USD base; used for HKD display + price conversion)        */
/* ------------------------------------------------------------------ */
const FX_FALLBACK = {
  hkdPerUsd: 7.8,
  hkdPerEur: 8.7,
  jpyPerUsd: 150,
  source: 'fallback',
  provider: 'built-in',
  fetchedAt: null,
  updatedAt: 0,
};
let fxCache = null;
const FX_TTL = 6 * 3600e3;

function normalizeFx(raw) {
  if (!raw || !(raw.hkdPerUsd > 0)) return null;
  return {
    hkdPerUsd: Number(raw.hkdPerUsd),
    hkdPerEur: raw.hkdPerEur > 0 ? Number(raw.hkdPerEur) : Number(raw.hkdPerUsd) / 0.9,
    jpyPerUsd: raw.jpyPerUsd > 0 ? Number(raw.jpyPerUsd) : 150,
    source: raw.source || 'fallback',
    provider: raw.provider || 'unknown',
    fetchedAt: raw.fetchedAt || null,
    updatedAt: raw.updatedAt || Date.now(),
  };
}

async function getFxRates() {
  if (fxCache && Date.now() - fxCache.updatedAt < FX_TTL && fxCache.jpyPerUsd) return fxCache;

  if (!fxCache || !fxCache.jpyPerUsd) {
    const disk = await readDiskCache(FX_CACHE_FILE, 7 * 24 * 3600e3);
    if (disk && disk.jpyPerUsd) fxCache = normalizeFx(disk);
  }
  if (fxCache && Date.now() - fxCache.updatedAt < FX_TTL && fxCache.jpyPerUsd) return fxCache;

  // Provider 1: open.er-api.com (free, no key)
  try {
    const r = await fetchText('https://open.er-api.com/v6/latest/USD', {
      headers: { Accept: 'application/json' },
    }, 9000);
    if (r.status === 200) {
      const data = JSON.parse(r.text);
      const hkd = Number(data?.rates?.HKD);
      const eur = Number(data?.rates?.EUR);
      const jpy = Number(data?.rates?.JPY);
      if (hkd > 0 && eur > 0) {
        const fresh = normalizeFx({
          hkdPerUsd: hkd,
          hkdPerEur: hkd / eur,
          jpyPerUsd: jpy > 0 ? jpy : 150,
          source: 'live',
          provider: 'open.er-api.com',
          fetchedAt: new Date().toISOString(),
          updatedAt: Date.now(),
        });
        fxCache = fresh;
        writeDiskCache(FX_CACHE_FILE, fresh);
        return fresh;
      }
    }
  } catch { /* try next provider */ }

  // Provider 2: fawazahmed0 currency-api on jsDelivr
  try {
    const r = await fetchText(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      { headers: { Accept: 'application/json' } },
      9000
    );
    if (r.status === 200) {
      const data = JSON.parse(r.text);
      const table = data?.usd || {};
      const hkd = Number(table.hkd);
      const eur = Number(table.eur);
      const jpy = Number(table.jpy);
      if (hkd > 0 && eur > 0) {
        const fresh = normalizeFx({
          hkdPerUsd: hkd,
          hkdPerEur: hkd / eur,
          jpyPerUsd: jpy > 0 ? jpy : 150,
          source: 'live',
          provider: 'jsdelivr currency-api',
          fetchedAt: data.date ? `${data.date}T00:00:00Z` : new Date().toISOString(),
          updatedAt: Date.now(),
        });
        fxCache = fresh;
        writeDiskCache(FX_CACHE_FILE, fresh);
        return fresh;
      }
    }
  } catch { /* fall through */ }

  if (fxCache) {
    fxCache = { ...fxCache, source: 'stale' };
    return fxCache;
  }
  return FX_FALLBACK;
}

/* ------------------------------------------------------------------ */
/* Japanese (or English) → Chinese translation (Google gtx, cached)    */
/* ------------------------------------------------------------------ */
const TR_PROVIDER = 'google';
const TR_TTL = 90 * 24 * 3600e3;
const TR_MAX_TEXTS = 40;
const TR_MAX_TEXT = 1200;
const TR_MAX_TOTAL = 16000;
const TR_LANG_ALIASES = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-sg': 'zh-CN',
  cn: 'zh-CN',
  simplified: 'zh-CN',
  'zh-tw': 'zh-TW',
  'zh-hant': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  tw: 'zh-TW',
  hk: 'zh-TW',
  traditional: 'zh-TW',
};
const TR_SOURCES = { auto: 'auto', en: 'en', ja: 'ja' };
const trMem = new Map();       // `${from}:${to}:${sha1(text)}` -> translated string
const trInflight = new Map();  // de-dupe concurrent identical translations
const TR_CONCURRENCY = 3;
const trQueue = {
  last: 0,
  next: 0,
  chains: Array.from({ length: TR_CONCURRENCY }, () => Promise.resolve()),
};

function normalizeTranslateLang(value) {
  const key = String(value || '').trim().toLowerCase();
  return TR_LANG_ALIASES[key] || 'zh-CN';
}

/** Source language: `ja` for Japanese card text, `auto` when unsure. */
function normalizeSourceLang(value) {
  const key = String(value || '').trim().toLowerCase();
  return TR_SOURCES[key] || 'auto';
}

/** Caps upstream concurrency and spaces request starts so Google stays happy. */
function trFetch(url) {
  const slot = trQueue.next++ % TR_CONCURRENCY;
  const run = async () => {
    const wait = 120 - (Date.now() - trQueue.last);
    if (wait > 0) await sleep(wait);
    trQueue.last = Date.now();
    let lastErr;
    let rateLimited = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      rateLimited = false;
      try {
        const r = await fetchText(url, { headers: { Accept: 'application/json' } }, 15000);
        if (r.status === 200) return r.text;
        lastErr = new Error(`translate HTTP ${r.status}`);
        if (r.status === 429) rateLimited = true;
        else if (r.status < 500) break;
      } catch (err) {
        lastErr = err;
      }
      // Google throttles bursts; 429s get a much longer, jittered backoff.
      await sleep((rateLimited ? 1200 : 400) * 2 ** attempt + Math.random() * 250);
    }
    throw lastErr || new Error('translation request failed');
  };
  const task = trQueue.chains[slot].then(run, run);
  trQueue.chains[slot] = task.catch(() => {});
  return task;
}

function parseTranslated(raw) {
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Unexpected translation response');
  return data[0].map((part) => (Array.isArray(part) ? String(part[0] || '') : '')).join('').trim();
}

async function translateOne(text, to, from = 'auto') {
  const source = String(text || '').trim();
  if (!source) return '';
  const fileKey = hashKey(`${from}|${to}|${source}`);
  const cacheKey = `${from}:${to}:${fileKey}`;
  if (trMem.has(cacheKey)) return trMem.get(cacheKey);

  const file = path.join(TRANSLATE_CACHE, fileKey + '.json');
  const disk = await readDiskCache(file, TR_TTL);
  if (typeof disk === 'string' && disk) {
    trMem.set(cacheKey, disk);
    return disk;
  }
  if (trInflight.has(cacheKey)) return trInflight.get(cacheKey);

  const task = (async () => {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx' +
      `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(source)}`;
    const raw = await trFetch(url);
    const translated = parseTranslated(raw);
    if (!translated) throw new Error('Empty translation');
    trMem.set(cacheKey, translated);
    if (trMem.size > 2000) trMem.delete(trMem.keys().next().value);
    await writeDiskCache(file, translated);
    return translated;
  })().finally(() => trInflight.delete(cacheKey));

  trInflight.set(cacheKey, task);
  return task;
}

async function handleTranslate(req, res, urlObj) {
  let rawTexts = [];
  let to = 'zh-CN';
  let from = 'auto';
  if (req.method === 'POST') {
    let body;
    try {
      body = await readBodyJson(req, 200000);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
    rawTexts = Array.isArray(body && body.texts) ? body.texts : [body && body.text];
    to = normalizeTranslateLang(body && body.to);
    from = normalizeSourceLang(body && body.from);
  } else {
    rawTexts = [urlObj.searchParams.get('text') || ''];
    to = normalizeTranslateLang(urlObj.searchParams.get('to'));
    from = normalizeSourceLang(urlObj.searchParams.get('from'));
  }

  const texts = rawTexts.map((text) => String(text === null || text === undefined ? '' : text));
  const filled = texts.filter((text) => text.trim());
  if (!filled.length) return json(res, 400, { ok: false, error: 'text is required' });
  if (filled.length > TR_MAX_TEXTS) {
    return json(res, 400, { ok: false, error: `Send at most ${TR_MAX_TEXTS} strings per request.` });
  }
  if (filled.some((text) => text.length > TR_MAX_TEXT)) {
    return json(res, 400, { ok: false, error: `Each string must be ${TR_MAX_TEXT} characters or fewer.` });
  }
  if (filled.reduce((sum, text) => sum + text.length, 0) > TR_MAX_TOTAL) {
    return json(res, 400, { ok: false, error: 'That batch is too large — split it up.' });
  }

  try {
    const translations = new Array(texts.length).fill('');
    let cursor = 0;
    const worker = async () => {
      while (cursor < texts.length) {
        const index = cursor++;
        const source = texts[index];
        translations[index] = source.trim() ? await translateOne(source, to, from) : '';
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return json(res, 200, {
      ok: true,
      from,
      to,
      provider: TR_PROVIDER,
      ...(req.method === 'POST'
        ? { translations }
        : { text: texts[0], translation: translations[0] }),
    });
  } catch (err) {
    log('translate failed:', err.message);
    return json(res, 502, { ok: false, error: 'The translation service is unavailable right now.' });
  }
}

/* ------------------------------------------------------------------ */
/* Japanese card set data (TCGdex) + SNKRDUNK JP prices                */
/* ------------------------------------------------------------------ */
const TCGDEX_BASE = 'https://api.tcgdex.net/v2';
const tcgdexMem = new Map();

async function tcgdexRequest(pathAndQuery, ttl = 24 * 3600e3) {
  const cacheKey = hashKey(pathAndQuery);
  const file = path.join(TCGDEX_CACHE, cacheKey + '.json');

  const disk = await readDiskCache(file, ttl);
  if (disk) return { status: disk.status, body: disk.body, cache: 'disk' };

  const mem = tcgdexMem.get(cacheKey);
  if (mem && Date.now() - mem.at < ttl) {
    return { status: 200, body: mem.value, cache: 'memory' };
  }

  let lastStatus = 502;
  let lastBody = { error: { message: 'Upstream TCGdex API is unavailable.' } };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetchText(TCGDEX_BASE + pathAndQuery, {
        headers: { Accept: 'application/json' },
      }, 25000);
      let body;
      try {
        body = JSON.parse(r.text);
      } catch {
        body = { error: { message: `TCGdex returned unreadable data (HTTP ${r.status}).` } };
      }
      if (r.status === 200) {
        tcgdexMem.set(cacheKey, { at: Date.now(), value: body });
        if (tcgdexMem.size > 400) tcgdexMem.delete(tcgdexMem.keys().next().value);
        writeDiskCache(file, { status: 200, body });
        return { status: 200, body, cache: 'miss' };
      }
      lastStatus = r.status;
      lastBody = body;
      if (r.status !== 429 && r.status < 500) break;
      await sleep(350 * 2 ** attempt + Math.random() * 200);
    } catch (err) {
      lastBody = { error: { message: 'Could not reach TCGdex.', detail: err.message } };
      await sleep(350 * 2 ** attempt + Math.random() * 200);
    }
  }
  const stale = await readDiskCache(file, 30 * 24 * 3600e3);
  if (stale && stale.status === 200 && stale.body) {
    return { status: 200, body: stale.body, cache: 'stale' };
  }
  return { status: lastStatus === 200 ? 502 : lastStatus, body: lastBody, cache: 'miss' };
}

async function jpSetsPayload() {
  const result = await tcgdexRequest('/ja/sets', 24 * 3600e3);
  if (result.status !== 200 || !Array.isArray(result.body)) {
    return { ok: false, error: 'Could not load Japanese sets', sets: [] };
  }
  // TCGdex returns oldest → newest; newest first is more useful in the UI.
  const sets = result.body.slice().reverse().map((set) => ({
    code: String(set.id || ''),
    name: String(set.name || ''),
    official: set.cardCount && set.cardCount.official ? Number(set.cardCount.official) : null,
    total: set.cardCount && set.cardCount.total ? Number(set.cardCount.total) : null
  })).filter((set) => set.code && set.name);
  return { ok: true, sets };
}

/**
 * SNKRDUNK search by set code. Product labels look like:
 *   メガリザードンXex MA [M2a 223/193](ハイクラスパック「MEGAドリームex」) - ¥2,900
 * Returns { [localIdNorm]: { productId, priceJPY, label, image } } with the
 * cheapest listing picked when a card has several product variants.
 */
async function snkrSetPriceMap(setCode) {
  const cacheFile = path.join(SNK_CACHE, `jp-set-${hashKey(String(setCode).toLowerCase())}.json`);
  const cached = await readDiskCache(cacheFile, 90 * 60e3);
  if (cached) return cached;

  const byLocalId = {};
  for (const page of [1, 2, 3]) {
    let html;
    try {
      html = await snkFetch(`${SNK_BASE}/search?keywords=${encodeURIComponent(setCode)}&page=${page}`);
    } catch (err) {
      log('snkr jp set page failed', setCode, page, err.message);
      break;
    }
    let matches = 0;
    const re = /<a([^>]*href="https:\/\/snkrdunk\.com\/apparels\/(\d+)"[^>]*)>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) {
      const attrs = m[1];
      const productId = m[2];
      const inner = m[3];
      const labelM = attrs.match(/aria-label="([^"]*)"/);
      if (!labelM) continue;
      const label = decodeEntities(labelM[1]);
      const cardM = label.match(/\[([A-Za-z0-9-]+)\s+(\d+)\/(\d+)\]/);
      if (!cardM || cardM[1].toLowerCase() !== String(setCode).toLowerCase()) continue;
      const localKey = cardM[2].replace(/^0+/, '') || '0';
      const priceM = label.match(/¥([\d,]+)\s*$/);
      const imgM = inner.match(/<img[^>]+src="([^"]+)"/);
      const entry = {
        productId,
        priceJPY: priceM ? Number(priceM[1].replace(/,/g, '')) : null,
        label: label.replace(/\s*-\s*¥[\d,]+\s*$/, ''),
        image: imgM ? decodeEntities(imgM[1]) : null,
        total: cardM[3]
      };
      matches += 1;
      const existing = byLocalId[localKey];
      if (!existing) {
        byLocalId[localKey] = entry;
      } else {
        const better = entry.priceJPY !== null &&
          (existing.priceJPY === null || entry.priceJPY < existing.priceJPY);
        if (better) byLocalId[localKey] = entry;
      }
    }
    if (!matches) break;
  }

  await writeDiskCache(cacheFile, byLocalId);
  return byLocalId;
}

async function jpSetPayload(codeRaw) {
  const code = String(codeRaw || '').trim();
  if (!/^[A-Za-z0-9-]{2,16}$/.test(code)) {
    return { error: 'Invalid Japanese set code.', status: 400 };
  }
  const result = await tcgdexRequest('/ja/sets/' + encodeURIComponent(code), 24 * 3600e3);
  if (result.status !== 200 || !result.body || !result.body.id) {
    return { error: 'No Japanese set found for “' + code + '”.', status: 404 };
  }
  const detail = result.body;
  const prices = await snkrSetPriceMap(detail.id).catch(() => ({}));
  const serieId = (detail.serie && detail.serie.id) || '';
  const official = detail.cardCount && detail.cardCount.official ? Number(detail.cardCount.official) : null;
  const total = detail.cardCount && detail.cardCount.total ? Number(detail.cardCount.total) : null;

  const cards = (Array.isArray(detail.cards) ? detail.cards : []).map((card) => {
    const localId = String(card.localId || '');
    const localKey = localId.replace(/^0+/, '') || '0';
    const price = prices[localKey] || null;
    const imageBase = serieId
      ? `https://assets.tcgdex.net/ja/${serieId}/${detail.id}/${localId}`
      : null;
    return {
      id: card.id,
      localId,
      number: official ? `${localId}/${official}` : localId,
      localKey,
      name: card.name,
      priceJPY: price ? price.priceJPY : null,
      productId: price ? price.productId : null,
      productUrl: price ? `${SNK_BASE}/apparels/${price.productId}` : null,
      productName: price ? price.label : null,
      image: price && price.image ? price.image : imageBase ? `${imageBase}/low.webp` : null,
      imageHigh: price && price.image ? price.image : imageBase ? `${imageBase}/high.webp` : null,
      hasPrice: Boolean(price && price.priceJPY)
    };
  });

  return {
    code: detail.id,
    name: detail.name,
    serie: detail.serie || null,
    releaseDate: detail.releaseDate || null,
    cardCount: { official, total },
    cards,
    pricedCount: cards.filter((card) => card.hasPrice).length,
    source: 'tcgdex+snkrdunk',
    fetchedAt: new Date().toISOString()
  };
}

async function jpCardPayload(cardIdRaw) {
  const cardId = String(cardIdRaw || '').trim();
  // Japanese card ids are `<setId>-<localId>`, and the set id itself may carry
  // a dash (promo sets: SV-P, S-P, M-P), so allow 1..3 dashed segments.
  if (cardId.length > 64 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+){1,3}$/.test(cardId)) {
    return { error: 'Invalid Japanese card id.', status: 400 };
  }
  const result = await tcgdexRequest('/ja/cards/' + encodeURIComponent(cardId), 24 * 3600e3);
  if (result.status !== 200 || !result.body || !result.body.id) {
    return { error: 'No Japanese card found for “' + cardId + '”.', status: 404 };
  }
  const card = result.body;
  const localId = String(card.localId || '');
  const localKey = localId.replace(/^0+/, '') || '0';
  // Prefer TCGdex's own set id; otherwise strip the trailing `-<localId>` so
  // dash-carrying promo set ids (SV-P) are not truncated to their first segment.
  const setId = (card.set && card.set.id) ||
    (localId && cardId.endsWith('-' + localId)
      ? cardId.slice(0, cardId.length - localId.length - 1)
      : cardId.split('-')[0]);

  let snkr = null;
  try {
    const prices = await snkrSetPriceMap(setId);
    const product = prices[localKey];
    if (product) {
      let listing = null;
      try {
        const page = await snkFetch(`${SNK_BASE}/apparels/${product.productId}`, `${SNK_BASE}/search`);
        listing = parseProductPage(page, product.productId);
      } catch { /* keep basic info */ }
      snkr = {
        productId: product.productId,
        url: `${SNK_BASE}/apparels/${product.productId}`,
        nameEN: listing ? listing.nameEN : null,
        nameJP: listing ? listing.nameJP : product.label,
        image: listing && listing.image ? listing.image : product.image,
        priceJPY: listing && (listing.usedMinPrice || listing.minPrice)
          ? (listing.usedMinPrice || listing.minPrice)
          : product.priceJPY,
        listings: listing ? (listing.usedListingCount ?? listing.listingCount ?? 0) : null,
        productNumber: listing ? listing.productNumber : null
      };
    }
  } catch (err) {
    log('jp card snkr failed', cardId, err.message);
  }

  let imageLow = null;
  let imageHigh = null;
  if (card.image) {
    imageLow = `${card.image}/low.webp`;
    imageHigh = `${card.image}/high.webp`;
  } else if (snkr && snkr.image) {
    imageLow = snkr.image;
    imageHigh = snkr.image;
  } else {
    try {
      const setResult = await tcgdexRequest('/ja/sets/' + encodeURIComponent(setId), 24 * 3600e3);
      const serieId = setResult.body && setResult.body.serie ? setResult.body.serie.id : '';
      if (serieId) {
        imageLow = `https://assets.tcgdex.net/ja/${serieId}/${setId}/${localId}/low.webp`;
        imageHigh = `https://assets.tcgdex.net/ja/${serieId}/${setId}/${localId}/high.webp`;
      }
    } catch { /* no image */ }
  }

  return {
    card: {
      id: card.id,
      localId,
      name: card.name,
      category: card.category || null,
      hp: card.hp || null,
      types: card.types || [],
      rarity: card.rarity || null,
      illustrator: card.illustrator || null,
      stage: card.stage || null,
      description: card.description || null,
      attacks: card.attacks || [],
      abilities: card.abilities || [],
      weaknesses: card.weaknesses || [],
      resistances: card.resistances || [],
      retreat: card.retreat || null,
      regulationMark: card.regulationMark || null
    },
    set: {
      id: setId,
      name: card.set ? card.set.name : null,
      cardCount: card.set ? card.set.cardCount : null
    },
    imageLow,
    imageHigh,
    cardmarket: card.pricing && card.pricing.cardmarket ? card.pricing.cardmarket : null,
    snkr,
    fetchedAt: new Date().toISOString()
  };
}

const jpInflight = new Map();
/**
 * Disk/in-flight cache for assembled Japanese payloads. Error payloads are
 * returned to the caller but deliberately not persisted: a transient TCGdex
 * hiccup (or a bad request that got fixed) must not stick around for the TTL.
 */
function jpCached(key, ttl, producer) {
  const file = path.join(TCGDEX_CACHE, 'resp-' + hashKey(key) + '.json');
  return (async () => {
    const cached = await readDiskCache(file, ttl);
    if (cached) return cached;
    if (jpInflight.has(key)) return jpInflight.get(key);
    const task = producer().then(async (value) => {
      const failed = value && (value.error || value.ok === false);
      if (!failed) await writeDiskCache(file, value);
      return value;
    }).finally(() => jpInflight.delete(key));
    jpInflight.set(key, task);
    return task;
  })();
}

async function handleJpSets(req, res) {
  const payload = await jpCached('jp-sets', 24 * 3600e3, jpSetsPayload);
  return json(res, 200, payload);
}

async function handleJpSet(req, res, urlObj) {
  const code = urlObj.searchParams.get('code') || '';
  const payload = await jpCached('jp-set-' + code.toLowerCase(), 90 * 60e3, () => jpSetPayload(code));
  if (payload.error) return json(res, payload.status || 404, payload);
  return json(res, 200, payload);
}

async function handleJpCard(req, res, urlObj) {
  const id = urlObj.searchParams.get('id') || '';
  const payload = await jpCached('jp-card-' + id.toLowerCase(), 60 * 60e3, () => jpCardPayload(id));
  if (payload.error) return json(res, payload.status || 404, payload);
  return json(res, 200, payload);
}

/* ------------------------------------------------------------------ */
/* Japanese-first storefront: card search + featured chase cards       */
/* ------------------------------------------------------------------ */
const JP_SEARCH_MAX_Q = 40;
const JP_SEARCH_PAGE_SIZE = 60;
const JP_SEARCH_MAX_PAGE_SIZE = 120;
const JP_SEARCH_TTL = 30 * 60e3;
const JP_SEARCH_PRICE_SETS = 3;
const JP_FEATURED_SETS = ['SV2a', 'SV8a', 'S12a', 'M2a', 'SV9', 'M1L', 'SV6a', 'S8b', 'SM12a', 'SV4a'];
const JP_FEATURED_LIMIT = 12;
const JP_FEATURED_TTL = 60 * 60e3;
const JP_FEATURED_CONCURRENCY = 3;

/** Local-id key used by the SNKRDUNK price map (leading zeros dropped). */
function jpLocalKey(localId) {
  return String(localId || '').replace(/^0+/, '') || '0';
}

/**
 * Japanese set index: set id -> { name, official }. Promo set ids contain a
 * dash (`SV-P`, `M-P`), so cards are matched against the longest known set id
 * that prefixes `<cardId>-` instead of naively splitting on the first dash.
 */
async function jpSetIndex() {
  const payload = await jpCached('jp-sets', 24 * 3600e3, jpSetsPayload);
  const index = new Map();
  if (payload && Array.isArray(payload.sets)) {
    for (const set of payload.sets) {
      if (set && set.code) {
        index.set(set.code, { name: set.name || '', official: set.official || null });
      }
    }
  }
  return index;
}

/** Resolve the Japanese set for one TCGdex card id (best effort). */
function jpSetForCard(cardId, localId, index) {
  const id = String(cardId || '');
  const haystack = id + '-';
  let best = null;
  index.forEach((info, code) => {
    if (!haystack.startsWith(code + '-')) return;
    if (!best || code.length > best.code.length) {
      best = { code, name: info.name, official: info.official };
    }
  });
  if (best) return best;
  // Set index unavailable: TCGdex ids are always `<setId>-<localId>`.
  const suffix = String(localId || '');
  const trimmed = suffix && id.endsWith('-' + suffix)
    ? id.slice(0, id.length - suffix.length - 1)
    : '';
  return { code: trimmed || id.split('-')[0], name: '', official: null };
}

/**
 * One page of Japanese cards from the TCGdex brief index, with set name/number
 * resolved and best-effort SNKRDUNK JPY prices for the first few set codes on
 * the page. Throws on upstream failure so the handler can answer 502 without
 * caching the error.
 */
async function jpSearchPayload(q, page, pageSize) {
  const query = '/ja/cards?name=' + encodeURIComponent(q) +
    '&pagination:page=' + page + '&pagination:itemsPerPage=' + pageSize;
  const result = await tcgdexRequest(query, 6 * 3600e3);
  if (result.status !== 200 || !Array.isArray(result.body)) {
    throw new Error(`TCGdex search failed (HTTP ${result.status}).`);
  }

  const index = await jpSetIndex().catch(() => new Map());
  const resolved = result.body.map((card) => {
    const localId = String(card.localId || '');
    return { card, localId, set: jpSetForCard(card.id, localId, index) };
  });

  const setCodes = [];
  for (const entry of resolved) {
    const code = entry.set.code;
    if (code && setCodes.indexOf(code) === -1) {
      setCodes.push(code);
      if (setCodes.length >= JP_SEARCH_PRICE_SETS) break;
    }
  }
  const priceMaps = await Promise.all(setCodes.map((code) =>
    snkrSetPriceMap(code).catch(() => ({}))));
  const pricesBySet = new Map();
  setCodes.forEach((code, i) => pricesBySet.set(code, priceMaps[i] || {}));

  const cards = resolved.map(({ card, localId, set }) => {
    const price = (pricesBySet.get(set.code) || {})[jpLocalKey(localId)] || null;
    const priceJPY = price && Number(price.priceJPY) > 0 ? Number(price.priceJPY) : null;
    return {
      id: card.id,
      localId,
      number: set.official ? `${localId}/${set.official}` : localId,
      name: card.name || '',
      setCode: set.code || '',
      setName: set.name || '',
      image: card.image ? `${card.image}/low.webp` : null,
      imageHigh: card.image ? `${card.image}/high.webp` : null,
      priceJPY,
      hasPrice: priceJPY !== null
    };
  });

  return { ok: true, q, page, pageSize, hasMore: cards.length === pageSize, cards };
}

async function handleJpCards(req, res, urlObj) {
  const q = String(urlObj.searchParams.get('q') || '').trim().slice(0, JP_SEARCH_MAX_Q);
  if (!q) return json(res, 400, { ok: false, error: 'Search term is required.' });
  let page = Number(urlObj.searchParams.get('page'));
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.floor(page);
  const sizeRaw = urlObj.searchParams.get('pageSize');
  let pageSize = sizeRaw === null || sizeRaw === '' ? JP_SEARCH_PAGE_SIZE : Number(sizeRaw);
  if (!Number.isFinite(pageSize)) pageSize = JP_SEARCH_PAGE_SIZE;
  pageSize = Math.min(JP_SEARCH_MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
  try {
    const payload = await jpCached(`jp-search-${q}-${page}-${pageSize}`, JP_SEARCH_TTL,
      () => jpSearchPayload(q, page, pageSize));
    return json(res, 200, payload);
  } catch (err) {
    log('jp card search failed', q, err.message);
    return json(res, 502, { ok: false, error: 'Japanese card search is unavailable right now.' });
  }
}

/**
 * The most valuable chase cards across the curated hot sets. Reuses
 * jpSetPayload (TCGdex + SNKRDUNK price map), merges priced cards, drops
 * duplicates and keeps the top 12. Throws when nothing priced came back so a
 * dead upstream is not cached for an hour.
 */
async function jpFeaturedPayload() {
  const sets = [];
  for (let i = 0; i < JP_FEATURED_SETS.length; i += JP_FEATURED_CONCURRENCY) {
    const batch = JP_FEATURED_SETS.slice(i, i + JP_FEATURED_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((code) => jpSetPayload(code)));
    settled.forEach((outcome, index) => {
      const code = batch[index];
      if (outcome.status === 'rejected') {
        log('jp featured set failed', code, outcome.reason && outcome.reason.message);
        return;
      }
      const set = outcome.value;
      if (!set || set.error || !Array.isArray(set.cards)) return;
      sets.push(set);
    });
  }

  const seen = new Set();
  const cards = [];
  for (const set of sets) {
    for (const card of set.cards) {
      if (!card || !card.id || !card.hasPrice || seen.has(card.id)) continue;
      const priceJPY = Number(card.priceJPY);
      if (!Number.isFinite(priceJPY) || priceJPY <= 0) continue;
      seen.add(card.id);
      cards.push({
        id: card.id,
        localId: card.localId,
        number: card.number,
        name: card.name,
        setCode: set.code,
        setName: set.name,
        image: card.image || null,
        imageHigh: card.imageHigh || null,
        priceJPY,
        hasPrice: true
      });
    }
  }
  cards.sort((a, b) => b.priceJPY - a.priceJPY);
  if (!cards.length) throw new Error('No priced Japanese cards available.');
  return { ok: true, cards: cards.slice(0, JP_FEATURED_LIMIT), updatedAt: new Date().toISOString() };
}

async function handleJpFeatured(req, res) {
  try {
    const payload = await jpCached('jp-featured', JP_FEATURED_TTL, jpFeaturedPayload);
    return json(res, 200, payload);
  } catch (err) {
    log('jp featured failed', err.message);
    return json(res, 502, { ok: false, error: 'Featured Japanese cards are unavailable right now.' });
  }
}

/* ------------------------------------------------------------------ */
/* admin auth                                                          */
/* ------------------------------------------------------------------ */
const LOGIN_WINDOW = 10 * 60e3;
const LOGIN_MAX_ATTEMPTS = 12;
const loginAttempts = new Map(); // ip -> number[] (timestamps of failures)

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'local';
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}

function issueToken() {
  pruneExpiredSessions();
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user: ADMIN_USER, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+([a-f0-9]{16,128})$/i);
  return match ? match[1] : null;
}

/** Returns the admin session, or null after replying with 401. */
function requireAdmin(req, res) {
  const token = bearerToken(req);
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    json(res, 401, { error: 'Not signed in. Sign in to the admin panel again.' }, {}, false);
    return null;
  }
  return { token, session };
}

/* ------------------------------------------------------------------ */
/* SNKRDUNK enrichment                                                 */
/* ------------------------------------------------------------------ */
const SNK_BASE = 'https://snkrdunk.com';
const snkQueue = { last: 0, chain: Promise.resolve() };

/** Serialises upstream SNKRDUNK requests to stay polite. */
function snkFetch(url, referer = SNK_BASE + '/') {
  const run = async () => {
    const wait = 220 - (Date.now() - snkQueue.last);
    if (wait > 0) await sleep(wait);
    snkQueue.last = Date.now();
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchText(url, {
          headers: { Accept: 'text/html,application/xhtml+xml', Referer: referer },
        }, 22000);
        if (r.status === 200) return r.text;
        lastErr = new Error(`SNKRDUNK HTTP ${r.status}`);
      } catch (err) {
        lastErr = err;
      }
      await sleep(500 + attempt * 500);
    }
    throw lastErr || new Error('SNKRDUNK request failed');
  };
  const p = snkQueue.chain.then(run, run);
  snkQueue.chain = p.catch(() => {});
  return p;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function unescapeJsonish(s) {
  let out = s;
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\"/g, '"')
      .replace(/\\n/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\\\\/g, '\\');
  }
  return out;
}

function parseSearchTiles(html) {
  const out = [];
  const seen = new Set();
  const re = /href="https:\/\/snkrdunk\.com\/apparels\/(\d+)"[^>]*?aria-label="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const label = decodeEntities(m[2]);
    const priceM = label.match(/¥([\d,]+)\s*$/);
    out.push({
      id: m[1],
      label,
      price: priceM ? Number(priceM[1].replace(/,/g, '')) : null,
    });
  }
  return out;
}

/**
 * Product pages are Next.js RSC documents. Names are pulled from the
 * <title>/<meta description> (clean, HTML-escaped) while the raw numbers
 * are pulled from the embedded `apparelData` blob.
 */
function parseProductPage(html, productId) {
  const titleM = html.match(/<title>([\s\S]*?)<\/title>/);
  const nameJP = titleM
    ? decodeEntities(titleM[1]).replace(/通販・買取・相場[\s\S]*$/, '').trim()
    : null;

  const descM = html.match(/<meta name="description" content="([\s\S]*?)"\s*\/?>/);
  const desc = descM ? decodeEntities(descM[1]) : '';
  const enM = desc.match(/（([^（）]*)）の在庫あり/);
  const nameEN = enM ? enM[1].trim() : null;

  const idx = html.indexOf('apparelData');
  const seg = idx >= 0 ? html.slice(idx, idx + 8000) : html;
  const num = (key) => {
    const m = seg.match(new RegExp('\\\\"' + key + '\\\\":(-?\\d+)'));
    return m ? Number(m[1]) : null;
  };
  const str = (key) => {
    const m = seg.match(new RegExp('\\\\"' + key + '\\\\":\\\\"([^"\\\\]*)\\\\"'));
    return m ? m[1] : null;
  };
  const imgM = seg.match(/\\"imageUrl\\":\\"([^"\\]+)\\"/);
  const item = {
    productId: Number(productId) || num('id'),
    productCatalogId: num('productCatalogId'),
    productNumber: str('productNumber'),
    nameEN,
    nameJP,
    image: imgM ? imgM[1] : null,
    releasedAt: str('releasedAt'),
    usedMinPrice: num('usedMinPrice'),
    usedListingCount: num('usedListingCount'),
    minPrice: num('minPrice'),
    listingCount: num('listingCount'),
    url: null,
  };
  item.url = item.productId ? `${SNK_BASE}/apparels/${item.productId}` : null;
  return item.nameJP || item.nameEN ? item : null;
}

const SET_STOP_WORDS = new Set([
  'the', 'set', 'series', 'expansion', 'pack', 'booster', 'base', 'promo',
  'promotional', 'card', 'cards', 'collection', 'special', 'edition', 'prism',
  'holo', 'holofoil', 'rare', 'ultra', 'secret', 'rainbow', 'shiny', 'ex', 'gx',
  'sun', 'moon', 'sword', 'shield', 'scarlet', 'violet', 'black', 'white',
]);

function normalizeSetName(name) {
  const text = String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter((w) => w && !SET_STOP_WORDS.has(w));
  return words.join(' ') || text;
}

function yearOf(value) {
  const m = String(value || '').match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

function scoreCandidate(card, item) {
  const en = String(item.nameEN || '').toLowerCase();
  const jp = String(item.nameJP || '');
  const cardName = String(card.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const setNorm = normalizeSetName(card.set?.name);
  const lookFor = `${card.number}/${card.set?.printedTotal || card.set?.total || ''}`;
  let score = 0;
  const reasons = [];

  if (en.includes(cardName) || en.split('[')[0].trim().includes(cardName)) { score += 4; reasons.push('name'); }
  if (en.includes(`[${lookFor}]`) || en.includes(` ${lookFor}]`) || en.includes(` ${lookFor} `)) { score += 3; reasons.push('number'); }
  if (jp.includes(`[${lookFor}]`) || jp.includes(` ${lookFor}]`)) { score += 1; reasons.push('jp-number'); }
  if (jp.includes('英語版') || /\[[a-z0-9 ]*en .*?\]/i.test(en) || en.includes('(en)')) { score += 2; reasons.push('english-version'); }

  const setWords = setNorm ? setNorm.split(' ') : [];
  const enSetMatch = setWords.length && setWords.every((w) => en.includes(w));
  if (enSetMatch) {
    score += 3;
    reasons.push('set');
  } else if (setNorm && en.includes(setNorm)) { score += 2; reasons.push('set-text'); }

  const jpSetNorm = normalizeSetName((card.set?.name || '').replace(/[^a-z0-9 ]/gi, ' '));
  if (jpSetNorm && jp.includes(jpSetNorm)) score += 1;

  if (/1st edition|1st ed\b/i.test(en)) { score -= 1; reasons.push('-first-ed'); }
  if (/metal card|metal\b/i.test(en)) { score -= 2; reasons.push('-metal'); }
  if (/psa|bgs|cgc|graded|slab/i.test(en)) { score -= 6; reasons.push('-graded'); }
  if ((item.usedMinPrice || 0) > 0) { score += 1; reasons.push('has-price'); }

  const cardYear = yearOf(card.set?.releaseDate);
  const itemYear = yearOf(item.releasedAt);
  if (cardYear && itemYear && Math.abs(cardYear - itemYear) <= 1) { score += 2; reasons.push('year'); }
  else if (cardYear && itemYear) { score -= 1; reasons.push('-year'); }

  return { score, reasons };
}

async function buildSnkrdunkCard(query) {
  const card = {
    id: String(query.cardId || '').slice(0, 60),
    name: String(query.name || '').slice(0, 80),
    number: String(query.number || '').slice(0, 12),
    set: {
      name: String(query.set || '').slice(0, 80),
      printedTotal: String(query.total || '').slice(0, 8),
      total: String(query.total || '').slice(0, 8),
      releaseDate: String(query.releaseDate || '').slice(0, 20),
    },
  };
  if (!card.name || !card.number) {
    return { matched: false, error: 'missing name/number', items: [] };
  }

  const term = `${card.name} ${card.number}/${card.set.printedTotal || card.set.total}`.trim();
  const searchUrl = `${SNK_BASE}/search?keywords=${encodeURIComponent(term)}&page=1`;
  const searchFile = path.join(SNK_CACHE, `search-${hashKey(searchUrl)}.json`);
  let tiles = await readDiskCache(searchFile, 6 * 3600e3);
  if (!tiles) {
    const html = await snkFetch(searchUrl);
    tiles = parseSearchTiles(html);
    await writeDiskCache(searchFile, tiles);
  }

  const lookFor = `${card.number}/${card.set.printedTotal || card.set.total}`;
  const numbered = tiles.filter((t) => t.label.includes(lookFor));
  const pool = (numbered.length ? numbered : tiles).slice(0, 6);

  const products = [];
  for (const tile of pool) {
    const pageUrl = `${SNK_BASE}/apparels/${tile.id}`;
    const pageFile = path.join(SNK_CACHE, `product-${tile.id}.json`);
    let parsed = await readDiskCache(pageFile, 6 * 3600e3);
    if (!parsed) {
      try {
        const html = await snkFetch(pageUrl, `${SNK_BASE}/search`);
        parsed = parseProductPage(html, tile.id);
        if (parsed) await writeDiskCache(pageFile, parsed);
      } catch (err) {
        log('snk product failed', tile.id, err.message);
      }
    }
    if (parsed) products.push({ ...parsed, tileLabel: tile.label });
  }

  const scored = products
    .map((item) => ({ item, ...scoreCandidate(card, item) }))
    .sort((a, b) => b.score - a.score || (b.item.usedMinPrice || 0) - (a.item.usedMinPrice || 0));

  const exact = scored.filter((s) =>
    s.reasons.includes('number') || s.reasons.includes('jp-number')
  );
  const items = exact
    .filter((s) => s.score > 0)
    .slice(0, 4)
    .map(({ item, score, reasons }) => ({
      productId: item.productId,
      url: item.url,
      nameEN: item.nameEN,
      nameJP: item.nameJP,
      productNumber: item.productNumber,
      image: item.image,
      releasedAt: item.releasedAt,
      priceJPY: item.usedMinPrice || item.minPrice || null,
      listings: item.usedListingCount ?? item.listingCount ?? 0,
      isEnglishVersion: /英語版/.test(item.nameJP || '') || /\[[^\]]*\bEN\b/i.test(item.nameEN || ''),
      score,
      reasons,
    }));

  return {
    matched: items.length > 0,
    query: term,
    source: 'snkrdunk',
    sourceUrl: `https://snkrdunk.com/search?keywords=${encodeURIComponent(term)}`,
    fetchedAt: new Date().toISOString(),
    items,
    suggestions: tiles.slice(0, 5).map((t) => ({ id: t.id, label: t.label, url: `${SNK_BASE}/apparels/${t.id}` })),
  };
}

async function handleSnkrdunkCard(req, res, urlObj) {
  const cardId = String(urlObj.searchParams.get('cardId') || '').slice(0, 60);
  if (!cardId) return json(res, 400, { error: 'cardId is required' });

  const file = path.join(SNK_CACHE, `card-${hashKey(cardId)}.json`);
  const cached = await readDiskCache(file, 60 * 60e3);
  if (cached) {
    res.setHeader('X-Proxy-Cache', 'disk');
    return json(res, 200, cached);
  }

  const query = {
    cardId,
    name: urlObj.searchParams.get('name') || '',
    number: urlObj.searchParams.get('number') || '',
    total: urlObj.searchParams.get('total') || '',
    set: urlObj.searchParams.get('set') || '',
    releaseDate: urlObj.searchParams.get('releaseDate') || '',
  };
  try {
    const result = await buildSnkrdunkCard(query);
    await writeDiskCache(file, result);
    return json(res, 200, result, { 'X-Proxy-Cache': 'miss' });
  } catch (err) {
    log('snkrdunk enrichment failed', err.message);
    return json(res, 200, {
      matched: false,
      error: 'SNKRDUNK did not answer in time',
      sourceUrl: `https://snkrdunk.com/search?keywords=${encodeURIComponent(`${query.name} ${query.number}`)}`,
      items: [],
      fetchedAt: new Date().toISOString(),
    });
  }
}

/* ------------------------------------------------------------------ */
/* admin API handlers                                                  */
/* ------------------------------------------------------------------ */
async function handleAdminLogin(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW);
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    return json(res, 429, { error: 'Too many sign-in attempts. Try again in a few minutes.' }, {}, false);
  }

  let body;
  try {
    body = await readBodyJson(req, 4000);
  } catch (err) {
    return json(res, 400, { error: err.message }, {}, false);
  }

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const userOk = username.length === ADMIN_USER.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(ADMIN_USER));
  const passOk = password.length === ADMIN_PASS.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASS));

  if (!userOk || !passOk) {
    attempts.push(now);
    loginAttempts.set(ip, attempts);
    log(`admin login failed from ${ip} (${attempts.length} recent failures)`);
    return json(res, 401, { error: 'Wrong username or password.' }, {}, false);
  }

  loginAttempts.delete(ip);
  const token = issueToken();
  log(`admin signed in from ${ip}`);
  return json(res, 200, {
    token,
    expiresAt: sessions.get(token).expiresAt,
    user: ADMIN_USER,
  }, {}, false);
}

async function handleAdminConfigGet(req, res) {
  if (!requireAdmin(req, res)) return;
  const payload = await adminConfigPayload();
  return json(res, 200, payload, {}, false);
}

async function handleAdminConfigPut(req, res) {
  if (!requireAdmin(req, res)) return;
  let body;
  try {
    body = await readBodyJson(req, 200000);
  } catch (err) {
    return json(res, 400, { error: err.message }, {}, false);
  }
  if (!body || (body.mode !== 'all' && body.mode !== 'curated')) {
    return json(res, 400, { error: 'mode must be "all" or "curated"' }, {}, false);
  }
  if (!Array.isArray(body.cards)) {
    return json(res, 400, { error: 'cards must be an array' }, {}, false);
  }
  saveSiteConfig({ mode: body.mode, cards: body.cards });
  log(`site config saved: mode=${siteConfig.mode}, cards=${siteConfig.cards.length}`);
  const payload = await adminConfigPayload();
  return json(res, 200, payload, {}, false);
}

async function handleAdminLogout(req, res) {
  const token = bearerToken(req);
  if (token) sessions.delete(token);
  return json(res, 200, { ok: true }, {}, false);
}

/* ------------------------------------------------------------------ */
/* static site                                                         */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep) && abs !== path.join(ROOT, 'index.html')) {
    return json(res, 403, { error: 'Forbidden' });
  }
  fsp.stat(abs).then((stat) => {
    if (stat.isDirectory()) return sendStatic(req, res, path.join(rel, 'index.html'));
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  }).catch(() => {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>404 — HoloDex</title>
      <body style="font-family:system-ui;background:#07080e;color:#eef1f9;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center"><h1 style="font-size:3rem;margin:0">404</h1>
      <p style="color:#a7adc2">That page slipped out of the binder.</p>
      <a href="/" style="color:#a78bfa">Back to HoloDex</a></div></body>`);
  });
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */
siteConfig = loadSiteConfig();

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = urlObj;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Authorization',
      });
      return res.end();
    }

    if (pathname === '/config.js') {
      const config = {
        apiBase: '/api/v2',
        proxy: true,
        snkrdunk: true,
        siteConfig: true,
        admin: true,
        translate: true,
        serverVersion: '1.6.0',
        hasApiKey: Boolean(TCG_KEY),
        adminUser: ADMIN_USER,
        port: PORT,
      };
      const raw = `window.APP_CONFIG = Object.assign(window.APP_CONFIG || {}, ${JSON.stringify(config)});\n`;
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(raw);
    }

    if (pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        mode: 'proxy',
        hasApiKey: Boolean(TCG_KEY),
        cacheDir: path.relative(ROOT, CACHE_DIR),
        siteMode: siteConfig.mode,
        curatedCards: siteConfig.cards.length,
        fx: await getFxRates(),
        jpSets: true,
        translate: true,
        uptime: Math.round(process.uptime()),
      });
    }

    if (pathname === '/api/fx') {
      return json(res, 200, { base: 'USD', ...(await getFxRates()) });
    }

    if (pathname === '/api/site-config') {
      return json(res, 200, publicSiteConfig());
    }

    if (pathname === '/api/site-cards') {
      if (siteConfig.mode !== 'curated') {
        return json(res, 200, { mode: 'all', updatedAt: siteConfig.updatedAt, cards: [] });
      }
      return json(res, 200, await siteCardsPayload());
    }

    if (pathname === '/api/admin/login' && req.method === 'POST') {
      return handleAdminLogin(req, res);
    }
    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      return handleAdminLogout(req, res);
    }
    if (pathname === '/api/admin/config' && req.method === 'GET') {
      return handleAdminConfigGet(req, res);
    }
    if (pathname === '/api/admin/config' && req.method === 'PUT') {
      return handleAdminConfigPut(req, res);
    }

    if (pathname === '/api/jp/sets') {
      return handleJpSets(req, res);
    }
    if (pathname === '/api/jp/set') {
      return handleJpSet(req, res, urlObj);
    }
    if (pathname === '/api/jp/card') {
      return handleJpCard(req, res, urlObj);
    }
    if (pathname === '/api/jp/cards') {
      return handleJpCards(req, res, urlObj);
    }
    if (pathname === '/api/jp/featured') {
      return handleJpFeatured(req, res);
    }

    if (pathname === '/api/translate') {
      return handleTranslate(req, res, urlObj);
    }

    if (pathname.startsWith('/api/v2/')) {
      return proxyTcg(pathname.slice('/api/v2'.length) + (urlObj.search || ''), res);
    }

    if (pathname === '/api/snkrdunk/card') {
      return handleSnkrdunkCard(req, res, urlObj);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Method not allowed' });
    }
    return sendStatic(req, res, pathname);
  } catch (err) {
    log('unhandled error', err);
    if (!res.headersSent) json(res, 500, { error: 'Internal server error', detail: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  log(`HoloDex running      → http://localhost:${PORT}`);
  log(`Admin panel          → http://localhost:${PORT}/admin`);
  log(`Pokémon TCG API: ${TCG_KEY ? 'proxied with API key' : 'proxied (no key — public rate limits apply)'}`);
  log(`Site mode: ${siteConfig.mode} · ${siteConfig.cards.length} curated card(s)`);
  log(`Admin user: ${ADMIN_USER} · config: data/site-config.json`);
  log('SNKRDUNK enrichment: enabled (server-side, cached)');
  log('Japanese set explorer: TCGdex + SNKRDUNK (cached)');
  log('Japanese → Chinese translation: /api/translate (cached)');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200);
  });
}
