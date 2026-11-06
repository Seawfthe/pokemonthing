/*
 * Static fallback config.
 * When you open index.html directly (file://) or serve the folder with any
 * dumb static server, the app talks to the Pokémon TCG API directly.
 * The bundled Node server (server.mjs) overrides this file dynamically and
 * adds a caching proxy + SNKRDUNK enrichment.
 */
window.APP_CONFIG = Object.assign(window.APP_CONFIG || {}, {
  apiBase: 'https://api.pokemontcg.io/v2',
  proxy: false,
  snkrdunk: false,
  siteConfig: false,
  admin: false
});
