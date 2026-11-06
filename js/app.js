/* ==========================================================================
   HoloDex · app controller
   Search, filters, home page, card detail modal, binder drawer, settings.
   Vanilla JS, no build step.
   ========================================================================== */
(function () {
  'use strict';

  var Api = window.PDXApi;
  var Price = window.PDXPrice;
  var Store = window.PDXStore;

  /* ------------------------------------------------------------------ constants */
  var FEATURED_IDS = [
    'swsh7-215', 'swsh7-218', 'swsh8-271', 'base1-4', 'swsh11-186',
    'swsh12-186', 'sv3pt5-199', 'sv8-238', 'sv4pt5-234', 'swsh8-269',
    'swsh4-188', 'sm12-251', 'sv3-223'
  ];

  var POPULAR_SETS = [
    'sv8', 'sv8pt5', 'sv3pt5', 'sv3', 'swsh7', 'swsh12pt5',
    'swsh8', 'swsh11', 'swsh12', 'base1'
  ];

  var SORT_VALUES = ['value-desc', 'value-asc', 'newest', 'oldest', 'name'];
  var JP_SORT_VALUES = ['price-desc', 'price-asc', 'number', 'name'];
  var PAGE_SIZE = 60;

  /* The storefront is Japanese-first: the home page, search and binder all show
     Japanese printings. English mode stays available from the header toggle. */
  var JP_QUICK_CHIPS = [
    { q: 'リザードン' }, { q: 'ピカチュウ' }, { q: 'ミュウ' }, { q: 'ブラッキー' },
    { jp: 'M2a' }, { jp: 'SV2a' }, { jp: 'S12a' }
  ];
  var EN_QUICK_CHIPS = [
    { q: 'Moonbreon' }, { q: 'Charizard ex' }, { q: 'Pikachu' },
    { set: 'sv3pt5', label: '151' }, { set: 'base1', label: 'Base Set' }, { set: 'swsh7', label: 'Evolving Skies' }
  ];

  /* Static page copy that flips with the header language toggle. Japanese mode
     is the storefront default; English mode keeps the original TCG API pitch. */
  var LANG_COPY = {
    ja: {
      badge: 'JP CARDS · LIVE PRICES',
      eyebrow: '<span class="live-dot" aria-hidden="true"></span> Japanese card market <span class="eyebrow-extra">· TCGdex scans &amp; SNKRDUNK JPY</span>',
      title: 'Japanese cards.<br /><span class="grad-text hero-grad">Every market.</span>',
      sub: 'Search the Japanese card index by its Japanese name — TCGdex scans, set codes, and live SNKRDUNK asking prices in JPY, converted to your currency.',
      placeholder: 'Search a Japanese card — 「リザードン」… or a set code like “M2a”',
      aria: 'Search Japanese Pokémon cards',
      setsTitle: 'Browse Japanese sets',
      features: [
        ['Japanese names, Japanese scans', 'Card names, attacks and flavour text come straight from TCGdex in Japanese — with the Japanese print scan for each card, not the English one.'],
        ['SNKRDUNK, in JPY', 'Live asking prices from Japan’s biggest card marketplace — shown in yen, with USD / HKD / EUR conversion at the top of the page.'],
        ['Binder that adds up', 'Drop Japanese cards into your binder, adjust quantities, and watch the total move with the market. Exports to JSON whenever you want it.']
      ]
    },
    en: {
      badge: 'LIVE PRICES',
      eyebrow: '<span class="live-dot" aria-hidden="true"></span> Live market data <span class="eyebrow-extra">· TCGplayer &amp; Cardmarket &amp; SNKRDUNK</span>',
      title: 'Every card.<br /><span class="grad-text hero-grad">Every market.</span>',
      sub: 'Search thousands of Pokémon cards, compare real prices from three marketplaces, and keep a running value on the cards you actually own.',
      placeholder: 'Search a card — “Moonbreon”, “Charizard ex”… or a set code',
      aria: 'Search Pokémon cards',
      setsTitle: 'Browse by set',
      features: [
        ['Three markets, one page', 'TCGplayer market prices in USD, Cardmarket trend data in EUR, and live SNKRDUNK listings in JPY — side by side on every card.'],
        ['Every variant priced', 'Normal, holofoil, reverse holo, 1st edition — each printing gets its own row so you know what the exact card in your hand is worth.'],
        ['Binder that adds up', 'Drop cards into your binder, adjust quantities, and watch the total move with the market. Exports to JSON whenever you want it.']
      ]
    }
  };

  function applyCopy() {
    var copy = LANG_COPY[isJa() ? 'ja' : 'en'];
    var badge = document.getElementById('brand-badge');
    if (badge) badge.textContent = copy.badge;
    var eyebrow = document.getElementById('hero-eyebrow');
    if (eyebrow) eyebrow.innerHTML = copy.eyebrow;
    var title = document.getElementById('hero-title');
    if (title) title.innerHTML = copy.title;
    var sub = document.getElementById('hero-sub');
    if (sub) sub.textContent = copy.sub;
    if (els['search-input']) {
      els['search-input'].placeholder = copy.placeholder;
      els['search-input'].setAttribute('aria-label', copy.aria);
    }
    var setsTitle = document.getElementById('sets-title');
    if (setsTitle) setsTitle.textContent = copy.setsTitle;
    copy.features.forEach(function (pair, index) {
      var card = document.getElementById('feature-' + (index + 1));
      if (!card) return;
      var heading = card.querySelector('h3');
      if (heading) heading.textContent = pair[0];
      var text = card.querySelector('p');
      if (text) text.textContent = pair[1];
    });
  }
  var PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 245 342">' +
    '<rect width="245" height="342" fill="#0c0f1a"/>' +
    '<g fill="none" stroke="#3b4262" stroke-width="2">' +
    '<circle cx="122" cy="171" r="46"/><path d="M76 171h92"/>' +
    '<circle cx="122" cy="171" r="16"/></g>' +
    '<text x="122" y="248" font-family="system-ui" font-size="13" fill="#565d7a" text-anchor="middle">no image</text></svg>'
  );

  /* ------------------------------------------------------------------ dom */
  var els = {};
  function cacheEls() {
    [
      'search-form', 'search-input', 'btn-search-submit', 'quick-chips', 'hero-note',
      'currency-toggle', 'lang-toggle', 'btn-binder', 'binder-count', 'btn-settings',
      'home-view', 'featured-grid', 'featured-meta', 'featured-title', 'featured-sub',
      'set-strip', 'sets-section', 'sets-sub', 'empty-message', 'footer-admin',
      'jp-view', 'jp-title', 'jp-sub', 'jp-kicker', 'jp-meta', 'jp-banner', 'jp-status',
      'jp-grid', 'jp-sort', 'jp-priced-toggle', 'jp-snkr-link', 'btn-jp-back',
      'btn-jp-load-more', 'jp-load-more-wrap', 'jp-load-note', 'jp-empty', 'jp-error',
      'jp-error-message', 'btn-jp-retry', 'btn-jp-reset-filter',
      'results-view', 'results-title', 'results-sub', 'btn-back-home',
      'sort-select', 'set-select', 'rarity-select', 'type-select', 'filter-chips',
      'filters', 'btn-clear-filters', 'result-status', 'results-grid',
      'empty-state', 'error-state', 'error-message', 'btn-retry', 'btn-error-settings',
      'btn-empty-clear', 'load-more-wrap', 'btn-load-more', 'load-more-note',
      'card-modal', 'modal-body',
      'binder-drawer', 'binder-list', 'binder-total-value', 'binder-total-note',
      'btn-binder-refresh', 'btn-binder-copy', 'btn-binder-export', 'btn-binder-clear',
      'settings-modal', 'apikey-input', 'btn-save-key', 'btn-clear-key',
      'btn-clear-cache', 'settings-mode', 'zh-lang', 'footer-mode', 'toasts'
    ].forEach(function (id) {
      els[id] = document.getElementById(id);
    });
    els.supertypeChips = Array.prototype.slice.call(document.querySelectorAll('[data-supertype]'));
  }

  /* ------------------------------------------------------------------ state */
  var state = {
    view: 'home',
    lang: 'ja',
    term: '', setId: '', rarity: '', type: '', supertype: '',
    sort: 'value-desc',
    currency: Store.getCurrency(),
    page: 1,
    cards: [],
    total: 0,
    loading: false,
    loadingMore: false,
    error: null,
    reqId: 0,
    sets: [],
    setsById: {},
    setsLoaded: false,
    featured: [],
    currentCard: null,
    modalSnapshot: null,
    detailCache: {},
    snkrCache: {},
    pendingSetFilter: '',
    dataMode: 'live',
    siteConfig: null,
    siteUpdatedAt: null,
    overrides: {},
    curatedCards: [],
    curatedMatches: 0,
    fx: null,
    jpSets: [],
    jpCode: null,
    jpSeq: 0,
    jp: null,
    currentJp: null,
    zh: false,
    zhLang: 'zh-CN',
    zhBusy: 0,
    jpFeatured: [],
    jpFeaturedAt: null,
    jpResults: { term: '', cards: [], page: 1, hasMore: false, loading: false, loadingMore: false, error: null, reqId: 0 },
    currentJpPayload: null
  };

  var knownJp = new Map();

  function isJa() {
    return state.lang === 'ja' && Boolean(Api.proxy);
  }

  var knownCards = new Map();
  var debounceTimer = null;
  var lastFocused = null;
  var clearBinderTimer = null;

  /* ------------------------------------------------------------------ utils */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function qtyLabel(n) {
    return n + (n === 1 ? ' card' : ' cards');
  }

  function activeSearch() {
    return Boolean(state.term || state.setId || state.rarity || state.type || state.supertype);
  }

  function setById(id) {
    return state.setsById[id] || null;
  }

  function setName(id) {
    var set = setById(id);
    return set ? set.name : id;
  }

  function releaseYear(set) {
    if (!set || !set.releaseDate) return '';
    var match = String(set.releaseDate).match(/(\d{4})/);
    return match ? match[1] : '';
  }

  function sortCards(cards) {
    var list = cards.slice();
    var value = function (card) {
      var v = Price.priceValue(card, state.currency);
      return v === null || v === undefined ? -1 : Number(v);
    };
    var nameCmp = function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); };
    switch (state.sort) {
      case 'value-asc':
        list.sort(function (a, b) { return value(a) - value(b) || nameCmp(a, b); });
        break;
      case 'newest':
        list.sort(function (a, b) {
          return String((b.set && b.set.releaseDate) || '').localeCompare(String((a.set && a.set.releaseDate) || '')) || nameCmp(a, b);
        });
        break;
      case 'oldest':
        list.sort(function (a, b) {
          return String((a.set && a.set.releaseDate) || '').localeCompare(String((b.set && b.set.releaseDate) || '')) || nameCmp(a, b);
        });
        break;
      case 'name':
        list.sort(nameCmp);
        break;
      default:
        list.sort(function (a, b) { return value(b) - value(a) || nameCmp(a, b); });
    }
    return list;
  }

  function toast(message, kind) {
    var node = document.createElement('div');
    node.className = 'toast toast--' + (kind || 'info');
    node.innerHTML = '<span class="toast-dot" aria-hidden="true"></span><span>' + esc(message) + '</span>';
    els.toasts.appendChild(node);
    while (els.toasts.children.length > 3) els.toasts.removeChild(els.toasts.firstElementChild);
    setTimeout(function () {
      node.classList.add('is-leaving');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 260);
    }, 2800);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  /* ------------------------------------------------------------- decorated data */
  function decorateCard(card) {
    if (!card) return card;
    if (Object.prototype.hasOwnProperty.call(state.overrides, card.id)) {
      var value = state.overrides[card.id];
      card.sitePriceHKD = value === null || value === undefined ? null : Number(value);
    }
    return card;
  }

  function decorateAll(cards) {
    return (cards || []).map(function (card) { return decorateCard(card); });
  }

  function decoratedBinder() {
    return Store.getBinder().map(function (entry) { return decorateCard(entry); });
  }

  function binderTotals(entries, currency) {
    var total = 0;
    var priced = 0;
    var missing = 0;
    var count = 0;
    (entries || []).forEach(function (entry) {
      count += entry.qty || 1;
      var value = Price.priceValue(entry, currency);
      if (value === null || value === undefined) {
        missing += 1;
      } else {
        total += Number(value) * (entry.qty || 1);
        priced += entry.qty || 1;
      }
    });
    return { total: total, count: count, priced: priced, missing: missing };
  }

  /* ------------------------------------------------------------------ overlays */
  function lockScroll(locked) {
    document.body.classList.toggle('is-locked', locked);
  }

  function openOverlay(id) {
    var overlay = document.getElementById(id);
    if (!overlay) return;
    lastFocused = document.activeElement;
    overlay.hidden = false;
    requestAnimationFrame(function () { overlay.classList.add('is-open'); });
    lockScroll(true);
    var focusTarget = overlay.querySelector('.modal, .drawer');
    if (focusTarget) setTimeout(function () { focusTarget.focus(); }, 30);
  }

  function closeOverlay(id) {
    var overlay = document.getElementById(id);
    if (!overlay || overlay.hidden) return;
    overlay.classList.remove('is-open');
    setTimeout(function () {
      overlay.hidden = true;
      var anyOpen = ['card-modal', 'binder-drawer', 'settings-modal'].some(function (key) {
        var node = document.getElementById(key);
        return node && !node.hidden;
      });
      if (!anyOpen) lockScroll(false);
    }, 220);
    if (lastFocused && typeof lastFocused.focus === 'function') {
      setTimeout(function () { lastFocused.focus(); }, 230);
    }
  }

  /* ------------------------------------------------------------------ currency */
  function applyCurrencyUI() {
    Array.prototype.slice.call(els['currency-toggle'].querySelectorAll('button')).forEach(function (button) {
      var isActive = button.getAttribute('data-currency') === state.currency;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  function changeCurrency(currency) {
    if (['USD', 'EUR', 'HKD', 'JPY'].indexOf(currency) === -1) return;
    state.currency = currency;
    Store.setCurrency(currency);
    applyCurrencyUI();
    if (state.dataMode === 'curated') state.featured = sortCuratedFeatured(state.curatedCards);
    if (state.featured.length) renderFeatured();
    if (isJa()) {
      if (state.view === 'results') renderJpResults();
      if (state.view === 'jp' && state.jp && state.jp.data) renderJp();
      if (!els['binder-drawer'].hidden) renderBinder();
      if (state.currentJp && !els['card-modal'].hidden && state.currentJpPayload) {
        els['modal-body'].innerHTML = jpModalHTML(state.currentJpPayload);
        annotateTranslations(els['modal-body'], 'jp:' + state.currentJp.id, 'ja');
      }
      return;
    }
    if (state.view === 'results' && !state.loading) renderResults();
    renderBinderBadge();
    if (!els['binder-drawer'].hidden) renderBinder();
    if (state.view === 'jp' && state.jp && state.jp.data) renderJp();
    if (state.currentCard && !els['card-modal'].hidden) {
      state.modalSnapshot = Store.snapshot(state.currentCard, state.currency);
      renderModalBase(state.currentCard, true);
    }
  }

  /* ------------------------------------------------------------------ home */
  function skeletonTile() {
    return '<div class="card-tile tile-skeleton" aria-hidden="true">' +
      '<div class="tile-media sk-block"></div>' +
      '<div class="tile-body"><div class="sk-line sk-w70"></div><div class="sk-line sk-w45"></div><div class="sk-line sk-w55"></div></div>' +
      '</div>';
  }

  function renderSkeletons(container, count) {
    container.innerHTML = new Array(count || 8).fill(skeletonTile()).join('');
  }

  function showHome() {
    state.view = 'home';
    state.jpCode = null;
    state.jp = null;
    els['jp-view'].hidden = true;
    els['home-view'].hidden = false;
    els['results-view'].hidden = true;
    updateURL();
    if (window.scrollY > 120) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showResults() {
    state.view = 'results';
    els['home-view'].hidden = true;
    els['results-view'].hidden = false;
  }

  function loadSets() {
    return Api.getSets().then(function (sets) {
      state.sets = sets || [];
      state.setsById = {};
      state.sets.forEach(function (set) { state.setsById[set.id] = set; });
      state.setsLoaded = true;
      buildSetOptions();
      renderSetStrip();
      if (state.pendingSetFilter) {
        els['set-select'].value = state.pendingSetFilter;
        state.pendingSetFilter = '';
      }
      els['set-select'].value = state.setId || '';
      if (state.view === 'results') renderResultMeta();
    }).catch(function () {
      renderSetStripError();
    });
  }

  /* Japanese-first home page: the featured rail and the set rail are both
     Japanese. English mode keeps the original TCG API home page behind the
     header toggle. */
  function loadJpFeatured() {
    if (!Api.getJpFeatured) { renderJpFeaturedError(); return; }
    renderSkeletons(els['featured-grid'], 8);
    els['featured-grid'].setAttribute('aria-busy', 'true');
    Api.getJpFeatured().then(function (res) {
      var cards = (res && res.cards) || [];
      cards.forEach(function (card) { knownJp.set(card.id, card); });
      state.jpFeatured = cards;
      state.featured = cards.slice(0, 8);
      state.jpFeaturedAt = (res && res.updatedAt) || null;
      els['featured-grid'].setAttribute('aria-busy', 'false');
      renderJpFeatured();
    }).catch(function () {
      renderJpFeaturedError();
    });
  }

  function renderJpFeaturedError() {
    els['featured-grid'].setAttribute('aria-busy', 'false');
    els['featured-grid'].innerHTML = '<p class="strip-note">Could not load the Japanese chase cards. <button type="button" class="link-inline" data-retry-featured>Retry</button></p>';
    if (els['featured-meta']) els['featured-meta'].textContent = '';
  }

  function renderJpFeatured() {
    if (!state.featured.length) {
      els['featured-grid'].innerHTML = '<p class="strip-note">No Japanese cards loaded right now.</p>';
      els['featured-meta'].textContent = '';
      return;
    }
    els['featured-grid'].innerHTML = state.featured.map(function (card, index) {
      return jpTileHTML(card, { rank: index + 1 });
    }).join('');
    els['featured-meta'].textContent = state.jpFeaturedAt
      ? 'SNKRDUNK · checked ' + Price.formatDate(state.jpFeaturedAt)
      : 'SNKRDUNK asking prices · JPY';
  }

  function renderJpSetStrip() {
    var container = els['set-strip'];
    container.setAttribute('aria-busy', 'false');
    var section = els['sets-section'] || document.getElementById('sets-section');
    if (section) section.hidden = false;
    var sets = (state.jpSets || []).slice(0, 10);
    if (!sets.length) {
      container.innerHTML = '<p class="strip-note">Japanese set list is napping. Search a card name instead →</p>';
      return;
    }
    container.innerHTML = sets.map(function (set) {
      var count = set.official || set.total || '';
      return '<button type="button" class="set-tile set-tile--jp" data-jp-set="' + esc(set.code) + '">' +
        '<span class="set-code-mark">' + esc(set.code) + '</span>' +
        '<span class="set-name set-name--jp">' + esc(set.name) + '</span>' +
        '<span class="set-meta">' + (count ? count + ' cards' : 'Japanese set') + '</span>' +
        '</button>';
    }).join('');
  }

  function buildSetOptions() {
    if (isJa()) {
      var jpHtml = '<option value="">All Japanese sets</option>';
      (state.jpSets || []).forEach(function (set) {
        jpHtml += '<option value="jp:' + esc(set.code) + '">' + esc(set.code) + ' — ' + esc(set.name) + '</option>';
      });
      els['set-select'].innerHTML = jpHtml;
      els['set-select'].value = '';
      return;
    }
    var groups = {};
    var done = {};
    state.sets.forEach(function (set) {
      var series = set.series || 'Other';
      if (!groups[series]) groups[series] = [];
      groups[series].push(set);
    });
    var order = Object.keys(groups).sort(function (a, b) {
      var years = function (series) {
        var list = groups[series];
        var newest = list.reduce(function (max, set) {
          var year = releaseYear(set);
          return year && Number(year) > max ? Number(year) : max;
        }, 0);
        return newest;
      };
      return years(b) - years(a);
    });

    var html = '<option value="">All sets</option>';
    order.forEach(function (series) {
      html += '<optgroup label="' + esc(series) + '">';
      groups[series].forEach(function (set) {
        html += '<option value="' + esc(set.id) + '">' + esc(set.name) + ' (' + esc(releaseYear(set)) + ')</option>';
      });
      html += '</optgroup>';
    });
    if (state.jpSets.length) {
      html += '<optgroup label="Japanese series (JP)">';
      state.jpSets.forEach(function (set) {
        html += '<option value="jp:' + esc(set.code) + '">' + esc(set.code) + ' — ' + esc(set.name) + '</option>';
      });
      html += '</optgroup>';
    }
    els['set-select'].innerHTML = html;
    els['set-select'].value = state.setId || '';
  }

  function splitJpQuery(term) {
    var parts = String(term || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    var code = parts[0].toLowerCase();
    var entry = null;
    for (var i = 0; i < state.jpSets.length; i++) {
      if (String(state.jpSets[i].code).toLowerCase() === code) { entry = state.jpSets[i]; break; }
    }
    if (!entry) return null;
    return { entry: entry, rest: parts.slice(1).join(' ') };
  }

  function renderSetStrip() {
    if (isJa()) { renderJpSetStrip(); return; }
    var container = els['set-strip'];
    container.setAttribute('aria-busy', 'false');
    var section = els['sets-section'] || document.getElementById('sets-section');
    var sets;
    if (state.dataMode === 'curated') {
      sets = state.sets.slice();
      if (section) section.hidden = sets.length < 2;
    } else {
      if (section) section.hidden = false;
      sets = POPULAR_SETS.map(setById).filter(Boolean);
    }
    if (!sets.length) {
      container.innerHTML = '<p class="strip-note">' +
        (state.dataMode === 'curated' ? 'No sets in the current selection.' : 'Set list is napping. Search for a card instead →') +
        '</p>';
      return;
    }
    container.innerHTML = sets.map(function (set) {
      var logo = set.images && set.images.logo ? set.images.logo : '';
      var year = releaseYear(set);
      return '<button type="button" class="set-tile" data-set="' + esc(set.id) + '">' +
        '<span class="set-logo">' + (logo ? '<img src="' + esc(logo) + '" alt="" loading="lazy" onerror="window.__holoImageError&&window.__holoImageError(this)" />' : '') + '</span>' +
        '<span class="set-name">' + esc(set.name) + '</span>' +
        '<span class="set-meta">' + esc(year) + (set.series ? ' · ' + esc(set.series) : '') + '</span>' +
        '</button>';
    }).join('');
  }

  function renderSetStripError() {
    els['set-strip'].setAttribute('aria-busy', 'false');
    els['set-strip'].innerHTML = '<p class="strip-note">Could not load the set list right now. Search works anyway.</p>';
  }

  function loadFeatured() {
    if (isJa()) { loadJpFeatured(); return; }
    renderSkeletons(els['featured-grid'], 8);
    els['featured-grid'].setAttribute('aria-busy', 'true');
    Api.getCardsByIds(FEATURED_IDS).then(function (cards) {
      decorateAll(cards).forEach(function (card) { knownCards.set(card.id, card); });
      state.featured = cards.slice().sort(function (a, b) {
        return (Price.priceValue(b, state.currency) || -1) - (Price.priceValue(a, state.currency) || -1);
      }).slice(0, 8);
      els['featured-grid'].setAttribute('aria-busy', 'false');
      renderFeatured();
    }).catch(function () {
      els['featured-grid'].setAttribute('aria-busy', 'false');
      els['featured-grid'].innerHTML = '<p class="strip-note">Could not load chase cards. <button class="link-inline" data-retry-featured>Retry</button></p>';
    });
  }

  function renderFeatured() {
    if (isJa()) { renderJpFeatured(); return; }
    if (!state.featured.length) {
      els['featured-grid'].innerHTML = '<p class="strip-note">' +
        (state.dataMode === 'curated' ? 'The curated catalog is empty right now.' : 'No featured cards loaded.') +
        '</p>';
      els['featured-meta'].textContent = '';
      return;
    }
    els['featured-grid'].innerHTML = state.featured.map(function (card, index) {
      return tileHTML(card, { rank: index + 1 });
    }).join('');
    if (state.dataMode === 'curated') {
      els['featured-meta'].textContent = state.curatedCards.length + ' handpicked cards';
      return;
    }
    var latest = '';
    state.featured.forEach(function (card) {
      var usd = Price.usdInfo(card);
      var date = usd && usd.updatedAt;
      if (date && (!latest || String(date) > String(latest))) latest = date;
    });
    els['featured-meta'].textContent = latest ? 'TCGplayer · updated ' + Price.formatDate(latest) : 'TCGplayer market prices';
  }

  /* ------------------------------------------------------------------ tiles */
  function tileHTML(card, opts) {
    opts = opts || {};
    var currency = state.currency;
    var value = Price.priceValue(card, currency);
    var label = Price.priceLabel(card, currency);
    var low = Price.priceLow(card, currency);
    var img = (card.images && (card.images.small || card.images.large)) || '';
    var setNameText = card.set ? card.set.name : '';
    var total = card.set ? (card.set.printedTotal || card.set.total || '') : '';
    var number = card.number ? '#' + card.number + (total ? '/' + total : '') : '';
    var rarity = card.rarity || '';
    var hasPrice = value !== null && value !== undefined;
    var isCustom = card.sitePriceHKD != null;

    var badge = '';
    if (opts.rank) {
      badge = '<span class="rank-badge rank-' + (opts.rank <= 3 ? opts.rank : 'n') + '">#' + opts.rank + '</span>';
    } else if (rarity) {
      badge = '<span class="rarity-badge">' + esc(rarity) + '</span>';
    }

    return '<article class="card-tile" data-card-id="' + esc(card.id) + '" tabindex="0" role="button" aria-label="' +
      esc(card.name + ', ' + setNameText + ', ' + Price.money(value, currency)) + '">' +
      '<div class="tile-media">' +
      '<img src="' + esc(img) + '" alt="' + esc(card.name) + ' card" loading="lazy" decoding="async" width="245" height="342" onerror="window.__holoImageError&&window.__holoImageError(this)" />' +
      '<span class="tile-sheen" aria-hidden="true"></span>' +
      badge +
      '<button type="button" class="quick-add" data-add-card="' + esc(card.id) + '" aria-label="Add ' + esc(card.name) + ' to binder" title="Add to binder">' +
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' +
      '</button>' +
      '</div>' +
      '<div class="tile-body">' +
      '<h3 class="tile-name" title="' + esc(card.name) + '">' + esc(card.name) + '</h3>' +
      '<p class="tile-sub">' + esc(setNameText) + (number ? ' · ' + esc(number) : '') + '</p>' +
      '<div class="tile-price-row">' +
      '<span class="tile-price' + (hasPrice ? '' : ' is-missing') + '">' + (hasPrice ? Price.money(value, currency) : '—') + '</span>' +
      '<span class="tile-price-tag' + (isCustom ? ' is-custom' : '') + '">' + (hasPrice ? esc(label) : 'no price') + '</span>' +
      '</div>' +
      '<p class="tile-low">' + (isCustom ? 'site price' : low !== null && low !== undefined ? 'Low ' + Price.money(low, currency) : '&nbsp;') + '</p>' +
      '</div>' +
      '</article>';
  }

  /* ------------------------------------------------------------------ search */
  function updateStateFromInputs() {
    state.term = els['search-input'].value.trim();
    var selectSet = els['set-select'].value;
    if (state.setsLoaded || selectSet) state.setId = selectSet;
    state.rarity = els['rarity-select'].value;
    state.type = els['type-select'].value;
    state.sort = els['sort-select'].value;
  }

  function searchLabel() {
    var bits = [];
    if (state.term) bits.push('“' + state.term + '”');
    if (state.setId) bits.push(state.setId === '' ? 'All sets' : setName(state.setId));
    if (state.rarity) bits.push(state.rarity);
    if (state.type) bits.push(state.type);
    if (state.supertype) bits.push(state.supertype);
    return bits.join(' · ');
  }

  function updateURL() {
    var params = new URLSearchParams();
    if (state.lang === 'en') params.set('lang', 'en');
    if (state.view === 'jp' && state.jpCode) {
      params.set('jp', state.jpCode);
      var query = params.toString();
      try { history.replaceState(null, '', location.pathname + '?' + query); } catch (err) { /* ignore */ }
      return;
    }
    if (state.term) params.set('q', state.term);
    if (state.setId) params.set('set', state.setId);
    if (state.rarity) params.set('rarity', state.rarity);
    if (state.type) params.set('type', state.type);
    if (state.supertype) params.set('supertype', state.supertype);
    if (state.sort !== 'value-desc') params.set('sort', state.sort);
    var query = params.toString();
    var url = location.pathname + (query ? '?' + query : '');
    try { history.replaceState(null, '', url); } catch (err) { /* file:// history is fine to skip */ }
  }

  function runSearch(opts) {
    opts = opts || {};
    updateStateFromInputs();
    var jpMatch = splitJpQuery(state.term);
    if (jpMatch) {
      openJpSet(jpMatch.entry.code, jpMatch.rest);
      return;
    }
    if (state.view === 'jp') {
      state.jpCode = null;
      state.jp = null;
      els['jp-view'].hidden = true;
      state.view = 'home';
    }
    if (isJa()) {
      runJpSearch(opts);
      return;
    }
    if (!activeSearch()) {
      showHome();
      return;
    }
    if (state.dataMode === 'curated') {
      runCuratedSearch(opts);
      return;
    }
    showResults();
    showResultsLoading();
    var resultsTop = els['results-view'].getBoundingClientRect().top;
    if (resultsTop > 140) {
      els['results-view'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    state.page = 1;
    state.cards = [];
    state.total = 0;
    state.loading = true;
    state.loadingMore = false;
    state.error = null;
    var reqId = ++state.reqId;
    updateURL();
    renderResultMeta();

    Api.searchCards({
      term: state.term,
      setId: state.setId,
      rarity: state.rarity,
      type: state.type,
      supertype: state.supertype,
      page: 1,
      pageSize: PAGE_SIZE
    }, { maxAge: opts.fresh ? 0 : 5 * 60 * 1000 }).then(function (res) {
      if (reqId !== state.reqId) return;
      state.loading = false;
      state.cards = decorateAll((res && res.data) || []);
      state.total = (res && res.totalCount) || 0;
      state.cards.forEach(function (card) { knownCards.set(card.id, card); });
      renderResults();
    }).catch(function (err) {
      if (reqId !== state.reqId) return;
      state.loading = false;
      state.error = err;
      renderResults();
    });
  }

  /* ------------------------------------------------------------- jp search */
  function runJpSearch(opts) {
    opts = opts || {};
    updateStateFromInputs();
    if (!state.term) {
      showHome();
      return;
    }
    showResults();
    var resultsTop = els['results-view'].getBoundingClientRect().top;
    if (resultsTop > 140) {
      els['results-view'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    var reqId = ++state.reqId;
    state.jpResults = {
      term: state.term,
      cards: [],
      page: 1,
      hasMore: false,
      loading: true,
      loadingMore: false,
      error: null,
      reqId: reqId
    };
    updateURL();
    els['empty-state'].hidden = true;
    els['error-state'].hidden = true;
    els['load-more-wrap'].hidden = true;
    els['results-title'].textContent = '“' + state.term + '”';
    els['results-sub'].textContent = 'Japanese printings from TCGdex';
    els['result-status'].textContent = 'Searching the Japanese index…';
    renderSkeletons(els['results-grid'], 10);

    if (!Api.getJpSearch) {
      state.jpResults.loading = false;
      state.jpResults.error = new Error('no-server');
      renderJpResults();
      return;
    }

    Api.getJpSearch(state.term, 1).then(function (res) {
      if (state.reqId !== reqId) return;
      if (!res || res.ok === false) throw new Error((res && res.error) || 'jp-search');
      var cards = (res && res.cards) || [];
      cards.forEach(function (card) { knownJp.set(card.id, card); });
      state.jpResults.cards = cards;
      state.jpResults.hasMore = Boolean(res && res.hasMore);
      state.jpResults.loading = false;
      renderJpResults();
    }).catch(function (err) {
      if (state.reqId !== reqId) return;
      state.jpResults.loading = false;
      state.jpResults.error = err;
      renderJpResults();
    });
  }

  function sortJpCards(cards) {
    var list = (cards || []).slice();
    var price = function (card) { return card.hasPrice ? Number(card.priceJPY) : -1; };
    var num = function (card) {
      var n = parseInt(String(card.localId || '').replace(/\D/g, ''), 10);
      return isFinite(n) ? n : 0;
    };
    switch (state.sort) {
      case 'price-asc':
        list.sort(function (a, b) {
          var aP = a.hasPrice ? Number(a.priceJPY) : Infinity;
          var bP = b.hasPrice ? Number(b.priceJPY) : Infinity;
          return aP - bP || num(a) - num(b);
        });
        break;
      case 'number':
        list.sort(function (a, b) { return num(a) - num(b); });
        break;
      case 'name':
        list.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ja'); });
        break;
      default:
        list.sort(function (a, b) { return price(b) - price(a) || num(a) - num(b); });
    }
    return list;
  }

  function renderJpResults() {
    var jr = state.jpResults;
    var grid = els['results-grid'];

    if (jr.error) {
      grid.innerHTML = '';
      els['empty-state'].hidden = true;
      els['error-state'].hidden = false;
      els['load-more-wrap'].hidden = true;
      els['error-message'].textContent = 'The Japanese card index did not answer. TCGdex may be taking a nap — try again in a moment.';
      els['result-status'].textContent = '';
      return;
    }

    var cards = sortJpCards(jr.cards);
    els['empty-state'].hidden = cards.length > 0;
    els['error-state'].hidden = true;

    if (!cards.length) {
      grid.innerHTML = '';
      els['load-more-wrap'].hidden = true;
      els['result-status'].textContent = 'No Japanese cards found';
      applyEmptyMessage();
      return;
    }

    grid.innerHTML = cards.map(function (card) { return jpTileHTML(card, {}); }).join('');
    els['result-status'].textContent = cards.length + ' Japanese cards' +
      (jr.hasMore ? ' · more available' : '') + ' · ' + priceSourceLabel();
    els['load-more-wrap'].hidden = !jr.hasMore;
    els['btn-load-more'].disabled = jr.loadingMore;
    els['btn-load-more'].textContent = jr.loadingMore ? 'Loading…' : 'Load more cards';
    els['load-more-note'].textContent = jr.hasMore
      ? 'SNKRDUNK asking prices are shown where a listing exists.'
      : '';
  }

  function loadMoreJp() {
    var jr = state.jpResults;
    if (!jr.term || jr.loading || jr.loadingMore || !jr.hasMore) return;
    jr.loadingMore = true;
    renderJpResults();
    var reqId = state.reqId;
    var nextPage = jr.page + 1;
    Api.getJpSearch(jr.term, nextPage).then(function (res) {
      if (state.reqId !== reqId) return;
      var cards = (res && res.cards) || [];
      var seen = new Set(jr.cards.map(function (card) { return card.id; }));
      cards.forEach(function (card) {
        if (!seen.has(card.id)) {
          seen.add(card.id);
          jr.cards.push(card);
          knownJp.set(card.id, card);
        }
      });
      jr.page = nextPage;
      jr.hasMore = Boolean(res && res.hasMore);
      jr.loadingMore = false;
      renderJpResults();
    }).catch(function () {
      if (state.reqId !== reqId) return;
      jr.loadingMore = false;
      toast('Could not load more Japanese cards', 'warn');
      renderJpResults();
    });
  }

  function matchesCuratedFilters(card) {
    var term = state.term.trim().toLowerCase();
    if (term) {
      var haystack = ((card.name || '') + ' ' + ((card.set && card.set.name) || '') + ' ' + (card.number || '')).toLowerCase();
      var tokens = term.split(/\s+/).filter(Boolean);
      if (!tokens.every(function (token) { return haystack.indexOf(token) !== -1; })) return false;
    }
    if (state.setId && (!card.set || card.set.id !== state.setId)) return false;
    if (state.rarity && card.rarity !== state.rarity) return false;
    if (state.type && (card.types || []).indexOf(state.type) === -1) return false;
    if (state.supertype && card.supertype !== state.supertype) return false;
    return true;
  }

  function runCuratedSearch(opts) {
    opts = opts || {};
    updateStateFromInputs();
    if (!activeSearch()) {
      showHome();
      return;
    }
    showResults();
    state.loading = false;
    state.loadingMore = false;
    state.error = null;
    state.reqId += 1;
    updateURL();
    state.cards = state.curatedCards.filter(matchesCuratedFilters);
    state.total = state.curatedCards.length;
    state.curatedMatches = state.cards.length;
    var resultsTop = els['results-view'].getBoundingClientRect().top;
    if (resultsTop > 140) {
      els['results-view'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    renderResults();
  }

  function showResultsLoading() {
    els['empty-state'].hidden = true;
    els['error-state'].hidden = true;
    els['load-more-wrap'].hidden = true;
    els['result-status'].textContent = 'Searching the stack…';
    renderSkeletons(els['results-grid'], 10);
  }

  function loadMore() {
    if (isJa()) { loadMoreJp(); return; }
    if (state.dataMode === 'curated') return;
    if (state.loading || state.loadingMore || state.cards.length >= state.total) return;
    state.loadingMore = true;
    state.page += 1;
    renderLoadMore();
    var reqId = state.reqId;
    Api.searchCards({
      term: state.term,
      setId: state.setId,
      rarity: state.rarity,
      type: state.type,
      supertype: state.supertype,
      page: state.page,
      pageSize: PAGE_SIZE
    }).then(function (res) {
      if (reqId !== state.reqId) return;
      var incoming = decorateAll((res && res.data) || []);
      var seen = new Set(state.cards.map(function (card) { return card.id; }));
      incoming.forEach(function (card) {
        if (!seen.has(card.id)) {
          state.cards.push(card);
          seen.add(card.id);
          knownCards.set(card.id, card);
        }
      });
      state.total = Math.max(state.total, (res && res.totalCount) || 0);
      state.loadingMore = false;
      renderResults();
    }).catch(function (err) {
      if (reqId !== state.reqId) return;
      state.loadingMore = false;
      state.page -= 1;
      toast('Could not load more cards: ' + (err.message || 'API hiccup'), 'warn');
      renderLoadMore();
    });
  }

  function renderResultMeta() {
    els['results-title'].textContent = searchLabel() || 'All cards';
    if (state.dataMode === 'curated') {
      els['results-sub'].textContent = state.curatedCards.length
        ? 'Curated selection · ' + state.curatedCards.length + ' cards'
        : 'Curated selection';
      return;
    }
    var filterBits = [];
    if (state.setId && setById(state.setId)) filterBits.push(setById(state.setId).name);
    if (state.rarity) filterBits.push(state.rarity);
    if (state.type) filterBits.push(state.type);
    if (state.supertype) filterBits.push(state.supertype);
    if (state.loading) {
      els['results-sub'].textContent = 'Hunting through the price index…';
    } else if (filterBits.length) {
      els['results-sub'].textContent = filterBits.join(' · ');
    } else {
      els['results-sub'].textContent = 'Across every set we track';
    }
  }

  function priceSourceLabel() {
    if (isJa()) {
      if (state.currency === 'JPY') return 'SNKRDUNK asking prices · JPY';
      return 'JPY converted to ' + state.currency + ' · SNKRDUNK asking prices';
    }
    if (state.currency === 'HKD') {
      return 'HKD at 1 USD = ' + Price.getFx().hkdPerUsd.toFixed(3);
    }
    return state.currency === 'EUR' ? 'EUR prices from Cardmarket' : 'USD prices from TCGplayer';
  }

  function renderResults() {
    if (isJa()) { renderJpResults(); return; }
    var grid = els['results-grid'];
    var cards = sortCards(state.cards);

    if (state.error) {
      grid.innerHTML = '';
      els['empty-state'].hidden = true;
      els['error-state'].hidden = false;
      els['load-more-wrap'].hidden = true;
      els['error-message'].textContent = friendlyError(state.error);
      els['result-status'].textContent = '';
      renderResultMeta();
      return;
    }

    els['error-state'].hidden = true;
    renderResultMeta();

    if (!cards.length) {
      grid.innerHTML = '';
      els['empty-state'].hidden = false;
      els['load-more-wrap'].hidden = true;
      els['result-status'].textContent = 'No cards found';
      applyEmptyMessage();
      return;
    }

    els['empty-state'].hidden = true;
    grid.innerHTML = cards.map(function (card) { return tileHTML(card, {}); }).join('');

    if (state.dataMode === 'curated') {
      els['result-status'].textContent = cards.length + ' of ' + state.total + ' curated cards · ' + priceSourceLabel();
      els['load-more-wrap'].hidden = true;
      return;
    }

    els['result-status'].textContent = cards.length + ' of ' + state.total + ' cards · ' + priceSourceLabel();
    renderLoadMore();

    if (state.sort === 'value-desc' || state.sort === 'value-asc') {
      els['load-more-note'].textContent = state.cards.length < state.total
        ? 'Price sorting applies to the cards loaded so far — load more to widen the list.'
        : '';
    } else {
      els['load-more-note'].textContent = state.cards.length < state.total
        ? 'Sorted across the cards loaded so far.'
        : '';
    }
  }

  function renderLoadMore() {
    var more = state.cards.length < state.total;
    els['load-more-wrap'].hidden = !more && !state.loadingMore;
    els['btn-load-more'].disabled = state.loadingMore;
    els['btn-load-more'].textContent = state.loadingMore ? 'Loading…' : 'Load more cards';
    if (more) {
      els['load-more-note'].textContent = 'Showing ' + state.cards.length + ' of ' + state.total + ' cards';
    }
  }

  function friendlyError(err) {
    if (!err) return 'Something went wrong.';
    switch (err.code) {
      case 'network':
        return 'Could not reach the card API. Check your internet connection, then hit retry.';
      case 'ratelimit':
        return 'The Pokémon TCG API rate limit is tapped out. Wait a minute, or drop a free API key into settings.';
      case 'auth':
        return 'The saved API key was rejected. Remove or replace it in settings.';
      case 'badquery':
        return 'That search was rejected. Try a simpler term or a card number like 199/165.';
      case 'notfound':
        return 'That card was not found in the API.';
      default:
        return 'The card API is having a moment. It usually recovers in a few seconds — hit retry.';
    }
  }

  /* ------------------------------------------------------------- translation */
  /* Every translatable string gets data-tr-text in the markup, so toggling the
     Chinese view needs no re-render — the annotator walks the DOM and appends
     the translated lines once the server answers. */
  function trData(text, kind) {
    var value = String(text === null || text === undefined ? '' : text).trim();
    if (!value) return '';
    return ' data-tr="' + (kind === 'block' ? 'block' : 'inline') + '" data-tr-text="' + esc(value) + '"';
  }

  /* Japanese names end in Latin marks like ex / VMAX / GX / LV.X. Google
     mangles those (ex → 前任), so translate the base name and re-attach the
     suffix verbatim. */
  var JP_NAME_SUFFIX = /^(.*?)((?:VMAX|VSTAR|V-?UNION|BREAK|GX|EX|Ex|ex|LV\.?\s?X|V|δ|◇|☆|Prism Star))+$/;

  function splitJpName(name) {
    var text = String(name === null || name === undefined ? '' : name).trim();
    var match = text.match(JP_NAME_SUFFIX);
    if (!match || !match[1].trim()) return { base: text, suffix: '' };
    return { base: match[1].trim(), suffix: match[0].slice(match[1].length).trim() };
  }

  function trName(name) {
    var parts = splitJpName(name);
    return trData(parts.base, 'inline') + (parts.suffix ? ' data-tr-append="' + esc(parts.suffix) + '"' : '');
  }

  function clearTranslations(root) {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('.tr-inline, .tr-block'), function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-tr-done], [data-tr-pending]'), function (node) {
      node.removeAttribute('data-tr-done');
      node.removeAttribute('data-tr-pending');
    });
  }

  function setZhBusy(delta) {
    state.zhBusy = Math.max(0, (state.zhBusy || 0) + delta);
    var button = document.getElementById('btn-modal-zh');
    if (!button) return;
    button.classList.toggle('is-busy', state.zhBusy > 0);
    button.textContent = state.zhBusy > 0 ? '翻译中…' : '中文';
  }

  /* The Chinese view is only wired into the Japanese card modal. */
  function currentModalKey() {
    if (els['card-modal'].hidden) return '';
    if (state.currentJp) return 'jp:' + state.currentJp.id;
    if (state.currentCard) return 'card:' + state.currentCard.id;
    return '';
  }

  function zhTarget() {
    if (els['card-modal'].hidden) return null;
    if (state.currentJp) return { key: 'jp:' + state.currentJp.id, from: 'ja' };
    return null; // English card details stay untranslated by design.
  }

  function annotateTranslations(root, key, from) {
    if (!root || !state.zh || !Api.canTranslate) return;
    var nodes = Array.prototype.slice.call(root.querySelectorAll('[data-tr-text]')).filter(function (node) {
      return node.getAttribute('data-tr-done') !== '1' && node.getAttribute('data-tr-pending') !== '1';
    });
    if (!nodes.length) return;

    var texts = [];
    var seen = Object.create(null);
    nodes.forEach(function (node) {
      var text = node.getAttribute('data-tr-text');
      if (!text || seen[text]) return;
      seen[text] = true;
      texts.push(text);
    });
    if (!texts.length) return;

    nodes.forEach(function (node) { node.setAttribute('data-tr-pending', '1'); });
    setZhBusy(1);

    Api.translateTexts(texts, { to: state.zhLang, from: from || 'auto' }).then(function (translations) {
      setZhBusy(-1);
      nodes.forEach(function (node) { node.removeAttribute('data-tr-pending'); });
      if (!translations) {
        toast('Translation is unavailable right now — try again in a moment', 'warn');
        return;
      }
      if (!state.zh || (key && key !== currentModalKey())) return;

      var map = Object.create(null);
      texts.forEach(function (text, index) {
        var value = translations[index];
        if (value) map[text] = value;
      });
      nodes.forEach(function (node) {
        if (node.getAttribute('data-tr-done') === '1') return;
        var translated = map[node.getAttribute('data-tr-text')];
        node.setAttribute('data-tr-done', '1');
        if (!translated) return;
        if (node.getAttribute('data-tr') === 'block') {
          var block = document.createElement('p');
          block.className = 'tr-block';
          block.textContent = translated;
          if (node.parentNode) node.parentNode.insertBefore(block, node.nextSibling);
        } else {
          var span = document.createElement('span');
          span.className = 'tr-inline';
          span.textContent = translated + (node.getAttribute('data-tr-append') || '');
          node.appendChild(span);
        }
      });
    });
  }

  function toggleZh() {
    if (!state.zh && !Api.canTranslate) {
      toast('Chinese translation needs the local server — run node server.mjs', 'warn');
      return;
    }
    state.zh = !state.zh;
    Store.setShowZh(state.zh);
    var button = document.getElementById('btn-modal-zh');
    if (button) {
      button.classList.toggle('is-active', state.zh);
      button.setAttribute('aria-pressed', String(state.zh));
    }
    if (!state.zh) {
      clearTranslations(els['modal-body']);
      state.zhBusy = 0;
      if (button) {
        button.classList.remove('is-busy');
        button.textContent = '中文';
      }
      return;
    }
    var target = zhTarget();
    if (target) annotateTranslations(els['modal-body'], target.key, target.from);
  }

  function applyZhVariant(lang) {
    state.zhLang = lang === 'zh-TW' ? 'zh-TW' : 'zh-CN';
    Store.setZhLang(state.zhLang);
    var target = zhTarget();
    if (!target) return;
    clearTranslations(els['modal-body']);
    if (state.zh) annotateTranslations(els['modal-body'], target.key, target.from);
  }

  /* ------------------------------------------------------------------ modal */
  function openCard(card) {
    if (!card) return;
    state.currentJp = null;
    decorateCard(card);
    knownCards.set(card.id, card);
    state.currentCard = card;
    state.modalSnapshot = Store.snapshot(card, state.currency);
    renderModalBase(card, false);
    openOverlay('card-modal');
    enhanceDetail(card);
    enhanceSnkrdunk(card);
  }

  function currentQty(cardId) {
    var entry = Store.binderEntryFor(cardId);
    return entry ? entry.qty || 1 : 1;
  }

  function renderModalBase(card, quiet) {
    var usd = Price.usdInfo(card);
    var eur = Price.eurInfo(card);
    var usdVars = Price.usdVariants(card);
    var set = card.set || {};
    var img = (card.images && (card.images.large || card.images.small)) || '';
    var numberText = card.number ? '#' + card.number + (set.printedTotal ? ' / ' + set.printedTotal : '') : '';
    var qty = currentQty(card.id);
    var inBinder = Boolean(Store.binderEntryFor(card.id));

    var snapshot = state.modalSnapshot;

    var body =
      '<div class="modal-grid">' +
        '<div class="modal-left">' +
          '<div class="modal-art"><img src="' + esc(img) + '" alt="' + esc(card.name) + ' card" onerror="window.__holoImageError&&window.__holoImageError(this)" /></div>' +
          '<div class="facts">' +
            factRow('Set', set.name || '—', set.series ? '<span class="fact-dim"> · ' + esc(set.series) + '</span>' : '') +
            factRow('Number', numberText || '—') +
            factRow('Rarity', card.rarity || '—') +
            factRow('Category', card.supertype || '—') +
            (card.types && card.types.length ? factRow('Type', card.types.join(' / ')) : '') +
            '<div class="facts-links">' +
              (usd && usd.url ? '<a class="outlink" href="' + esc(usd.url) + '" target="_blank" rel="noopener noreferrer">TCGplayer <span aria-hidden="true">↗</span></a>' : '') +
              (eur && eur.url ? '<a class="outlink" href="' + esc(eur.url) + '" target="_blank" rel="noopener noreferrer">Cardmarket <span aria-hidden="true">↗</span></a>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-right">' +
          '<header class="modal-head">' +
            '<p class="modal-kicker">' + esc(set.name || '') + (set.releaseDate ? ' · ' + Price.formatDate(set.releaseDate) : '') + '</p>' +
            '<h2 id="modal-title">' + esc(card.name) + '</h2>' +
            '<div class="chip-row">' +
              (card.rarity ? '<span class="tag tag-rarity">' + esc(card.rarity) + '</span>' : '') +
              (card.supertype ? '<span class="tag">' + esc(card.supertype) + '</span>' : '') +
              (card.types || []).map(function (type) { return '<span class="tag tag-type" data-type="' + esc(type) + '">' + esc(type) + '</span>'; }).join('') +
              (card.hp ? '<span class="tag tag-hp">HP ' + esc(card.hp) + '</span>' : '') +
            '</div>' +
          '</header>' +
          '<div class="modal-actions">' +
            '<div class="stepper" role="group" aria-label="Quantity">' +
              '<button type="button" class="stepper-btn" data-qty-step="-1" aria-label="Decrease quantity">−</button>' +
              '<span class="stepper-value" id="modal-qty">' + qty + '</span>' +
              '<button type="button" class="stepper-btn" data-qty-step="1" aria-label="Increase quantity">+</button>' +
            '</div>' +
            '<button type="button" class="btn btn-primary" id="btn-modal-add">' + (inBinder ? 'Add another' : 'Add to binder') + '</button>' +
            '<button type="button" class="btn btn-soft" id="btn-modal-refresh">Refresh live</button>' +
            '<a class="btn btn-ghost" href="https://snkrdunk.com/search?keywords=' + encodeURIComponent(card.name + ' ' + (card.number || '') + '/' + (set.printedTotal || set.total || '')) + '" target="_blank" rel="noopener noreferrer">SNKRDUNK ↗</a>' +
          '</div>' +
          cardOverrideBanner(card) +
          '<div class="price-cards">' +
            priceCard('TCGplayer', 'USD', usd ? Price.money(usd.market, 'USD') : null, usd ? usd.label + ' · low ' + Price.money(usd.low, 'USD') : 'No USD price listed', usd && usd.updatedAt ? 'Updated ' + Price.formatDate(usd.updatedAt) : '') +
            priceCard('Cardmarket', 'EUR', eur ? Price.money(eur.trend, 'EUR') : null, eur ? 'trend · avg ' + Price.money(eur.avg, 'EUR') : 'No EUR price listed', eur && eur.updatedAt ? 'Updated ' + Price.formatDate(eur.updatedAt) : '') +
            '<div class="price-card price-card--jp" id="snkr-summary">' +
              '<div class="price-card-head"><span class="price-source">SNKRDUNK</span><span class="price-currency">JPY</span></div>' +
              '<div class="price-value is-loading">Checking…</div>' +
              '<div class="price-sub">JP marketplace · live listings</div>' +
            '</div>' +
          '</div>' +
          (snapshot && snapshot.previous !== null && snapshot.previous !== undefined
            ? deltaHTML(snapshot, state.currency)
            : '') +
          '<div id="snkr-panel" class="snkr-panel">' + snkrLoadingHTML() + '</div>' +
          (usdVars.length ? variantsHTML(usdVars) : '') +
          (eur ? eurTableHTML(eur) : '') +
          '<div class="modal-detail" id="modal-detail">' + detailLoadingHTML() + '</div>' +
          '<p class="modal-note">Prices are marketplace estimates pulled at different refresh rates. They are not offers to buy or sell. SNKRDUNK data is matched by card number and set name.</p>' +
        '</div>' +
      '</div>';

    els['modal-body'].innerHTML = body;
    els['modal-body'].scrollTop = 0;

    if (!quiet) {
      // Wire up per-modal controls (re-bound after every render).
      var stepButtons = els['modal-body'].querySelectorAll('[data-qty-step]');
      Array.prototype.forEach.call(stepButtons, function (button) {
        button.addEventListener('click', function () {
          var display = document.getElementById('modal-qty');
          var next = Math.max(1, Math.min(99, parseInt(display.textContent, 10) + parseInt(button.getAttribute('data-qty-step'), 10)));
          display.textContent = String(next);
        });
      });
      var addBtn = document.getElementById('btn-modal-add');
      if (addBtn) addBtn.addEventListener('click', function () {
        var qty = parseInt((document.getElementById('modal-qty') || {}).textContent, 10) || 1;
        Store.addToBinder(state.currentCard, qty);
        renderBinderBadge();
        if (!els['binder-drawer'].hidden) renderBinder();
        toast('Added ' + qtyLabel(qty) + ' to your binder', 'success');
        addBtn.textContent = 'Added ✓';
        addBtn.disabled = true;
        setTimeout(function () { addBtn.disabled = false; addBtn.textContent = 'Add another'; }, 1200);
      });
      var refreshBtn = document.getElementById('btn-modal-refresh');
      if (refreshBtn) refreshBtn.addEventListener('click', function () { refreshCardLive(); });
    }
  }

  function factRow(label, value, extra) {
    return '<div class="fact"><span class="fact-label">' + esc(label) + '</span><span class="fact-value">' + esc(value) + (extra || '') + '</span></div>';
  }

  function cardOverrideBanner(card) {
    var priceHKD = Price.sitePriceHKD(card);
    if (priceHKD === null) return '';
    var fx = Price.getFx();
    var usd = fx.hkdPerUsd > 0 ? priceHKD / fx.hkdPerUsd : null;
    var eur = fx.hkdPerEur > 0 ? priceHKD / fx.hkdPerEur : null;
    return '<div class="override-banner">' +
      '<span class="tag tag-override">SITE PRICE</span>' +
      '<span class="override-value">' + Price.money(priceHKD, 'HKD') + '</span>' +
      '<span class="override-note">set by the site owner · ≈ ' + Price.money(usd, 'USD') + ' · ' + Price.money(eur, 'EUR') + '</span>' +
      '</div>';
  }

  function priceCard(source, currency, value, sub, updated) {
    return '<div class="price-card">' +
      '<div class="price-card-head"><span class="price-source">' + esc(source) + '</span><span class="price-currency">' + esc(currency) + '</span></div>' +
      '<div class="price-value' + (value ? '' : ' is-missing') + '">' + (value || '—') + '</div>' +
      '<div class="price-sub">' + esc(sub) + '</div>' +
      (updated ? '<div class="price-updated">' + esc(updated) + '</div>' : '') +
      '</div>';
  }

  function deltaHTML(snapshot, currency) {
    var diff = snapshot.value - snapshot.previous;
    if (!isFinite(diff)) return '';
    var direction = diff > 0.004 ? 'up' : diff < -0.004 ? 'down' : 'flat';
    var arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '◆';
    var label = direction === 'flat' ? 'No change' : Price.money(Math.abs(diff), currency) + (direction === 'up' ? ' up' : ' down');
    var when = snapshot.previousAt ? Price.formatDate(new Date(snapshot.previousAt).toISOString().slice(0, 10)) : 'last check';
    return '<div class="delta-line delta-' + direction + '"><span class="delta-arrow" aria-hidden="true">' + arrow + '</span>' +
      '<span>' + esc(label) + ' since your last check' + (when ? ' (' + esc(when) + ')' : '') + '</span></div>';
  }

  function variantsHTML(variants) {
    var rows = variants.map(function (variant) {
      return '<tr>' +
        '<td class="col-label"><span class="variant-name">' + esc(variant.label) + '</span></td>' +
        '<td>' + Price.money(variant.market, 'USD') + '</td>' +
        '<td>' + Price.money(variant.low, 'USD') + '</td>' +
        '<td>' + Price.money(variant.mid, 'USD') + '</td>' +
        '<td>' + Price.money(variant.high, 'USD') + '</td>' +
        '<td>' + Price.money(variant.directLow, 'USD') + '</td>' +
        '</tr>';
    }).join('');
    return '<section class="modal-section">' +
      '<div class="modal-section-head"><h3>TCGplayer variants</h3><span class="section-tag">USD</span></div>' +
      '<div class="table-wrap"><table class="price-table">' +
      '<thead><tr><th class="col-label">Printing</th><th>Market</th><th>Low</th><th>Mid</th><th>High</th><th>Direct low</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></section>';
  }

  function eurTableHTML(eur) {
    var rows = [
      ['Trend price', eur.trend],
      ['Average sell price', eur.avg],
      ['Low price', eur.low],
      ['Low price (ex+)', eur.lowEx],
      ['1-day average', eur.avg1],
      ['7-day average', eur.avg7],
      ['30-day average', eur.avg30]
    ].filter(function (row) { return row[1] !== null && row[1] !== undefined; });

    var reverse = [
      ['Reverse holo sell', eur.reverseSell],
      ['Reverse holo low', eur.reverseLow],
      ['Reverse holo trend', eur.reverseTrend],
      ['Reverse holo 7-day', eur.reverseAvg7],
      ['Reverse holo 30-day', eur.reverseAvg30]
    ].filter(function (row) { return row[1] !== null && row[1] !== undefined; });

    if (!rows.length && !reverse.length) return '';

    var rowHTML = function (row) {
      return '<tr><td class="col-label">' + esc(row[0]) + '</td><td>' + Price.money(row[1], 'EUR') + '</td></tr>';
    };

    return '<section class="modal-section">' +
      '<div class="modal-section-head"><h3>Cardmarket detail</h3><span class="section-tag">EUR</span></div>' +
      '<div class="table-wrap"><table class="price-table price-table--two">' +
      '<thead><tr><th class="col-label">Metric</th><th>Value</th></tr></thead>' +
      '<tbody>' + rows.map(rowHTML).join('') + reverse.map(rowHTML).join('') + '</tbody></table></div></section>';
  }

  function detailLoadingHTML() {
    return '<div class="detail-skeleton" aria-hidden="true"><span class="sk-line sk-w40"></span><span class="sk-line sk-w90"></span><span class="sk-line sk-w70"></span></div>';
  }

  function enhanceDetail(card) {
    var container = document.getElementById('modal-detail');
    if (!container) return;
    if (state.detailCache[card.id]) {
      container.innerHTML = detailHTML(card, state.detailCache[card.id]);
      return;
    }
    Api.getCard(card.id).then(function (full) {
      state.detailCache[card.id] = full;
      knownCards.set(full.id, decorateCard(Object.assign({}, card, full)));
      var node = document.getElementById('modal-detail');
      if (node && state.currentCard && state.currentCard.id === card.id) {
        node.innerHTML = detailHTML(card, full);
        // refresh facts with richer data
        var facts = document.querySelector('.modal-left .facts');
        if (facts && full.artist) {
          var existing = facts.querySelector('[data-artist]');
          if (!existing) {
            var row = document.createElement('div');
            row.className = 'fact';
            row.setAttribute('data-artist', '1');
            row.innerHTML = '<span class="fact-label">Illustrator</span><span class="fact-value">' + esc(full.artist) + '</span>';
            facts.insertBefore(row, facts.querySelector('.facts-links'));
          }
        }
      }
    }).catch(function () {
      var node = document.getElementById('modal-detail');
      if (node && state.currentCard && state.currentCard.id === card.id) {
        node.innerHTML = '<p class="detail-note">Could not load the deep card data right now — prices above are still live.</p>';
      }
    });
  }

  function detailHTML(card, full) {
    var blocks = [];
    var legal = full.legalities || {};
    var legalTags = ['standard', 'expanded', 'unlimited'].filter(function (key) {
      return legal[key] && legal[key].toLowerCase() === 'legal';
    }).map(function (key) {
      return '<span class="tag tag-legal">' + esc(key.charAt(0).toUpperCase() + key.slice(1)) + ' legal</span>';
    }).join('');

    if (full.abilities && full.abilities.length) {
      blocks.push('<div class="text-block"><h4>Abilities</h4>' + full.abilities.map(function (ability) {
        return '<div class="ability"><div class="ability-head"><span class="ability-name">' + esc(ability.name) + '</span>' +
          '<span class="ability-type">' + esc(ability.type || 'Ability') + '</span></div>' +
          '<p>' + esc(ability.text || '') + '</p></div>';
      }).join('') + '</div>');
    }

    if (full.attacks && full.attacks.length) {
      blocks.push('<div class="text-block"><h4>Attacks</h4>' + full.attacks.map(function (attack) {
        var cost = (attack.cost || []).map(function (type) {
          return '<span class="energy-dot" data-type="' + esc(type) + '" title="' + esc(type) + '"></span>';
        }).join('');
        return '<div class="attack"><div class="attack-head"><span class="attack-cost">' + cost + '</span>' +
          '<span class="attack-name">' + esc(attack.name) + '</span>' +
          '<span class="attack-damage">' + esc(attack.damage || '') + '</span></div>' +
          (attack.text ? '<p>' + esc(attack.text) + '</p>' : '') + '</div>';
      }).join('') + '</div>');
    }

    if (full.rules && full.rules.length) {
      blocks.push('<div class="text-block"><h4>Rules</h4><ul class="rules-list">' + full.rules.map(function (rule) {
        return '<li>' + esc(rule) + '</li>';
      }).join('') + '</ul></div>');
    }

    var stats = [];
    if (full.weaknesses && full.weaknesses.length) {
      stats.push('<div class="stat"><span class="stat-label">Weakness</span><span class="stat-value">' +
        full.weaknesses.map(function (w) { return esc(w.type) + ' ' + esc(w.value); }).join(', ') + '</span></div>');
    }
    if (full.resistances && full.resistances.length) {
      stats.push('<div class="stat"><span class="stat-label">Resistance</span><span class="stat-value">' +
        full.resistances.map(function (r) { return esc(r.type) + ' ' + esc(r.value); }).join(', ') + '</span></div>');
    }
    if (full.retreatCost && full.retreatCost.length) {
      stats.push('<div class="stat"><span class="stat-label">Retreat</span><span class="stat-value">' +
        full.retreatCost.map(function () { return '<span class="energy-dot energy-dot--retreat"></span>'; }).join('') + '</span></div>');
    }
    if (full.nationalPokedexNumbers && full.nationalPokedexNumbers.length) {
      stats.push('<div class="stat"><span class="stat-label">Pokédex</span><span class="stat-value">#' + full.nationalPokedexNumbers.join(' / #') + '</span></div>');
    }
    if (full.artist) {
      stats.push('<div class="stat"><span class="stat-label">Illustrator</span><span class="stat-value">' + esc(full.artist) + '</span></div>');
    }
    if (card.supertype) {
      stats.push('<div class="stat"><span class="stat-label">Category</span><span class="stat-value">' + esc(card.supertype) + '</span></div>');
    }
    if (stats.length || legalTags) {
      blocks.push('<div class="text-block"><h4>Card stats</h4><div class="stat-grid">' + stats.join('') + '</div>' +
        (legalTags ? '<div class="chip-row legal-row">' + legalTags + '</div>' : '') + '</div>');
    }

    if (full.flavorText) {
      blocks.push('<blockquote class="flavor">' + esc(full.flavorText) + '</blockquote>');
    }

    if (!blocks.length) return '<p class="detail-note">No extra card text stored for this one.</p>';
    return '<section class="modal-section modal-section--detail">' +
      '<div class="modal-section-head"><h3>Full card data</h3><span class="section-tag">Pokémon TCG API</span></div>' +
      blocks.join('') + '</section>';
  }

  function snkrLoadingHTML() {
    return '<div class="snkr-head"><span class="snkr-logo">SNKRDUNK</span><span class="snkr-tag">JP marketplace · JPY</span></div>' +
      '<div class="snkr-loading"><span class="spinner" aria-hidden="true"></span> Checking Japanese listings…</div>';
  }

  function enhanceSnkrdunk(card) {
    var panel = document.getElementById('snkr-panel');
    if (!panel) return;
    var summary = document.getElementById('snkr-summary');
    var cached = state.snkrCache[card.id];

    var render = function (data) {
      var panelNode = document.getElementById('snkr-panel');
      var summaryNode = document.getElementById('snkr-summary');
      if (!panelNode || !state.currentCard || state.currentCard.id !== card.id) return;
      panelNode.innerHTML = snkrHTML(card, data);
      if (summaryNode) {
        var items = (data && data.items) || [];
        var best = items.find(function (item) { return item.priceJPY; }) || items[0];
        var valueHtml = best && best.priceJPY
          ? Price.money(best.priceJPY, 'JPY')
          : '<span class="price-value-empty">No listings</span>';
        var subText = best && best.priceJPY
          ? (best.listings ? best.listings + (best.listings === 1 ? ' listing' : ' listings') : 'lowest asking price') +
            (best.nameEN ? ' · ' + best.nameEN.split('[')[0].trim() : '')
          : 'No active listings right now';
        summaryNode.innerHTML =
          '<div class="price-card-head"><span class="price-source">SNKRDUNK</span><span class="price-currency">JPY</span></div>' +
          '<div class="price-value' + (best && best.priceJPY ? '' : ' is-missing') + '">' + valueHtml + '</div>' +
          '<div class="price-sub">' + esc(subText) + '</div>' +
          (data && data.fetchedAt ? '<div class="price-updated">Checked ' + Price.formatDate(data.fetchedAt.slice(0, 10)) + '</div>' : '');
      }
    };

    if (!Api.snkrdunk) {
      render(null);
      return;
    }
    if (cached) { render(cached); return; }

    Api.getSnkrdunk(card).then(function (data) {
      state.snkrCache[card.id] = data;
      render(data);
    }).catch(function () {
      render(null);
    });
  }

  function snkrHTML(card, data) {
    var head = '<div class="snkr-head"><span class="snkr-logo">SNKRDUNK</span><span class="snkr-tag">JP marketplace · JPY</span></div>';
    var manual = 'https://snkrdunk.com/search?keywords=' + encodeURIComponent(card.name + ' ' + (card.number || '') + '/' + ((card.set && (card.set.printedTotal || card.set.total)) || ''));

    if (!Api.snkrdunk) {
      return '<section class="snkr-block">' + head +
        '<p class="snkr-empty">Japanese market prices need the local server. Run <code>node server.mjs</code> and reload to pull live SNKRDUNK listings.</p>' +
        '<a class="btn btn-ghost btn-small" href="' + esc(manual) + '" target="_blank" rel="noopener noreferrer">Search SNKRDUNK ↗</a></section>';
    }
    if (!data) {
      return '<section class="snkr-block">' + head +
        '<p class="snkr-empty">SNKRDUNK did not answer just now. The other market prices above are still live.</p>' +
        '<a class="btn btn-ghost btn-small" href="' + esc(manual) + '" target="_blank" rel="noopener noreferrer">Search SNKRDUNK ↗</a></section>';
    }
    if (!data.matched || !data.items || !data.items.length) {
      return '<section class="snkr-block">' + head +
        '<p class="snkr-empty">No exact SNKRDUNK match for <strong>' + esc(card.name) + '</strong> ' +
        (card.number ? '#' + esc(card.number) : '') + '. Their Japanese listings use different set numbering for some prints.</p>' +
        '<a class="btn btn-ghost btn-small" href="' + esc(manual) + '" target="_blank" rel="noopener noreferrer">Search SNKRDUNK ↗</a></section>';
    }

    var sorted = data.items.slice().sort(function (a, b) {
      return (b.priceJPY || 0) - (a.priceJPY || 0);
    });
    var rows = sorted.map(function (item) {
      var title = item.nameEN || item.nameJP || 'SNKRDUNK listing';
      var enFlag = item.isEnglishVersion ? '<span class="tag tag-mini">EN</span>' : '<span class="tag tag-mini tag-mini--jp">JP</span>';
      return '<a class="snkr-row" href="' + esc(item.url || '#') + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="snkr-row-main"><span class="snkr-row-title">' + esc(title) + '</span>' +
        '<span class="snkr-row-meta">' + enFlag + (item.listings ? '<span>' + item.listings + ' listings</span>' : '<span>no active listings</span>') +
        (item.productNumber ? '<span class="snkr-sku">' + esc(item.productNumber) + '</span>' : '') + '</span></span>' +
        '<span class="snkr-row-price">' + (item.priceJPY ? Price.money(item.priceJPY, 'JPY') : '—') + '</span>' +
        '</a>';
    }).join('');

    return '<section class="snkr-block">' + head +
      '<p class="snkr-blurb">Live asking prices on Japan’s biggest card marketplace, matched by set + card number.</p>' +
      '<div class="snkr-rows">' + rows + '</div>' +
      '<p class="snkr-foot">Checked ' + esc(Price.formatDate((data.fetchedAt || '').slice(0, 10))) + ' · JPY, before shipping and fees · <a href="' + esc(manual) + '" target="_blank" rel="noopener noreferrer">search more ↗</a></p>' +
      '</section>';
  }

  function refreshCardLive() {
    if (!state.currentCard) return;
    var button = document.getElementById('btn-modal-refresh');
    if (button) { button.disabled = true; button.textContent = 'Refreshing…'; }
    Api.getCard(state.currentCard.id).then(function (fresh) {
      if (!fresh) throw new Error('empty');
      state.detailCache[fresh.id] = fresh;
      var merged = decorateCard(Object.assign({}, state.currentCard, fresh));
      knownCards.set(fresh.id, merged);
      state.currentCard = merged;
      state.modalSnapshot = Store.snapshot(merged, state.currency);
      Store.updateBinderCard(merged);
      renderBinderBadge();
      renderModalBase(merged, false);
      enhanceDetail(merged);
      var cached = state.snkrCache[fresh.id];
      if (cached) {
        renderModalSnkrOnly(fresh, cached);
      } else {
        enhanceSnkrdunk(merged);
      }
      toast('Live data refreshed', 'success');
    }).catch(function () {
      toast('Could not refresh — API hiccup', 'warn');
      if (button) { button.disabled = false; button.textContent = 'Refresh live'; }
    });
  }

  function renderModalSnkrOnly(card, data) {
    var panel = document.getElementById('snkr-panel');
    var summary = document.getElementById('snkr-summary');
    if (!panel) return;
    panel.innerHTML = snkrHTML(card, data);
    if (summary) {
      var items = (data && data.items) || [];
      var best = items.find(function (item) { return item.priceJPY; }) || items[0];
      summary.innerHTML = '<div class="price-card-head"><span class="price-source">SNKRDUNK</span><span class="price-currency">JPY</span></div>' +
        '<div class="price-value' + (best && best.priceJPY ? '' : ' is-missing') + '">' + (best && best.priceJPY ? Price.money(best.priceJPY, 'JPY') : '—') + '</div>' +
        '<div class="price-sub">' + (best && best.listings ? best.listings + ' listings' : 'JP marketplace') + '</div>';
    }
  }

  /* ------------------------------------------------------- japanese series */
  var JP_PAGE_SIZE = 60;

  function jpSnkrSearchUrl(code) {
    return 'https://snkrdunk.com/search?keywords=' + encodeURIComponent(code);
  }

  function jpyToUsd(jpy) {
    var fx = Price.getFx();
    return Number(jpy) / (fx.jpyPerUsd || 150);
  }
  function jpyToHkd(jpy) {
    var fx = Price.getFx();
    return jpyToUsd(jpy) * fx.hkdPerUsd;
  }
  function jpyToEur(jpy) {
    var fx = Price.getFx();
    var usd = jpyToUsd(jpy);
    return fx.hkdPerEur > 0 ? usd * (fx.hkdPerUsd / fx.hkdPerEur) : usd * 0.9;
  }
  function jpyConversions(jpy) {
    if (!jpy) return '';
    return '≈ ' + Price.money(jpyToHkd(jpy), 'HKD') +
      ' · ≈ ' + Price.money(jpyToUsd(jpy), 'USD') +
      ' · ≈ ' + Price.money(jpyToEur(jpy), 'EUR');
  }

  function openJpSet(code, filterText, opts) {
    opts = opts || {};
    if (!Api.proxy) {
      toast('Japanese set lookup needs the local server — run node server.mjs', 'warn');
      return;
    }
    var normalized = String(code || '').trim();
    if (!normalized) return;
    state.jpCode = normalized;
    state.view = 'jp';
    state.jpSeq += 1;
    state.jp = {
      data: null,
      loading: true,
      error: null,
      sort: 'number',
      pricedOnly: false,
      visible: JP_PAGE_SIZE,
      filter: String(filterText || '').trim()
    };

    els['home-view'].hidden = true;
    els['results-view'].hidden = true;
    els['jp-view'].hidden = false;
    els['jp-kicker'].textContent = 'Japanese series';
    els['jp-title'].innerHTML = esc(normalized);
    els['jp-sub'].textContent = 'Loading Japanese series…';
    els['jp-meta'].textContent = 'Cards from TCGdex · prices from SNKRDUNK (JPY)';
    els['jp-status'].textContent = '';
    els['jp-grid'].innerHTML = new Array(8).fill(skeletonTile()).join('');
    els['jp-empty'].hidden = true;
    els['jp-error'].hidden = true;
    els['jp-load-more-wrap'].hidden = true;
    els['jp-sort'].value = 'number';
    els['jp-priced-toggle'].classList.remove('is-active');
    els['jp-snkr-link'].href = jpSnkrSearchUrl(normalized);
    els['search-input'].value = normalized + (filterText ? ' ' + filterText : '');
    updateURL();
    if (opts.scroll !== false) els['jp-view'].scrollIntoView({ behavior: 'smooth', block: 'start' });

    var seq = state.jpSeq;
    Api.getJpSet(normalized).then(function (data) {
      if (seq !== state.jpSeq || state.jpCode !== normalized) return;
      if (!data || data.error) {
        jpSetError((data && data.error) || 'Could not load that Japanese series.');
        return;
      }
      state.jp.loading = false;
      state.jp.data = data;
      renderJp();
    }).catch(function (err) {
      if (seq !== state.jpSeq) return;
      jpSetError((err && err.message) || 'Could not load that Japanese series.');
    });
  }

  function jpSetError(message) {
    if (!state.jp) return;
    state.jp.loading = false;
    state.jp.error = message;
    els['jp-grid'].innerHTML = '';
    els['jp-load-more-wrap'].hidden = true;
    els['jp-empty'].hidden = true;
    els['jp-error'].hidden = false;
    els['jp-error-message'].textContent = message;
    els['jp-status'].textContent = '';
    els['jp-sub'].textContent = 'No data loaded.';
    els['jp-meta'].textContent = 'Japanese set codes look like M2a, SV2a or S12a. The Japanese card API may also be taking a nap.';
  }

  function closeJpView() {
    state.jpCode = null;
    state.jp = null;
    els['jp-view'].hidden = true;
    els['search-input'].value = '';
    showHome();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function filterJpCards() {
    var jp = state.jp;
    if (!jp || !jp.data) return [];
    var cards = (jp.data.cards || []).slice();
    if (jp.filter) {
      var needle = jp.filter.toLowerCase();
      cards = cards.filter(function (card) {
        return String(card.name || '').toLowerCase().indexOf(needle) !== -1 ||
          String(card.number || '').toLowerCase().indexOf(needle) !== -1 ||
          String(card.localId || '').toLowerCase().indexOf(needle) !== -1 ||
          String(card.productName || '').toLowerCase().indexOf(needle) !== -1;
      });
    }
    if (jp.pricedOnly) cards = cards.filter(function (card) { return card.hasPrice; });
    var numberValue = function (card) {
      var n = parseInt(String(card.localId || '').replace(/\D/g, ''), 10);
      return isFinite(n) ? n : 0;
    };
    if (jp.sort === 'price-desc' || jp.sort === 'price-asc') {
      cards.sort(function (a, b) {
        var aP = a.hasPrice ? a.priceJPY : null;
        var bP = b.hasPrice ? b.priceJPY : null;
        if (aP === null && bP === null) return numberValue(a) - numberValue(b);
        if (aP === null) return 1;
        if (bP === null) return -1;
        return jp.sort === 'price-desc' ? bP - aP : aP - bP;
      });
    } else if (jp.sort === 'name') {
      cards.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ja'); });
    } else {
      cards.sort(function (a, b) { return numberValue(a) - numberValue(b); });
    }
    return cards;
  }

  function renderJp() {
    var jp = state.jp;
    if (!jp || !jp.data) return;
    var data = jp.data;
    var serie = data.serie && data.serie.name ? data.serie.name : 'Japanese series';
    els['jp-kicker'].textContent = 'Japanese series · ' + serie;
    els['jp-title'].innerHTML = esc(data.name) + ' <span class="tag-code">' + esc(data.code) + '</span>';

    var bits = [];
    bits.push(data.cardCount && data.cardCount.official ? data.cardCount.official + ' cards' : (data.cards || []).length + ' cards');
    if (data.cardCount && data.cardCount.total && data.cardCount.official && data.cardCount.total !== data.cardCount.official) {
      bits.push(data.cardCount.total + ' total prints');
    }
    if (data.releaseDate) bits.push('released ' + Price.formatDate(data.releaseDate));
    els['jp-sub'].textContent = bits.join(' · ');
    els['jp-meta'].innerHTML = 'Japanese printing · <strong>' + (data.pricedCount || 0) + '</strong> of ' +
      ((data.cards || []).length) + ' cards listed on SNKRDUNK · JPY market prices';
    els['jp-snkr-link'].href = jpSnkrSearchUrl(data.code);

    var filtered = filterJpCards();
    (data.cards || []).forEach(function (card) {
      knownJp.set(card.id, {
        id: card.id,
        localId: card.localId,
        number: card.number,
        name: card.name,
        setCode: data.code,
        setName: data.name,
        image: card.image,
        imageHigh: card.imageHigh,
        priceJPY: card.priceJPY,
        hasPrice: card.hasPrice
      });
    });
    var shown = filtered.slice(0, jp.visible);
    els['jp-grid'].innerHTML = shown.map(function (card) { return jpTileHTML(card); }).join('');
    els['jp-empty'].hidden = filtered.length > 0;
    els['jp-load-more-wrap'].hidden = filtered.length <= jp.visible;
    els['jp-load-note'].textContent = 'Showing ' + shown.length + ' of ' + filtered.length + ' cards';
    els['jp-status'].textContent =
      'Showing ' + shown.length + ' of ' + filtered.length + ' cards · ' + (data.pricedCount || 0) + ' priced' +
      (jp.filter ? ' · filter “' + jp.filter + '”' : '');
    els['jp-priced-toggle'].classList.toggle('is-active', jp.pricedOnly);
  }

  function jpTileHTML(card, opts) {
    opts = opts || {};
    var jpData = state.jp && state.jp.data ? state.jp.data : null;
    var code = card.setCode || (jpData ? jpData.code : '');
    var setNameText = card.setName || (jpData ? jpData.name : '');
    var localId = card.localId || '';
    var official = jpData && jpData.cardCount ? jpData.cardCount.official : null;
    var number = card.number || (localId ? (official ? localId + '/' + official : localId) : '');
    var hasPrice = Boolean(card.hasPrice && card.priceJPY);
    var value = hasPrice ? Price.priceValue({ jpPriceJPY: Number(card.priceJPY) }, state.currency) : null;
    var price = value !== null && value !== undefined ? Price.money(value, state.currency) : '—';
    var img = card.image || '';
    var badge = '';
    if (opts.rank) {
      badge = '<span class="rank-badge rank-' + (opts.rank <= 3 ? opts.rank : 'n') + '">#' + opts.rank + '</span>';
    } else if (number) {
      badge = '<span class="jp-num-badge">' + esc(number) + '</span>';
    }
    var tag = hasPrice ? (state.currency === 'JPY' ? 'SNKRDUNK' : 'JPY → ' + state.currency) : 'no listing';
    var lowLine = hasPrice
      ? (state.currency === 'JPY' ? 'lowest asking price' : Price.money(Number(card.priceJPY), 'JPY') + ' on SNKRDUNK')
      : 'not on SNKRDUNK yet';
    return '<article class="card-tile jp-tile" data-jp-id="' + esc(card.id) + '" tabindex="0" role="button" aria-label="' +
      esc(card.name + ', ' + code + ' ' + number + (hasPrice ? ', ' + price : '')) + '">' +
      '<div class="tile-media">' +
        (img ? '<img src="' + esc(img) + '" alt="' + esc(card.name) + '" loading="lazy" decoding="async" onerror="window.__jpImgErr&&window.__jpImgErr(this)" />' : '') +
        '<div class="jp-fallback"' + (img ? ' hidden' : '') + '>' +
          '<span class="jp-fallback-code">' + esc(code) + '</span>' +
          '<span class="jp-fallback-num">' + esc(localId) + '</span>' +
          '<span class="jp-fallback-label">' + esc(card.name) + '</span>' +
        '</div>' +
        badge +
        '<button type="button" class="quick-add" data-jp-add="' + esc(card.id) + '" aria-label="Add ' + esc(card.name) + ' to binder" title="Add to binder">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="tile-body">' +
        '<h3 class="tile-name" title="' + esc(card.name) + '">' + esc(card.name) + '</h3>' +
        '<p class="tile-sub">' + esc(setNameText || code) + (number ? ' · ' + esc(number) : '') + '</p>' +
        '<div class="tile-price-row">' +
          '<span class="tile-price' + (hasPrice ? '' : ' is-missing') + '">' + price + '</span>' +
          '<span class="tile-price-tag">' + esc(tag) + '</span>' +
        '</div>' +
        '<p class="tile-low">' + esc(lowLine) + '</p>' +
      '</div>' +
      '</article>';
  }

  function jpModalLoadingHTML(summary) {
    var name = summary ? summary.name : 'Japanese card';
    var img = summary && summary.imageHigh ? summary.imageHigh : summary && summary.image ? summary.image : '';
    return '<div class="modal-grid">' +
      '<div class="modal-left"><div class="modal-art">' +
        (img ? '<img src="' + esc(img) + '" alt="' + esc(name) + '" onerror="window.__jpModalImgErr&&window.__jpModalImgErr(this)" />' : '<div class="jp-loading-art"></div>') +
      '</div></div>' +
      '<div class="modal-right"><header class="modal-head">' +
        '<p class="modal-kicker">Japanese printing</p>' +
        '<h2>' + esc(name) + '</h2></header>' +
        '<div class="jp-loading-art" style="height:130px;aspect-ratio:auto"></div>' +
        '<p class="jp-modal-note">Loading full Japanese card data from TCGdex…</p>' +
      '</div></div>';
  }

  function jpModalFallbackHTML(summary, setData, message) {
    var name = summary ? summary.name : 'Japanese card';
    var img = summary && summary.imageHigh ? summary.imageHigh : summary && summary.image ? summary.image : '';
    var code = setData ? setData.code : '';
    var number = summary ? summary.number : '';
    var price = summary && summary.hasPrice ? Price.money(summary.priceJPY, 'JPY') : null;
    var url = summary && summary.productUrl ? summary.productUrl : (code ? jpSnkrSearchUrl(code) : 'https://snkrdunk.com');
    return '<div class="modal-grid">' +
      '<div class="modal-left"><div class="modal-art">' +
        (img ? '<img src="' + esc(img) + '" alt="' + esc(name) + '" onerror="window.__jpModalImgErr&&window.__jpModalImgErr(this)" />' : '<div class="jp-loading-art"></div>') +
      '</div></div>' +
      '<div class="modal-right"><header class="modal-head">' +
        '<p class="modal-kicker">' + esc(code) + (number ? ' · ' + esc(number) : '') + '</p>' +
        '<h2 id="modal-title"' + trName(name) + '>' + esc(name) + '</h2></header>' +
        '<p class="jp-modal-note">' + esc(message) + '</p>' +
        (price ? '<div class="override-banner"><span class="tag tag-jp">SNKRDUNK</span><span class="override-value">' + esc(price) + '</span><span class="override-note">lowest asking price · JPY</span></div>' : '') +
        '<div class="jp-modal-links"><a class="btn btn-primary" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">View on SNKRDUNK ↗</a></div>' +
      '</div></div>';
  }

  function openJpCard(cardId) {
    if (!cardId) return;
    var jp = state.jp;
    var summary = null;
    if (jp && jp.data) {
      for (var i = 0; i < jp.data.cards.length; i++) {
        if (jp.data.cards[i].id === cardId) { summary = jp.data.cards[i]; break; }
      }
    }
    state.currentCard = null; // the Chinese translation only applies to JP cards
    state.currentJp = { id: cardId, summary: summary };
    state.currentJpPayload = null;
    els['modal-body'].innerHTML = jpModalLoadingHTML(summary);
    openOverlay('card-modal');
    Api.getJpCard(cardId).then(function (payload) {
      if (!state.currentJp || state.currentJp.id !== cardId) return;
      if (!payload || payload.error) {
        els['modal-body'].innerHTML = jpModalFallbackHTML(summary, jp ? jp.data : null, (payload && payload.error) || 'Could not load full card data.');
        annotateTranslations(els['modal-body'], 'jp:' + cardId, 'ja');
        return;
      }
      state.currentJpPayload = payload;
      knownJp.set(cardId, payloadToJpCard(payload));
      els['modal-body'].innerHTML = jpModalHTML(payload);
      annotateTranslations(els['modal-body'], 'jp:' + cardId, 'ja');
    }).catch(function () {
      if (!state.currentJp || state.currentJp.id !== cardId) return;
      els['modal-body'].innerHTML = jpModalFallbackHTML(summary, jp ? jp.data : null, 'Could not load full card data right now.');
      annotateTranslations(els['modal-body'], 'jp:' + cardId, 'ja');
    });
  }

  /* Normalise the /api/jp/card payload into the summary shape the tiles use. */
  function payloadToJpCard(payload) {
    var card = (payload && payload.card) || {};
    var set = (payload && payload.set) || {};
    var snkr = payload && payload.snkr;
    var price = snkr && snkr.priceJPY ? Number(snkr.priceJPY) : null;
    return {
      id: card.id,
      localId: card.localId,
      number: card.localId ? (set.cardCount && set.cardCount.official ? card.localId + '/' + set.cardCount.official : card.localId) : '',
      name: card.name,
      setCode: set.id,
      setName: set.name,
      image: payload && payload.imageLow,
      imageHigh: payload && payload.imageHigh,
      priceJPY: price,
      hasPrice: Boolean(price)
    };
  }

  function addJpToBinder(card, qty) {
    if (!card || !card.id) return;
    var entry = {
      id: card.id,
      name: card.name || card.id,
      number: card.number || card.localId || '',
      set: { id: card.setCode || '', name: card.setName || '' },
      images: { small: card.image || '', large: card.imageHigh || card.image || '' },
      jpPriceJPY: card.hasPrice && card.priceJPY ? Number(card.priceJPY) : null,
      jp: true,
      updatedAt: Date.now()
    };
    Store.addToBinder(entry, qty || 1);
    knownJp.set(entry.id, card);
    renderBinderBadge();
    if (!els['binder-drawer'].hidden) renderBinder();
    toast(entry.name + ' added to binder', 'success');
  }

  function quickAddJp(id) {
    var card = knownJp.get(id);
    if (!card) return;
    addJpToBinder(card, 1);
  }

  function jpModalHTML(payload) {
    var card = payload.card || {};
    var set = payload.set || {};
    var snkr = payload.snkr;
    var cm = payload.cardmarket;
    var official = set.cardCount && (set.cardCount.official || set.cardCount.total);
    var snkrPrice = snkr && snkr.priceJPY ? snkr.priceJPY : null;
    var cmTrend = cm && (cm.trend || cm.avg) ? (cm.trend || cm.avg) : null;
    var fx = Price.getFx();
    var hkApprox = snkrPrice !== null
      ? jpyToHkd(snkrPrice)
      : cmTrend !== null ? cmTrend * fx.hkdPerEur : null;
    var img = payload.imageHigh || payload.imageLow || '';

    var chips = [];
    if (card.rarity) chips.push('<span class="tag tag-rarity">' + esc(card.rarity) + '</span>');
    if (card.category) chips.push('<span class="tag">' + esc(card.category) + '</span>');
    (card.types || []).forEach(function (type) {
      chips.push('<span class="tag tag-type" data-type="' + esc(type) + '">' + esc(type) + '</span>');
    });
    if (card.hp) chips.push('<span class="tag tag-hp">HP ' + esc(card.hp) + '</span>');
    if (card.regulationMark) chips.push('<span class="tag">Reg ' + esc(card.regulationMark) + '</span>');

    var priceCards =
      '<div class="price-card price-card--jp">' +
        '<div class="price-card-head"><span class="price-source">SNKRDUNK</span><span class="price-currency">JPY</span></div>' +
        '<div class="price-value' + (snkrPrice ? '' : ' is-missing') + '">' + (snkrPrice ? Price.money(snkrPrice, 'JPY') : 'No listings') + '</div>' +
        '<div class="price-sub">' + (snkrPrice ? (snkr.listings ? snkr.listings + ' listings · lowest asking' : 'lowest asking price') : 'no active listings right now') + '</div>' +
        (snkrPrice ? '<div class="jp-price-conversions">' + esc(jpyConversions(snkrPrice)) + '</div>' : '') +
      '</div>' +
      '<div class="price-card">' +
        '<div class="price-card-head"><span class="price-source">CARDMARKET</span><span class="price-currency">EUR</span></div>' +
        '<div class="price-value' + (cmTrend ? '' : ' is-missing') + '">' + (cmTrend ? Price.money(cmTrend, 'EUR') : '—') + '</div>' +
        '<div class="price-sub">' + (cmTrend
          ? 'trend' + (cm.avg ? ' · avg ' + Price.money(cm.avg, 'EUR') : '') + (cm.low ? ' · low ' + Price.money(cm.low, 'EUR') : '')
          : 'no Cardmarket price for this print') + '</div>' +
        (cmTrend ? '<div class="jp-price-conversions">≈ ' + Price.money(cmTrend * fx.hkdPerEur, 'HKD') +
          ' · ≈ ' + Price.money(cmTrend * (fx.hkdPerUsd / fx.hkdPerEur), 'USD') + '</div>' : '') +
      '</div>' +
      '<div class="price-card">' +
        '<div class="price-card-head"><span class="price-source">≈ HKD</span><span class="price-currency">HKD</span></div>' +
        '<div class="price-value' + (hkApprox ? '' : ' is-missing') + '">' + (hkApprox ? Price.money(hkApprox, 'HKD') : '—') + '</div>' +
        '<div class="price-sub">' + (snkrPrice ? 'converted from SNKRDUNK JPY' : cmTrend ? 'converted from Cardmarket EUR' : 'no price to convert') + '</div>' +
      '</div>';

    var attacksHtml = '';
    if (card.attacks && card.attacks.length) {
      attacksHtml = '<div class="text-block"><h4>Attacks</h4>' + card.attacks.map(function (attack) {
        var cost = (attack.cost || []).map(function (type) {
          return '<span class="energy-dot" data-type="' + esc(type) + '"></span>';
        }).join('');
        var effect = attack.effect || attack.text || '';
        return '<div class="attack"><div class="attack-head"><span class="attack-cost">' + cost + '</span>' +
          '<span class="attack-name"' + trData(attack.name, 'inline') + '>' + esc(attack.name) + '</span>' +
          '<span class="attack-damage">' + esc(attack.damage || '') + '</span></div>' +
          (effect ? '<p class="jp-attack-text"' + trData(effect, 'block') + '>' + esc(effect) + '</p>' : '') + '</div>';
      }).join('') + '</div>';
    }

    var abilitiesHtml = '';
    if (card.abilities && card.abilities.length) {
      abilitiesHtml = '<div class="text-block"><h4>Abilities</h4>' + card.abilities.map(function (ability) {
        var effect = ability.effect || ability.text || '';
        return '<div class="ability"><div class="ability-head"><span class="ability-name"' + trData(ability.name, 'inline') + '>' + esc(ability.name) + '</span>' +
          '<span class="ability-type">' + esc(ability.type || 'Ability') + '</span></div>' +
          (effect ? '<p class="jp-attack-text"' + trData(effect, 'block') + '>' + esc(effect) + '</p>' : '') + '</div>';
      }).join('') + '</div>';
    }

    var stats = [];
    if (card.weaknesses && card.weaknesses.length) {
      stats.push('<div class="stat"><span class="stat-label">Weakness</span><span class="stat-value">' +
        card.weaknesses.map(function (w) { return esc(w.type) + ' ' + esc(w.value); }).join(', ') + '</span></div>');
    }
    if (card.resistances && card.resistances.length) {
      stats.push('<div class="stat"><span class="stat-label">Resistance</span><span class="stat-value">' +
        card.resistances.map(function (r) { return esc(r.type) + ' ' + esc(r.value); }).join(', ') + '</span></div>');
    }
    if (card.retreat !== null && card.retreat !== undefined) {
      var retreatCount = Array.isArray(card.retreat) ? card.retreat.length : Number(card.retreat) || 0;
      var dots = '';
      for (var i = 0; i < retreatCount; i++) dots += '<span class="energy-dot energy-dot--retreat"></span>';
      if (dots) stats.push('<div class="stat"><span class="stat-label">Retreat</span><span class="stat-value">' + dots + '</span></div>');
    }
    if (card.illustrator) stats.push('<div class="stat"><span class="stat-label">Illustrator</span><span class="stat-value">' + esc(card.illustrator) + '</span></div>');
    if (official) stats.push('<div class="stat"><span class="stat-label">Set size</span><span class="stat-value">' + official + ' cards</span></div>');

    var snkrLink = snkr && snkr.url ? snkr.url : jpSnkrSearchUrl(set.id || '');
    var tcgdexLink = 'https://tcgdex.dev/ja/cards/' + encodeURIComponent(card.id || '');

    return '<div class="modal-grid">' +
      '<div class="modal-left">' +
        '<div class="modal-art">' +
          (img ? '<img src="' + esc(img) + '" alt="' + esc(card.name) + '" onerror="window.__jpModalImgErr&&window.__jpModalImgErr(this)" />' : '<div class="jp-loading-art"></div>') +
        '</div>' +
        '<div class="facts">' +
          factRow('Set', set.id || '—', set.name ? '<span class="fact-dim"> · ' + esc(set.name) + '</span>' : '') +
          factRow('Number', (card.localId || '') + (official ? ' / ' + official : '')) +
          factRow('Rarity', card.rarity || '—') +
          (card.illustrator ? factRow('Illustrator', card.illustrator) : '') +
          '<div class="facts-links">' +
            '<a class="outlink" href="' + esc(snkrLink) + '" target="_blank" rel="noopener noreferrer">SNKRDUNK <span aria-hidden="true">↗</span></a>' +
            '<a class="outlink" href="' + esc(tcgdexLink) + '" target="_blank" rel="noopener noreferrer">TCGdex <span aria-hidden="true">↗</span></a>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="modal-right">' +
        '<header class="modal-head">' +
          '<p class="modal-kicker">' + esc(set.id || '') + ' · ' + esc(set.name || 'Japanese printing') + '</p>' +
          '<h2 id="modal-title"' + trName(card.name) + '>' + esc(card.name) + '</h2>' +
          '<div class="chip-row">' + chips.join('') + '</div>' +
        '</header>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-primary" data-jp-modal-add="' + esc(card.id) + '">Add to binder</button>' +
          '<a class="btn btn-soft" href="' + esc(snkrLink) + '" target="_blank" rel="noopener noreferrer">View on SNKRDUNK ↗</a>' +
          '<a class="btn btn-soft" href="' + esc(tcgdexLink) + '" target="_blank" rel="noopener noreferrer">TCGdex</a>' +
          '<button type="button" class="btn btn-soft btn-zh' + (state.zh ? ' is-active' : '') + '" id="btn-modal-zh" data-zh-toggle aria-pressed="' + state.zh + '" title="Show the Chinese translation of this Japanese card">' +
            (state.zhBusy > 0 ? '翻译中…' : '中文') + '</button>' +
        '</div>' +
        '<div class="price-cards">' + priceCards + '</div>' +
        (abilitiesHtml ? '<section class="modal-section">' + abilitiesHtml + '</section>' : '') +
        (attacksHtml ? '<section class="modal-section">' + attacksHtml + '</section>' : '') +
        (stats.length ? '<section class="modal-section"><div class="text-block"><h4>Card stats</h4><div class="stat-grid">' + stats.join('') + '</div></div></section>' : '') +
        (card.description ? '<blockquote class="flavor"' + trData(card.description, 'inline') + '>' + esc(card.description) + '</blockquote>' : '') +
        '<p class="jp-modal-note">Japanese printing. SNKRDUNK prices are JPY asking prices; Cardmarket covers Japanese cards in EUR. TCGplayer does not list Japanese prints. Converted figures are approximate.</p>' +
      '</div>' +
    '</div>';
  }

  /* ------------------------------------------------------------------ binder */
  function renderBinderBadge() {
    var entries = Store.getBinder();
    var totalQty = entries.reduce(function (sum, entry) { return sum + (entry.qty || 1); }, 0);
    els['binder-count'].textContent = String(totalQty);
    els['binder-count'].hidden = totalQty === 0;
  }

  function renderBinder() {
    var entries = decoratedBinder();
    var totals = binderTotals(entries, state.currency);
    els['binder-total-value'].textContent = Price.money(totals.total, state.currency);
    els['binder-total-note'].textContent = entries.length
      ? qtyLabel(totals.count) + ' · ' + totals.priced + ' priced' + (totals.missing ? ' · ' + totals.missing + ' without a price' : '') + ' · ' + state.currency
      : 'No cards yet';

    if (!entries.length) {
      els['binder-list'].innerHTML =
        '<div class="binder-empty">' +
        '<div class="binder-empty-icon" aria-hidden="true">❒</div>' +
        '<h3>Your binder is empty</h3>' +
        '<p>Hit the <strong>+</strong> on any card — or add one from its detail view — and it will show up here with a running total.</p>' +
        '<button type="button" class="btn btn-soft" data-close="binder">Start browsing</button>' +
        '</div>';
      return;
    }

    els['binder-list'].innerHTML = entries.map(function (entry) {
      var value = Price.priceValue(entry, state.currency);
      var lineTotal = value !== null && value !== undefined ? Number(value) * (entry.qty || 1) : null;
      var img = entry.images && (entry.images.small || entry.images.large) || '';
      return '<div class="binder-row" data-binder-row="' + esc(entry.id) + '">' +
        '<button type="button" class="binder-thumb" data-open-card="' + esc(entry.id) + '" aria-label="Open ' + esc(entry.name) + '">' +
        '<img src="' + esc(img) + '" alt="" loading="lazy" onerror="window.__holoImageError&&window.__holoImageError(this)" /></button>' +
        '<div class="binder-info">' +
        '<button type="button" class="binder-name" data-open-card="' + esc(entry.id) + '">' + esc(entry.name) + '</button>' +
        '<span class="binder-set">' + esc(entry.set ? entry.set.name : '') + (entry.number ? ' · #' + esc(entry.number) : '') + '</span>' +
        '<span class="binder-price">' + (value !== null && value !== undefined ? Price.money(value, state.currency) + ' each' : 'No price') + '</span>' +
        '</div>' +
        '<div class="binder-qty">' +
        '<button type="button" class="stepper-btn" data-binder-qty="-1" aria-label="Decrease quantity">−</button>' +
        '<span class="stepper-value">' + (entry.qty || 1) + '</span>' +
        '<button type="button" class="stepper-btn" data-binder-qty="1" aria-label="Increase quantity">+</button>' +
        '</div>' +
        '<div class="binder-line">' + (lineTotal !== null ? Price.money(lineTotal, state.currency) : '—') +
        '<button type="button" class="binder-remove" data-binder-remove="' + esc(entry.id) + '" aria-label="Remove ' + esc(entry.name) + '">Remove</button>' +
        '</div>' +
        '</div>';
    }).join('');
  }

  function openBinder() {
    renderBinder();
    openOverlay('binder-drawer');
    // Refresh in the background if the data is old (best-effort, no blocking).
    var entries = Store.getBinder();
    var stale = entries.some(function (entry) {
      return !entry.updatedAt || Date.now() - entry.updatedAt > 30 * 60 * 1000;
    });
    if (stale && entries.length) refreshBinderPrices(true);
  }

  function refreshBinderPrices(silent) {
    var entries = Store.getBinder();
    if (!entries.length) {
      if (!silent) toast('Your binder is empty', 'info');
      return Promise.resolve();
    }
    var button = els['btn-binder-refresh'];
    if (!silent) { button.disabled = true; button.textContent = 'Refreshing…'; }
    var updated = 0;
    var failed = 0;
    var queue = entries.slice();
    var worker = function () {
      if (!queue.length) return Promise.resolve();
      var entry = queue.shift();
      if (entry.jp) {
        return Api.getJpCard(entry.id).then(function (payload) {
          var price = payload && payload.snkr && payload.snkr.priceJPY ? Number(payload.snkr.priceJPY) : null;
          if (price) {
            entry.jpPriceJPY = price;
            if (payload.set && payload.set.name) entry.set = { id: payload.set.id, name: payload.set.name };
            Store.updateBinderCard(entry);
            updated += 1;
          }
        }).catch(function () { failed += 1; }).then(worker);
      }
      return Api.getCard(entry.id).then(function (card) {
        if (card) { Store.updateBinderCard(decorateCard(card)); updated += 1; }
      }).catch(function () { failed += 1; }).then(worker);
    };
    var workers = [];
    for (var i = 0; i < 3; i++) workers.push(worker());
    return Promise.all(workers).then(function () {
      renderBinder();
      renderBinderBadge();
      if (!silent || updated) {
        toast(updated + ' price' + (updated === 1 ? '' : 's') + ' refreshed' + (failed ? ', ' + failed + ' failed' : ''), failed ? 'warn' : 'success');
      }
      if (!silent) { button.disabled = false; button.textContent = 'Refresh prices'; }
    });
  }

  function binderSummaryText() {
    var entries = decoratedBinder();
    var totals = binderTotals(entries, state.currency);
    var lines = ['HoloDex binder · ' + qtyLabel(totals.count) + ' · ' + Price.money(totals.total, state.currency)];
    entries.forEach(function (entry) {
      var value = Price.priceValue(entry, state.currency);
      lines.push((entry.qty || 1) + '× ' + entry.name + ' — ' + (entry.set ? entry.set.name : '') +
        (entry.number ? ' #' + entry.number : '') + ' — ' +
        (value !== null && value !== undefined ? Price.money(value, state.currency) : 'no price'));
    });
    return lines.join('\n');
  }

  function exportBinder() {
    var entries = decoratedBinder();
    if (!entries.length) { toast('Your binder is empty', 'info'); return; }
    var totals = binderTotals(entries, state.currency);
    var payload = {
      app: 'HoloDex',
      exportedAt: new Date().toISOString(),
      currency: state.currency,
      count: totals.count,
      total: Number(totals.total.toFixed(2)),
      cards: entries.map(function (entry) {
        return {
          id: entry.id,
          name: entry.name,
          set: entry.set ? entry.set.name : '',
          number: entry.number,
          rarity: entry.rarity,
          qty: entry.qty || 1,
          unitPrice: Price.priceValue(entry, state.currency),
          japanese: Boolean(entry.jp),
          jpPriceJPY: entry.jpPriceJPY || null,
          market: {
            tcgplayer: entry.tcgplayer || null,
            cardmarket: entry.cardmarket || null
          }
        };
      })
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'holodex-binder-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Binder exported', 'success');
  }

  function clearBinder() {
    var button = els['btn-binder-clear'];
    if (button.getAttribute('data-armed') !== '1') {
      button.setAttribute('data-armed', '1');
      button.textContent = 'Tap again to clear';
      clearTimeout(clearBinderTimer);
      clearBinderTimer = setTimeout(function () {
        button.removeAttribute('data-armed');
        button.textContent = 'Clear binder';
      }, 3000);
      return;
    }
    clearTimeout(clearBinderTimer);
    button.removeAttribute('data-armed');
    button.textContent = 'Clear binder';
    Store.clearBinder();
    renderBinder();
    renderBinderBadge();
    toast('Binder cleared', 'info');
  }

  /* ------------------------------------------------------------------ settings */
  function openSettings() {
    var key = Api.getApiKey();
    els['apikey-input'].value = key || '';
    if (els['zh-lang']) els['zh-lang'].value = state.zhLang;
    els['settings-mode'].textContent = Api.proxy
      ? 'Mode: local proxy · disk cache + retries · SNKRDUNK enrichment on'
      : 'Mode: direct API · no key needed for light use';
    openOverlay('settings-modal');
  }

  function saveKey() {
    var key = els['apikey-input'].value.trim();
    Api.setApiKey(key);
    if (key) toast('API key saved — bigger daily limit unlocked', 'success');
    else toast('API key removed', 'info');
    closeOverlay('settings-modal');
  }

  /* ------------------------------------------------------------------ events */
  function bindEvents() {
    els['search-form'].addEventListener('submit', function (event) {
      event.preventDefault();
      runSearch({ fresh: false });
    });

    els['search-input'].addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var value = els['search-input'].value.trim();
      if (!value && !state.setId && !state.rarity && !state.type && !state.supertype) {
        debounceTimer = setTimeout(function () { state.term = ''; showHome(); updateURL(); }, 180);
        return;
      }
      if (value.length === 1) return;
      debounceTimer = setTimeout(function () { runSearch({}); }, 520);
    });

    els['search-input'].addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        els['search-input'].value = '';
        els['search-input'].blur();
        if (!state.setId && !state.rarity && !state.type && !state.supertype) showHome();
      }
    });

    els['quick-chips'].addEventListener('click', function (event) {
      var chip = event.target.closest('[data-q], [data-set], [data-jp-set]');
      if (!chip) return;
      if (chip.hasAttribute('data-jp-set')) {
        openJpSet(chip.getAttribute('data-jp-set'));
        return;
      }
      if (chip.hasAttribute('data-q')) {
        clearFilterInputs(true);
        els['search-input'].value = chip.getAttribute('data-q');
      } else {
        clearFilterInputs(true);
        els['search-input'].value = '';
        state.setId = chip.getAttribute('data-set');
        els['set-select'].value = state.setId;
      }
      runSearch({ fresh: true });
      closeMobileSearchFocus();
      document.querySelector('.results-head') && els['results-view'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    els['currency-toggle'].addEventListener('click', function (event) {
      var button = event.target.closest('[data-currency]');
      if (!button) return;
      changeCurrency(button.getAttribute('data-currency'));
    });

    els['btn-binder'].addEventListener('click', openBinder);
    els['btn-settings'].addEventListener('click', openSettings);

    els['sort-select'].addEventListener('change', function () {
      state.sort = els['sort-select'].value;
      updateURL();
      if (isJa()) {
        if (state.jpResults.cards.length) renderJpResults();
        else if (state.term) runJpSearch({});
        return;
      }
      if (activeSearch()) {
        if (state.cards.length) renderResults();
        else runSearch({});
      }
    });

    els['set-select'].addEventListener('change', function () {
      var value = els['set-select'].value;
      if (value.indexOf('jp:') === 0) {
        els['set-select'].value = '';
        state.setId = '';
        openJpSet(value.slice(3));
        return;
      }
      runSearch({});
    });
    ['rarity-select', 'type-select'].forEach(function (id) {
      els[id].addEventListener('change', function () { runSearch({}); });
    });

    els['filter-chips'] && els['filter-chips'].addEventListener('click', function (event) {
      var chip = event.target.closest('[data-supertype]');
      if (!chip) return;
      state.supertype = chip.getAttribute('data-supertype');
      updateSupertypeChips();
      runSearch({});
    });
    // Chips live inside .filters, not #filter-chips.
    Array.prototype.forEach.call(document.querySelectorAll('[data-supertype]'), function (chip) {
      chip.addEventListener('click', function () {
        state.supertype = chip.getAttribute('data-supertype');
        updateSupertypeChips();
        runSearch({});
      });
    });

    els['btn-clear-filters'].addEventListener('click', function () {
      els['search-input'].value = '';
      clearFilterInputs(true);
      showHome();
      updateURL();
    });

    els['btn-empty-clear'].addEventListener('click', function () {
      els['search-input'].value = '';
      clearFilterInputs(true);
      showHome();
      updateURL();
    });

    els['btn-back-home'].addEventListener('click', function () {
      els['search-input'].value = '';
      clearFilterInputs(true);
      showHome();
      updateURL();
    });

    els['btn-retry'].addEventListener('click', function () { runSearch({ fresh: true }); });
    els['btn-error-settings'].addEventListener('click', openSettings);
    els['btn-load-more'].addEventListener('click', loadMore);

    // Chinese translation toggle inside the card modal (survives re-renders).
    els['modal-body'].addEventListener('click', function (event) {
      if (event.target.closest('[data-zh-toggle]')) { toggleZh(); return; }
      var jpAdd = event.target.closest('[data-jp-modal-add]');
      if (jpAdd && state.currentJpPayload) {
        addJpToBinder(payloadToJpCard(state.currentJpPayload), 1);
        jpAdd.textContent = 'Added ✓';
        jpAdd.disabled = true;
        setTimeout(function () { jpAdd.disabled = false; jpAdd.textContent = 'Add to binder'; }, 1200);
      }
    });

    if (els['lang-toggle']) {
      els['lang-toggle'].addEventListener('click', function (event) {
        var button = event.target.closest('[data-lang]');
        if (button) changeLang(button.getAttribute('data-lang'));
      });
    }

    // Card grids (delegated)
    [els['results-grid'], els['featured-grid']].forEach(function (grid) {
      grid.addEventListener('click', function (event) {
        var jpAddButton = event.target.closest('[data-jp-add]');
        if (jpAddButton) {
          event.stopPropagation();
          quickAddJp(jpAddButton.getAttribute('data-jp-add'));
          return;
        }
        var addButton = event.target.closest('[data-add-card]');
        if (addButton) {
          event.stopPropagation();
          quickAdd(addButton.getAttribute('data-add-card'));
          return;
        }
        var jpTile = event.target.closest('[data-jp-id]');
        if (jpTile) { openJpCard(jpTile.getAttribute('data-jp-id')); return; }
        var tile = event.target.closest('[data-card-id]');
        if (tile) openCardFromId(tile.getAttribute('data-card-id'));
      });
      grid.addEventListener('keydown', function (event) {
        var jpTile = event.target.closest('[data-jp-id]');
        if (jpTile && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          openJpCard(jpTile.getAttribute('data-jp-id'));
          return;
        }
        var tile = event.target.closest('[data-card-id]');
        if (!tile) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openCardFromId(tile.getAttribute('data-card-id'));
        }
      });
    });

    els['jp-grid'].addEventListener('click', function (event) {
      var jpAddButton = event.target.closest('[data-jp-add]');
      if (jpAddButton) {
        event.stopPropagation();
        quickAddJp(jpAddButton.getAttribute('data-jp-add'));
        return;
      }
      var tile = event.target.closest('[data-jp-id]');
      if (tile) openJpCard(tile.getAttribute('data-jp-id'));
    });
    els['jp-grid'].addEventListener('keydown', function (event) {
      var tile = event.target.closest('[data-jp-id]');
      if (!tile) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openJpCard(tile.getAttribute('data-jp-id'));
      }
    });
    els['btn-jp-back'].addEventListener('click', closeJpView);
    els['btn-jp-load-more'].addEventListener('click', function () {
      if (!state.jp) return;
      state.jp.visible += JP_PAGE_SIZE;
      renderJp();
    });
    els['jp-sort'].addEventListener('change', function () {
      if (!state.jp) return;
      state.jp.sort = els['jp-sort'].value;
      state.jp.visible = JP_PAGE_SIZE;
      renderJp();
    });
    els['jp-priced-toggle'].addEventListener('click', function () {
      if (!state.jp) return;
      state.jp.pricedOnly = !state.jp.pricedOnly;
      state.jp.visible = JP_PAGE_SIZE;
      renderJp();
    });
    els['btn-jp-retry'].addEventListener('click', function () {
      if (!state.jpCode) return;
      openJpSet(state.jpCode, state.jp ? state.jp.filter : '', { scroll: false });
    });
    els['btn-jp-reset-filter'].addEventListener('click', function () {
      if (!state.jp) return;
      state.jp.filter = '';
      els['search-input'].value = state.jpCode || '';
      renderJp();
    });

    els['set-strip'].addEventListener('click', function (event) {
      var jpSet = event.target.closest('[data-jp-set]');
      if (jpSet) {
        clearFilterInputs(true);
        openJpSet(jpSet.getAttribute('data-jp-set'));
        return;
      }
      var tile = event.target.closest('[data-set]');
      if (!tile) return;
      clearFilterInputs(true);
      els['search-input'].value = '';
      state.setId = tile.getAttribute('data-set');
      els['set-select'].value = state.setId;
      runSearch({ fresh: true });
      els['results-view'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // retry featured
    document.addEventListener('click', function (event) {
      if (event.target.closest('[data-retry-featured]')) {
        if (isJa()) loadJpFeatured();
        else if (state.dataMode === 'curated') loadCuratedCatalog();
        else loadFeatured();
      }
    });

    // Overlay close buttons
    document.addEventListener('click', function (event) {
      var closer = event.target.closest('[data-close]');
      if (closer) {
        var target = closer.getAttribute('data-close');
        closeOverlay(target === 'modal' ? 'card-modal' : target === 'binder' ? 'binder-drawer' : 'settings-modal');
      }
      var openCardButton = event.target.closest('[data-open-card]');
      if (openCardButton) {
        event.preventDefault();
        openCardFromId(openCardButton.getAttribute('data-open-card'));
      }
    });

    // Binder rows + actions
    els['binder-list'].addEventListener('click', function (event) {
      var qtyButton = event.target.closest('[data-binder-qty]');
      var removeButton = event.target.closest('[data-binder-remove]');
      if (removeButton) {
        Store.removeFromBinder(removeButton.getAttribute('data-binder-remove'));
        renderBinder();
        renderBinderBadge();
        toast('Removed from binder', 'info');
        return;
      }
      if (qtyButton) {
        var row = qtyButton.closest('[data-binder-row]');
        if (!row) return;
        var id = row.getAttribute('data-binder-row');
        var entry = Store.binderEntryFor(id);
        var next = Math.max(1, Math.min(99, (entry ? entry.qty || 1 : 1) + parseInt(qtyButton.getAttribute('data-binder-qty'), 10)));
        Store.setQuantity(id, next);
        renderBinder();
        renderBinderBadge();
      }
    });

    els['btn-binder-refresh'].addEventListener('click', function () { refreshBinderPrices(false); });
    els['btn-binder-copy'].addEventListener('click', function () {
      if (!Store.getBinder().length) { toast('Your binder is empty', 'info'); return; }
      copyText(binderSummaryText()).then(function () { toast('Summary copied to clipboard', 'success'); })
        .catch(function () { toast('Could not copy — clipboard blocked', 'warn'); });
    });
    els['btn-binder-export'].addEventListener('click', exportBinder);
    els['btn-binder-clear'].addEventListener('click', clearBinder);

    // Settings
    els['btn-save-key'].addEventListener('click', saveKey);
    els['btn-clear-key'].addEventListener('click', function () {
      Api.setApiKey('');
      els['apikey-input'].value = '';
      toast('API key removed', 'info');
    });
    els['btn-clear-cache'].addEventListener('click', function () {
      Api.clearCache();
      if (Api.clearTranslationCache) Api.clearTranslationCache();
      Store.clearSnapshots();
      toast('Cached prices, translations and snapshots cleared', 'success');
    });

    if (els['zh-lang']) {
      els['zh-lang'].addEventListener('change', function () {
        applyZhVariant(els['zh-lang'].value);
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (!els['card-modal'].hidden) { closeOverlay('card-modal'); return; }
        if (!els['binder-drawer'].hidden) { closeOverlay('binder-drawer'); return; }
        if (!els['settings-modal'].hidden) { closeOverlay('settings-modal'); return; }
      }
      var target = event.target;
      var typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        els['search-input'].focus();
        els['search-input'].select();
      }
      if (event.key === 'Tab' && !els['card-modal'].hidden) {
        // Minimal focus trap for the card dialog.
        var modal = els['card-modal'].querySelector('.modal');
        var focusable = modal.querySelectorAll('a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      }
    });

    // Focus search when the page loads with no active query.
    var params = new URLSearchParams(location.search);
    if (!params.get('q') && !params.get('set') && !params.get('rarity') && !params.get('type')) {
      // Leave focus alone on touch devices.
      if (window.matchMedia('(pointer: fine)').matches) {
        setTimeout(function () { els['search-input'].focus(); }, 400);
      }
    }
  }

  function closeMobileSearchFocus() {
    els['search-input'].blur();
  }

  function updateSupertypeChips() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-supertype]'), function (chip) {
      var active = chip.getAttribute('data-supertype') === state.supertype;
      chip.classList.toggle('is-active', active);
    });
  }

  function clearFilterInputs(hard) {
    clearTimeout(debounceTimer);
    state.term = '';
    if (hard) {
      state.setId = '';
      state.rarity = '';
      state.type = '';
      state.supertype = '';
      state.sort = 'value-desc';
      els['sort-select'].value = state.sort;
    }
    state.setId = els['set-select'].value = hard ? '' : state.setId;
    if (hard) {
      els['rarity-select'].value = '';
      els['type-select'].value = '';
    }
    updateSupertypeChips();
  }

  function openCardFromId(id) {
    var jpCard = knownJp.get(id);
    if (jpCard) { openJpCard(id); return; }
    var storedJp = Store.getBinder().find(function (entry) { return entry.id === id && entry.jp; });
    if (storedJp) { openJpCard(id); return; }
    var card = knownCards.get(id);
    if (!card) {
      var stored = Store.getBinder().find(function (entry) { return entry.id === id; });
      if (stored) card = decorateCard(stored);
    }
    if (!card) {
      // Last resort: fetch it.
      Api.getCard(id).then(function (fresh) { if (fresh) { knownCards.set(id, fresh); openCard(fresh); } })
        .catch(function () { toast('Could not load that card', 'warn'); });
      return;
    }
    openCard(card);
  }

  function quickAdd(id) {
    var card = knownCards.get(id) || Store.getBinder().find(function (entry) { return entry.id === id; });
    if (!card) return;
    Store.addToBinder(card, 1);
    renderBinderBadge();
    if (!els['binder-drawer'].hidden) renderBinder();
    toast(card.name + ' added to binder', 'success');
  }

  /* ------------------------------------------------------------------ url */
  function readURL() {
    try {
      var params = new URLSearchParams(location.search);
      state.term = (params.get('q') || '').slice(0, 80);
      state.setId = params.get('set') || '';
      state.rarity = params.get('rarity') || '';
      state.type = params.get('type') || '';
      state.supertype = params.get('supertype') || '';
      state.jpCode = params.get('jp') || '';
      var sort = params.get('sort');
      if (sort && SORT_VALUES.indexOf(sort) !== -1) state.sort = sort;
      state.pendingSetFilter = state.setId;
    } catch (err) { /* ignore */ }
  }

  function applyStateToInputs() {
    els['search-input'].value = state.term;
    els['sort-select'].value = isJa()
      ? (JP_SORT_VALUES.indexOf(state.sort) !== -1 ? state.sort : 'price-desc')
      : (SORT_VALUES.indexOf(state.sort) !== -1 ? state.sort : 'value-desc');
    els['rarity-select'].value = state.rarity;
    els['type-select'].value = state.type;
    updateSupertypeChips();
    if (state.setId && !isJa()) els['set-select'].value = state.setId;
  }

  /* ------------------------------------------------------------------ boot */
  function resolveLang() {
    var params = new URLSearchParams(location.search || '');
    var urlLang = params.get('lang');
    if (urlLang === 'en') return 'en';
    var stored = null;
    try { stored = Store.getCardLang ? Store.getCardLang() : null; } catch (err) { stored = null; }
    if (stored === 'en') return 'en';
    return Api.proxy ? 'ja' : 'en';
  }

  function applyLangUI() {
    var wrap = els['lang-toggle'];
    if (wrap) {
      wrap.hidden = !Api.proxy;
      Array.prototype.slice.call(wrap.querySelectorAll('[data-lang]')).forEach(function (button) {
        var active = button.getAttribute('data-lang') === state.lang;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
    }
    document.body.classList.toggle('jp-mode', isJa());
    applyCopy();
    if (els['sort-select']) {
      els['sort-select'].innerHTML = isJa()
        ? '<option value="price-desc">Highest price</option>' +
          '<option value="price-asc">Lowest price</option>' +
          '<option value="number">Card number</option>' +
          '<option value="name">Name</option>'
        : '<option value="value-desc">Highest value</option>' +
          '<option value="value-asc">Lowest value</option>' +
          '<option value="newest">Newest first</option>' +
          '<option value="oldest">Oldest first</option>' +
          '<option value="name">Name A–Z</option>';
      els['sort-select'].value = isJa()
        ? (JP_SORT_VALUES.indexOf(state.sort) !== -1 ? state.sort : 'price-desc')
        : (SORT_VALUES.indexOf(state.sort) !== -1 ? state.sort : 'value-desc');
    }
    renderQuickChips();
  }

  function renderQuickChips() {
    if (!els['quick-chips']) return;
    var chips = isJa() ? JP_QUICK_CHIPS : EN_QUICK_CHIPS;
    els['quick-chips'].innerHTML = '<span class="quick-label">Try</span>' + chips.map(function (chip) {
      if (chip.jp) {
        return '<button class="chip chip-jp" type="button" data-jp-set="' + esc(chip.jp) + '">' + esc(chip.jp) + ' · JP</button>';
      }
      if (chip.set) {
        return '<button class="chip" type="button" data-set="' + esc(chip.set) + '">' + esc(chip.label || chip.set) + '</button>';
      }
      return '<button class="chip" type="button" data-q="' + esc(chip.q) + '">' + esc(chip.q) + '</button>';
    }).join('');
  }

  function changeLang(lang) {
    if (lang !== 'ja' && lang !== 'en') return;
    if (lang === state.lang) return;
    if (lang === 'ja' && !Api.proxy) {
      toast('Japanese card data needs the local server — run node server.mjs', 'warn');
      return;
    }
    if (Store.setCardLang) Store.setCardLang(lang);
    var params = new URLSearchParams(location.search);
    if (lang === 'en') params.set('lang', 'en');
    else params.delete('lang');
    var qs = params.toString();
    location.href = location.pathname + (qs ? '?' + qs : '');
  }

  function init() {
    cacheEls();
    state.lang = resolveLang();
    state.currency = Store.getCurrency();
    state.zh = Store.getShowZh();
    state.zhLang = Store.getZhLang();
    applyLangUI();
    applyCurrencyUI();
    renderBinderBadge();
    if (els['footer-admin']) els['footer-admin'].hidden = !(Api.proxy && Api.siteConfig);

    readURL();
    applyStateToInputs();
    bindEvents();
    captureEmptyMessage();
    renderFxNote();

    loadJpSets();
    loadSiteContext().then(startContent).catch(startContent);
  }

  function loadJpSets() {
    if (!Api.proxy) return Promise.resolve([]);
    return Api.getJpSets().then(function (res) {
      if (!res || !res.ok || !Array.isArray(res.sets) || !res.sets.length) return state.jpSets;
      state.jpSets = res.sets;
      if (state.setsLoaded || isJa()) buildSetOptions();
      renderFxNote();
      return state.jpSets;
    }).catch(function () { return state.jpSets; });
  }

  function loadSiteContext() {
    return Promise.all([
      Api.getFxRates ? Api.getFxRates().catch(function () { return null; }) : Promise.resolve(null),
      Api.getSiteConfig ? Api.getSiteConfig().catch(function () { return null; }) : Promise.resolve(null)
    ]).then(function (results) {
      var fx = results[0];
      if (fx) {
        Price.setFx(fx);
        state.fx = fx;
      }
      var cfg = results[1];
      if (cfg) {
        state.siteConfig = cfg;
        state.overrides = cfg.overrides || {};
        state.siteUpdatedAt = cfg.updatedAt || null;
        state.dataMode = cfg.mode === 'curated' ? 'curated' : 'live';
      }
      renderFxNote();
    });
  }

  function updateSectionCopy() {
    if (isJa()) {
      if (els['featured-title']) els['featured-title'].textContent = 'Most valuable Japanese cards';
      if (els['featured-sub']) els['featured-sub'].textContent = 'The heavy hitters of the Japanese market, ranked by live SNKRDUNK asking price.';
      if (els['sets-sub']) els['sets-sub'].textContent = 'Every Japanese set TCGdex knows — newest first. Tap one to see the whole print run.';
      return;
    }
    var curated = state.dataMode === 'curated';
    if (els['featured-title']) els['featured-title'].textContent = curated ? 'The curated picks' : 'Most valuable right now';
    if (els['featured-sub']) {
      els['featured-sub'].textContent = curated
        ? 'Handpicked by the site owner, ranked by current price.'
        : 'The heavy hitters of the hobby, ranked by TCGplayer market price.';
    }
    if (els['sets-sub']) {
      els['sets-sub'].textContent = curated
        ? 'Sets represented in the current selection.'
        : 'Twenty-six years of cardboard, from Base Set to the newest release.';
    }
  }

  function startContent() {
    updateSectionCopy();
    var fxLabel = (Price.getFx().source || 'live') === 'live' ? 'live FX' : 'fallback FX';

    if (isJa()) {
      els['footer-mode'].textContent = 'Local proxy · Japanese cards (TCGdex) · SNKRDUNK JPY · ' + fxLabel;
      renderFxNote();
      var setsReady = state.jpSets.length ? Promise.resolve(state.jpSets) : loadJpSets();
      setsReady.then(function () {
        renderJpSetStrip();
        buildSetOptions();
        if (state.jpCode) { openJpSet(state.jpCode, '', { scroll: false, fromUrl: true }); return; }
        loadJpFeatured();
        if (state.term) runJpSearch({});
        else showHome();
      });
      startConfigPolling();
      return;
    }

    if (Api.proxy) {
      els['footer-mode'].textContent = state.dataMode === 'curated'
        ? 'Local proxy · curated catalog · ' + fxLabel
        : 'Local proxy · cached · SNKRDUNK on · ' + fxLabel;
    } else {
      els['footer-mode'].textContent = 'Direct API mode · SNKRDUNK needs server.mjs';
    }
    renderFxNote();

    if (state.jpCode) {
      openJpSet(state.jpCode, '', { scroll: true, fromUrl: true });
      startConfigPolling();
      return;
    }

    if (state.dataMode === 'curated') {
      loadCuratedCatalog();
      startConfigPolling();
      return;
    }

    loadSets();
    loadFeatured();
    if (activeSearch()) runSearch({});
    else showHome();
    startConfigPolling();
  }

  function renderFxNote() {
    if (!els['hero-note']) return;
    var fx = Price.getFx();
    if (isJa()) {
      var jpBits = ['Japanese prints from TCGdex', 'SNKRDUNK asking prices in JPY'];
      if (fx && fx.jpyPerUsd) jpBits.push('1 USD ≈ ' + Number(fx.jpyPerUsd).toFixed(1) + ' JPY');
      if (fx && fx.hkdPerUsd) jpBits.push('HKD at 1 USD = ' + fx.hkdPerUsd.toFixed(3));
      if (state.jpSets.length) jpBits.push(state.jpSets.length + ' Japanese sets indexed');
      els['hero-note'].textContent = jpBits.join(' · ');
      return;
    }
    var bits = ['Prices from TCGplayer (USD)', 'Cardmarket (EUR)', 'SNKRDUNK (JPY)'];
    if (fx && fx.hkdPerUsd) bits.push('HKD at 1 USD = ' + fx.hkdPerUsd.toFixed(3));
    if (state.jpSets.length) bits.push('JP set codes via TCGdex');
    if (state.dataMode === 'curated') bits.push('curated selection');
    els['hero-note'].textContent = bits.join(' · ');
  }

  var defaultEmptyHTML = '';
  function captureEmptyMessage() {
    var node = document.getElementById('empty-message');
    if (node) defaultEmptyHTML = node.innerHTML;
  }

  function applyEmptyMessage() {
    var node = document.getElementById('empty-message');
    if (!node) return;
    if (isJa()) {
      node.innerHTML = 'No Japanese card matched that. Try a shorter name (「リザードン」), the set code (M2a), or the card number (201/165).';
      return;
    }
    node.innerHTML = state.dataMode === 'curated'
      ? 'This site shows a hand-picked set of cards. That one is not in the current selection — try a different search or clear the filters.'
      : defaultEmptyHTML;
  }

  function loadCuratedCatalog() {
    renderSkeletons(els['featured-grid'], 6);
    els['featured-grid'].setAttribute('aria-busy', 'true');
    Api.getSiteCards().then(function (res) {
      var cards = decorateAll((res && res.cards) || []);
      cards.forEach(function (card) { knownCards.set(card.id, card); });
      state.curatedCards = cards;
      buildCuratedSets(cards);
      state.featured = sortCuratedFeatured(cards);
      els['featured-grid'].setAttribute('aria-busy', 'false');
      renderFeatured();
      renderSetStrip();
      if (activeSearch()) runSearch({});
      else showHome();
    }).catch(function () {
      els['featured-grid'].setAttribute('aria-busy', 'false');
      els['featured-grid'].innerHTML = '<p class="strip-note">Could not load the curated catalog. <button type="button" class="link-inline" data-retry-featured>Retry</button></p>';
    });
  }

  function sortCuratedFeatured(cards) {
    return (cards || []).slice().sort(function (a, b) {
      return (Price.priceValue(b, state.currency) || -1) - (Price.priceValue(a, state.currency) || -1);
    }).slice(0, 8);
  }

  function buildCuratedSets(cards) {
    var map = {};
    (cards || []).forEach(function (card) {
      var set = card.set;
      if (!set || !set.id || map[set.id]) return;
      map[set.id] = {
        id: set.id,
        name: set.name,
        series: set.series,
        releaseDate: set.releaseDate,
        printedTotal: set.printedTotal,
        total: set.total,
        images: set.images || {}
      };
    });
    state.sets = Object.keys(map).map(function (id) { return map[id]; }).sort(function (a, b) {
      return String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''));
    });
    state.setsById = {};
    state.sets.forEach(function (set) { state.setsById[set.id] = set; });
    state.setsLoaded = true;
    buildSetOptions();
    if (state.pendingSetFilter) {
      els['set-select'].value = state.pendingSetFilter;
      state.pendingSetFilter = '';
    }
    if (state.setId) els['set-select'].value = state.setId;
  }

  var configPollTimer = null;
  var refreshingConfig = false;

  function startConfigPolling() {
    if (!Api.siteConfig || configPollTimer) return;
    configPollTimer = setInterval(refreshSiteContext, 45000);
    window.addEventListener('focus', refreshSiteContext);
  }

  function refreshSiteContext() {
    if (refreshingConfig || !Api.siteConfig) return;
    refreshingConfig = true;
    Api.getSiteConfig().then(function (cfg) {
      refreshingConfig = false;
      if (!cfg) return;
      var currentMode = state.dataMode === 'curated' ? 'curated' : 'all';
      if (cfg.mode !== currentMode) {
        window.location.reload();
        return;
      }
      if (cfg.updatedAt === state.siteUpdatedAt) return;
      state.siteUpdatedAt = cfg.updatedAt;
      state.overrides = cfg.overrides || {};
      if (state.dataMode === 'curated') {
        Api.getSiteCards().then(function (res) {
          var cards = decorateAll((res && res.cards) || []);
          cards.forEach(function (card) { knownCards.set(card.id, card); });
          state.curatedCards = cards;
          state.featured = sortCuratedFeatured(cards);
          buildCuratedSets(cards);
          renderFeatured();
          renderSetStrip();
          if (state.view === 'results' && activeSearch()) runCuratedSearch();
          if (!els['binder-drawer'].hidden) renderBinder();
        });
      } else {
        knownCards.forEach(function (card) { decorateCard(card); });
        if (state.featured.length) {
          state.featured = decorateAll(state.featured);
          renderFeatured();
        }
        if (state.view === 'results' && !state.loading) renderResults();
        if (state.currentCard && !els['card-modal'].hidden) {
          state.currentCard = decorateCard(state.currentCard);
          renderModalBase(state.currentCard, true);
        }
        if (!els['binder-drawer'].hidden) renderBinder();
        renderFxNote();
      }
    }).catch(function () {
      refreshingConfig = false;
    });
  }

  // Japanese card image fallback: show the styled placeholder instead of a broken image.
  window.__jpImgErr = function (img) {
    if (!img) return;
    img.style.display = 'none';
    var media = img.parentNode;
    if (media) {
      var fallback = media.querySelector('.jp-fallback');
      if (fallback) fallback.hidden = false;
    }
  };

  window.__jpModalImgErr = function (img) {
    if (!img) return;
    img.onerror = null;
    img.src = PLACEHOLDER_IMG;
    img.classList.add('is-placeholder');
  };

  // Image fallback used from inline onerror handlers.
  window.__holoImageError = function (img) {
    if (!img || img.getAttribute('data-fallback') === '1') return;
    img.setAttribute('data-fallback', '1');
    img.src = PLACEHOLDER_IMG;
    img.classList.add('is-placeholder');
  };

  init();
})();
