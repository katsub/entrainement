'use strict';

// Unit tests for sheets.js — Sheets REST calls + tab discovery + localStorage
// cache. Per plan Handoff note H3, no agent can complete a real Google
// sign-in, so this file never touches the network or a real token: every
// call goes through a stub `fetch` that asserts the exact request shape
// (URL, method, headers, body), and storage is a plain-object double
// implementing the Web Storage interface (getItem/setItem/removeItem/
// key/length) instead of a browser localStorage.
//
// Run with: node --test tests/sheets.test.js   (zero dependencies)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Sheets = require(path.join('..', 'sheets.js'));

const SPREADSHEET_ID = 'SHEET_ID_123';

// ---------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------

class FakeStorage {
  constructor() {
    this._data = Object.create(null);
    this._order = [];
  }
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : null;
  }
  setItem(key, value) {
    if (!Object.prototype.hasOwnProperty.call(this._data, key)) this._order.push(key);
    this._data[key] = String(value);
  }
  removeItem(key) {
    delete this._data[key];
    const idx = this._order.indexOf(key);
    if (idx !== -1) this._order.splice(idx, 1);
  }
  key(i) {
    return this._order[i];
  }
  get length() {
    return this._order.length;
  }
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

// `handler(url, init, callIndex)` -> response-like object (see jsonResponse).
function makeStubFetch(handler) {
  const calls = [];
  function stubFetch(url, init) {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init, calls.length - 1));
  }
  stubFetch.calls = calls;
  return stubFetch;
}

function makeClient(overrides) {
  const storage = (overrides && overrides.storage) || new FakeStorage();
  const opts = Object.assign(
    {
      spreadsheetId: SPREADSHEET_ID,
      storage,
      getToken: () => 'TEST_TOKEN',
      onAuthFailure: () => ({ status: 'redirecting', url: 'https://accounts.google.com/...' }),
      now: () => 1700000000000
    },
    overrides
  );
  const client = Sheets.createClient(opts);
  client._storage = storage; // expose for assertions
  return client;
}

// ---------------------------------------------------------------------
// A1 quoting / range building (H4)
// ---------------------------------------------------------------------

test('quoteSheetTitle doubles internal single quotes', () => {
  assert.equal(Sheets.quoteSheetTitle('S54'), "'S54'");
  assert.equal(Sheets.quoteSheetTitle("L'été"), "'L''été'");
});

test('buildValuesGetUrl percent-encodes the range but leaves quotes/! alone', () => {
  const url = Sheets.buildValuesGetUrl(SPREADSHEET_ID, 'S54');
  assert.equal(url, `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/'S54'!A%3AZ`);
  // No valueRenderOption anywhere (H4) — the Python defaults are implicit.
  assert.ok(!url.includes('valueRenderOption'));
});

test('buildValuesUpdateUrl carries valueInputOption=USER_ENTERED and the cell A1 ref', () => {
  const url = Sheets.buildValuesUpdateUrl(SPREADSHEET_ID, 'S54', 'O12');
  assert.equal(url, `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/'S54'!O12?valueInputOption=USER_ENTERED`);
});

test('buildMetadataUrl requests exactly title,hidden,index', () => {
  const url = Sheets.buildMetadataUrl(SPREADSHEET_ID);
  assert.equal(
    url,
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties(title%2Chidden%2Cindex)`
  );
});

test('buildBatchGetUrl repeats ranges= per title, each quoted !C11', () => {
  const url = Sheets.buildBatchGetUrl(SPREADSHEET_ID, ['S54', 'S53']);
  assert.equal(
    url,
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchGet?ranges='S54'!C11&ranges='S53'!C11`
  );
});

// ---------------------------------------------------------------------
// colToLetter — port of server.py's col_to_letter
// ---------------------------------------------------------------------

test('colToLetter matches server.py col_to_letter (0-based, bijective base26)', () => {
  assert.equal(Sheets.colToLetter(0), 'A');
  assert.equal(Sheets.colToLetter(13), 'N');
  assert.equal(Sheets.colToLetter(14), 'O');
  assert.equal(Sheets.colToLetter(25), 'Z');
  assert.equal(Sheets.colToLetter(26), 'AA');
  assert.equal(Sheets.colToLetter(27), 'AB');
});

// ---------------------------------------------------------------------
// coerceValue — parity with update_cell_internal (server.py:1913-1921)
// ---------------------------------------------------------------------

test('coerceValue: "." present -> float, else int, else keep string', () => {
  assert.equal(Sheets.coerceValue('82.5'), 82.5);
  assert.equal(Sheets.coerceValue('10'), 10);
  assert.equal(Sheets.coerceValue('-5'), -5);
  assert.equal(Sheets.coerceValue('-5.25'), -5.25);
});

test('coerceValue: "82,5" (comma, not dot) stays a string, exactly like server.py', () => {
  assert.equal(Sheets.coerceValue('82,5'), '82,5');
});

test('coerceValue: trailing garbage does not parse (Python ValueError parity)', () => {
  assert.equal(Sheets.coerceValue('12.5abc'), '12.5abc');
  assert.equal(Sheets.coerceValue('12abc'), '12abc');
});

test('coerceValue: empty string and free text stay strings', () => {
  assert.equal(Sheets.coerceValue(''), '');
  assert.equal(Sheets.coerceValue('bon travail'), 'bon travail');
});

test('coerceValue: non-string input passes through unchanged', () => {
  assert.equal(Sheets.coerceValue(42), 42);
});

// ---------------------------------------------------------------------
// isJourCell — the C11 filter rule
// ---------------------------------------------------------------------

test('isJourCell is case-insensitive and rejects empty/other text', () => {
  assert.equal(Sheets.isJourCell('JOUR 3'), true);
  assert.equal(Sheets.isJourCell('jour 1'), true);
  assert.equal(Sheets.isJourCell('Semaine JOUR X'), true);
  assert.equal(Sheets.isJourCell('REPOS'), false);
  assert.equal(Sheets.isJourCell(''), false);
  assert.equal(Sheets.isJourCell(null), false);
  assert.equal(Sheets.isJourCell(undefined), false);
});

// ---------------------------------------------------------------------
// selectStaleTabKeys — 31-day retention, current/previous always protected
// ---------------------------------------------------------------------

test('selectStaleTabKeys prunes old unprotected entries, keeps young and protected ones', () => {
  const now = 1700000000000;
  const DAY = 24 * 60 * 60 * 1000;
  const entries = [
    { title: 'S50', fetchedAt: now - 40 * DAY }, // old, unprotected -> prune
    { title: 'S51', fetchedAt: now - 5 * DAY }, // young -> keep
    { title: 'S52', fetchedAt: now - 40 * DAY, }, // old but protected -> keep
    { title: 'S53', fetchedAt: now - 32 * DAY } // just past 31 days -> prune
  ];
  const stale = Sheets.selectStaleTabKeys(entries, ['S52'], now);
  assert.deepEqual(stale.sort(), ['S50', 'S53']);
});

test('selectStaleTabKeys keeps an entry exactly at the 31-day boundary', () => {
  const now = 1700000000000;
  const DAY = 24 * 60 * 60 * 1000;
  const entries = [{ title: 'S49', fetchedAt: now - 31 * DAY }];
  const stale = Sheets.selectStaleTabKeys(entries, [], now);
  assert.deepEqual(stale, []);
});

// ---------------------------------------------------------------------
// listWorkoutSheets — GET metadata, ONE batchGet, hidden/JOUR filtering,
// order preservation
// ---------------------------------------------------------------------

test('listWorkoutSheets: filters hidden and non-JOUR tabs, preserves order, writes entr.meta', async () => {
  const storage = new FakeStorage();
  const fetchCalls = [];
  const fetch = makeStubFetch((url, init) => {
    fetchCalls.push(url);
    if (url.includes('values:batchGet')) {
      return jsonResponse(200, {
        valueRanges: [
          { values: [['JOUR 1']] }, // S1: qualifies
          { values: [['REPOS']] }, // S2: not JOUR -> excluded
          { values: [['JOUR 2']] }, // S3: hidden -> excluded despite JOUR
          { values: [['jour 3']] } // S4: qualifies (case-insensitive)
        ]
      });
    }
    // metadata call
    return jsonResponse(200, {
      sheets: [
        { properties: { title: 'S1', hidden: false, index: 0 } },
        { properties: { title: 'S2', hidden: false, index: 1 } },
        { properties: { title: 'S3', hidden: true, index: 2 } },
        { properties: { title: 'S4', hidden: false, index: 3 } }
      ]
    });
  });

  const client = makeClient({ storage, fetch });
  const titles = await client.listWorkoutSheets();

  assert.deepEqual(titles, ['S1', 'S4']); // order preserved, hidden + non-JOUR dropped

  // Exactly 2 calls: one metadata GET, one batchGet.
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].init.method, 'GET');
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer TEST_TOKEN');
  assert.ok(fetch.calls[0].url.includes('fields=sheets.properties'));
  assert.ok(fetch.calls[1].url.includes('values:batchGet'));
  assert.ok(fetch.calls[1].url.includes("ranges='S1'!C11"));
  assert.ok(fetch.calls[1].url.includes("ranges='S4'!C11"));

  // entr.meta written with the qualifying titles.
  const meta = JSON.parse(storage.getItem('entr.meta'));
  assert.deepEqual(meta.workoutSheets, ['S1', 'S4']);
  assert.equal(meta.fetchedAt, 1700000000000);
});

test('listWorkoutSheets: no sheets found returns [] without throwing', async () => {
  const fetch = makeStubFetch(() => jsonResponse(200, { sheets: [] }));
  const client = makeClient({ fetch });
  const titles = await client.listWorkoutSheets();
  assert.deepEqual(titles, []);
  assert.equal(fetch.calls.length, 1); // no batchGet when there are no sheets at all
});

test('listWorkoutSheets prunes stale unrelated tabs and protects current/previous', async () => {
  const storage = new FakeStorage();
  const now = 1700000000000;
  const DAY = 24 * 60 * 60 * 1000;
  // Pre-seed cache: S1 (current, old) must survive; S0 (unrelated, old) must be dropped.
  storage.setItem('entr.tab.S1', JSON.stringify({ sheet_name: 'S1', values: [], fetchedAt: now - 40 * DAY }));
  storage.setItem('entr.tab.S0', JSON.stringify({ sheet_name: 'S0', values: [], fetchedAt: now - 40 * DAY }));

  const fetch = makeStubFetch((url) => {
    if (url.includes('values:batchGet')) {
      return jsonResponse(200, { valueRanges: [{ values: [['JOUR 1']] }] });
    }
    return jsonResponse(200, { sheets: [{ properties: { title: 'S1', hidden: false, index: 0 } }] });
  });

  const client = makeClient({ storage, fetch, now: () => now });
  await client.listWorkoutSheets();

  assert.equal(storage.getItem('entr.tab.S1') !== null, true, 'current tab must be protected');
  assert.equal(storage.getItem('entr.tab.S0'), null, 'unrelated stale tab must be pruned');
});

// ---------------------------------------------------------------------
// getTab — GET values, no valueRenderOption, write-through cache
// ---------------------------------------------------------------------

test('getTab: GET with no valueRenderOption, returns {sheet_name, values}, caches it', async () => {
  const storage = new FakeStorage();
  const fetch = makeStubFetch((url) => {
    assert.ok(!url.includes('valueRenderOption'));
    assert.ok(url.endsWith("/values/'S54'!A%3AZ"));
    return jsonResponse(200, { values: [['a', 'b'], ['c']] });
  });

  const client = makeClient({ storage, fetch });
  const data = await client.getTab('S54');

  assert.deepEqual(data, { sheet_name: 'S54', values: [['a', 'b'], ['c']] });
  assert.equal(fetch.calls[0].init.method, 'GET');
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer TEST_TOKEN');

  const cached = JSON.parse(storage.getItem('entr.tab.S54'));
  assert.deepEqual(cached, { sheet_name: 'S54', values: [['a', 'b'], ['c']], fetchedAt: 1700000000000 });
});

test('getTab: missing values in response falls back to []', async () => {
  const fetch = makeStubFetch(() => jsonResponse(200, {}));
  const client = makeClient({ fetch });
  const data = await client.getTab('S54');
  assert.deepEqual(data.values, []);
});

test('getCachedTab reads the cache synchronously, null when absent or corrupt', () => {
  const storage = new FakeStorage();
  const client = makeClient({ storage });
  assert.equal(client.getCachedTab('S54'), null);

  storage.setItem('entr.tab.S54', JSON.stringify({ sheet_name: 'S54', values: [[1]], fetchedAt: 123 }));
  assert.deepEqual(client.getCachedTab('S54'), { sheet_name: 'S54', values: [[1]], fetchedAt: 123 });

  storage.setItem('entr.tab.S55', 'not json {{{');
  assert.equal(client.getCachedTab('S55'), null);
});

// ---------------------------------------------------------------------
// getLastTab / getPastTab — index -1 / -2
// ---------------------------------------------------------------------

function makeDiscoveryFetch(titles, extraHandler) {
  return makeStubFetch((url) => {
    if (url.includes('values:batchGet')) {
      return jsonResponse(200, { valueRanges: titles.map(() => ({ values: [['JOUR X']] })) });
    }
    if (url.includes('/values/')) {
      return extraHandler ? extraHandler(url) : jsonResponse(200, { values: [['x']] });
    }
    return jsonResponse(200, { sheets: titles.map((t, i) => ({ properties: { title: t, hidden: false, index: i } })) });
  });
}

test('getLastTab resolves to the last (current-week) qualifying tab', async () => {
  const fetch = makeDiscoveryFetch(['S52', 'S53', 'S54']);
  const client = makeClient({ fetch });
  const result = await client.getLastTab();
  assert.equal(result.title, 'S54');
  assert.equal(result.sheet_name, 'S54');
});

test('getPastTab resolves to the second-to-last (previous-week) qualifying tab', async () => {
  const fetch = makeDiscoveryFetch(['S52', 'S53', 'S54']);
  const client = makeClient({ fetch });
  const result = await client.getPastTab();
  assert.equal(result.title, 'S53');
});

test('getLastTab throws clearly when there are no workout sheets', async () => {
  const fetch = makeDiscoveryFetch([]);
  const client = makeClient({ fetch });
  await assert.rejects(() => client.getLastTab(), /No workout sheets found/);
});

test('getPastTab throws clearly when only one workout sheet exists', async () => {
  const fetch = makeDiscoveryFetch(['S54']);
  const client = makeClient({ fetch });
  await assert.rejects(() => client.getPastTab(), /out of range/);
});

// ---------------------------------------------------------------------
// updateCell / updateRPE — PUT, valueInputOption=USER_ENTERED, body shape,
// write-through cache patch
// ---------------------------------------------------------------------

test('updateCell: PUT with valueInputOption=USER_ENTERED and body {values:[[v]]}', async () => {
  const fetch = makeStubFetch((url, init) => {
    assert.equal(init.method, 'PUT');
    assert.ok(url.includes('valueInputOption=USER_ENTERED'));
    assert.ok(url.includes("'S54'!N12"));
    assert.deepEqual(JSON.parse(init.body), { values: [[82.5]] });
    return jsonResponse(200, {});
  });
  const client = makeClient({ fetch });
  await client.updateCell('S54', 12, 13, '82.5'); // col 13 -> N, coerced to float
});

test('updateCell: "82,5" is sent as a string (French-locale comma stays untouched)', async () => {
  const fetch = makeStubFetch((url, init) => {
    assert.deepEqual(JSON.parse(init.body), { values: [['82,5']] });
    return jsonResponse(200, {});
  });
  const client = makeClient({ fetch });
  await client.updateCell('S54', 12, 13, '82,5');
});

test('updateCell write-through patches the cached tab, padding the row as needed', async () => {
  const storage = new FakeStorage();
  storage.setItem('entr.tab.S54', JSON.stringify({ sheet_name: 'S54', values: [['a']], fetchedAt: 999 }));
  const fetch = makeStubFetch(() => jsonResponse(200, {}));
  const client = makeClient({ storage, fetch });

  await client.updateCell('S54', 3, 5, '10'); // row 3 doesn't exist yet, col 5 padding needed

  const cached = JSON.parse(storage.getItem('entr.tab.S54'));
  assert.equal(cached.values.length, 3);
  assert.deepEqual(cached.values[0], ['a']);
  assert.deepEqual(cached.values[1], []);
  assert.deepEqual(cached.values[2], ['', '', '', '', '', 10]);
  assert.equal(cached.fetchedAt, 999, 'write-through must not bump fetchedAt');
});

test('updateCell write-through is a no-op when the tab was never cached', async () => {
  const storage = new FakeStorage();
  const fetch = makeStubFetch(() => jsonResponse(200, {}));
  const client = makeClient({ storage, fetch });
  await client.updateCell('S54', 3, 5, '10'); // should not throw
  assert.equal(storage.getItem('entr.tab.S54'), null);
});

test('updateRPE: same PUT pinned to column O regardless of caller', async () => {
  const fetch = makeStubFetch((url, init) => {
    assert.ok(url.includes("'S54'!O12"));
    assert.deepEqual(JSON.parse(init.body), { values: [[8.5]] });
    return jsonResponse(200, {});
  });
  const client = makeClient({ fetch });
  await client.updateRPE('S54', 12, '8.5');
});

test('updateRPE write-through patches column index 14 (O)', async () => {
  const storage = new FakeStorage();
  storage.setItem('entr.tab.S54', JSON.stringify({ sheet_name: 'S54', values: [[]], fetchedAt: 1 }));
  const fetch = makeStubFetch(() => jsonResponse(200, {}));
  const client = makeClient({ storage, fetch });
  await client.updateRPE('S54', 1, '9');
  const cached = JSON.parse(storage.getItem('entr.tab.S54'));
  assert.equal(cached.values[0][Sheets.RPE_COLUMN_INDEX], 9);
  assert.equal(cached.values[0].length, 15);
});

// ---------------------------------------------------------------------
// Auth header on every request
// ---------------------------------------------------------------------

test('every request carries Authorization: Bearer <token>', async () => {
  const seen = [];
  const fetch = makeStubFetch((url, init) => {
    seen.push(init.headers.Authorization);
    if (url.includes('/values/')) return jsonResponse(200, { values: [] });
    return jsonResponse(200, {});
  });
  const client = makeClient({ fetch, getToken: () => 'ABC123' });
  await client.getTab('S54');
  assert.ok(seen.every((h) => h === 'Bearer ABC123'));
});

// ---------------------------------------------------------------------
// 401/403 handling delegates to the injected auth-failure hook
// ---------------------------------------------------------------------

test('401 response calls onAuthFailure and rejects without duplicating redirect logic', async () => {
  let authFailureCalls = 0;
  const fetch = makeStubFetch(() => jsonResponse(401, { error: 'unauthorized' }));
  const client = makeClient({
    fetch,
    onAuthFailure: () => {
      authFailureCalls++;
      return { status: 'redirecting' };
    }
  });
  await assert.rejects(() => client.getTab('S54'), (err) => {
    assert.equal(err.authRequired, true);
    return true;
  });
  assert.equal(authFailureCalls, 1);
});

test('403 response also triggers onAuthFailure', async () => {
  let authFailureCalls = 0;
  const fetch = makeStubFetch(() => jsonResponse(403, { error: 'forbidden' }));
  const client = makeClient({ fetch, onAuthFailure: () => { authFailureCalls++; return {}; } });
  await assert.rejects(() => client.getTab('S54'));
  assert.equal(authFailureCalls, 1);
});

test('no stored token short-circuits: fetch is never called, onAuthFailure is', async () => {
  let authFailureCalls = 0;
  const fetch = makeStubFetch(() => {
    throw new Error('fetch must not be called when there is no valid token');
  });
  const client = makeClient({
    fetch,
    getToken: () => null,
    onAuthFailure: () => {
      authFailureCalls++;
      return { status: 'redirecting' };
    }
  });
  await assert.rejects(() => client.getTab('S54'), (err) => {
    assert.equal(err.authRequired, true);
    return true;
  });
  assert.equal(authFailureCalls, 1);
  assert.equal(fetch.calls.length, 0);
});

test('a non-auth error (e.g. 500) rejects with the server message, no auth hook call', async () => {
  let authFailureCalls = 0;
  const fetch = makeStubFetch(() => jsonResponse(500, { error: { message: 'internal boom' } }));
  const client = makeClient({ fetch, onAuthFailure: () => { authFailureCalls++; return {}; } });
  await assert.rejects(() => client.getTab('S54'), /internal boom/);
  assert.equal(authFailureCalls, 0);
});

// ---------------------------------------------------------------------
// clearCache — drops entr.tab.* and entr.meta, leaves entr.settings alone
// ---------------------------------------------------------------------

test('clearCache removes tabs and meta but preserves settings', () => {
  const storage = new FakeStorage();
  storage.setItem('entr.tab.S54', JSON.stringify({ sheet_name: 'S54', values: [], fetchedAt: 1 }));
  storage.setItem('entr.tab.S53', JSON.stringify({ sheet_name: 'S53', values: [], fetchedAt: 1 }));
  storage.setItem('entr.meta', JSON.stringify({ workoutSheets: ['S54', 'S53'], fetchedAt: 1 }));
  storage.setItem('entr.settings', JSON.stringify({ showPastLoad: true }));

  const client = makeClient({ storage });
  client.clearCache();

  assert.equal(storage.getItem('entr.tab.S54'), null);
  assert.equal(storage.getItem('entr.tab.S53'), null);
  assert.equal(storage.getItem('entr.meta'), null);
  assert.deepEqual(JSON.parse(storage.getItem('entr.settings')), { showPastLoad: true });
});

// ---------------------------------------------------------------------
// pruneCache — client-level integration over the pure selectStaleTabKeys
// ---------------------------------------------------------------------

test('pruneCache removes only stale + unprotected entr.tab.* entries', () => {
  const storage = new FakeStorage();
  const now = 1700000000000;
  const DAY = 24 * 60 * 60 * 1000;
  storage.setItem('entr.tab.old', JSON.stringify({ values: [], fetchedAt: now - 60 * DAY }));
  storage.setItem('entr.tab.current', JSON.stringify({ values: [], fetchedAt: now - 60 * DAY }));
  storage.setItem('entr.tab.recent', JSON.stringify({ values: [], fetchedAt: now - DAY }));

  const client = makeClient({ storage, now: () => now });
  const removed = client.pruneCache(['current']);

  assert.deepEqual(removed.sort(), ['old']);
  assert.equal(storage.getItem('entr.tab.old'), null);
  assert.notEqual(storage.getItem('entr.tab.current'), null);
  assert.notEqual(storage.getItem('entr.tab.recent'), null);
});

// ---------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------

test('getSettings defaults showPastLoad to false, setSettings merges and persists', () => {
  const storage = new FakeStorage();
  const client = makeClient({ storage });

  assert.deepEqual(client.getSettings(), { showPastLoad: false });

  client.setSettings({ showPastLoad: true });
  assert.deepEqual(client.getSettings(), { showPastLoad: true });

  const fresh = makeClient({ storage });
  assert.deepEqual(fresh.getSettings(), { showPastLoad: true });
});

// ---------------------------------------------------------------------
// Default auth bridge wiring (createClient with no getToken/onAuthFailure)
// ---------------------------------------------------------------------

test('createClient without getToken/onAuthFailure wires up real auth.js without throwing', async () => {
  const fetch = makeStubFetch(() => {
    throw new Error('must not reach the network: default getToken() has no window/localStorage in node');
  });
  const client = Sheets.createClient({ spreadsheetId: SPREADSHEET_ID, storage: new FakeStorage(), fetch });
  // No stored token available under node (no window/localStorage) -> short-circuits
  // through the real Auth.getValidToken()/handleAuthFailure() bridge, never calling fetch.
  await assert.rejects(() => client.getTab('S54'));
  assert.equal(fetch.calls.length, 0);
});

// ---------------------------------------------------------------------
// Source-level sanity: no secrets, uses the shared config/auth surface
// ---------------------------------------------------------------------

test('sheets.js source contains no client secret or API key', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'sheets.js'), 'utf8');
  assert.doesNotMatch(src, /GOCSPX|client_secret/i);
});
