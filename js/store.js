/* ==========================================================================
   HoloDex · local state
   Everything personal lives in localStorage: currency preference, API key,
   the binder, and "last seen price" snapshots used for deltas.
   ========================================================================== */
(function () {
  'use strict';

  var PREFS_KEY = 'holodex.prefs';
  var BINDER_KEY = 'holodex.binder';
  var SNAP_PREFIX = 'holodex.snap.';
  var MAX_BINDER = 300;

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (err) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ---------------------------------------------------------------- prefs */
  var DEFAULT_PREFS = { currency: 'JPY', cardLang: 'ja', lastUpdated: null, showZh: false, zhLang: 'zh-CN' };

  function getPrefs() {
    var prefs = readJSON(PREFS_KEY, {});
    return Object.assign({}, DEFAULT_PREFS, prefs);
  }

  function setPref(key, value) {
    var prefs = getPrefs();
    prefs[key] = value;
    writeJSON(PREFS_KEY, prefs);
    return prefs;
  }

  function normalizeCurrency(currency) {
    return currency === 'EUR' || currency === 'HKD' || currency === 'JPY' ? currency : 'USD';
  }

  function getCurrency() {
    return normalizeCurrency(getPrefs().currency);
  }

  function setCurrency(currency) {
    setPref('currency', normalizeCurrency(currency));
  }

  /* ---------------------------------------------------------------- card language */
  function normalizeCardLang(lang) {
    return lang === 'en' ? 'en' : 'ja';
  }

  function getCardLang() {
    return normalizeCardLang(getPrefs().cardLang);
  }

  function setCardLang(lang) {
    if (lang !== 'ja' && lang !== 'en') return;
    setPref('cardLang', lang);
  }

  /* ---------------------------------------------------------------- chinese */
  function normalizeZhLang(lang) {
    return lang === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  }

  function getShowZh() {
    return Boolean(getPrefs().showZh);
  }

  function setShowZh(on) {
    setPref('showZh', Boolean(on));
  }

  function getZhLang() {
    return normalizeZhLang(getPrefs().zhLang);
  }

  function setZhLang(lang) {
    setPref('zhLang', normalizeZhLang(lang));
  }

  /* ---------------------------------------------------------------- binder */
  function slimCard(card) {
    // Japanese cards carry a single scan URL (image/imageHigh) and a JPY price
    // instead of TCGplayer/Cardmarket blocks; keep them binder-safe.
    var images = card.images;
    if (!images && card.image) {
      images = { small: card.image, large: card.imageHigh || card.image };
    }
    var set = card.set;
    if (!set && (card.setCode || card.setName)) {
      set = { id: card.setCode || '', name: card.setName || '', printedTotal: null, total: null };
    }
    var jp = card.jpPriceJPY === null || card.jpPriceJPY === undefined ? null : Number(card.jpPriceJPY);
    return {
      id: card.id,
      name: card.name,
      number: card.number || '',
      rarity: card.rarity || '',
      supertype: card.supertype || '',
      types: card.types || [],
      images: images || {},
      set: set ? {
        id: set.id,
        name: set.name,
        printedTotal: set.printedTotal,
        total: set.total
      } : null,
      setName: card.setName || (set && set.name) || '',
      tcgplayer: card.tcgplayer || null,
      cardmarket: card.cardmarket || null,
      sitePriceHKD: card.sitePriceHKD != null ? Number(card.sitePriceHKD) : null,
      jpPriceJPY: isFinite(jp) && jp > 0 ? jp : null,
      jp: Boolean(card.jp) || Boolean(card.jpPriceJPY)
    };
  }

  function getBinder() {
    var list = readJSON(BINDER_KEY, []);
    return Array.isArray(list) ? list.filter(function (entry) { return entry && entry.id; }) : [];
  }

  function saveBinder(list) {
    var trimmed = list.slice(0, MAX_BINDER);
    var ok = writeJSON(BINDER_KEY, trimmed);
    if (!ok) {
      // Try again with half the cards if we ran out of quota.
      trimmed = trimmed.slice(0, Math.floor(trimmed.length / 2));
      writeJSON(BINDER_KEY, trimmed);
    }
    return trimmed;
  }

  function addToBinder(card, quantity) {
    var amount = Math.max(1, Math.min(99, Number(quantity) || 1));
    var list = getBinder();
    var existing = null;
    list.forEach(function (entry) { if (entry.id === card.id) existing = entry; });
    if (existing) {
      existing.qty = Math.min(99, (existing.qty || 1) + amount);
      existing.tcgplayer = card.tcgplayer || existing.tcgplayer;
      existing.cardmarket = card.cardmarket || existing.cardmarket;
      if (card.jpPriceJPY) existing.jpPriceJPY = Number(card.jpPriceJPY);
      existing.updatedAt = Date.now();
    } else {
      var entry = slimCard(card);
      entry.qty = amount;
      entry.addedAt = Date.now();
      entry.updatedAt = Date.now();
      list.unshift(entry);
    }
    saveBinder(list);
    return getBinder();
  }

  function removeFromBinder(id) {
    var list = getBinder().filter(function (entry) { return entry.id !== id; });
    saveBinder(list);
    return list;
  }

  function setQuantity(id, quantity) {
    var amount = Math.max(1, Math.min(99, Number(quantity) || 1));
    var list = getBinder().map(function (entry) {
      if (entry.id === id) entry.qty = amount;
      return entry;
    });
    saveBinder(list);
    return getBinder();
  }

  function clearBinder() {
    saveBinder([]);
    return [];
  }

  function updateBinderCard(card) {
    var list = getBinder().map(function (entry) {
      if (entry.id !== card.id) return entry;
      return Object.assign(entry, slimCard(card), { qty: entry.qty || 1, updatedAt: Date.now() });
    });
    saveBinder(list);
    return getBinder();
  }

  function binderEntryFor(id) {
    var found = null;
    getBinder().forEach(function (entry) { if (entry.id === id) found = entry; });
    return found;
  }

  /* ---------------------------------------------------------------- totals */
  function binderValue(currency) {
    var total = 0;
    var priced = 0;
    var missing = 0;
    var count = 0;
    getBinder().forEach(function (entry) {
      count += entry.qty || 1;
      var value = window.PDXPrice.priceValue(entry, currency);
      if (value === null || value === undefined) {
        missing += 1;
      } else {
        total += Number(value) * (entry.qty || 1);
        priced += entry.qty || 1;
      }
    });
    return { total: total, count: count, priced: priced, missing: missing };
  }

  /* ---------------------------------------------------------------- prices */
  function snapshot(card, currency) {
    var key = SNAP_PREFIX + currency + ':' + card.id;
    var value = window.PDXPrice.priceValue(card, currency);
    if (value === null || value === undefined) return null;
    var previous = readJSON(key, null);
    writeJSON(key, { value: Number(value), currency: currency, at: Date.now() });
    if (!previous || typeof previous.value !== 'number' || previous.currency !== currency) {
      return { previous: null, value: Number(value) };
    }
    return { previous: previous.value, previousAt: previous.at, value: Number(value) };
  }

  function clearSnapshots() {
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (key && key.indexOf(SNAP_PREFIX) === 0) localStorage.removeItem(key);
      }
    } catch (err) { /* ignore */ }
  }

  window.PDXStore = {
    getPrefs: getPrefs,
    setPref: setPref,
    getCurrency: getCurrency,
    setCurrency: setCurrency,
    getCardLang: getCardLang,
    setCardLang: setCardLang,
    getShowZh: getShowZh,
    setShowZh: setShowZh,
    getZhLang: getZhLang,
    setZhLang: setZhLang,
    getBinder: getBinder,
    addToBinder: addToBinder,
    removeFromBinder: removeFromBinder,
    setQuantity: setQuantity,
    clearBinder: clearBinder,
    updateBinderCard: updateBinderCard,
    binderEntryFor: binderEntryFor,
    binderValue: binderValue,
    snapshot: snapshot,
    clearSnapshots: clearSnapshots
  };
})();
