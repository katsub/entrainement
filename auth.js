// auth.js — OAuth 2.0 implicit flow, top-level REDIRECT (no popup, no
// external <script>, no client secret). Uses CLIENT_ID / SCOPE from
// config.js. See /root/.claude/plans/your-job-is-to-iterative-trinket.md
// §1 ("auth.js — OAuth without secrets") and Handoff note H3.
//
// Design (H3 — nobody but Diego can complete a real sign-in, so this file
// must be inspectable and unit-testable with no browser and no real
// token): every function that does URL building, hash parsing, state
// validation or expiry math is PURE — it takes plain arguments/objects and
// returns a value, never touching `window`/`location`/`localStorage`
// directly. The few functions that need storage/navigation/time take an
// injectable `env` object: `{location, sessionStorage, localStorage,
// history, now}`, defaulting to the real globals. Tests pass plain object
// doubles for `env` instead.
//
// Works both as a plain <script src="auth.js"> (after config.js; exposes
// `window.Auth`) and as a CommonJS module for `node --test` (see tail).

(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  var AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  var LOGIN_HINT = 'diego.fig.silva@gmail.com';
  var TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60000; // renew 60s before Google says it expires

  var STORAGE_KEYS = {
    TOKEN: 'entr.token', // localStorage: {token, expiresAt}
    STATE: 'entr.oauth.state', // sessionStorage: the `state` we sent, to check on return
    APP_STATE: 'entr.oauth.appstate', // sessionStorage: JSON app state (active tab + scroll) to restore
    SILENT_ATTEMPTED: 'entr.oauth.silentAttempted', // sessionStorage: one-shot guard, never loop
    INTERACTION_REQUIRED: 'entr.oauth.interactionRequired' // sessionStorage: last silent attempt failed
  };

  var MESSAGES = {
    SIGN_IN_REQUIRED: 'Connexion à Google requise',
    RECONNECT: 'Se reconnecter'
  };

  // ---------------------------------------------------------------------
  // Pure helpers — no globals touched, fully unit-testable
  // ---------------------------------------------------------------------

  // Cryptographically random hex string (byteLength*2 hex chars). Uses the
  // Web Crypto API in a browser, Node's `crypto` module under `node --test`,
  // falling back to Math.random only if neither is available (should never
  // happen in either target environment).
  function randomHex(byteLength) {
    var bytes = new Uint8Array(byteLength);
    var filled = false;

    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
      filled = true;
    }

    if (!filled && typeof require === 'function') {
      try {
        var nodeCrypto = require('crypto');
        var buf = nodeCrypto.randomBytes(byteLength);
        for (var i = 0; i < byteLength; i++) bytes[i] = buf[i];
        filled = true;
      } catch (e) {
        /* fall through to Math.random below */
      }
    }

    if (!filled) {
      for (var j = 0; j < byteLength; j++) bytes[j] = Math.floor(Math.random() * 256);
    }

    var hex = '';
    for (var b = 0; b < bytes.length; b++) {
      hex += ('0' + bytes[b].toString(16)).slice(-2);
    }
    return hex;
  }

  // Builds the full `accounts.google.com/o/oauth2/v2/auth` URL.
  // opts: {clientId, redirectUri, scope, state, silent, loginHint}
  function buildAuthUrl(opts) {
    var params = [
      ['client_id', opts.clientId],
      ['redirect_uri', opts.redirectUri],
      ['response_type', 'token'],
      ['scope', opts.scope],
      ['state', opts.state],
      ['include_granted_scopes', 'true'],
      ['login_hint', opts.loginHint]
    ];
    if (opts.silent) {
      params.push(['prompt', 'none']);
    }
    var qs = params
      .map(function (pair) {
        return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1] == null ? '' : pair[1]);
      })
      .join('&');
    return AUTH_ENDPOINT + '?' + qs;
  }

  // Derives the redirect_uri from a Location-like object ({origin,
  // pathname}) so it resolves to exactly the *directory* the app is served
  // from — never a filename, never a query string. This is what must equal
  // one of the two registered redirect URIs:
  //   https://katsub.github.io/entrainement/   (production)
  //   http://localhost:8000/                   (local dev)
  // Works whether the browser's address bar shows the bare directory
  // (".../entrainement/") or an explicit "index.html" — both strip down to
  // the same directory URI.
  function computeRedirectUri(loc) {
    var origin = (loc && loc.origin) || '';
    var pathname = (loc && loc.pathname) || '/';
    var lastSlash = pathname.lastIndexOf('/');
    var dir = lastSlash === -1 ? '/' : pathname.slice(0, lastSlash + 1);
    if (dir === '') dir = '/';
    return origin + dir;
  }

  // Parses a location.hash string ("#a=1&b=2" or "a=1&b=2") into a plain
  // object, url-decoding keys and values.
  function parseHashParams(hash) {
    var result = {};
    var s = hash || '';
    if (s.charAt(0) === '#') s = s.slice(1);
    if (!s) return result;
    var pairs = s.split('&');
    for (var i = 0; i < pairs.length; i++) {
      if (!pairs[i]) continue;
      var eq = pairs[i].indexOf('=');
      var rawKey = eq === -1 ? pairs[i] : pairs[i].slice(0, eq);
      var rawVal = eq === -1 ? '' : pairs[i].slice(eq + 1);
      try {
        result[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal.replace(/\+/g, '%20'));
      } catch (e) {
        // malformed percent-encoding — keep the raw text rather than throw
        result[rawKey] = rawVal;
      }
    }
    return result;
  }

  // Classifies already-parsed hash params into one of three pure outcomes.
  // Does not touch storage — callers decide what to do with each shape.
  function classifyHashResult(params) {
    if (params && params.error) {
      return { type: 'error', error: params.error, errorDescription: params.error_description };
    }
    if (params && params.access_token) {
      return {
        type: 'token',
        accessToken: params.access_token,
        state: params.state,
        expiresIn: parseInt(params.expires_in, 10)
      };
    }
    return { type: 'none' };
  }

  // True iff receivedState is non-empty and matches expectedState exactly.
  function validateState(receivedState, expectedState) {
    return !!receivedState && !!expectedState && receivedState === expectedState;
  }

  // expiresInSeconds as returned by Google, nowMs = Date.now() at receipt.
  // Subtracts a 60s safety margin so getValidToken() treats the token as
  // expired slightly before Google actually rejects it.
  function computeExpiresAt(expiresInSeconds, nowMs) {
    return nowMs + expiresInSeconds * 1000 - TOKEN_EXPIRY_SAFETY_MARGIN_MS;
  }

  // tokenRecord: {token, expiresAt} or null/undefined.
  function isTokenValid(tokenRecord, nowMs) {
    return !!(
      tokenRecord &&
      typeof tokenRecord.token === 'string' &&
      tokenRecord.token.length > 0 &&
      typeof tokenRecord.expiresAt === 'number' &&
      tokenRecord.expiresAt > nowMs
    );
  }

  // ---------------------------------------------------------------------
  // Storage helpers (null-safe wrappers so a missing/undefined storage in
  // a minimal test env object never throws)
  // ---------------------------------------------------------------------

  function getItem(storage, key) {
    if (!storage) return null;
    var v = storage.getItem(key);
    return v === undefined ? null : v;
  }
  function setItem(storage, key, value) {
    if (!storage) return;
    storage.setItem(key, value);
  }
  function removeItem(storage, key) {
    if (!storage) return;
    storage.removeItem(key);
  }

  // ---------------------------------------------------------------------
  // config.js access (CLIENT_ID / SCOPE) — browser reads window globals,
  // node reads the CommonJS export. No client secret is read, ever.
  // ---------------------------------------------------------------------

  function readConfigDefaults() {
    if (typeof window !== 'undefined' && window.CLIENT_ID) {
      return { clientId: window.CLIENT_ID, scope: window.SCOPE };
    }
    if (typeof require === 'function') {
      try {
        var cfg = require('./config.js');
        return { clientId: cfg.CLIENT_ID, scope: cfg.SCOPE };
      } catch (e) {
        /* config.js not reachable from here (e.g. isolated unit test) */
      }
    }
    return { clientId: undefined, scope: undefined };
  }

  // ---------------------------------------------------------------------
  // Stateful API — env-injectable, defaults to the real browser globals
  // ---------------------------------------------------------------------

  function defaultEnv() {
    var w = typeof window !== 'undefined' ? window : undefined;
    return {
      location: w ? w.location : undefined,
      sessionStorage: w ? w.sessionStorage : undefined,
      localStorage: w ? w.localStorage : undefined,
      history: w ? w.history : undefined,
      now: function () {
        return Date.now();
      }
    };
  }

  // Strips the hash from the visible URL via history.replaceState, per the
  // plan ("history.replaceState to strip the hash"). Never assigns
  // `location.hash` directly — that would push a new history entry / fire
  // an extra hashchange on a real Location object.
  function clearHash(env) {
    if (!env.history || typeof env.history.replaceState !== 'function') return;
    var loc = env.location || {};
    var clean = (loc.origin || '') + (loc.pathname || '') + (loc.search || '');
    env.history.replaceState(null, '', clean);
  }

  // opts: {silent, appState, clientId, scope}. `appState` is an opaque,
  // JSON-serialisable value (app.js's job to fill in — e.g. {tab, scroll})
  // stashed in sessionStorage and handed back verbatim by handleRedirect()
  // after the round trip. `clientId`/`scope` overrides exist for tests;
  // production code omits them and gets config.js's values.
  function signIn(opts, env) {
    opts = opts || {};
    env = env || defaultEnv();
    var defaults = readConfigDefaults();
    var clientId = opts.clientId || defaults.clientId;
    var scope = opts.scope || defaults.scope;
    if (!clientId || !scope) {
      throw new Error('auth.js: CLIENT_ID/SCOPE missing — is config.js loaded before auth.js?');
    }

    var state = randomHex(16);
    setItem(env.sessionStorage, STORAGE_KEYS.STATE, state);
    if (opts.appState !== undefined) {
      setItem(env.sessionStorage, STORAGE_KEYS.APP_STATE, JSON.stringify(opts.appState));
    }

    var url = buildAuthUrl({
      clientId: clientId,
      redirectUri: computeRedirectUri(env.location),
      scope: scope,
      state: state,
      silent: !!opts.silent,
      loginHint: LOGIN_HINT
    });

    if (env.location) {
      env.location.href = url; // top-level redirect — no popup, no iframe
    }
    return url;
  }

  // Call once on every page load. Returns:
  //   {status: 'none'}                       — no hash to process
  //   {status: 'signed_in', token, appState}  — token stored, hash cleared
  //   {status: 'state_mismatch'}              — rejected, no token stored
  //   {status: 'error', error, errorDescription} — Google returned ?error=…
  //     (error === 'interaction_required' is the expected silent-renewal
  //     failure; also sets the flag needsReconnect() reads)
  function handleRedirect(env) {
    env = env || defaultEnv();
    var loc = env.location || {};
    var params = parseHashParams(loc.hash);
    var outcome = classifyHashResult(params);

    if (outcome.type === 'none') {
      return { status: 'none' };
    }

    if (outcome.type === 'error') {
      clearHash(env);
      if (outcome.error === 'interaction_required') {
        setItem(env.sessionStorage, STORAGE_KEYS.INTERACTION_REQUIRED, '1');
      }
      return { status: 'error', error: outcome.error, errorDescription: outcome.errorDescription };
    }

    // outcome.type === 'token'
    var expectedState = getItem(env.sessionStorage, STORAGE_KEYS.STATE);
    removeItem(env.sessionStorage, STORAGE_KEYS.STATE);

    if (!validateState(outcome.state, expectedState)) {
      clearHash(env);
      return { status: 'state_mismatch' };
    }

    if (!isFinite(outcome.expiresIn) || outcome.expiresIn <= 0) {
      clearHash(env);
      return { status: 'error', error: 'invalid_expires_in' };
    }

    var tokenRecord = {
      token: outcome.accessToken,
      expiresAt: computeExpiresAt(outcome.expiresIn, env.now())
    };
    setItem(env.localStorage, STORAGE_KEYS.TOKEN, JSON.stringify(tokenRecord));
    clearHash(env);

    // A successful round trip re-arms the one-shot silent guard and clears
    // any stale "needs reconnect" state from a previous failed attempt.
    removeItem(env.sessionStorage, STORAGE_KEYS.SILENT_ATTEMPTED);
    removeItem(env.sessionStorage, STORAGE_KEYS.INTERACTION_REQUIRED);

    var appState = null;
    var rawAppState = getItem(env.sessionStorage, STORAGE_KEYS.APP_STATE);
    if (rawAppState) {
      removeItem(env.sessionStorage, STORAGE_KEYS.APP_STATE);
      try {
        appState = JSON.parse(rawAppState);
      } catch (e) {
        appState = null;
      }
    }

    return { status: 'signed_in', token: tokenRecord.token, appState: appState };
  }

  // Stored token if unexpired, else null. Never touches the network.
  function getValidToken(env) {
    env = env || defaultEnv();
    var raw = getItem(env.localStorage, STORAGE_KEYS.TOKEN);
    if (!raw) return null;
    var record;
    try {
      record = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    return isTokenValid(record, env.now()) ? record.token : null;
  }

  function signOut(env) {
    env = env || defaultEnv();
    removeItem(env.localStorage, STORAGE_KEYS.TOKEN);
  }

  // Call when Sheets responds 401/403. Drops the stored token, then:
  //   - if this session hasn't tried a silent renewal yet: sets the
  //     one-shot guard and redirects with prompt=none. Returns
  //     {status: 'redirecting', url}.
  //   - if the guard is already set (a silent attempt already happened
  //     this session, e.g. it came back interaction_required): does NOT
  //     redirect again — returns {status: 'reconnect_required'} so the UI
  //     can show the "Se reconnecter" button instead of looping.
  function handleAuthFailure(env, appState) {
    env = env || defaultEnv();
    removeItem(env.localStorage, STORAGE_KEYS.TOKEN);

    var alreadyAttempted = !!getItem(env.sessionStorage, STORAGE_KEYS.SILENT_ATTEMPTED);
    if (alreadyAttempted) {
      return { status: 'reconnect_required' };
    }

    setItem(env.sessionStorage, STORAGE_KEYS.SILENT_ATTEMPTED, '1');
    var url = signIn({ silent: true, appState: appState }, env);
    return { status: 'redirecting', url: url };
  }

  // True once a prompt=none attempt has come back with
  // error=interaction_required this session — the UI's cue to show the
  // "Se reconnecter" button (MESSAGES.RECONNECT).
  function needsReconnect(env) {
    env = env || defaultEnv();
    return !!getItem(env.sessionStorage, STORAGE_KEYS.INTERACTION_REQUIRED);
  }

  // What the "Se reconnecter" button calls: a full-prompt (non-silent)
  // redirect, bypassing the one-shot guard since this is explicit user
  // interaction, not an automatic retry.
  function reconnect(env, appState) {
    env = env || defaultEnv();
    removeItem(env.sessionStorage, STORAGE_KEYS.INTERACTION_REQUIRED);
    return signIn({ silent: false, appState: appState }, env);
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  var Auth = {
    // stateful (env-injectable; production code omits `env`)
    signIn: signIn,
    handleRedirect: handleRedirect,
    getValidToken: getValidToken,
    signOut: signOut,
    handleAuthFailure: handleAuthFailure,
    needsReconnect: needsReconnect,
    reconnect: reconnect,
    // pure (exported for direct unit testing, see tests/auth.test.js)
    randomHex: randomHex,
    buildAuthUrl: buildAuthUrl,
    computeRedirectUri: computeRedirectUri,
    parseHashParams: parseHashParams,
    classifyHashResult: classifyHashResult,
    validateState: validateState,
    computeExpiresAt: computeExpiresAt,
    isTokenValid: isTokenValid,
    // constants
    MESSAGES: MESSAGES,
    STORAGE_KEYS: STORAGE_KEYS,
    LOGIN_HINT: LOGIN_HINT
  };

  // Plain <script> usage: expose on window.
  if (root) {
    root.Auth = Auth;
  }

  // node --test usage: CommonJS export tail.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Auth;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
