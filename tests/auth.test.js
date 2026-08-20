'use strict';

// Unit tests for auth.js — the OAuth implicit top-level-redirect flow.
//
// Per plan Handoff note H3, nobody but Diego can complete a real Google
// sign-in, so these tests never touch a browser or a real token. They
// exercise auth.js's pure functions directly (URL building, hash parsing,
// state validation, expiry math) and its env-injectable stateful functions
// via plain-object doubles for `location` / `sessionStorage` /
// `localStorage` / `history` / `now`.
//
// Run with: node --test tests/auth.test.js   (zero dependencies)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Auth = require(path.join('..', 'auth.js'));

// ---------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------

class FakeStorage {
  constructor() {
    this._data = Object.create(null);
  }
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : null;
  }
  setItem(key, value) {
    this._data[key] = String(value);
  }
  removeItem(key) {
    delete this._data[key];
  }
}

function makeEnv(overrides) {
  const replaceStateCalls = [];
  const env = {
    location: { origin: 'http://localhost:8000', pathname: '/', search: '', hash: '', href: '' },
    sessionStorage: new FakeStorage(),
    localStorage: new FakeStorage(),
    history: {
      replaceState(state, title, url) {
        replaceStateCalls.push(url);
        // Mimic real History API: replaceState updates location transparently.
        const q = url.indexOf('#');
        env.location.hash = q === -1 ? '' : url.slice(q);
        const withoutHash = q === -1 ? url : url.slice(0, q);
        const s = withoutHash.indexOf('?');
        env.location.search = s === -1 ? '' : withoutHash.slice(s);
      }
    },
    now: () => 1000000
  };
  env.history._calls = replaceStateCalls;
  Object.assign(env, overrides);
  return env;
}

// ---------------------------------------------------------------------
// buildAuthUrl — every required param present; prompt=none only when silent
// ---------------------------------------------------------------------

test('buildAuthUrl includes every required OAuth param', () => {
  const url = Auth.buildAuthUrl({
    clientId: 'CID123',
    redirectUri: 'https://katsub.github.io/entrainement/',
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    state: 'STATE123',
    silent: false,
    loginHint: 'diego.fig.silva@gmail.com'
  });

  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
  assert.match(url, /[?&]client_id=CID123(&|$)/);
  assert.match(url, /[?&]redirect_uri=https%3A%2F%2Fkatsub.github.io%2Fentrainement%2F(&|$)/);
  assert.match(url, /[?&]response_type=token(&|$)/);
  assert.match(url, /[?&]scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fspreadsheets(&|$)/);
  assert.match(url, /[?&]state=STATE123(&|$)/);
  assert.match(url, /[?&]include_granted_scopes=true(&|$)/);
  assert.match(url, /[?&]login_hint=diego.fig.silva%40gmail.com(&|$)/);
});

test('buildAuthUrl omits prompt=none when not silent', () => {
  const url = Auth.buildAuthUrl({
    clientId: 'CID',
    redirectUri: 'http://localhost:8000/',
    scope: 'scope',
    state: 'st',
    silent: false,
    loginHint: 'diego.fig.silva@gmail.com'
  });
  assert.ok(!/[?&]prompt=/.test(url));
});

test('buildAuthUrl adds prompt=none only when silent:true', () => {
  const url = Auth.buildAuthUrl({
    clientId: 'CID',
    redirectUri: 'http://localhost:8000/',
    scope: 'scope',
    state: 'st',
    silent: true,
    loginHint: 'diego.fig.silva@gmail.com'
  });
  assert.match(url, /[?&]prompt=none(&|$)/);
});

test('buildAuthUrl never includes a client_secret-shaped param', () => {
  const url = Auth.buildAuthUrl({
    clientId: 'CID',
    redirectUri: 'http://localhost:8000/',
    scope: 'scope',
    state: 'st',
    silent: false,
    loginHint: 'x'
  });
  assert.ok(!/client_secret/i.test(url));
  assert.ok(!/[?&]code=/.test(url)); // implicit flow, not code flow
});

// ---------------------------------------------------------------------
// computeRedirectUri — must resolve to exactly the two registered URIs,
// never a filename or query string
// ---------------------------------------------------------------------

test('computeRedirectUri resolves GitHub Pages directory URL exactly', () => {
  const uri = Auth.computeRedirectUri({ origin: 'https://katsub.github.io', pathname: '/entrainement/' });
  assert.equal(uri, 'https://katsub.github.io/entrainement/');
});

test('computeRedirectUri strips index.html down to the same directory URI', () => {
  const uri = Auth.computeRedirectUri({
    origin: 'https://katsub.github.io',
    pathname: '/entrainement/index.html'
  });
  assert.equal(uri, 'https://katsub.github.io/entrainement/');
});

test('computeRedirectUri resolves localhost dev server exactly', () => {
  const uri = Auth.computeRedirectUri({ origin: 'http://localhost:8000', pathname: '/' });
  assert.equal(uri, 'http://localhost:8000/');
});

test('computeRedirectUri strips a query string (never part of pathname anyway)', () => {
  // query/hash never reach computeRedirectUri since it only reads
  // origin+pathname, but assert the contract explicitly: no ? or # in output.
  const uri = Auth.computeRedirectUri({ origin: 'https://katsub.github.io', pathname: '/entrainement/' });
  assert.ok(!uri.includes('?'));
  assert.ok(!uri.includes('#'));
});

// ---------------------------------------------------------------------
// parseHashParams / classifyHashResult
// ---------------------------------------------------------------------

test('parseHashParams parses a leading-# token hash', () => {
  const params = Auth.parseHashParams('#access_token=abc123&token_type=Bearer&expires_in=3600&state=xyz');
  assert.deepEqual(params, { access_token: 'abc123', token_type: 'Bearer', expires_in: '3600', state: 'xyz' });
});

test('parseHashParams handles an empty hash', () => {
  assert.deepEqual(Auth.parseHashParams(''), {});
  assert.deepEqual(Auth.parseHashParams('#'), {});
  assert.deepEqual(Auth.parseHashParams(undefined), {});
});

test('parseHashParams url-decodes values', () => {
  const params = Auth.parseHashParams('#error_description=Access%20denied%20by%20user');
  assert.equal(params.error_description, 'Access denied by user');
});

test('classifyHashResult recognizes a token response', () => {
  const outcome = Auth.classifyHashResult({ access_token: 'tok', state: 'st', expires_in: '3600' });
  assert.equal(outcome.type, 'token');
  assert.equal(outcome.accessToken, 'tok');
  assert.equal(outcome.expiresIn, 3600);
});

test('classifyHashResult recognizes an error response (interaction_required)', () => {
  const outcome = Auth.classifyHashResult({ error: 'interaction_required' });
  assert.equal(outcome.type, 'error');
  assert.equal(outcome.error, 'interaction_required');
});

test('classifyHashResult recognizes no-hash-content', () => {
  assert.equal(Auth.classifyHashResult({}).type, 'none');
});

// ---------------------------------------------------------------------
// validateState
// ---------------------------------------------------------------------

test('validateState accepts a matching state', () => {
  assert.equal(Auth.validateState('abc', 'abc'), true);
});

test('validateState rejects a mismatched state', () => {
  assert.equal(Auth.validateState('abc', 'def'), false);
});

test('validateState rejects when either side is missing', () => {
  assert.equal(Auth.validateState('', 'abc'), false);
  assert.equal(Auth.validateState('abc', ''), false);
  assert.equal(Auth.validateState(undefined, undefined), false);
});

// ---------------------------------------------------------------------
// expiry math
// ---------------------------------------------------------------------

test('computeExpiresAt applies the 60s safety margin', () => {
  const now = 1000000;
  const expiresAt = Auth.computeExpiresAt(3600, now);
  assert.equal(expiresAt, now + 3600 * 1000 - 60000);
});

test('isTokenValid: true for an unexpired token', () => {
  const now = 1000000;
  assert.equal(Auth.isTokenValid({ token: 't', expiresAt: now + 1 }, now), true);
});

test('isTokenValid: false for an expired token', () => {
  const now = 1000000;
  assert.equal(Auth.isTokenValid({ token: 't', expiresAt: now - 1 }, now), false);
  assert.equal(Auth.isTokenValid({ token: 't', expiresAt: now }, now), false); // boundary: not strictly after
});

test('isTokenValid: false for null/missing/malformed records', () => {
  const now = 1000000;
  assert.equal(Auth.isTokenValid(null, now), false);
  assert.equal(Auth.isTokenValid(undefined, now), false);
  assert.equal(Auth.isTokenValid({ expiresAt: now + 1 }, now), false); // no token
  assert.equal(Auth.isTokenValid({ token: '', expiresAt: now + 1 }, now), false); // empty token
  assert.equal(Auth.isTokenValid({ token: 't' }, now), false); // no expiresAt
});

// ---------------------------------------------------------------------
// randomHex — format + uniqueness (not cryptanalysis, just sanity)
// ---------------------------------------------------------------------

test('randomHex produces a hex string of the requested byte length', () => {
  const s = Auth.randomHex(16);
  assert.equal(s.length, 32);
  assert.match(s, /^[0-9a-f]{32}$/);
});

test('randomHex is not the same across calls', () => {
  const a = Auth.randomHex(16);
  const b = Auth.randomHex(16);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------
// signIn (stateful) — stashes state in sessionStorage, builds the URL,
// "navigates" via env.location.href
// ---------------------------------------------------------------------

test('signIn stashes a state in sessionStorage and navigates to accounts.google.com', () => {
  const env = makeEnv();
  const url = Auth.signIn({ silent: false }, env);

  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
  assert.equal(env.location.href, url);
  const stashedState = env.sessionStorage.getItem('entr.oauth.state');
  assert.ok(stashedState);
  assert.ok(url.includes('state=' + stashedState));
  assert.ok(!/[?&]prompt=/.test(url)); // not silent
});

test('signIn({silent:true}) includes prompt=none', () => {
  const env = makeEnv();
  const url = Auth.signIn({ silent: true }, env);
  assert.match(url, /[?&]prompt=none(&|$)/);
});

test('signIn stashes appState as JSON in sessionStorage', () => {
  const env = makeEnv();
  Auth.signIn({ silent: true, appState: { tab: 'treino', scroll: 240 } }, env);
  const raw = env.sessionStorage.getItem('entr.oauth.appstate');
  assert.deepEqual(JSON.parse(raw), { tab: 'treino', scroll: 240 });
});

test('signIn picks up CLIENT_ID/SCOPE from config.js when not overridden', () => {
  const env = makeEnv();
  const config = require(path.join('..', 'config.js'));
  const url = Auth.signIn({ silent: false }, env);
  assert.ok(url.includes('client_id=' + encodeURIComponent(config.CLIENT_ID)));
  assert.ok(url.includes('scope=' + encodeURIComponent(config.SCOPE)));
});

// ---------------------------------------------------------------------
// handleRedirect — success path
// ---------------------------------------------------------------------

test('handleRedirect stores the token, strips the hash, and restores appState on a valid return', () => {
  const env = makeEnv();
  // simulate signIn() having run before the "redirect"
  env.sessionStorage.setItem('entr.oauth.state', 'STATE-ABC');
  env.sessionStorage.setItem('entr.oauth.appstate', JSON.stringify({ tab: 'passados', scroll: 88 }));
  env.location.hash = '#access_token=TOK-XYZ&token_type=Bearer&expires_in=3600&state=STATE-ABC';

  const result = Auth.handleRedirect(env);

  assert.equal(result.status, 'signed_in');
  assert.equal(result.token, 'TOK-XYZ');
  assert.deepEqual(result.appState, { tab: 'passados', scroll: 88 });

  const stored = JSON.parse(env.localStorage.getItem('entr.token'));
  assert.equal(stored.token, 'TOK-XYZ');
  assert.equal(stored.expiresAt, env.now() + 3600 * 1000 - 60000);

  // hash stripped via history.replaceState, no filename/query leaked
  assert.equal(env.history._calls.length, 1);
  assert.ok(!env.history._calls[0].includes('#'));

  // one-shot state consumed, appState consumed
  assert.equal(env.sessionStorage.getItem('entr.oauth.state'), null);
  assert.equal(env.sessionStorage.getItem('entr.oauth.appstate'), null);
});

test('handleRedirect with no hash returns status "none" and touches nothing', () => {
  const env = makeEnv();
  const result = Auth.handleRedirect(env);
  assert.equal(result.status, 'none');
  assert.equal(env.localStorage.getItem('entr.token'), null);
  assert.equal(env.history._calls.length, 0);
});

// ---------------------------------------------------------------------
// handleRedirect — state mismatch must reject, no token stored
// ---------------------------------------------------------------------

test('handleRedirect rejects a state mismatch and stores no token', () => {
  const env = makeEnv();
  env.sessionStorage.setItem('entr.oauth.state', 'EXPECTED');
  env.location.hash = '#access_token=TOK&token_type=Bearer&expires_in=3600&state=WRONG';

  const result = Auth.handleRedirect(env);

  assert.equal(result.status, 'state_mismatch');
  assert.equal(env.localStorage.getItem('entr.token'), null);
});

test('handleRedirect rejects when there was no expected state stashed at all', () => {
  const env = makeEnv();
  env.location.hash = '#access_token=TOK&token_type=Bearer&expires_in=3600&state=SOMETHING';
  const result = Auth.handleRedirect(env);
  assert.equal(result.status, 'state_mismatch');
  assert.equal(env.localStorage.getItem('entr.token'), null);
});

// ---------------------------------------------------------------------
// handleRedirect — error hash handling (notably interaction_required)
// ---------------------------------------------------------------------

test('handleRedirect surfaces error=interaction_required and sets needsReconnect', () => {
  const env = makeEnv();
  env.location.hash = '#error=interaction_required';

  const result = Auth.handleRedirect(env);

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'interaction_required');
  assert.equal(Auth.needsReconnect(env), true);
});

test('handleRedirect surfaces other OAuth errors (e.g. access_denied) without setting needsReconnect', () => {
  const env = makeEnv();
  env.location.hash = '#error=access_denied';

  const result = Auth.handleRedirect(env);

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'access_denied');
  assert.equal(Auth.needsReconnect(env), false);
});

test('a successful sign-in clears a stale needsReconnect flag', () => {
  const env = makeEnv();
  env.sessionStorage.setItem('entr.oauth.interactionRequired', '1');
  env.sessionStorage.setItem('entr.oauth.state', 'S1');
  env.location.hash = '#access_token=TOK&token_type=Bearer&expires_in=3600&state=S1';

  Auth.handleRedirect(env);

  assert.equal(Auth.needsReconnect(env), false);
});

// ---------------------------------------------------------------------
// getValidToken / signOut
// ---------------------------------------------------------------------

test('getValidToken returns null when nothing is stored', () => {
  const env = makeEnv();
  assert.equal(Auth.getValidToken(env), null);
});

test('getValidToken returns the token when unexpired', () => {
  const env = makeEnv();
  env.localStorage.setItem('entr.token', JSON.stringify({ token: 'TOK', expiresAt: env.now() + 10000 }));
  assert.equal(Auth.getValidToken(env), 'TOK');
});

test('getValidToken returns null when expired', () => {
  const env = makeEnv();
  env.localStorage.setItem('entr.token', JSON.stringify({ token: 'TOK', expiresAt: env.now() - 1 }));
  assert.equal(Auth.getValidToken(env), null);
});

test('getValidToken returns null for corrupted JSON rather than throwing', () => {
  const env = makeEnv();
  env.localStorage.setItem('entr.token', '{not json');
  assert.equal(Auth.getValidToken(env), null);
});

test('signOut clears the stored token', () => {
  const env = makeEnv();
  env.localStorage.setItem('entr.token', JSON.stringify({ token: 'TOK', expiresAt: env.now() + 10000 }));
  Auth.signOut(env);
  assert.equal(env.localStorage.getItem('entr.token'), null);
  assert.equal(Auth.getValidToken(env), null);
});

// ---------------------------------------------------------------------
// handleAuthFailure — one-shot guard prevents a second silent attempt
// ---------------------------------------------------------------------

test('handleAuthFailure drops the token and attempts one silent redirect', () => {
  const env = makeEnv();
  env.localStorage.setItem('entr.token', JSON.stringify({ token: 'STALE', expiresAt: env.now() + 10000 }));

  const result = Auth.handleAuthFailure(env);

  assert.equal(result.status, 'redirecting');
  assert.match(result.url, /[?&]prompt=none(&|$)/);
  assert.equal(env.localStorage.getItem('entr.token'), null); // token dropped
  assert.equal(env.location.href, result.url); // navigated
});

test('handleAuthFailure never attempts a second silent redirect this session (one-shot guard)', () => {
  const env = makeEnv();

  const first = Auth.handleAuthFailure(env);
  assert.equal(first.status, 'redirecting');
  env.location.href = ''; // reset the spy so we can prove nothing navigates again

  const second = Auth.handleAuthFailure(env);
  assert.equal(second.status, 'reconnect_required');
  assert.equal(env.location.href, ''); // no second navigation happened
});

test('handleAuthFailure guard resets after a successful sign-in, allowing a fresh silent attempt', () => {
  const env = makeEnv();

  Auth.handleAuthFailure(env); // spends the one-shot guard
  assert.equal(Auth.handleAuthFailure(env).status, 'reconnect_required');

  // simulate a full successful round trip (e.g. user tapped "Se reconnecter")
  env.sessionStorage.setItem('entr.oauth.state', 'S-NEW');
  env.location.hash = '#access_token=NEWTOK&token_type=Bearer&expires_in=3600&state=S-NEW';
  Auth.handleRedirect(env);

  // guard is re-armed — a later 401 gets a fresh silent attempt, not an
  // immediate reconnect_required
  const after = Auth.handleAuthFailure(env);
  assert.equal(after.status, 'redirecting');
});

// ---------------------------------------------------------------------
// reconnect — explicit full-prompt redirect, bypasses the guard
// ---------------------------------------------------------------------

test('reconnect issues a non-silent redirect and clears needsReconnect', () => {
  const env = makeEnv();
  env.sessionStorage.setItem('entr.oauth.interactionRequired', '1');

  const url = Auth.reconnect(env, { tab: 'treino', scroll: 0 });

  assert.ok(!/[?&]prompt=/.test(url)); // full prompt, not silent
  assert.equal(Auth.needsReconnect(env), false);
  assert.equal(env.location.href, url);
});

// ---------------------------------------------------------------------
// French user-facing strings
// ---------------------------------------------------------------------

test('MESSAGES exposes the exact French strings the UI must use', () => {
  assert.equal(Auth.MESSAGES.SIGN_IN_REQUIRED, 'Connexion à Google requise');
  assert.equal(Auth.MESSAGES.RECONNECT, 'Se reconnecter');
});

// ---------------------------------------------------------------------
// No secrets, ever
// ---------------------------------------------------------------------

test('auth.js source contains no client_secret / GOCSPX-shaped string', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
  assert.ok(!/GOCSPX/.test(src));
  assert.ok(!/client_secret/i.test(src));
  // no dependency on Google Identity Services or any other external script
  assert.ok(!/gsi\/client/i.test(src));
  assert.ok(!/apis\.google\.com/i.test(src));
});
