// config.js — public identifiers only. NO client secret, ever.
//
// Works both as a plain <script src="config.js"> (defines globals on
// `window`) and as a CommonJS module for `node --test` (see tail).

(function (root) {
  'use strict';

  // OAuth 2.0 web-application client (project "gg-arena"). Public identifier
  // — safe to ship in a client-side app. The matching client secret is never
  // used by this app and must never be added here or anywhere else in this
  // repo.
  var CLIENT_ID = '774618988902-e5jq9nc645jld1u2jv4jetqt51g0lfqf.apps.googleusercontent.com';

  // Diego's workout spreadsheet. The ID is just a name — the sheet itself
  // stays private (Google Sheets sharing permissions), so committing the ID
  // to this public repo is fine.
  var SPREADSHEET_ID = '1u6svCgYOvD24XxNTpm-1hC-tVAen5GjCgkGeO6_OQhE';

  // OAuth scope requested by the implicit-flow sign-in.
  var SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

  // Bumped on every release that changes cached app-shell files or the
  // localStorage cache shape. Used by sw.js (cache name suffix) and by
  // sheets.js (localStorage key namespacing / invalidation).
  var CACHE_VERSION = 'entr-v3';

  var CONFIG = {
    CLIENT_ID: CLIENT_ID,
    SPREADSHEET_ID: SPREADSHEET_ID,
    SCOPE: SCOPE,
    CACHE_VERSION: CACHE_VERSION
  };

  // Plain <script> usage: expose as globals on window.
  if (root) {
    root.CLIENT_ID = CLIENT_ID;
    root.SPREADSHEET_ID = SPREADSHEET_ID;
    root.SCOPE = SCOPE;
    root.CACHE_VERSION = CACHE_VERSION;
    root.CONFIG = CONFIG;
  }

  // node --test usage: CommonJS export tail.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
