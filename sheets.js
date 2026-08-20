// sheets.js — Google Sheets REST calls + tab discovery + localStorage cache.
// Port of server.py's Sheets logic (get_workout_sheets, fetch_academia_sheet_data,
// update_cell_internal, update_rpe_internal) to a browser-only REST client with no
// server, no secrets, no Python client library. See
// /root/.claude/plans/your-job-is-to-iterative-trinket.md §2 ("sheets.js — Sheets
// API + cache") and Handoff note H4 (A1 quoting, no valueRenderOption).
//
// Design (H3-style testability): every piece of network/URL/cache logic that does
// NOT need a live token is a PURE function (URL builders, A1 quoting, numeric
// coercion, JOUR matching, cache-key building, stale-entry selection). The only
// stateful surface is `createClient(options)`, which takes ONE injectable `fetch`
// and ONE injectable `storage` (plus a couple of small auth hooks) so
// `node --test` can exercise the whole request/response/cache pipeline with a
// stub fetch and a plain-object storage double — zero network, zero browser,
// zero real token (per H3, nobody but Diego can complete a real sign-in).
//
// Works both as a plain <script src="sheets.js"> (after config.js and auth.js;
// exposes `window.Sheets`) and as a CommonJS module for `node --test` (see tail).

(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  var API_ROOT = 'https://sheets.googleapis.com/v4/spreadsheets';
  var SHEETS_METADATA_FIELDS = 'sheets.properties(title,hidden,index)';

  // RPE always lives in column O (index 14, 0-based) — same as
  // update_rpe_internal (server.py:1982-2035), which hardcodes "!O{row_index}"
  // and comments "RPE is stored in column O, which is index 14 (0-based)".
  var RPE_COLUMN_LETTER = 'O';
  var RPE_COLUMN_INDEX = 14;

  // "Up to a month of past perfs" (plan §2 / README) — entr.tab.* entries older
  // than this are pruned unless they are the current or previous workout tab.
  var RETENTION_DAYS = 31;
  var RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  var STORAGE_KEYS = {
    TAB_PREFIX: 'entr.tab.', // + title -> {sheet_name, values, fetchedAt}
    META: 'entr.meta', // {workoutSheets: [title,...], fetchedAt}
    SETTINGS: 'entr.settings' // {showPastLoad: boolean}
  };

  // ---------------------------------------------------------------------
  // A1 range building — Handoff note H4: wrap the tab title in single quotes,
  // double any `'` inside it, then encodeURIComponent the WHOLE range (not
  // just the title). encodeURIComponent deliberately leaves `'` and `!`
  // unescaped (they are in its unreserved set) and only escapes `:` etc., so
  // `'S54'!A:Z` becomes `'S54'!A%3AZ` — that is expected, not a bug.
  // ---------------------------------------------------------------------

  function quoteSheetTitle(title) {
    return "'" + String(title).replace(/'/g, "''") + "'";
  }

  function buildA1Range(title, a1) {
    return quoteSheetTitle(title) + '!' + a1;
  }

  // ---------------------------------------------------------------------
  // URL builders — pure, one per Sheets REST call this module makes.
  // ---------------------------------------------------------------------

  // GET /v4/spreadsheets/{id}?fields=sheets.properties(title,hidden,index)
  function buildMetadataUrl(spreadsheetId) {
    return API_ROOT + '/' + encodeURIComponent(spreadsheetId) + '?fields=' + encodeURIComponent(SHEETS_METADATA_FIELDS);
  }

  // GET /v4/spreadsheets/{id}/values:batchGet?ranges='T1'!C11&ranges='T2'!C11...
  function buildBatchGetUrl(spreadsheetId, titles) {
    var qs = titles
      .map(function (title) {
        return 'ranges=' + encodeURIComponent(buildA1Range(title, 'C11'));
      })
      .join('&');
    return API_ROOT + '/' + encodeURIComponent(spreadsheetId) + '/values:batchGet?' + qs;
  }

  // GET /v4/spreadsheets/{id}/values/{encoded 'title'!A:Z}
  // Deliberately NO valueRenderOption param (H4) — the Python client's
  // defaults (FORMATTED_VALUE, ROWS) are what every parsing rule in app.js
  // assumes, so this must mirror that by omission, not by passing the
  // literal default value.
  function buildValuesGetUrl(spreadsheetId, title) {
    return API_ROOT + '/' + encodeURIComponent(spreadsheetId) + '/values/' + encodeURIComponent(buildA1Range(title, 'A:Z'));
  }

  // PUT /v4/spreadsheets/{id}/values/{encoded range}?valueInputOption=USER_ENTERED
  function buildValuesUpdateUrl(spreadsheetId, title, cellA1) {
    return (
      API_ROOT +
      '/' +
      encodeURIComponent(spreadsheetId) +
      '/values/' +
      encodeURIComponent(buildA1Range(title, cellA1)) +
      '?valueInputOption=USER_ENTERED'
    );
  }

  // ---------------------------------------------------------------------
  // Pure domain logic
  // ---------------------------------------------------------------------

  // 0-based column index -> A1 column letters. Exact port of server.py's
  // col_to_letter (server.py:1907-1912), a bijective base-26 conversion
  // (0->A, 25->Z, 26->AA, ...).
  function colToLetter(col) {
    var letter = '';
    while (col >= 0) {
      letter = String.fromCharCode(65 + (col % 26)) + letter;
      col = Math.floor(col / 26) - 1;
    }
    return letter;
  }

  // Strict Python-int()/float()-shaped literals — deliberately stricter than
  // parseInt/parseFloat, which accept trailing garbage ("12abc" -> 12) where
  // Python's int()/float() would raise ValueError and server.py would keep
  // the original string. This is what makes "82,5" (comma, not dot) stay a
  // string: it has no '.', and it is not a bare integer, so PY_INT_RE fails.
  var PY_INT_RE = /^\s*[+-]?\d+\s*$/;
  var PY_FLOAT_RE = /^\s*[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

  // Numeric coercion identical to update_cell_internal (server.py:1913-1921):
  //   if '.' in value: try float(value), else keep the string
  //   else:            try int(value), else keep the string
  function coerceValue(value) {
    if (typeof value !== 'string') return value;
    if (value.indexOf('.') !== -1) {
      if (PY_FLOAT_RE.test(value)) {
        var f = parseFloat(value);
        if (!isNaN(f)) return f;
      }
      return value;
    }
    if (PY_INT_RE.test(value)) {
      var i = parseInt(value, 10);
      if (!isNaN(i)) return i;
    }
    return value;
  }

  // Port of the "Check if cell contains JOUR (case insensitive)" rule in
  // get_workout_sheets (server.py:1432-1433).
  function isJourCell(value) {
    return !!value && String(value).toUpperCase().indexOf('JOUR') !== -1;
  }

  // entries: [{title, fetchedAt}]. Returns the titles that should be pruned:
  // older than RETENTION_DAYS AND not in protectedTitles. Pure — no storage.
  function selectStaleTabKeys(entries, protectedTitles, nowMs) {
    var protectedSet = {};
    (protectedTitles || []).forEach(function (t) {
      if (t) protectedSet[t] = true;
    });
    var cutoff = nowMs - RETENTION_MS;
    return (entries || [])
      .filter(function (e) {
        return e && !protectedSet[e.title] && typeof e.fetchedAt === 'number' && e.fetchedAt < cutoff;
      })
      .map(function (e) {
        return e.title;
      });
  }

  function tabCacheKey(title) {
    return STORAGE_KEYS.TAB_PREFIX + title;
  }

  // ---------------------------------------------------------------------
  // Storage helpers — null-safe, JSON in/out. `storage` must implement the
  // standard Web Storage interface (getItem/setItem/removeItem/key/length);
  // real window.localStorage does, and tests pass a plain-object double.
  // ---------------------------------------------------------------------

  function storageGet(storage, key) {
    var raw = storage.getItem(key);
    if (raw === undefined || raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function storageSet(storage, key, value) {
    storage.setItem(key, JSON.stringify(value));
  }

  function listTabCacheEntries(storage) {
    var entries = [];
    var len = storage.length || 0;
    for (var i = 0; i < len; i++) {
      var key = storage.key(i);
      if (!key || key.indexOf(STORAGE_KEYS.TAB_PREFIX) !== 0) continue;
      var title = key.slice(STORAGE_KEYS.TAB_PREFIX.length);
      var parsed = storageGet(storage, key);
      entries.push({ title: title, fetchedAt: parsed ? parsed.fetchedAt : undefined });
    }
    return entries;
  }

  function readTabCache(storage, title) {
    return storageGet(storage, tabCacheKey(title));
  }

  function writeTabCache(storage, title, data, fetchedAt) {
    storageSet(storage, tabCacheKey(title), {
      sheet_name: data.sheet_name,
      values: data.values,
      fetchedAt: fetchedAt
    });
  }

  function readMetaCache(storage) {
    return storageGet(storage, STORAGE_KEYS.META);
  }

  function writeMetaCache(storage, titles, fetchedAt) {
    storageSet(storage, STORAGE_KEYS.META, { workoutSheets: titles, fetchedAt: fetchedAt });
  }

  function readSettings(storage) {
    var parsed = storageGet(storage, STORAGE_KEYS.SETTINGS);
    var merged = { showPastLoad: false };
    if (parsed && typeof parsed === 'object') {
      Object.keys(parsed).forEach(function (k) {
        merged[k] = parsed[k];
      });
    }
    return merged;
  }

  function writeSettings(storage, patch) {
    var merged = readSettings(storage);
    Object.keys(patch || {}).forEach(function (k) {
      merged[k] = patch[k];
    });
    storageSet(storage, STORAGE_KEYS.SETTINGS, merged);
    return merged;
  }

  // Write-through: patch values[row1-1][col0] in the cached tab, padding the
  // row (and the values array itself) as needed. No-op if the tab was never
  // cached — nothing to patch. fetchedAt is left untouched: this only
  // updates data, it does not count as a fresh network fetch.
  function patchCachedCell(storage, title, row1, col0, value) {
    var cached = readTabCache(storage, title);
    if (!cached) return false;
    var values = cached.values || [];
    while (values.length < row1) values.push([]);
    var row = values[row1 - 1];
    while (row.length <= col0) row.push('');
    row[col0] = value;
    cached.values = values;
    writeTabCache(storage, title, cached, cached.fetchedAt);
    return true;
  }

  // ---------------------------------------------------------------------
  // Network primitive — the ONE place every Sheets REST call goes through.
  // client: {fetch, storage, spreadsheetId, getToken, onAuthFailure, now}
  // ---------------------------------------------------------------------

  function buildErrorFromResponse(res) {
    var reader = typeof res.text === 'function' ? res.text() : Promise.resolve('');
    return reader
      .catch(function () {
        return '';
      })
      .then(function (text) {
        var message = 'Sheets API error ' + res.status;
        if (text) {
          var detail = text;
          try {
            var parsed = JSON.parse(text);
            if (parsed && parsed.error && parsed.error.message) detail = parsed.error.message;
          } catch (e) {
            /* not JSON — use raw text */
          }
          message += ': ' + detail;
        }
        var err = new Error(message);
        err.status = res.status;
        return err;
      });
  }

  // method: 'GET'|'PUT'. body: optional plain object, JSON-encoded.
  function doFetch(client, method, url, body) {
    var token = client.getToken();
    if (!token) {
      var authResult = client.onAuthFailure();
      var noTokenErr = new Error('sheets.js: no valid token — auth failure handler invoked');
      noTokenErr.authRequired = true;
      noTokenErr.authResult = authResult;
      return Promise.reject(noTokenErr);
    }

    var headers = { Authorization: 'Bearer ' + token };
    var init = { method: method, headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    return client.fetch(url, init).then(function (res) {
      var status = res.status;
      var ok = typeof res.ok === 'boolean' ? res.ok : status >= 200 && status < 300;

      if (status === 401 || status === 403) {
        var authResult2 = client.onAuthFailure();
        var authErr = new Error('Sheets API auth failure: ' + status);
        authErr.status = status;
        authErr.authRequired = true;
        authErr.authResult = authResult2;
        throw authErr;
      }

      if (!ok) {
        return buildErrorFromResponse(res).then(function (err) {
          throw err;
        });
      }

      return res.json();
    });
  }

  // ---------------------------------------------------------------------
  // Tab discovery — port of get_workout_sheets (server.py:1384-1451).
  // ---------------------------------------------------------------------

  function extractFirstCellValue(valueRange) {
    if (!valueRange || !valueRange.values || !valueRange.values[0]) return '';
    var first = valueRange.values[0][0];
    return first === undefined || first === null ? '' : first;
  }

  // GET metadata, then ONE values:batchGet over 'title'!C11 for every tab.
  // A tab qualifies iff NOT hidden AND C11 contains JOUR (case-insensitive).
  // Original order preserved. Writes entr.meta, then prunes entr.tab.*
  // (protecting the resolved current/previous titles) — "after each
  // successful load" per plan §2.
  function listWorkoutSheets(client) {
    return doFetch(client, 'GET', buildMetadataUrl(client.spreadsheetId)).then(function (meta) {
      var sheets = (meta && meta.sheets) || [];
      if (!sheets.length) {
        writeMetaCache(client.storage, [], client.now());
        pruneCache(client, []);
        return [];
      }

      var titles = sheets.map(function (s) {
        return s.properties.title;
      });

      return doFetch(client, 'GET', buildBatchGetUrl(client.spreadsheetId, titles)).then(function (batch) {
        var valueRanges = (batch && batch.valueRanges) || [];
        var qualifying = [];

        for (var i = 0; i < sheets.length; i++) {
          var props = sheets[i].properties;
          var hidden = !!props.hidden;
          var cellValue = extractFirstCellValue(valueRanges[i]);
          if (!hidden && isJourCell(cellValue)) {
            qualifying.push(props.title);
          }
        }

        writeMetaCache(client.storage, qualifying, client.now());
        var protectedTitles = [qualifying[qualifying.length - 1], qualifying[qualifying.length - 2]];
        pruneCache(client, protectedTitles);
        return qualifying;
      });
    });
  }

  // ---------------------------------------------------------------------
  // Tab read — port of fetch_academia_sheet_data (server.py:1458-1493).
  // ---------------------------------------------------------------------

  // GET the full tab, write-through entr.tab.<title>. Returns the exact
  // {sheet_name, values} shape academia.html already consumes.
  function getTab(client, title) {
    return doFetch(client, 'GET', buildValuesGetUrl(client.spreadsheetId, title)).then(function (result) {
      var data = { sheet_name: title, values: (result && result.values) || [] };
      writeTabCache(client.storage, title, data, client.now());
      return data;
    });
  }

  function getCachedTab(client, title) {
    return readTabCache(client.storage, title);
  }

  // sheet_index -1 (current week). Each call does its own listWorkoutSheets()
  // round trip — callers that need BOTH current and previous should call
  // listWorkoutSheets() once themselves and then getTab(title) twice, to
  // stay within the ~3-4-calls-per-load budget (plan "Risks").
  function getLastTab(client) {
    return listWorkoutSheets(client).then(function (titles) {
      if (!titles.length) {
        throw new Error("No workout sheets found (no sheets with 'JOUR' in cell C11)");
      }
      var title = titles[titles.length - 1];
      return getTab(client, title).then(function (data) {
        return { sheet_name: data.sheet_name, values: data.values, title: title };
      });
    });
  }

  // sheet_index -2 (previous week).
  function getPastTab(client) {
    return listWorkoutSheets(client).then(function (titles) {
      if (titles.length < 2) {
        throw new Error('Sheet index out of range (only ' + titles.length + ' workout sheets found)');
      }
      var title = titles[titles.length - 2];
      return getTab(client, title).then(function (data) {
        return { sheet_name: data.sheet_name, values: data.values, title: title };
      });
    });
  }

  // ---------------------------------------------------------------------
  // Cell writes — port of update_cell_internal / update_rpe_internal
  // (server.py:1893-1980, 1982-2035).
  // ---------------------------------------------------------------------

  function doUpdate(client, title, row1, col0, colLetter, rawValue) {
    var coerced = coerceValue(rawValue);
    var cellA1 = colLetter + String(row1);
    var url = buildValuesUpdateUrl(client.spreadsheetId, title, cellA1);
    var body = { values: [[coerced]] };

    return doFetch(client, 'PUT', url, body).then(function (result) {
      patchCachedCell(client.storage, title, row1, col0, coerced);
      return result;
    });
  }

  // row1: 1-based row (A1 notation). col0: 0-based column index.
  function updateCell(client, title, row1, col0, value) {
    return doUpdate(client, title, row1, col0, colToLetter(col0), value);
  }

  // Same PUT as updateCell, pinned to column O (index 14).
  function updateRPE(client, title, row1, value) {
    return doUpdate(client, title, row1, RPE_COLUMN_INDEX, RPE_COLUMN_LETTER, value);
  }

  // ---------------------------------------------------------------------
  // Cache maintenance
  // ---------------------------------------------------------------------

  // Removes entr.tab.* entries older than RETENTION_DAYS that are not in
  // protectedTitles (typically [currentTitle, previousTitle]).
  function pruneCache(client, protectedTitles) {
    var entries = listTabCacheEntries(client.storage);
    var stale = selectStaleTabKeys(entries, protectedTitles, client.now());
    stale.forEach(function (title) {
      client.storage.removeItem(tabCacheKey(title));
    });
    return stale;
  }

  // Deletes entr.tab.* and entr.meta (the "cache" proper). Deliberately
  // leaves entr.settings alone — settings are a user preference, not a
  // fetch cache, and must survive a refresh/clear (that's the whole point
  // of moving them off the 7-day-capped iOS cookie).
  function clearCache(client) {
    var entries = listTabCacheEntries(client.storage);
    entries.forEach(function (e) {
      client.storage.removeItem(tabCacheKey(e.title));
    });
    client.storage.removeItem(STORAGE_KEYS.META);
  }

  // ---------------------------------------------------------------------
  // Auth bridge defaults — sheets.js never reimplements auth.js's
  // redirect/one-shot-guard logic (plan: "401/403 handling delegates to the
  // auth layer's failure path — do not duplicate the redirect logic"). By
  // default it looks up the real Auth object (window.Auth in a browser,
  // require('./auth.js') under node --test) and calls straight through to
  // it; tests override getToken/onAuthFailure directly instead.
  // ---------------------------------------------------------------------

  function defaultAuthBridge() {
    var authObj = null;
    if (typeof window !== 'undefined' && window.Auth) {
      authObj = window.Auth;
    } else if (typeof require === 'function') {
      try {
        authObj = require('./auth.js');
      } catch (e) {
        authObj = null;
      }
    }
    if (!authObj) {
      return {
        getToken: function () {
          return null;
        },
        onAuthFailure: function () {
          return { status: 'reconnect_required' };
        }
      };
    }
    return {
      getToken: function () {
        return authObj.getValidToken();
      },
      onAuthFailure: function () {
        return authObj.handleAuthFailure();
      }
    };
  }

  function defaultSpreadsheetId() {
    if (typeof window !== 'undefined' && window.SPREADSHEET_ID) return window.SPREADSHEET_ID;
    if (typeof require === 'function') {
      try {
        return require('./config.js').SPREADSHEET_ID;
      } catch (e) {
        /* config.js not reachable */
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------
  // Client factory — the ONE injectable-fetch / injectable-storage surface.
  // options: {fetch, storage, spreadsheetId, getToken, onAuthFailure, now}
  // Production code (app.js) calls createClient({}) and gets real
  // fetch/localStorage/config.js/Auth wired in. Tests pass every field
  // explicitly and never touch the network or a browser.
  // ---------------------------------------------------------------------

  function createClient(options) {
    options = options || {};

    // Found by S5's render-parity harness (never exercised by node --test,
    // which always injects options.fetch): grabbing the bare `fetch`
    // reference and later invoking it as `client.fetch(url, init)` detaches
    // it from `window`, and real browsers' native fetch is spec'd to throw
    // "TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation"
    // when called with a receiver other than window/undefined. `.bind`ing
    // it to window at the point the default is chosen keeps every call site
    // in this file (which always calls it as client.fetch(...)) working.
    var fetchFn = options.fetch ||
        (typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch.bind(window) :
            typeof fetch !== 'undefined' ? fetch : undefined);
    var storage = options.storage || (typeof window !== 'undefined' ? window.localStorage : undefined);
    var spreadsheetId = options.spreadsheetId || defaultSpreadsheetId();
    var bridge = defaultAuthBridge();
    var getToken = options.getToken || bridge.getToken;
    var onAuthFailure = options.onAuthFailure || bridge.onAuthFailure;
    var now = options.now || function () { return Date.now(); };

    if (typeof fetchFn !== 'function') throw new Error('sheets.js: no fetch available — pass options.fetch');
    if (!storage) throw new Error('sheets.js: no storage available — pass options.storage');
    if (!spreadsheetId) throw new Error('sheets.js: no spreadsheetId — pass options.spreadsheetId or load config.js first');

    var client = {
      fetch: fetchFn,
      storage: storage,
      spreadsheetId: spreadsheetId,
      getToken: getToken,
      onAuthFailure: onAuthFailure,
      now: now
    };

    return {
      spreadsheetId: spreadsheetId,

      listWorkoutSheets: function () {
        return listWorkoutSheets(client);
      },
      getLastTab: function () {
        return getLastTab(client);
      },
      getPastTab: function () {
        return getPastTab(client);
      },
      getTab: function (title) {
        return getTab(client, title);
      },
      getCachedTab: function (title) {
        return getCachedTab(client, title);
      },
      getCachedMeta: function () {
        return readMetaCache(client.storage);
      },

      updateCell: function (title, row1, col0, value) {
        return updateCell(client, title, row1, col0, value);
      },
      updateRPE: function (title, row1, value) {
        return updateRPE(client, title, row1, value);
      },

      getSettings: function () {
        return readSettings(client.storage);
      },
      setSettings: function (patch) {
        return writeSettings(client.storage, patch);
      },

      pruneCache: function (protectedTitles) {
        return pruneCache(client, protectedTitles);
      },
      clearCache: function () {
        return clearCache(client);
      }
    };
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------

  var Sheets = {
    createClient: createClient,

    // pure helpers (exported for direct unit testing, see tests/sheets.test.js)
    quoteSheetTitle: quoteSheetTitle,
    buildA1Range: buildA1Range,
    buildMetadataUrl: buildMetadataUrl,
    buildBatchGetUrl: buildBatchGetUrl,
    buildValuesGetUrl: buildValuesGetUrl,
    buildValuesUpdateUrl: buildValuesUpdateUrl,
    colToLetter: colToLetter,
    coerceValue: coerceValue,
    isJourCell: isJourCell,
    selectStaleTabKeys: selectStaleTabKeys,
    tabCacheKey: tabCacheKey,

    // constants
    API_ROOT: API_ROOT,
    SHEETS_METADATA_FIELDS: SHEETS_METADATA_FIELDS,
    RPE_COLUMN_LETTER: RPE_COLUMN_LETTER,
    RPE_COLUMN_INDEX: RPE_COLUMN_INDEX,
    RETENTION_DAYS: RETENTION_DAYS,
    STORAGE_KEYS: STORAGE_KEYS
  };

  // Plain <script> usage: expose on window.
  if (root) {
    root.Sheets = Sheets;
  }

  // node --test usage: CommonJS export tail.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Sheets;
  }
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null);
