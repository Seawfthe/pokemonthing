/* ==========================================================================
   HoloDex · API layer
   - Pokémon TCG API client (direct or through the local caching proxy)
   - retry / backoff because the public API flakes now and then
   - localStorage cache with TTL so repeat searches are instant
   - price normalisation for TCGplayer (USD), Cardmarket (EUR),
     SNKRDUNK (JPY) and SNKRDUNK match lookup through the local server
   ========================================================================== */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var DIRECT_BASE = 'https://api.pokemontcg.io/v2';
  var BASE = String(CFG.apiBase || DIRECT_BASE).replace(/\/+$/, '');
  var PROXY = Boolean(CFG.proxy);
  var SNKRDUNK = Boolean(CFG.snkrdunk);
  var SITE_CONFIG = Boolean(CFG.siteConfig);
  var TRANSLATE = PROXY && CFG.translate !== false;

  /* Live FX rates (USD base). Updated from /api/fx; fallback values offline. */
  var FX = {
    hkdPerUsd: 7.8,
    hkdPerEur: 8.7,
    jpyPerUsd: 150,
    source: 'fallback',
    provider: 'built-in',
    fetchedAt: null
  };

  var CACHE_PREFIX = 'holodex.cache.';
  var CACHE_INDEX_KEY = 'holodex.cache.index';
  var mem = Object.create(null);

  var CARD_SELECT = 'id,name,number,rarity,supertype,types,images,set,tcgplayer,cardmarket';
  var SETS_SELECT = 'id,name,series,releaseDate,printedTotal,total,images';

  var sleep = function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  };

  /* ---------------------------------------------------------------- errors */
  function ApiError(code, message, status) {
    this.name = 'ApiError';
    this.code = code;
    this.message = message || 'Something went wrong.';
    this.status = status || 0;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  /* ---------------------------------------------------------------- cache */
  function readLocal(key) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.at !== 'number') return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function readCache(key, maxAge) {
    var hit = mem[key];
    if (hit && Date.now() - hit.at < maxAge) return hit.value;
    var local = readLocal(key);
    if (local && Date.now() - local.at < maxAge) {
      mem[key] = local;
      return local.value;
    }
    return null;
  }

  function writeCache(key, value, maxAge) {
    mem[key] = { at: Date.now(), value: value, maxAge: maxAge };
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), value: value }));
      var index = JSON.parse(localStorage.getItem(CACHE_INDEX_KEY) || '{}');
      index[key] = Date.now();
      localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
    } catch (err) {
      pruneCache();
    }
  }

  function cacheKeys() {
    try {
      return Object.keys(JSON.parse(localStorage.getItem(CACHE_INDEX_KEY) || '{}'));
    } catch (err) {
      return [];
    }
  }

  function pruneCache() {
    var keys = cacheKeys().sort(function (a, b) {
      var ia = JSON.parse(localStorage.getItem(CACHE_INDEX_KEY) || '{}');
      return (ia[a] || 0) - (ia[b] || 0);
    });
    var drop = keys.slice(0, Math.ceil(keys.length / 2));
    drop.forEach(function (k) { localStorage.removeItem(CACHE_PREFIX + k); });
    try {
      var index = JSON.parse(localStorage.getItem(CACHE_INDEX_KEY) || '{}');
      drop.forEach(function (k) { delete index[k]; });
      localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
    } catch (err) { /* ignore */ }
  }

  function clearCache() {
    mem = Object.create(null);
    var keys = cacheKeys();
    keys.forEach(function (k) { localStorage.removeItem(CACHE_PREFIX + k); });
    try { localStorage.removeItem(CACHE_INDEX_KEY); } catch (err) { /* ignore */ }
    // Also nuke anything we wrote that the index forgot about.
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(k);
      }
    } catch (err) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- key */
  function getApiKey() {
    try { return localStorage.getItem('holodex.apikey') || ''; } catch (err) { return ''; }
  }

  function setApiKey(value) {
    try {
      if (value) localStorage.setItem('holodex.apikey', value);
      else localStorage.removeItem('holodex.apikey');
    } catch (err) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- fetch */
  function buildUrl(path, params) {
    var qs = new URLSearchParams();
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === '') return;
      qs.set(key, value);
    });
    var query = qs.toString();
    return BASE + path + (query ? (path.indexOf('?') === -1 ? '?' : '&') + query : '');
  }

  function request(path, params, opts) {
    opts = opts || {};
    var url = buildUrl(path, params);
    var maxAge = opts.maxAge === undefined ? 5 * 60 * 1000 : opts.maxAge;
    var cacheKey = 'api:' + url;
    var cached = readCache(cacheKey, maxAge);
    if (cached) return Promise.resolve(cached);

    var maxAttempts = opts.retries === undefined ? 5 : opts.retries;

    function attempt(n) {
      var headers = { Accept: 'application/json' };
      var key = getApiKey();
      if (key && !PROXY) headers['X-Api-Key'] = key;

      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 30000) : null;

      return fetch(url, {
        headers: headers,
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      }).then(function (res) {
        if (timer) clearTimeout(timer);
        if (res.ok) {
          return res.json().then(function (data) {
            writeCache(cacheKey, data, maxAge);
            return data;
          });
        }
        var retriable = res.status === 429 || res.status >= 500;
        if (retriable && n < maxAttempts) {
          var wait = res.status === 429 ? 1400 + n * 900 : 320 * Math.pow(2, n) + Math.random() * 240;
          return sleep(wait).then(function () { return attempt(n + 1); });
        }
        if (res.status === 400) throw new ApiError('badquery', 'That search syntax was rejected. Try a simpler term.', 400);
        if (res.status === 404) throw new ApiError('notfound', 'That card was not found.', 404);
        if (res.status === 401 || res.status === 403) throw new ApiError('auth', 'The API key was rejected.', res.status);
        if (res.status === 429) throw new ApiError('ratelimit', 'Hit the API rate limit. Wait a moment, or add a free API key in settings.', 429);
        throw new ApiError('server', 'The card API is having a moment (HTTP ' + res.status + ').', res.status);
      }, function (err) {
        if (timer) clearTimeout(timer);
        if (n < maxAttempts) {
          return sleep(400 * Math.pow(2, n) + Math.random() * 250).then(function () { return attempt(n + 1); });
        }
        throw new ApiError('network', 'Could not reach the card API. Check your connection.', 0);
      });
    }

    return attempt(0);
  }

  /* ---------------------------------------------------------------- fx + site config */
  function setFx(rates) {
    if (!rates) return FX;
    var hkdPerUsd = Number(rates.hkdPerUsd);
    var hkdPerEur = Number(rates.hkdPerEur);
    if (isFinite(hkdPerUsd) && hkdPerUsd > 0) {
      var jpyPerUsd = Number(rates.jpyPerUsd);
      FX = {
        hkdPerUsd: hkdPerUsd,
        hkdPerEur: (isFinite(hkdPerEur) && hkdPerEur > 0) ? hkdPerEur : hkdPerUsd / 0.9,
        jpyPerUsd: (isFinite(jpyPerUsd) && jpyPerUsd > 0) ? jpyPerUsd : 150,
        source: rates.source || 'live',
        provider: rates.provider || 'server',
        fetchedAt: rates.fetchedAt || null
      };
    }
    return FX;
  }

  function getFx() { return FX; }

  function fetchJson(url) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 12000) : null;
    return fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) return null;
      return res.json();
    }).catch(function () {
      if (timer) clearTimeout(timer);
      return null;
    });
  }

  function getFxRates() {
    if (!PROXY) return Promise.resolve(FX);
    return fetchJson('/api/fx?_=' + Date.now()).then(function (data) {
      return data ? setFx(data) : FX;
    });
  }

  function getSiteConfig() {
    if (!SITE_CONFIG) return Promise.resolve(null);
    return fetchJson('/api/site-config?_=' + Date.now());
  }

  function getSiteCards() {
    if (!SITE_CONFIG) return Promise.resolve(null);
    return fetchJson('/api/site-cards?_=' + Date.now());
  }

  /* ---------------------------------------------------------------- japanese sets */
  function getJpSets() {
    if (!PROXY) return Promise.resolve({ ok: false, sets: [] });
    return fetchJson('/api/jp/sets').then(function (data) {
      return data && Array.isArray(data.sets) ? data : { ok: false, sets: [] };
    });
  }

  function getJpSet(code) {
    if (!PROXY || !code) return Promise.resolve(null);
    return fetchJson('/api/jp/set?code=' + encodeURIComponent(code));
  }

  function getJpCard(id) {
    if (!PROXY || !id) return Promise.resolve(null);
    return fetchJson('/api/jp/card?id=' + encodeURIComponent(id));
  }

  /**
   * Japanese card search (JP-first storefront). Always resolves to
   * `{ ok, cards: [...] }` so the UI never has to null-check twice.
   */
  function getJpSearch(term, page) {
    var query = String(term === null || term === undefined ? '' : term).trim();
    if (!PROXY || !query) return Promise.resolve({ ok: false, cards: [] });
    var pageNumber = Number(page);
    if (!isFinite(pageNumber) || pageNumber < 1) pageNumber = 1;
    return fetchJson('/api/jp/cards?q=' + encodeURIComponent(query) +
      '&page=' + Math.floor(pageNumber) + '&pageSize=60').then(function (data) {
      return data && data.ok && Array.isArray(data.cards) ? data : { ok: false, cards: [] };
    });
  }

  /** Featured / most valuable Japanese chase cards (SNKRDUNK JPY). */
  function getJpFeatured() {
    if (!PROXY) return Promise.resolve({ ok: false, cards: [] });
    return fetchJson('/api/jp/featured').then(function (data) {
      return data && data.ok && Array.isArray(data.cards) ? data : { ok: false, cards: [] };
    });
  }

  function overrideFor(card, overrides) {
    if (!card || !overrides) return null;
    if (!Object.prototype.hasOwnProperty.call(overrides, card.id)) return null;
    var value = overrides[card.id];
    if (value === null || value === undefined) return null;
    var number = Number(value);
    return isFinite(number) && number > 0 ? number : null;
  }

  function applyOverrides(cards, overrides) {
    (cards || []).forEach(function (card) {
      var value = overrideFor(card, overrides);
      if (value !== null) card.sitePriceHKD = value;
    });
    return cards;
  }

  /* ---------------------------------------------------------------- query */
  var ALIASES = {
    'moonbreon': 'umbreon vmax',
    'moon kitty': 'umbreon vmax',
    'bubble mew': 'mew ex',
    'base zard': 'charizard',
    'base set zard': 'charizard',
    'sunbreon': 'umbreon ex',
    'rayray': 'rayquaza'
  };

  function sanitizeTerm(term) {
    return String(term || '')
      .replace(/[:"()\[\]{}~^\\\/!+]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function buildQuery(query) {
    var parts = [];
    var term = sanitizeTerm(query.term);
    if (term) {
      var alias = ALIASES[term.toLowerCase()];
      if (alias) term = alias;
      term.split(' ').filter(Boolean).slice(0, 6).forEach(function (token) {
        parts.push('name:*' + token + '*');
      });
    }
    if (query.setId) parts.push('set.id:' + String(query.setId).replace(/[^a-z0-9.-]/gi, ''));
    if (query.rarity) parts.push('rarity:"' + sanitizeTerm(query.rarity) + '"');
    if (query.type) parts.push('types:' + sanitizeTerm(query.type));
    if (query.supertype) parts.push('supertype:"' + sanitizeTerm(query.supertype) + '"');
    return parts.join(' ');
  }

  /* ---------------------------------------------------------------- public */
  function searchCards(query, opts) {
    var q = buildQuery(query);
    if (!q) return Promise.resolve({ data: [], page: 1, pageSize: 0, count: 0, totalCount: 0 });
    return request('/cards', {
      q: q,
      page: query.page || 1,
      pageSize: query.pageSize || 60,
      select: CARD_SELECT
    }, { maxAge: opts && opts.maxAge !== undefined ? opts.maxAge : 5 * 60 * 1000, retries: 5 });
  }

  function getCard(id, opts) {
    opts = opts || {};
    return request('/cards/' + encodeURIComponent(id), {}, {
      maxAge: opts.maxAge || 15 * 60 * 1000,
      retries: opts.retries === undefined ? 5 : opts.retries
    }).then(function (res) {
      return res && res.data ? res.data : res;
    });
  }

  var setsPromise = null;
  function getSets() {
    if (setsPromise) return setsPromise;
    setsPromise = request('/sets', { select: SETS_SELECT }, { maxAge: 24 * 60 * 60 * 1000 }).then(function (res) {
      var sets = (res && res.data) || [];
      return sets.slice().sort(function (a, b) {
        return String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''));
      });
    }).catch(function (err) {
      setsPromise = null;
      throw err;
    });
    return setsPromise;
  }

  function getCardsByIds(ids) {
    var results = [];
    var queue = ids.slice();
    var concurrency = 4;

    function worker() {
      if (!queue.length) return Promise.resolve();
      var id = queue.shift();
      return getCard(id, { retries: 3 }).then(function (card) {
        if (card) results.push(card);
      }).catch(function () { /* skip failed card */ }).then(worker);
    }

    var workers = [];
    for (var i = 0; i < concurrency; i++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  function getSnkrdunk(card) {
    if (!SNKRDUNK || !card || !card.set) return Promise.resolve(null);
    var cacheKey = 'snk:' + card.id;
    var cached = readCache(cacheKey, 30 * 60 * 1000);
    if (cached) return Promise.resolve(cached);

    var params = new URLSearchParams({
      cardId: card.id,
      name: card.name || '',
      number: card.number || '',
      total: String((card.set && card.set.printedTotal) || (card.set && card.set.total) || ''),
      set: (card.set && card.set.name) || '',
      releaseDate: (card.set && card.set.releaseDate) || ''
    });

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 40000) : null;

    return fetch('/api/snkrdunk/card?' + params.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (data) writeCache(cacheKey, data, 30 * 60 * 1000);
      return data;
    }).catch(function () {
      if (timer) clearTimeout(timer);
      return null;
    });
  }

  /* ---------------------------------------------------------------- prices */
  var VARIANT_ORDER = [
    '1stEditionHolofoil', '1stEditionNormal', 'holofoil', 'normal',
    'reverseHolofoil', 'unlimitedHolofoil', 'unlimited', 'holo', 'reverseHolo'
  ];

  function variantRank(key) {
    var index = VARIANT_ORDER.indexOf(key);
    return index === -1 ? 50 : index;
  }

  function variantLabel(key) {
    var map = {
      normal: 'Normal',
      holofoil: 'Holofoil',
      reverseHolofoil: 'Reverse Holofoil',
      '1stEditionHolofoil': '1st Edition Holofoil',
      '1stEditionNormal': '1st Edition Normal',
      unlimitedHolofoil: 'Unlimited Holofoil',
      unlimited: 'Unlimited',
      holo: 'Holo',
      reverseHolo: 'Reverse Holo'
    };
    if (map[key]) return map[key];
    return String(key)
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, function (c) { return c.toUpperCase(); })
      .trim();
  }

  function usdInfo(card) {
    var tp = card && card.tcgplayer;
    var prices = tp && tp.prices;
    if (!prices) return null;
    var keys = Object.keys(prices).filter(function (key) {
      var p = prices[key];
      return p && (p.market || p.mid || p.low || p.high);
    });
    if (!keys.length) return null;
    keys.sort(function (a, b) { return variantRank(a) - variantRank(b) || a.localeCompare(b); });
    var key = keys[0];
    var p = prices[key];
    return {
      variant: key,
      label: variantLabel(key),
      market: p.market || p.mid || p.low || null,
      low: p.low || null,
      mid: p.mid || null,
      high: p.high || null,
      directLow: p.directLow || null,
      url: tp.url || null,
      updatedAt: tp.updatedAt || null
    };
  }

  function usdVariants(card) {
    var tp = card && card.tcgplayer;
    var prices = tp && tp.prices;
    if (!prices) return [];
    return Object.keys(prices).map(function (key) {
      var p = prices[key] || {};
      return {
        key: key,
        label: variantLabel(key),
        market: p.market || null,
        low: p.low || null,
        mid: p.mid || null,
        high: p.high || null,
        directLow: p.directLow || null
      };
    }).sort(function (a, b) { return variantRank(a.key) - variantRank(b.key); });
  }

  function eurInfo(card) {
    var cm = card && card.cardmarket;
    var p = cm && cm.prices;
    if (!p) return null;
    var trend = p.trendPrice || p.averageSellPrice || null;
    if (!trend) return null;
    return {
      trend: p.trendPrice || null,
      avg: p.averageSellPrice || null,
      low: p.lowPrice || null,
      lowEx: p.lowPriceExPlus || null,
      avg1: p.avg1 || null,
      avg7: p.avg7 || null,
      avg30: p.avg30 || null,
      reverseSell: p.reverseHoloSell || null,
      reverseLow: p.reverseHoloLow || null,
      reverseTrend: p.reverseHoloTrend || null,
      reverseAvg1: p.reverseHoloAvg1 || null,
      reverseAvg7: p.reverseHoloAvg7 || null,
      reverseAvg30: p.reverseHoloAvg30 || null,
      url: cm.url || null,
      updatedAt: cm.updatedAt || null
    };
  }

  function maxUsd(card) {
    var prices = (card && card.tcgplayer && card.tcgplayer.prices) || {};
    var best = 0;
    Object.keys(prices).forEach(function (key) {
      var p = prices[key];
      var value = p && (p.market || p.mid || p.low);
      if (value && value > best) best = value;
    });
    return best;
  }

  function maxEur(card) {
    var info = eurInfo(card);
    if (!info) return 0;
    return Math.max(info.trend || 0, info.avg || 0);
  }

  function sitePriceHKD(card) {
    var value = card && card.sitePriceHKD;
    if (value === null || value === undefined) return null;
    var number = Number(value);
    return isFinite(number) && number > 0 ? number : null;
  }

  /* Japanese prints carry a single SNKRDUNK asking price in JPY. */
  function jpPriceJPY(card) {
    var value = card && card.jpPriceJPY;
    if (value === null || value === undefined) return null;
    var number = Number(value);
    return isFinite(number) && number > 0 ? number : null;
  }

  /**
   * Convert a JPY asking price into a display currency. USD/HKD/EUR go through
   * the live FX rates (USD base); anything else falls back to USD.
   */
  function jpyTo(currency, jpy) {
    var amount = Number(jpy);
    if (!isFinite(amount) || amount <= 0) return null;
    if (currency === 'JPY') return amount;
    var usd = amount / (FX.jpyPerUsd || 150);
    if (currency === 'HKD') return usd * FX.hkdPerUsd;
    if (currency === 'EUR') return usd * FX.hkdPerUsd / FX.hkdPerEur;
    return usd;
  }

  function priceValue(card, currency) {
    var custom = sitePriceHKD(card);
    if (custom !== null) {
      if (currency === 'HKD') return custom;
      if (currency === 'EUR') return custom / FX.hkdPerEur;
      return custom / FX.hkdPerUsd;
    }
    var jp = jpPriceJPY(card);
    if (jp !== null) return jpyTo(currency, jp);
    if (currency === 'HKD') {
      var usdInfoLocal = usdInfo(card);
      if (usdInfoLocal && usdInfoLocal.market) return usdInfoLocal.market * FX.hkdPerUsd;
      var eurInfoLocal = eurInfo(card);
      if (eurInfoLocal && eurInfoLocal.trend) return eurInfoLocal.trend * FX.hkdPerEur;
      return null;
    }
    if (currency === 'EUR') {
      var eur = eurInfo(card);
      return eur ? (eur.trend || eur.avg || null) : null;
    }
    var usd = usdInfo(card);
    return usd ? usd.market : null;
  }

  function priceLabel(card, currency) {
    if (sitePriceHKD(card) !== null) return 'custom';
    if (jpPriceJPY(card) !== null) return 'SNKRDUNK';
    if (currency === 'HKD') return 'converted';
    if (currency === 'EUR') return 'trend';
    var usd = usdInfo(card);
    return usd ? usd.label.toLowerCase() : '';
  }

  function priceLow(card, currency) {
    if (sitePriceHKD(card) !== null) return null;
    if (jpPriceJPY(card) !== null) return null;
    if (currency === 'HKD') {
      var usdForLow = usdInfo(card);
      if (usdForLow && usdForLow.low) return usdForLow.low * FX.hkdPerUsd;
      var eurForLow = eurInfo(card);
      if (eurForLow && eurForLow.low) return eurForLow.low * FX.hkdPerEur;
      return null;
    }
    if (currency === 'EUR') {
      var eur = eurInfo(card);
      return eur ? eur.low : null;
    }
    var usd = usdInfo(card);
    return usd ? usd.low : null;
  }

  /* ---------------------------------------------------------------- format */
  var formatters = {};
  function money(value, currency) {
    if (value === null || value === undefined || isNaN(Number(value))) return '—';
    var number = Number(value);
    if (currency === 'JPY') {
      return '¥' + Math.round(number).toLocaleString('en-US');
    }
    var code = currency === 'HKD' ? 'HKD' : currency === 'EUR' ? 'EUR' : 'USD';
    if (!formatters[code]) {
      formatters[code] = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    }
    return formatters[code].format(number);
  }

  function compactMoney(value, currency) {
    if (value === null || value === undefined || isNaN(Number(value))) return '—';
    var number = Number(value);
    if (number >= 10000) {
      var rounded = Math.round(number / 100) / 10;
      return money(rounded * 1000, currency);
    }
    return money(number, currency);
  }

  function formatDate(value) {
    if (!value) return '—';
    var text = String(value).replace(/\//g, '-');
    var parts = text.split(/[-T ]/);
    if (parts.length >= 3) {
      var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      }
    }
    var parsed = new Date(value);
    return isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function shortDate(value) {
    if (!value) return '';
    var text = String(value).replace(/\//g, '-');
    var parts = text.split(/[-T ]/);
    if (parts.length >= 3) {
      var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      }
    }
    return '';
  }

  /* ---------------------------------------------------------------- translation */
  var TR_MAX_TEXTS = 40;
  var trMem = Object.create(null);

  function normalizeTrLang(value) {
    return value === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  }

  function normalizeTrSource(value) {
    return value === 'ja' ? 'ja' : value === 'en' ? 'en' : 'auto';
  }

  function trKey(text, to, from) {
    return from + '\u0000' + to + '\u0000' + text;
  }

  function cachedTranslation(text, to, from) {
    var key = trKey(text, to, from);
    return Object.prototype.hasOwnProperty.call(trMem, key) ? trMem[key] : null;
  }

  /**
   * Japanese (or English) → Chinese translation through the local server (which
   * caches on disk). Returns an array aligned with the input, or null when the
   * API is unavailable (static mode, server down, upstream blocked).
   *
   * opts: { to: 'zh-CN' | 'zh-TW', from: 'ja' | 'en' | 'auto' }
   */
  function translateTexts(texts, opts) {
    var to = normalizeTrLang(opts && opts.to);
    var from = normalizeTrSource(opts && opts.from);
    var input = (texts || []).map(function (raw) {
      return String(raw === null || raw === undefined ? '' : raw);
    });

    var collect = function () {
      return input.map(function (text) {
        var trimmed = text.trim();
        if (!trimmed) return '';
        var hit = cachedTranslation(trimmed, to, from);
        return hit === null ? '' : hit;
      });
    };

    if (!TRANSLATE) return Promise.resolve(null);

    var unique = [];
    var seen = Object.create(null);
    input.forEach(function (text) {
      var trimmed = text.trim();
      if (!trimmed || seen[trimmed]) return;
      seen[trimmed] = true;
      unique.push(trimmed);
    });
    if (!unique.length) return Promise.resolve(collect());

    var missing = unique.filter(function (text) { return cachedTranslation(text, to, from) === null; });
    if (!missing.length) return Promise.resolve(collect());

    function requestBatch(batch) {
      return fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ texts: batch, to: to, from: from }),
        cache: 'no-store'
      }).then(function (res) {
        if (!res.ok) throw new Error('Translation HTTP ' + res.status);
        return res.json();
      }).then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.translations)) {
          throw new Error((data && data.error) || 'Translation failed');
        }
        batch.forEach(function (text, index) {
          var value = data.translations[index];
          if (typeof value === 'string' && value) trMem[trKey(text, to, from)] = value;
        });
      });
    }

    // The server caps batches at 40 strings; send the rest after each chunk.
    var chain = Promise.resolve();
    for (var offset = 0; offset < missing.length; offset += TR_MAX_TEXTS) {
      (function (chunk) {
        chain = chain.then(function () { return requestBatch(chunk); });
      })(missing.slice(offset, offset + TR_MAX_TEXTS));
    }
    return chain.then(collect).catch(function () { return null; });
  }

  function translateText(text, opts) {
    return translateTexts([text], opts).then(function (list) {
      return list && list.length ? list[0] : null;
    });
  }

  function clearTranslationCache() {
    trMem = Object.create(null);
  }

  window.PDXApi = {
    proxy: PROXY,
    snkrdunk: SNKRDUNK,
    siteConfig: SITE_CONFIG,
    canTranslate: TRANSLATE,
    translate: translateText,
    translateTexts: translateTexts,
    clearTranslationCache: clearTranslationCache,
    getFxRates: getFxRates,
    setFx: setFx,
    getFx: getFx,
    getSiteConfig: getSiteConfig,
    getSiteCards: getSiteCards,
    getJpSets: getJpSets,
    getJpSet: getJpSet,
    getJpCard: getJpCard,
    getJpSearch: getJpSearch,
    getJpFeatured: getJpFeatured,
    applyOverrides: applyOverrides,
    searchCards: searchCards,
    getCard: getCard,
    getSets: getSets,
    getCardsByIds: getCardsByIds,
    getSnkrdunk: getSnkrdunk,
    buildQuery: buildQuery,
    getApiKey: getApiKey,
    setApiKey: setApiKey,
    clearCache: clearCache,
    ApiError: ApiError
  };

  window.PDXPrice = {
    usdInfo: usdInfo,
    usdVariants: usdVariants,
    eurInfo: eurInfo,
    maxUsd: maxUsd,
    maxEur: maxEur,
    priceValue: priceValue,
    priceLabel: priceLabel,
    priceLow: priceLow,
    jpPriceJPY: jpPriceJPY,
    jpyTo: jpyTo,
    sitePriceHKD: sitePriceHKD,
    getFx: getFx,
    setFx: setFx,
    variantLabel: variantLabel,
    money: money,
    compactMoney: compactMoney,
    formatDate: formatDate,
    shortDate: shortDate
  };
})();
