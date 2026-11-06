/* ==========================================================================
   HoloDex · admin panel
   - signs in against the local server (password never reaches the browser)
   - curate the public catalog, override prices in HKD, persist to disk
   ========================================================================== */
(function () {
  'use strict';

  var Api = window.PDXApi;
  var Price = window.PDXPrice;
  var TOKEN_KEY = 'holodex.adminToken';

  var state = {
    token: '',
    mode: 'all',
    cards: [],             // [{ id, priceHKD, addedAt, card }]
    dirty: false,
    saving: false,
    searching: false,
    searchTerm: '',
    searchResults: [],
    added: new Set()
  };

  var els = {};
  var searchTimer = null;
  var searchSeq = 0;
  var clearArmed = false;
  var clearTimer = null;

  /* ---------------------------------------------------------------- utils */
  function $(id) { return document.getElementById(id); }

  function cacheEls() {
    [
      'login-view', 'admin-view', 'login-form', 'login-user', 'login-pass',
      'login-error', 'login-submit', 'server-off', 'mode-toggle', 'dirty-status',
      'btn-save', 'btn-preview', 'btn-logout', 'admin-search-form',
      'admin-search-input', 'admin-search-results', 'search-status',
      'curated-count', 'admin-curated-list', 'btn-clear-all', 'toasts'
    ].forEach(function (id) { els[id] = $(id); });
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
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
    }, 3200);
  }

  function setDirty(dirty) {
    state.dirty = dirty;
    els['dirty-status'].textContent = dirty ? 'Unsaved changes' : 'Synced';
    els['dirty-status'].classList.toggle('is-clean', !dirty);
  }

  function loginError(message) {
    if (!message) {
      els['login-error'].hidden = true;
      els['login-error'].textContent = '';
      return;
    }
    els['login-error'].hidden = false;
    els['login-error'].textContent = message;
  }

  /* ---------------------------------------------------------------- transport */
  function adminFetch(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) {
          var authError = new Error(data.error || 'Session expired. Sign in again.');
          authError.code = 'auth';
          throw authError;
        }
        if (!res.ok) {
          var error = new Error(data.error || ('Request failed (HTTP ' + res.status + ')'));
          error.code = 'http';
          throw error;
        }
        return data;
      });
    });
  }

  /* ---------------------------------------------------------------- views */
  function showLogin(message) {
    els['login-view'].hidden = false;
    els['admin-view'].hidden = true;
    loginError(message || '');
    setTimeout(function () {
      if (els['login-user']) els['login-user'].focus();
    }, 60);
  }

  function showPanel() {
    els['login-view'].hidden = true;
    els['admin-view'].hidden = false;
    loginError('');
  }

  function signOut(message) {
    state.token = '';
    state.cards = [];
    state.mode = 'all';
    state.dirty = false;
    state.added = new Set();
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (err) { /* ignore */ }
    showLogin(message || '');
  }

  /* ---------------------------------------------------------------- data */
  function applyConfig(data) {
    state.cards = ((data && data.cards) || []).map(function (entry) {
      return {
        id: entry.id,
        priceHKD: entry.priceHKD === null || entry.priceHKD === undefined ? null : Number(entry.priceHKD),
        addedAt: entry.addedAt || null,
        card: entry.card || null
      };
    });
    state.mode = data && data.mode === 'curated' ? 'curated' : 'all';
    if (data && data.fx) {
      state.fx = data.fx;
      Price.setFx(data.fx);
    }
    state.added = new Set(state.cards.map(function (entry) { return entry.id; }));
  }

  function loadConfig() {
    return adminFetch('/api/admin/config').then(function (data) {
      applyConfig(data);
      setDirty(false);
      renderMode();
      renderCatalog();
      renderSearchResults();
    }).catch(function (err) {
      if (err.code === 'auth') {
        signOut(err.message);
        return;
      }
      toast(err.message || 'Could not load the admin config', 'warn');
    });
  }

  function save() {
    if (state.saving) return;
    state.saving = true;
    els['btn-save'].disabled = true;
    els['btn-save'].textContent = 'Saving…';

    var payload = {
      mode: state.mode,
      cards: state.cards.map(function (entry) {
        return {
          id: entry.id,
          priceHKD: entry.priceHKD === null ? null : entry.priceHKD,
          addedAt: entry.addedAt
        };
      })
    };

    adminFetch('/api/admin/config', { method: 'PUT', body: JSON.stringify(payload) }).then(function (data) {
      applyConfig(data);
      setDirty(false);
      els['dirty-status'].textContent = 'Saved just now';
      renderMode();
      renderCatalog();
      renderSearchResults();
      toast('Catalog saved — the live site picks it up on the next refresh', 'success');
    }).catch(function (err) {
      if (err.code === 'auth') {
        signOut(err.message);
        return;
      }
      toast(err.message || 'Save failed', 'warn');
    }).then(function () {
      state.saving = false;
      els['btn-save'].disabled = false;
      els['btn-save'].textContent = 'Save changes';
    });
  }

  /* ---------------------------------------------------------------- render */
  function renderMode() {
    Array.prototype.slice.call(els['mode-toggle'].querySelectorAll('button')).forEach(function (button) {
      button.classList.toggle('is-active', button.getAttribute('data-mode') === state.mode);
    });
  }

  function marketHKDCard(card) {
    if (!card) return null;
    return Price.priceValue(card, 'HKD');
  }

  function renderCatalog() {
    var list = els['admin-curated-list'];
    if (!state.cards.length) {
      list.innerHTML = '<p class="admin-empty">No cards yet. Search on the left and hit <strong>Add</strong> to start building your catalog.</p>';
      els['curated-count'].textContent = '0 cards';
      return;
    }

    list.innerHTML = state.cards.map(function (entry) {
      var card = entry.card || {};
      var set = card.set || {};
      var img = (card.images && card.images.small) || '';
      var market = marketHKDCard(card);
      var meta = esc(set.name || '') +
        (card.number ? ' · #' + esc(card.number) : '') +
        (card.rarity ? ' · ' + esc(card.rarity) : '');
      return '<div class="admin-card-row" data-card-id="' + esc(entry.id) + '">' +
        '<span class="admin-thumb">' +
          (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" onerror="this.style.opacity=0.15" />' : '') +
        '</span>' +
        '<span class="admin-row-info">' +
          '<span class="admin-row-name">' + esc(card.name || entry.id) + '</span>' +
          '<span class="admin-row-meta">' + meta + '</span>' +
        '</span>' +
        '<span class="admin-price-wrap">' +
          '<span class="admin-price-field">' +
            '<span class="admin-price-prefix">HK$</span>' +
            '<input type="number" min="0.01" step="0.01" inputmode="decimal" ' +
              'data-price-input="' + esc(entry.id) + '" ' +
              'value="' + (entry.priceHKD !== null ? esc(String(entry.priceHKD)) : '') + '" ' +
              'placeholder="' + (market !== null ? esc(String(Math.round(market))) : 'market') + '" />' +
          '</span>' +
          '<span class="admin-market">' +
            (market !== null ? 'market <strong>' + esc(Price.money(market, 'HKD')) + '</strong>' : 'no market price') +
          '</span>' +
        '</span>' +
        '<button type="button" class="admin-remove" data-remove-card="' + esc(entry.id) + '">Remove</button>' +
        '</div>';
    }).join('');

    els['curated-count'].textContent = state.cards.length + (state.cards.length === 1 ? ' card' : ' cards');
  }

  function renderSearchResults() {
    var list = els['admin-search-results'];
    if (state.searching) {
      list.innerHTML = '<div class="admin-loading"><span class="spinner" aria-hidden="true"></span> Searching the whole index…</div>';
      return;
    }
    if (!state.searchResults.length) {
      list.innerHTML = '<p class="admin-empty">' +
        (state.searchTerm ? 'No cards matched that search.' : 'Start typing to search every card.') +
        '</p>';
      return;
    }

    list.innerHTML = state.searchResults.map(function (card) {
      var set = card.set || {};
      var img = (card.images && card.images.small) || '';
      var added = state.added.has(card.id);
      var market = marketHKDCard(card);
      return '<div class="admin-search-row' + (added ? ' is-added' : '') + '">' +
        '<span class="admin-thumb">' +
          (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" onerror="this.style.opacity=0.15" />' : '') +
        '</span>' +
        '<span class="admin-row-info">' +
          '<span class="admin-row-name">' + esc(card.name) + '</span>' +
          '<span class="admin-row-meta">' + esc(set.name || '') +
            (card.number ? ' · #' + esc(card.number) : '') +
            (market !== null ? ' · ' + esc(Price.money(market, 'HKD')) : '') +
          '</span>' +
        '</span>' +
        '<button type="button" class="btn btn-soft btn-small" data-add-card="' + esc(card.id) + '"' +
          (added ? ' disabled' : '') + '>' + (added ? 'Added ✓' : 'Add') + '</button>' +
        '</div>';
    }).join('');
  }

  /* ---------------------------------------------------------------- actions */
  function addCard(id) {
    if (state.added.has(id)) return;
    var card = null;
    state.searchResults.forEach(function (result) { if (result.id === id) card = result; });
    state.cards.push({
      id: id,
      priceHKD: null,
      addedAt: new Date().toISOString(),
      card: card
    });
    state.added.add(id);
    setDirty(true);
    renderCatalog();
    renderSearchResults();
    toast('Added ' + ((card && card.name) || id) + ' to the catalog', 'success');
  }

  function removeCard(id) {
    var removed = null;
    state.cards = state.cards.filter(function (entry) {
      if (entry.id === id) { removed = entry; return false; }
      return true;
    });
    state.added.delete(id);
    if (removed) {
      setDirty(true);
      renderCatalog();
      renderSearchResults();
      toast('Removed ' + ((removed.card && removed.card.name) || id), 'info');
    }
  }

  function setPrice(id, rawValue) {
    var value = rawValue === '' ? null : Number(rawValue);
    if (value !== null && (!isFinite(value) || value <= 0)) value = null;
    state.cards.forEach(function (entry) {
      if (entry.id === id) entry.priceHKD = value;
    });
    setDirty(true);
  }

  function clearCatalog() {
    var button = els['btn-clear-all'];
    if (!clearArmed) {
      clearArmed = true;
      button.textContent = 'Tap again to clear all';
      clearTimer = setTimeout(function () {
        clearArmed = false;
        button.textContent = 'Clear catalog';
      }, 3200);
      return;
    }
    clearTimeout(clearTimer);
    clearArmed = false;
    button.textContent = 'Clear catalog';
    state.cards = [];
    state.added = new Set();
    setDirty(true);
    renderCatalog();
    renderSearchResults();
    toast('Catalog cleared — hit Save to apply', 'info');
  }

  function runSearch(term) {
    var seq = ++searchSeq;
    state.searchTerm = term;
    state.searching = true;
    renderSearchResults();
    Api.searchCards({ term: term, page: 1, pageSize: 12 }, { maxAge: 2 * 60 * 1000 })
      .then(function (res) {
        if (seq !== searchSeq) return;
        state.searching = false;
        state.searchResults = (res && res.data) || [];
        renderSearchResults();
      })
      .catch(function (err) {
        if (seq !== searchSeq) return;
        state.searching = false;
        state.searchResults = [];
        renderSearchResults();
        toast(err.message || 'Card search failed', 'warn');
      });
  }

  /* ---------------------------------------------------------------- events */
  function bindEvents() {
    els['login-form'].addEventListener('submit', function (event) {
      event.preventDefault();
      var username = els['login-user'].value.trim();
      var password = els['login-pass'].value;
      if (!username || !password) return;
      loginError('');
      els['login-submit'].disabled = true;
      els['login-submit'].textContent = 'Signing in…';

      fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || !data.token) throw new Error(data.error || 'Sign in failed.');
          state.token = data.token;
          try { sessionStorage.setItem(TOKEN_KEY, data.token); } catch (err) { /* ignore */ }
          els['login-pass'].value = '';
          showPanel();
          loadConfig();
        });
      }).catch(function (err) {
        loginError(err.message || 'Sign in failed.');
      }).then(function () {
        els['login-submit'].disabled = false;
        els['login-submit'].textContent = 'Sign in';
      });
    });

    els['mode-toggle'].addEventListener('click', function (event) {
      var button = event.target.closest('[data-mode]');
      if (!button || button.getAttribute('data-mode') === state.mode) return;
      state.mode = button.getAttribute('data-mode');
      setDirty(true);
      renderMode();
    });

    els['btn-save'].addEventListener('click', save);

    els['btn-preview'].addEventListener('click', function () {
      window.open('/', '_blank', 'noopener');
    });

    els['btn-logout'].addEventListener('click', function () {
      if (state.dirty && !window.confirm('You have unsaved changes. Sign out anyway?')) return;
      adminFetch('/api/admin/logout', { method: 'POST' })
        .catch(function () { /* ignore */ })
        .then(function () { signOut(''); });
    });

    els['btn-clear-all'].addEventListener('click', clearCatalog);

    els['admin-search-form'].addEventListener('submit', function (event) {
      event.preventDefault();
      clearTimeout(searchTimer);
      var term = els['admin-search-input'].value.trim();
      if (term.length >= 2) runSearch(term);
    });

    els['admin-search-input'].addEventListener('input', function () {
      clearTimeout(searchTimer);
      var term = els['admin-search-input'].value.trim();
      if (term.length < 2) {
        searchSeq += 1;
        state.searchTerm = '';
        state.searching = false;
        state.searchResults = [];
        renderSearchResults();
        return;
      }
      searchTimer = setTimeout(function () { runSearch(term); }, 420);
    });

    els['admin-search-results'].addEventListener('click', function (event) {
      var button = event.target.closest('[data-add-card]');
      if (button) addCard(button.getAttribute('data-add-card'));
    });

    els['admin-curated-list'].addEventListener('click', function (event) {
      var removeButton = event.target.closest('[data-remove-card]');
      if (removeButton) {
        removeCard(removeButton.getAttribute('data-remove-card'));
      }
    });

    els['admin-curated-list'].addEventListener('input', function (event) {
      var input = event.target.closest('[data-price-input]');
      if (input) setPrice(input.getAttribute('data-price-input'), input.value.trim());
    });

    window.addEventListener('beforeunload', function (event) {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  /* ---------------------------------------------------------------- boot */
  function boot() {
    cacheEls();
    if (!Api || !Api.siteConfig) {
      els['server-off'].hidden = false;
      els['login-form'].hidden = true;
      return;
    }
    try { state.token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (err) { state.token = ''; }
    bindEvents();
    if (state.token) {
      showPanel();
      loadConfig();
    } else {
      showLogin();
    }
  }

  boot();
})();
