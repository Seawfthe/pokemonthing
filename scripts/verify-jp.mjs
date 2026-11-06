#!/usr/bin/env node
/**
 * Japanese storefront smoke test
 * ------------------------------------------------------------------
 *   node scripts/verify-jp.mjs                    # http://127.0.0.1:4310
 *   node scripts/verify-jp.mjs http://127.0.0.1:4399
 *
 * Asserts that every card surface answers with a *Japanese* printing:
 * TCGdex names in Japanese, set code + local number, and (for featured)
 * SNKRDUNK JPY asking prices. Also covers promo sets whose set id carries a
 * dash (`SV-P`, `M-P`) — those used to be rejected by /api/jp/card.
 *
 * Exit code 0 = all checks passed. No dependencies; needs the local server.
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:4310').replace(/\/+$/, '');

let passed = 0;
const failures = [];

function ok(label, extra) {
  passed += 1;
  console.log('PASS ' + label + (extra === undefined ? '' : ' — ' + extra));
}

function fail(label, detail) {
  failures.push(label);
  console.log('FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

function check(condition, label, extra) {
  if (condition) ok(label, extra);
  else fail(label, extra);
}

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const JA = /[\u3040-\u30ff\u4e00-\u9fff]/;

function isJapaneseName(name) {
  return typeof name === 'string' && JA.test(name);
}

function hasNumberShape(card) {
  return typeof card.number === 'string' && /^\d+(\/\d+)?$/.test(card.number);
}

async function main() {
  /* ---------------------------------------------------------------- health */
  const health = await getJson('/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`Server not reachable at ${BASE}. Start it first: node server.mjs`);
    process.exit(1);
  }
  check(health.body.mode === 'proxy', 'health: proxy mode', health.body.mode);
  check(health.body.jpSets === true, 'health: Japanese sets enabled');

  /* ----------------------------------------------------------------- sets */
  const sets = await getJson('/api/jp/sets');
  check(sets.status === 200 && sets.body.ok === true, 'sets: ok');
  check(Array.isArray(sets.body.sets) && sets.body.sets.length > 100,
    'sets: Japanese set index', sets.body.sets && sets.body.sets.length + ' sets');
  const promoSet = (sets.body.sets || []).find((set) => set.code === 'SV-P');
  check(Boolean(promoSet), 'sets: dash set code SV-P present');

  /* --------------------------------------------------------------- search */
  const search = await getJson('/api/jp/cards?q=' + encodeURIComponent('ピカチュウ') + '&page=1&pageSize=10');
  const searchCards = (search.body && search.body.cards) || [];
  check(search.status === 200 && search.body.ok === true, 'search: ok');
  check(searchCards.length >= 5, 'search: results', searchCards.length + ' cards');
  const firstSearch = searchCards[0] || {};
  check(isJapaneseName(firstSearch.name), 'search: Japanese card name', firstSearch.name);
  check(typeof firstSearch.setCode === 'string' && firstSearch.setCode.length > 0,
    'search: set code resolved', firstSearch.setCode);
  check(hasNumberShape(firstSearch), 'search: local card number', firstSearch.number);

  const empty = await getJson('/api/jp/cards?q=zzzzqqq');
  check(empty.status === 200 && empty.body.ok === true && empty.body.cards.length === 0,
    'search: unknown term returns an empty list, not an error');

  /* ------------------------------------------------------------- featured */
  const featured = await getJson('/api/jp/featured');
  const featuredCards = (featured.body && featured.body.cards) || [];
  check(featured.status === 200 && featured.body.ok === true, 'featured: ok');
  check(featuredCards.length >= 1 && featuredCards.length <= 12,
    'featured: card count', featuredCards.length + ' cards');
  check(featuredCards.every((card) => isJapaneseName(card.name) && card.hasPrice),
    'featured: Japanese names with SNKRDUNK JPY prices');
  check(featuredCards.every((card, index) =>
    index === 0 || featuredCards[index - 1].priceJPY >= card.priceJPY),
    'featured: sorted by JPY price, highest first');

  /* ------------------------------------------------------- promo set view */
  const promoRun = await getJson('/api/jp/set?code=SV-P');
  const promoCards = (promoRun.body && promoRun.body.cards) || [];
  check(promoRun.status === 200 && promoCards.length > 0,
    'set SV-P: dash set code opens', promoCards.length + ' cards');
  const promoCard = promoCards.find((card) => card.localId === '001') || promoCards[0] || {};
  check(Boolean(promoCard.localId) && hasNumberShape(promoCard),
    'set SV-P: cards carry local ids and numbers', promoCard.number);

  /* ------------------------------------- dash-set card detail (regression) */
  for (const id of ['SV-P-001', 'M-P-001', 'SV2a-201']) {
    const card = await getJson('/api/jp/card?id=' + encodeURIComponent(id));
    const payload = card.body || {};
    const detail = payload.card || {};
    const setName = payload.set && payload.set.id;
    check(card.status === 200 && detail.id === id,
      `card ${id}: detail loads`, card.status);
    check(isJapaneseName(detail.name), `card ${id}: Japanese name`, detail.name);
    check(!setName || setIdMatches(setName, id),
      `card ${id}: set id keeps its dash`, setName);
  }

  const badId = await getJson('/api/jp/card?id=' + encodeURIComponent('not-a-card-here-now'));
  check(badId.status === 400 || badId.status === 404,
    'card: malformed id is rejected cleanly', badId.status);

  /* ------------------------------------------------------------------ html */
  const page = await fetch(BASE + '/').then((res) => res.text()).catch(() => '');
  check(page.includes('日本語') && page.includes('Japanese card market'),
    'page: Japanese storefront shell');

  /* ---------------------------------------------------------------- report */
  console.log(`\n${passed}/${passed + failures.length} checks passed`);
  if (failures.length) {
    console.log('Failed: ' + failures.join(', '));
    process.exit(1);
  }
}

/** `SV-P-001` lives in set `SV-P`, not `SV`. */
function setIdMatches(setId, cardId) {
  return String(cardId).startsWith(setId + '-');
}

main().catch((err) => {
  console.error('verify-jp failed:', err.message);
  process.exit(1);
});
