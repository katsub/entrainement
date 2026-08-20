'use strict';

// Unit tests for app.js — parseDays / injectPastComments / renderDay.
//
// Per plan Handoff note H3, these three functions must be callable from
// node --test on fixture JSON with no network and no browser. This file
// never touches a real browser: parseDays and injectPastComments are pure
// (rows/objects in, objects out); renderDay is exercised with a tiny
// synthetic `document` stub (createElement only) just to prove it doesn't
// explode under node and produces the expected markup fragments — it is
// not a DOM/rendering test suite.
//
// ALL fixtures below are synthetic/invented — no real workout data. This
// repo is public (H2/H4). The real Passé: byte-diff against server.py's
// output on Diego's actual sheet data happens separately (S5's parity
// harness), never in this file.
//
// Run with: node --test tests/app.test.js   (zero dependencies)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const App = require(path.join('..', 'app.js'));

// ---------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------

// Builds a ragged `values` matrix (rows.forEach relies on 0-based row
// index === Sheets row number - 1, exactly like the real API response).
// `rowSpecs` is an array of { at, cells } where `at` is the 1-based sheet
// row number and `cells` is the row array (0-based columns, C=2, G=6,
// K=10, L=11, M=12, N=13, O=14, R=17).
function buildRows(rowSpecs, totalRows) {
  const rows = [];
  let maxRow = totalRows || 0;
  rowSpecs.forEach((spec) => { if (spec.at > maxRow) maxRow = spec.at; });
  for (let i = 0; i < maxRow; i++) rows.push([]);
  rowSpecs.forEach((spec) => {
    rows[spec.at - 1] = spec.cells;
  });
  return rows;
}

// Column helper: builds a row with JOUR header in C (idx 2).
function jourRow(label) {
  const r = [];
  r[2] = label;
  return r;
}

// Column helper: builds an exercise row.
// cols: {name (G/6), sets (K/10), reps (L/11), rpeDonne (M/12), charge (N/13), rpePercu (O/14), comment (R/17)}
function exerciseRow(cols) {
  const r = [];
  if (cols.name !== undefined) r[6] = cols.name;
  if (cols.sets !== undefined) r[10] = cols.sets;
  if (cols.reps !== undefined) r[11] = cols.reps;
  if (cols.rpeDonne !== undefined) r[12] = cols.rpeDonne;
  if (cols.charge !== undefined) r[13] = cols.charge;
  if (cols.rpePercu !== undefined) r[14] = cols.rpePercu;
  if (cols.comment !== undefined) r[17] = cols.comment;
  return r;
}

// Column helper: a row carrying a dynamic fatigue-label cell plus a value
// some columns to the right of it (mirrors parseDays' findValue scan).
function labelRow(colIndex, label, valueAtOffset) {
  const r = [];
  r[colIndex] = label;
  if (valueAtOffset !== undefined) {
    r[colIndex + valueAtOffset.offset] = valueAtOffset.value;
  }
  return r;
}

// ---------------------------------------------------------------------
// parseDays
// ---------------------------------------------------------------------

test('parseDays: day detection — multiple JOUR headers become separate days, in order', () => {
  const rows = buildRows([
    { at: 3, cells: jourRow('JOUR 1 - Haut du corps') },
    { at: 4, cells: exerciseRow({ name: 'Développé couché', sets: '4', reps: '8', charge: '60' }) },
    { at: 8, cells: jourRow('JOUR 2 - Bas du corps') },
    { at: 9, cells: exerciseRow({ name: 'Squat', sets: '5', reps: '5', charge: '100' }) },
  ]);

  const days = App.parseDays(rows, 'TestSheet');

  assert.equal(days.length, 2);
  assert.equal(days[0].name, 'JOUR 1 - Haut du corps');
  assert.equal(days[1].name, 'JOUR 2 - Bas du corps');
  assert.equal(days[0].exercises.length, 1);
  assert.equal(days[0].exercises[0].name, 'Développé couché');
  assert.equal(days[1].exercises[0].name, 'Squat');
  assert.equal(days[0].sheetName, 'TestSheet');
});

test('parseDays: merged Séries cell carries over into exercises 2 AND 3 of a group', () => {
  // Exercise 1 has a real "Séries" value; exercises 2 and 3 are a merged
  // group (blank K) sharing the same value, exercise 4 resets it (blank
  // name row) then a new exercise with its own value starts fresh.
  const rows = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100' }) },
    { at: 5, cells: exerciseRow({ name: 'Leg Press', reps: '8', charge: '120' }) }, // sets blank -> carry '3'
    { at: 6, cells: exerciseRow({ name: 'Fentes', reps: '10', charge: '20' }) },     // sets blank -> still carries '3'
    { at: 7, cells: [] },                                                            // blank row resets lastSets
    { at: 8, cells: exerciseRow({ name: 'Curl', sets: '4', reps: '12', charge: '15' }) },
  ]);

  const days = App.parseDays(rows, 'TestSheet');
  const ex = days[0].exercises;

  assert.equal(ex.length, 4);
  assert.equal(ex[0].name, 'Squat');
  assert.equal(ex[0].sets, '3');
  assert.equal(ex[1].name, 'Leg Press');
  assert.equal(ex[1].sets, '3', 'exercise 2 of the group must inherit the merged Séries value');
  assert.equal(ex[2].name, 'Fentes');
  assert.equal(ex[2].sets, '3', 'exercise 3 of the group must also inherit the merged Séries value');
  assert.equal(ex[3].name, 'Curl');
  assert.equal(ex[3].sets, '4', 'a fresh Séries value after a blank-row reset must not carry the old one');
});

test('parseDays: fatigue label scan finds Physique (fixed col H), Mentale (dynamic scan) and Post-séance (fixed col K)', () => {
  const rows = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100' }) },
    // "Fatigue Physique" label anywhere in the row -> value always read from column H (idx 7)
    { at: 5, cells: (() => { const r = ['', '', '', '', '', '', 'Fatigue Physique']; r[7] = '6'; return r; })() },
    // "Fatigue Mentale" label -> dynamic scan finds the first non-empty cell within 3 columns to the right
    { at: 6, cells: labelRow(3, 'Fatigue Mentale', { offset: 2, value: '7' }) },
    // Post-séance label -> value always read from column K (idx 10), and it flips hasFatigueValue
    { at: 7, cells: (() => { const r = ['', '', '', '', '', '', '', '', '', '', '8', 'Fatigue après la séance']; return r; })() },
  ]);

  const days = App.parseDays(rows, 'TestSheet');
  const day = days[0];

  assert.ok(day.fatiguePhysique, 'fatiguePhysique should be detected');
  assert.equal(day.fatiguePhysique.colIndex, 7);
  assert.equal(day.fatiguePhysique.value, '6');

  assert.ok(day.fatiguePsy, 'fatiguePsy should be detected');
  assert.equal(day.fatiguePsy.value, '7');

  assert.ok(day.fatiguePost, 'fatiguePost should be detected');
  assert.equal(day.fatiguePost.colIndex, 10);
  assert.equal(day.fatiguePost.value, '8');
});

test('parseDays: completion flag (hasFatigueValue) — valid 0-10 value in K sets it, invalid/missing does not', () => {
  const rowsValid = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100' }) },
    { at: 5, cells: (() => { const r = []; r[10] = '7.5'; r[15] = 'Fatigue post-séance'; return r; })() },
  ]);
  const daysValid = App.parseDays(rowsValid, 'TestSheet');
  assert.equal(daysValid[0].hasFatigueValue, true);

  const rowsOutOfRange = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100' }) },
    { at: 5, cells: (() => { const r = []; r[10] = '11'; r[15] = 'Fatigue post-séance'; return r; })() },
  ]);
  const daysOutOfRange = App.parseDays(rowsOutOfRange, 'TestSheet');
  assert.equal(daysOutOfRange[0].hasFatigueValue, false, 'a value outside 0-10 must not mark the day complete');

  const rowsMissing = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100' }) },
  ]);
  const daysMissing = App.parseDays(rowsMissing, 'TestSheet');
  assert.equal(daysMissing[0].hasFatigueValue, false, 'no post-séance label at all must not mark the day complete');

  // filterable-as-active still works with 0 exercises for a day header with none
  assert.equal(daysMissing[0].exercises.length, 1);
});

test('parseDays: JOUR 3 -> H41 physical fatigue override', () => {
  const rowSpecs = [
    { at: 3, cells: jourRow('JOUR 3') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100' }) },
    // A misleading "Fatigue Physique" label elsewhere in the sheet, at the wrong row —
    // the override must ignore it and read row 41 col H (idx 7) unconditionally.
    { at: 10, cells: (() => { const r = ['', '', '', '', '', '', '', '9']; return r; })() },
  ];
  // Row 41, column H (idx 7) holds the real override value.
  rowSpecs.push({ at: 41, cells: (() => { const r = []; r[7] = '4'; return r; })() });
  const rows = buildRows(rowSpecs, 41);

  const days = App.parseDays(rows, 'TestSheet');
  const day3 = days.find((d) => d.name.toUpperCase().includes('JOUR 3'));

  assert.ok(day3);
  assert.equal(day3.fatiguePhysique.rowIndex, 41);
  assert.equal(day3.fatiguePhysique.colIndex, 7);
  assert.equal(day3.fatiguePhysique.value, '4', 'JOUR 3 must read H41 regardless of any other fatigue-label match');
});

test('parseDays: JOUR 5 -> H71 physical fatigue override', () => {
  const rowSpecs = [
    { at: 3, cells: jourRow('JOUR 5') },
    { at: 4, cells: exerciseRow({ name: 'Deadlift', sets: '3', reps: '5', charge: '140' }) },
  ];
  rowSpecs.push({ at: 71, cells: (() => { const r = []; r[7] = '9'; return r; })() });
  const rows = buildRows(rowSpecs, 71);

  const days = App.parseDays(rows, 'TestSheet');
  const day5 = days.find((d) => d.name.toUpperCase().includes('JOUR 5'));

  assert.ok(day5);
  assert.equal(day5.fatiguePhysique.rowIndex, 71);
  assert.equal(day5.fatiguePhysique.colIndex, 7);
  assert.equal(day5.fatiguePhysique.value, '9');
});

test('parseDays: day comment is read from row 23 + (dayNum-1)*15, column O (14)', () => {
  const rowSpecs = [
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100' }) },
  ];
  rowSpecs.push({ at: 23, cells: (() => { const r = []; r[14] = 'RAS, bonne séance'; return r; })() });
  const rows = buildRows(rowSpecs, 23);

  const days = App.parseDays(rows, 'TestSheet');
  assert.deepEqual(days[0].comment, { rowIndex: 23, colIndex: 14, value: 'RAS, bonne séance' });
});

test('parseDays: header/label rows themselves are not treated as exercises', () => {
  const rows = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'EXERCICE', sets: 'Séries' }) }, // column header row
    { at: 5, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100' }) },
  ]);
  const days = App.parseDays(rows, 'TestSheet');
  assert.equal(days[0].exercises.length, 1);
  assert.equal(days[0].exercises[0].name, 'Squat');
});

// ---------------------------------------------------------------------
// injectPastComments
// ---------------------------------------------------------------------

function sheetWithRows(rowSpecs, totalRows) {
  return { sheet_name: 'S', values: buildRows(rowSpecs, totalRows) };
}

test('injectPastComments: exact sets+reps match is preferred, heaviest wins on a tie', () => {
  const past = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', rpeDonne: '7', charge: '95', rpePercu: '8' }) },
    { at: 5, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', rpeDonne: '7', charge: '105', rpePercu: '8.5' }) }, // exact match, heavier
    { at: 6, cells: exerciseRow({ name: 'Squat', sets: '5', reps: '5', rpeDonne: '7', charge: '999', rpePercu: '9' }) },   // not exact (sets differ), must be ignored
  ]);
  const current = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5' }) },
  ]);

  const result = App.injectPastComments(current, past);
  assert.equal(result.values[3][17], 'Passé: 3x5 @105kg RPE 8.5');
});

test('injectPastComments: no exact match falls back to the heaviest same-name entry in that JOUR', () => {
  const past = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Bench', sets: '4', reps: '6', rpeDonne: '7', charge: '60', rpePercu: '7' }) },
    { at: 5, cells: exerciseRow({ name: 'Bench', sets: '4', reps: '8', rpeDonne: '7', charge: '55', rpePercu: '6.5' }) },
  ]);
  const current = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Bench', sets: '3', reps: '8' }) }, // matches neither past row exactly
  ]);

  const result = App.injectPastComments(current, past);
  // Heaviest candidate among same-name/same-day entries: 60kg
  assert.equal(result.values[3][17], 'Passé: 4x6 @60kg RPE 7');
});

test('injectPastComments: RPE prefers perçu (O) and falls back to donné (M)', () => {
  const past = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', rpeDonne: '7', charge: '100', rpePercu: '8' }) },
  ]);
  const current = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5' }) },
  ]);
  let result = App.injectPastComments(current, past);
  assert.equal(result.values[3][17], 'Passé: 3x5 @100kg RPE 8', 'RPE perçu (O) must be used when present');

  const pastNoPercu = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', rpeDonne: '7', charge: '100' }) }, // rpePercu blank
  ]);
  const current2 = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5' }) },
  ]);
  result = App.injectPastComments(current2, pastNoPercu);
  assert.equal(result.values[3][17], 'Passé: 3x5 @100kg RPE 7', 'RPE must fall back to donné (M) when perçu is blank');
});

test('injectPastComments: skips a row whose comment already contains "Passé:"', () => {
  const past = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', rpeDonne: '7', charge: '100', rpePercu: '8' }) },
  ]);
  const current = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', comment: 'Passé: 3x5 @999kg RPE 9' }) },
  ]);
  const result = App.injectPastComments(current, past);
  assert.equal(result.values[3][17], 'Passé: 3x5 @999kg RPE 9', 'an existing Passé: line must never be overwritten');
});

test('injectPastComments: prepends with a \\n\\n separator ahead of an existing user comment', () => {
  const past = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', rpeDonne: '7', charge: '100', rpePercu: '8' }) },
  ]);
  const current = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', comment: 'Bonne forme aujourd\'hui' }) },
  ]);
  const result = App.injectPastComments(current, past);
  assert.equal(result.values[3][17], 'Passé: 3x5 @100kg RPE 8\n\nBonne forme aujourd\'hui');
});

test('injectPastComments: no candidates in that JOUR/name -> comment untouched, no crash', () => {
  const past = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', rpeDonne: '7', charge: '100', rpePercu: '8' }) },
  ]);
  const current = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 2') }, // different day, no past data for JOUR 2
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5' }) },
  ]);
  const result = App.injectPastComments(current, past);
  assert.equal(result.values[3][17], undefined);
});

test('injectPastComments: returns input unchanged when either payload is missing values', () => {
  const current = sheetWithRows([{ at: 3, cells: jourRow('JOUR 1') }]);
  assert.equal(App.injectPastComments(null, { values: [] }), null);
  assert.equal(App.injectPastComments(current, null), current);
  assert.equal(App.injectPastComments(current, {}), current);
});

test('injectPastComments: row shorter than column R is padded to exactly 18 cells with "" in between', () => {
  const past = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', rpeDonne: '7', charge: '100', rpePercu: '8' }) },
  ]);
  const current = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    // No `comment`, so this row's original length stops at index 11 (last
    // assigned cell is `reps`, K/10..L/11) -- well short of column R (17).
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5' }) },
  ]);
  const row = current.values[3];
  assert.equal(row.length, 12, 'fixture sanity check: row starts shorter than column R');

  const result = App.injectPastComments(current, past);
  const paddedRow = result.values[3];
  assert.equal(paddedRow.length, 18, 'row must be padded to exactly 18 cells, not left sparse');
  assert.equal(paddedRow[17], 'Passé: 3x5 @100kg RPE 8');
  // Every cell between the original end and column R must be a real empty
  // string (matching Python's `while len(row) < 18: row.append("")`), not
  // a sparse-array hole (`undefined`) that a naive `row[17] = x` assignment
  // would silently leave behind.
  for (let i = 12; i < 17; i++) {
    assert.equal(paddedRow[i], '', `cell ${i} must be "" after padding, not a hole`);
    assert.notEqual(typeof paddedRow[i], 'undefined');
  }
});

test('injectPastComments: no double-prefix — running it twice over the same current tab leaves a single "Passé:" line', () => {
  const past = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', rpeDonne: '7', charge: '100', rpePercu: '8' }) },
  ]);
  const current = sheetWithRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', comment: 'RAS' }) },
  ]);

  const once = App.injectPastComments(current, past);
  assert.equal(once.values[3][17], 'Passé: 3x5 @100kg RPE 8\n\nRAS');

  // app.js calls injectPastComments again on every re-render (cache-first
  // render, then the network re-render, then updateFatigueCell) over data
  // that may already carry an injected comment -- it must stay idempotent.
  const twice = App.injectPastComments(once, past);
  assert.equal(twice.values[3][17], 'Passé: 3x5 @100kg RPE 8\n\nRAS', 'a second pass must not add a second Passé: line');
  const passeOccurrences = (twice.values[3][17].match(/Passé:/g) || []).length;
  assert.equal(passeOccurrences, 1, 'only one "Passé:" marker must ever be present');
});

// ---------------------------------------------------------------------
// renderDay — minimal smoke test under a synthetic `document` (H3: must be
// callable from node --test with no browser at all)
// ---------------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this._innerHTML = '';
    this.style = {};
    this.children = [];
  }
  set innerHTML(html) { this._innerHTML = html; }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

test('renderDay: runs under node with a synthetic document and produces the expected fragments', () => {
  const fakeDocument = { createElement: (tag) => new FakeElement(tag) };
  const previousDocument = global.document;
  global.document = fakeDocument;
  try {
    const day = {
      name: 'JOUR 1',
      sheetName: 'TestSheet',
      hasFatigueValue: false,
      fatiguePhysique: { rowIndex: 5, colIndex: 7, value: '6' },
      fatiguePsy: null,
      fatiguePost: { rowIndex: 6, colIndex: 10, value: null },
      comment: { rowIndex: 23, colIndex: 14, value: 'RAS' },
      exercises: [
        {
          name: 'Squat',
          sets: '3',
          reps: '5',
          rpe: '',
          load: '100',
          rowIndex: 4,
          currentRpe: '8',
          comment: 'Passé: 3x5 @95kg RPE 7.5\n\nBonne série',
        },
      ],
    };

    const container = new FakeElement('div');
    App.renderDay(day, container, false, false);

    assert.equal(container.children.length, 1, 'renderDay appends exactly one cards-container');
    const cardsContainer = container.children[0];
    assert.equal(cardsContainer.className, 'cards-container');
    // exercise card + fatigue card + comment card
    assert.equal(cardsContainer.children.length, 3);

    const exerciseCardHtml = cardsContainer.children[0].innerHTML;
    assert.match(exerciseCardHtml, /Squat/);
    assert.match(exerciseCardHtml, /class="detail-value highlight">3</);
    assert.match(exerciseCardHtml, /class="detail-value highlight">5</);
    assert.match(exerciseCardHtml, /class="past-perf-line">Passé: 3x5 @95kg RPE 7\.5</);
    assert.match(exerciseCardHtml, /class="user-comment-line">Bonne série</);

    const fatigueCardHtml = cardsContainer.children[1].innerHTML;
    assert.match(fatigueCardHtml, /Fatigue/);

    const commentCardHtml = cardsContainer.children[2].innerHTML;
    assert.match(commentCardHtml, /Commentaires/);
  } finally {
    if (previousDocument === undefined) {
      delete global.document;
    } else {
      global.document = previousDocument;
    }
  }
});

// ---------------------------------------------------------------------
// Source-level checks
// ---------------------------------------------------------------------

test('app.js: no client secret, and no live multi-user/SBD plumbing calls', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.doesNotMatch(src, /GOCSPX/);
  assert.doesNotMatch(src, /client_secret/);
  // Strip comment lines first: these identifiers legitimately appear in
  // explanatory `//` comments documenting what each rewrite dropped
  // (e.g. "the fetch(buildApiUrl(...)) call ... is replaced by
  // sheetsClient.getPastTab()"), which is not the same as live code still
  // calling them.
  const codeOnly = src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  assert.doesNotMatch(codeOnly, /getUsername\s*\(/);
  assert.doesNotMatch(codeOnly, /buildApiUrl\s*\(/);
  assert.doesNotMatch(codeOnly, /\bCURRENT_USER\b/);
  assert.doesNotMatch(codeOnly, /sbd_charts_logic/);
  assert.doesNotMatch(codeOnly, /pollForFreshData\s*\(/);
});
