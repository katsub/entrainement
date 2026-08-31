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
// injectPastComments — merged "Séries" cells (regression: the "Passé: ..."
// line was missing for every exercise but the first of a fused group)
// ---------------------------------------------------------------------

test('injectPastComments: a merged Séries cell carries over, so every exercise of the group gets its Passé: line', () => {
  // Column K is filled only on the first row of the group on BOTH sheets —
  // exactly how the real sheet fuses it, and what parseDays already
  // compensates for when rendering.
  const past = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100', rpePercu: '8' }) },
    { at: 5, cells: exerciseRow({ name: 'Leg Press', reps: '8', charge: '120', rpePercu: '7' }) },
    { at: 6, cells: exerciseRow({ name: 'Fentes', reps: '10', charge: '20', rpePercu: '7.5' }) },
  ]);
  const current = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5' }) },
    { at: 5, cells: exerciseRow({ name: 'Leg Press', reps: '8' }) },
    { at: 6, cells: exerciseRow({ name: 'Fentes', reps: '10' }) },
  ]);

  const result = App.injectPastComments({ sheet_name: 'S54', values: current }, { sheet_name: 'S53', values: past });

  assert.equal(result.values[3][17], 'Passé: 3x5 @100kg RPE 8');
  assert.equal(result.values[4][17], 'Passé: 3x8 @120kg RPE 7', 'merged group member 2 must get a Passé: line');
  assert.equal(result.values[5][17], 'Passé: 3x10 @20kg RPE 7.5', 'merged group member 3 must get a Passé: line');
});

test('injectPastComments: a merged Séries value never leaks across a JOUR boundary or a blank row', () => {
  const past = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100', rpePercu: '8' }) },
    { at: 8, cells: jourRow('JOUR 2') },
    // No sets anywhere in JOUR 2 -> nothing to index, and JOUR 1's '3'
    // must NOT be carried into it.
    { at: 9, cells: exerciseRow({ name: 'Rowing', reps: '8', charge: '70', rpePercu: '7' }) },
  ]);
  const current = buildRows([
    { at: 3, cells: jourRow('JOUR 2') },
    { at: 4, cells: exerciseRow({ name: 'Rowing', reps: '8' }) },
  ]);

  const result = App.injectPastComments({ sheet_name: 'S54', values: current }, { sheet_name: 'S53', values: past });
  assert.equal(result.values[3][17], undefined, 'no sets on either side of JOUR 2 -> no injection, no carry-over');

  // A blank row between two groups resets the carry-over too.
  const past2 = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100', rpePercu: '8' }) },
    { at: 5, cells: [] },
    { at: 6, cells: exerciseRow({ name: 'Curl', reps: '12', charge: '15', rpePercu: '7' }) },
  ]);
  const current2 = buildRows([
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Curl', sets: '4', reps: '12' }) },
  ]);
  const result2 = App.injectPastComments({ sheet_name: 'S54', values: current2 }, { sheet_name: 'S53', values: past2 });
  assert.equal(result2.values[3][17], undefined, 'a blank row must clear the carried Séries value');
});

// ---------------------------------------------------------------------
// Browser-ish harness — loads a FRESH app.js against fake window/document
// so the stateful halves (loadPastData, updateCell/updateRPE token
// pre-flight, flushPendingWrites) are exercised end to end through the
// real sheets.js + auth.js with a stub fetch. Still zero network, zero
// browser, zero real token (H3).
// ---------------------------------------------------------------------

const Config = require(path.join('..', 'config.js'));

class FakeStorage {
  constructor() { this._data = Object.create(null); this._order = []; }
  getItem(key) { return Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : null; }
  setItem(key, value) {
    if (!Object.prototype.hasOwnProperty.call(this._data, key)) this._order.push(key);
    this._data[key] = String(value);
  }
  removeItem(key) {
    delete this._data[key];
    const i = this._order.indexOf(key);
    if (i !== -1) this._order.splice(i, 1);
  }
  key(i) { return this._order[i]; }
  get length() { return this._order.length; }
}

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(c) { this._set.add(c); }
  remove(c) { this._set.delete(c); }
  contains(c) { return this._set.has(c); }
  toggle(c) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); }
}

class FakeNode extends FakeElement {
  constructor(tag) {
    super(tag);
    this.textContent = '';
    this.classList = new FakeClassList();
    this.disabled = false;
    this.checked = false;
  }
  set innerHTML(html) { this._innerHTML = html; if (html === '') this.children = []; }
  get innerHTML() { return this._innerHTML; }
  contains() { return false; }
}

class FakeDocument {
  constructor() { this.elements = Object.create(null); this.body = new FakeNode('body'); }
  getElementById(id) {
    if (!this.elements[id]) this.elements[id] = new FakeNode('div');
    return this.elements[id];
  }
  createElement(tag) { return new FakeNode(tag); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

// Loads a fresh app.js (and with it a fresh sheetsClient) bound to fake
// browser globals. `opts.fetchHandler(url, init)` returns a response-like.
// Returns everything a test needs to assert on, plus restore().
function loadAppInFakeBrowser(opts) {
  opts = opts || {};
  const localStorage = new FakeStorage();
  const sessionStorage = new FakeStorage();
  const calls = [];
  const fetchImpl = function (url, init) {
    calls.push({ url, init });
    return Promise.resolve((opts.fetchHandler || (() => jsonResponse(200, {})))(url, init, calls.length - 1));
  };
  const location = { origin: 'http://localhost:8000', pathname: '/', search: '', hash: '', href: 'http://localhost:8000/' };
  const fakeWindow = {
    localStorage, sessionStorage, location,
    fetch: fetchImpl,
    scrollY: 0,
    scrollTo: () => {},
    history: { replaceState: () => {} },
    CLIENT_ID: Config.CLIENT_ID,
    SCOPE: Config.SCOPE,
    SPREADSHEET_ID: Config.SPREADSHEET_ID
  };
  const fakeDocument = new FakeDocument();

  const saved = { window: global.window, document: global.document };
  global.window = fakeWindow;
  global.document = fakeDocument;

  const appPath = require.resolve(path.join(__dirname, '..', 'app.js'));
  delete require.cache[appPath];
  let FreshApp;
  try {
    FreshApp = require(appPath);
  } catch (e) {
    global.window = saved.window;
    global.document = saved.document;
    throw e;
  }

  return {
    App: FreshApp,
    window: fakeWindow,
    document: fakeDocument,
    localStorage,
    sessionStorage,
    location,
    calls,
    restore() {
      delete require.cache[appPath];
      if (saved.window === undefined) delete global.window; else global.window = saved.window;
      if (saved.document === undefined) delete global.document; else global.document = saved.document;
    }
  };
}

function setToken(storage, expiresAt) {
  storage.setItem('entr.token', JSON.stringify({ token: 'TEST_TOKEN', expiresAt }));
}

// ---------------------------------------------------------------------
// loadPastData — the "Passé" tab must show the WHOLE previous week plus
// the current week's completed days (regression: the old rolling window
// deleted one previous-week day for each completed current-week day)
// ---------------------------------------------------------------------

// Builds a day block: a JOUR header, one exercise, and a post-session
// fatigue label whose column K carries `fatiguePost` ('' = not done yet).
function dayBlock(startRow, label, exerciseName, fatiguePost) {
  const fatigueRow = [];
  fatigueRow[6] = 'Niveau de fatigue après la séance';
  fatigueRow[10] = fatiguePost;
  return [
    { at: startRow, cells: jourRow(label) },
    { at: startRow + 1, cells: exerciseRow({ name: exerciseName, sets: '3', reps: '5', charge: '100' }) },
    { at: startRow + 2, cells: fatigueRow }
  ];
}

test('loadPastData: shows every day of the previous week plus the completed days of the current week', async () => {
  const pastValues = buildRows([
    ...dayBlock(3, 'JOUR 1', 'Squat', '5'),
    ...dayBlock(8, 'JOUR 2', 'Bench', '6'),
    ...dayBlock(13, 'JOUR 3', 'Deadlift', '7')
  ]);

  const harness = loadAppInFakeBrowser({
    fetchHandler: (url) => {
      if (url.indexOf('?fields=') !== -1) {
        return jsonResponse(200, { sheets: [{ properties: { title: 'S53', hidden: false, index: 0 } }, { properties: { title: 'S54', hidden: false, index: 1 } }] });
      }
      if (url.indexOf('values:batchGet') !== -1) {
        return jsonResponse(200, { valueRanges: [{ values: [['JOUR']] }, { values: [['JOUR']] }] });
      }
      if (url.indexOf('S53') !== -1) return jsonResponse(200, { values: pastValues });
      return jsonResponse(200, { values: [] });
    }
  });

  try {
    setToken(harness.localStorage, Date.now() + 3600000);

    // Current week: JOUR 1 done, JOUR 2 still open.
    harness.window.currentData = {
      sheet_name: 'S54',
      values: buildRows([...dayBlock(3, 'JOUR 1', 'Squat', '4'), ...dayBlock(8, 'JOUR 2', 'Bench', '')])
    };

    await harness.App.loadPastData();

    const content = harness.document.getElementById('content-passados');
    const headers = content.children.filter((c) => c.tagName === 'h3').map((c) => c.textContent);

    assert.deepEqual(
      headers,
      ['JOUR 1', 'JOUR 2', 'JOUR 3', 'JOUR 1'],
      'all three previous-week days must survive, with the completed current-week day appended'
    );

    const errorEl = harness.document.getElementById('error-passados');
    assert.notEqual(errorEl.style.display, 'block', 'no error must be shown');
  } finally {
    harness.restore();
  }
});

// Sets up "À venir" with a current week (window.currentData) and an optional
// next-week sheet reachable over the stub fetch as window.nextTitle.
function futureHarness(nextValues) {
  return loadAppInFakeBrowser({
    fetchHandler: (url) => {
      if (url.indexOf('S56') !== -1) {
        if (!nextValues) return jsonResponse(500, { error: 'boom' });
        return jsonResponse(200, { values: nextValues });
      }
      return jsonResponse(200, { values: [] });
    }
  });
}

function futureHeadings(harness) {
  const content = harness.document.getElementById('content-futuros');
  return content.children
    .filter((c) => c.tagName === 'h3' || c.tagName === 'h2')
    .map((c) => c.tagName + ':' + c.textContent);
}

test('loadFutureData: on the last day of the week, shows next week instead of going empty', async () => {
  const harness = futureHarness(buildRows([
    ...dayBlock(3, 'JOUR 1', 'Squat', ''),
    ...dayBlock(8, 'JOUR 2', 'Bench', '')
  ]));
  try {
    setToken(harness.localStorage, Date.now() + 3600000);
    // Current week: JOUR 1 done, JOUR 2 is the workout in progress -> nothing
    // left after it, which is exactly when the tab used to render empty.
    harness.window.currentData = {
      sheet_name: 'S55',
      values: buildRows([...dayBlock(3, 'JOUR 1', 'Squat', '5'), ...dayBlock(8, 'JOUR 2', 'Bench', '')])
    };
    harness.window.nextTitle = 'S56';

    await harness.App.loadFutureData();

    assert.deepEqual(futureHeadings(harness), [
      'h2:Semaine prochaine — S56',
      'h3:JOUR 1',
      'h3:JOUR 2'
    ]);
  } finally {
    harness.restore();
  }
});

test('loadFutureData: this week\'s remaining days come first, then next week under its heading', async () => {
  const harness = futureHarness(buildRows([...dayBlock(3, 'JOUR 1', 'Squat', '')]));
  try {
    setToken(harness.localStorage, Date.now() + 3600000);
    // JOUR 1 done, JOUR 2 in progress, JOUR 3 still ahead.
    harness.window.currentData = {
      sheet_name: 'S55',
      values: buildRows([
        ...dayBlock(3, 'JOUR 1', 'Squat', '5'),
        ...dayBlock(8, 'JOUR 2', 'Bench', ''),
        ...dayBlock(13, 'JOUR 3', 'Deadlift', '')
      ])
    };
    harness.window.nextTitle = 'S56';

    await harness.App.loadFutureData();

    assert.deepEqual(futureHeadings(harness), [
      'h3:JOUR 3',
      'h2:Semaine prochaine — S56',
      'h3:JOUR 1'
    ]);
  } finally {
    harness.restore();
  }
});

test('loadFutureData: the next-week sheet is fetched once, not on every tab switch', async () => {
  const harness = futureHarness(buildRows([...dayBlock(3, 'JOUR 1', 'Squat', '')]));
  try {
    setToken(harness.localStorage, Date.now() + 3600000);
    harness.window.currentData = { sheet_name: 'S55', values: buildRows([...dayBlock(3, 'JOUR 1', 'Squat', '')]) };
    harness.window.nextTitle = 'S56';

    await harness.App.loadFutureData();
    await harness.App.loadFutureData();
    await harness.App.loadFutureData();

    const s56Calls = harness.calls.filter((c) => c.url.indexOf('S56') !== -1);
    assert.equal(s56Calls.length, 1, 'the memo must survive repeated switches to the tab');
  } finally {
    harness.restore();
  }
});

test('loadFutureData: a failed next-week fetch does not wipe the days already rendered', async () => {
  const harness = futureHarness(null); // S56 responds 500
  try {
    setToken(harness.localStorage, Date.now() + 3600000);
    harness.window.currentData = {
      sheet_name: 'S55',
      values: buildRows([...dayBlock(3, 'JOUR 1', 'Squat', ''), ...dayBlock(8, 'JOUR 2', 'Bench', '')])
    };
    harness.window.nextTitle = 'S56';

    await harness.App.loadFutureData();

    assert.deepEqual(futureHeadings(harness), ['h3:JOUR 2'], "this week's remaining day must survive the failure");
  } finally {
    harness.restore();
  }
});

test('loadFutureData: no next sheet and nothing left this week still reports the empty state', async () => {
  const harness = futureHarness(null);
  try {
    harness.window.currentData = { sheet_name: 'S55', values: buildRows([...dayBlock(3, 'JOUR 1', 'Squat', '')]) };
    harness.window.nextTitle = null;

    await harness.App.loadFutureData();

    const content = harness.document.getElementById('content-futuros');
    assert.match(content.innerHTML, /Pas encore d'entraînements à venir/);
  } finally {
    harness.restore();
  }
});

test('resolveWeekTabs: nextTitle is the sheet that was held back, and null once it is current', async () => {
  const tabs = { S55: weekTab('S55'), S56: weekTab('S56') };
  const held = await App.resolveWeekTabs(['S55', 'S56'], fetcherFor(tabs));
  assert.equal(held.currentTitle, 'S55');
  assert.equal(held.nextTitle, 'S56', 'the sheet not promoted is next week');

  const promoted = await App.resolveWeekTabs(['S55', 'S56'], fetcherFor({ S55: weekTab('S55', 8), S56: weekTab('S56') }));
  assert.equal(promoted.currentTitle, 'S56');
  assert.equal(promoted.nextTitle, null, 'there is no sheet beyond the newest one');
});

// ---------------------------------------------------------------------
// Token pre-flight on writes + pending-write replay
// ---------------------------------------------------------------------

test('updateCell: an expired token parks the edit and renews BEFORE any PUT goes out', async () => {
  const harness = loadAppInFakeBrowser({});
  try {
    setToken(harness.localStorage, Date.now() - 1000); // already expired

    const el = harness.document.createElement('input');
    const ok = await harness.App.updateCell('S54', 12, 13, '82.5', el);

    assert.equal(ok, false, 'the write must report failure, not silently claim success');
    assert.equal(harness.calls.length, 0, 'no request may be sent with a dead token');

    const parked = JSON.parse(harness.sessionStorage.getItem('entr.pendingWrites'));
    assert.deepEqual(parked, [{ kind: 'cell', sheetName: 'S54', rowIndex: 12, colIndex: 13, value: '82.5' }]);

    assert.match(harness.location.href, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/, 'a renewal redirect must have started');
    assert.match(harness.location.href, /prompt=none/, 'the renewal must be silent');
    assert.equal(harness.localStorage.getItem('entr.token'), null, 'the dead token must be dropped');
  } finally {
    harness.restore();
  }
});

test('updateRPE: an expired token parks the RPE edit too, pinned to column O', async () => {
  const harness = loadAppInFakeBrowser({});
  try {
    setToken(harness.localStorage, Date.now() - 1000);

    const el = harness.document.createElement('select');
    const ok = await harness.App.updateRPE('S54', 12, '8.5', el);

    assert.equal(ok, false);
    assert.equal(harness.calls.length, 0);
    const parked = JSON.parse(harness.sessionStorage.getItem('entr.pendingWrites'));
    assert.deepEqual(parked, [{ kind: 'rpe', sheetName: 'S54', rowIndex: 12, colIndex: 14, value: '8.5' }]);
  } finally {
    harness.restore();
  }
});

test('updateCell: a valid token goes straight to the PUT and parks nothing', async () => {
  const harness = loadAppInFakeBrowser({ fetchHandler: () => jsonResponse(200, { updatedCells: 1 }) });
  try {
    setToken(harness.localStorage, Date.now() + 3600000);

    const el = harness.document.createElement('input');
    const ok = await harness.App.updateCell('S54', 12, 13, '82.5', el);

    assert.equal(ok, true);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].init.method, 'PUT');
    assert.equal(harness.sessionStorage.getItem('entr.pendingWrites'), null, 'nothing may be parked on a clean write');
    assert.equal(harness.location.href, 'http://localhost:8000/', 'no redirect on a clean write');
  } finally {
    harness.restore();
  }
});

test('queuePendingWrite: a field edited twice before the redirect replays only its latest value', async () => {
  const harness = loadAppInFakeBrowser({});
  try {
    setToken(harness.localStorage, Date.now() - 1000);
    const el = harness.document.createElement('input');

    await harness.App.updateCell('S54', 12, 13, '80', el);
    await harness.App.updateCell('S54', 12, 13, '82.5', el);
    await harness.App.updateCell('S54', 13, 13, '60', el);

    const parked = JSON.parse(harness.sessionStorage.getItem('entr.pendingWrites'));
    assert.equal(parked.length, 2, 'the same cell must be de-duplicated');
    assert.equal(parked[0].value, '82.5', 'the latest value for that cell wins');
    assert.equal(parked[1].rowIndex, 13);
  } finally {
    harness.restore();
  }
});

test('flushPendingWrites: replays parked edits once a token is back, then clears the queue', async () => {
  const harness = loadAppInFakeBrowser({ fetchHandler: () => jsonResponse(200, { updatedCells: 1 }) });
  try {
    setToken(harness.localStorage, Date.now() + 3600000);
    harness.sessionStorage.setItem('entr.pendingWrites', JSON.stringify([
      { kind: 'cell', sheetName: 'S54', rowIndex: 12, colIndex: 13, value: '82.5' },
      { kind: 'rpe', sheetName: 'S54', rowIndex: 12, colIndex: 14, value: '8.5' }
    ]));

    const replayed = await harness.App.flushPendingWrites();

    assert.equal(replayed, 2);
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[0].init.method, 'PUT');
    assert.match(decodeURIComponent(harness.calls[0].url), /'S54'!N12/, 'column N (index 13), row 12');
    assert.match(decodeURIComponent(harness.calls[1].url), /'S54'!O12/, 'RPE stays pinned to column O');
    assert.equal(harness.sessionStorage.getItem('entr.pendingWrites'), null, 'a fully replayed queue is cleared');
  } finally {
    harness.restore();
  }
});

test('flushPendingWrites: an edit that fails again stays parked for the next attempt', async () => {
  const harness = loadAppInFakeBrowser({ fetchHandler: () => jsonResponse(500, { error: { message: 'boom' } }) });
  try {
    setToken(harness.localStorage, Date.now() + 3600000);
    const entry = { kind: 'cell', sheetName: 'S54', rowIndex: 12, colIndex: 13, value: '82.5' };
    harness.sessionStorage.setItem('entr.pendingWrites', JSON.stringify([entry]));

    const replayed = await harness.App.flushPendingWrites();

    assert.equal(replayed, 0);
    assert.deepEqual(JSON.parse(harness.sessionStorage.getItem('entr.pendingWrites')), [entry]);
  } finally {
    harness.restore();
  }
});

test('updateCell: a 401 on an apparently-valid token parks the edit instead of alerting', async () => {
  const harness = loadAppInFakeBrowser({ fetchHandler: () => jsonResponse(401, { error: { message: 'Invalid Credentials' } }) });
  try {
    setToken(harness.localStorage, Date.now() + 3600000);

    // alert() does not exist under node — if the auth path ever fell
    // through to it, this test would throw instead of returning false.
    const el = harness.document.createElement('input');
    const ok = await harness.App.updateCell('S54', 12, 13, '82.5', el);

    assert.equal(ok, false);
    assert.deepEqual(JSON.parse(harness.sessionStorage.getItem('entr.pendingWrites')), [
      { kind: 'cell', sheetName: 'S54', rowIndex: 12, colIndex: 13, value: '82.5' }
    ]);
    assert.match(harness.location.href, /prompt=none/, 'the 401 backstop must also renew');
  } finally {
    harness.restore();
  }
});

// ---------------------------------------------------------------------
// resolveWeekTabs — which sheet counts as "this week"
// ---------------------------------------------------------------------

// A one-JOUR week sheet. `fatigue` undefined -> the day is unfinished.
function weekTab(title, fatigue) {
  const specs = [
    { at: 3, cells: jourRow('JOUR 1') },
    { at: 4, cells: exerciseRow({ name: 'Squat', sets: '3', reps: '5', charge: '100' }) },
  ];
  if (fatigue !== undefined) {
    specs.push({ at: 5, cells: (() => { const r = []; r[10] = String(fatigue); r[15] = 'Fatigue post-séance'; return r; })() });
  }
  return { sheet_name: title, values: buildRows(specs) };
}

function fetcherFor(tabs) {
  return (title) => Promise.resolve(tabs[title] || null);
}

test('resolveWeekTabs: an untouched newest sheet does not steal the week from an unfinished previous one', async () => {
  const tabs = {
    S54: weekTab('S54', 7),
    S55: weekTab('S55'),        // previous week, still unfinished
    S56: weekTab('S56'),        // new sheet, never started
  };
  const r = await App.resolveWeekTabs(['S54', 'S55', 'S56'], fetcherFor(tabs));

  assert.equal(r.currentTitle, 'S55', 'the unfinished week must stay current');
  assert.equal(r.pastTitle, 'S54', 'the past window must slide back with it');
  assert.equal(r.currentTab, tabs.S55);
  assert.equal(r.pastTab, tabs.S54);
});

test('resolveWeekTabs: the newest sheet becomes current as soon as one of its days is completed', async () => {
  const tabs = {
    S54: weekTab('S54', 7),
    S55: weekTab('S55'),        // left unfinished on purpose — user moved on
    S56: weekTab('S56', 6),     // started
  };
  const r = await App.resolveWeekTabs(['S54', 'S55', 'S56'], fetcherFor(tabs));

  assert.equal(r.currentTitle, 'S56');
  assert.equal(r.pastTitle, 'S55');
});

test('resolveWeekTabs: a fully completed previous week hands over to the new sheet', async () => {
  const tabs = { S55: weekTab('S55', 8), S56: weekTab('S56') };
  const r = await App.resolveWeekTabs(['S55', 'S56'], fetcherFor(tabs));

  assert.equal(r.currentTitle, 'S56');
  assert.equal(r.pastTitle, 'S55');
});

test('resolveWeekTabs: sliding back with no older sheet leaves pastTitle null, not the current week', async () => {
  const tabs = { S55: weekTab('S55'), S56: weekTab('S56') };
  const r = await App.resolveWeekTabs(['S55', 'S56'], fetcherFor(tabs));

  assert.equal(r.currentTitle, 'S55');
  assert.equal(r.pastTitle, null);
  assert.equal(r.pastTab, null);
});

test('resolveWeekTabs: a single sheet, and a cache miss, both fall back to the plain -1/-2 window', async () => {
  const only = { S56: weekTab('S56') };
  const single = await App.resolveWeekTabs(['S56'], fetcherFor(only));
  assert.equal(single.currentTitle, 'S56');
  assert.equal(single.pastTitle, null);

  // Cache-first path: the previous tab isn't in localStorage yet.
  const miss = await App.resolveWeekTabs(['S55', 'S56'], fetcherFor({ S56: weekTab('S56') }));
  assert.equal(miss.currentTitle, 'S56', 'an unavailable previous tab must not shift the window');
  assert.equal(miss.pastTitle, 'S55');
});

test('resolveWeekTabs: days with no exercises never count as started or unfinished', async () => {
  const empty = { sheet_name: 'S56', values: buildRows([{ at: 3, cells: jourRow('JOUR 1') }]) };
  assert.equal(App.weekIsStarted(empty), false);
  assert.equal(App.weekHasUnfinishedDay(empty), false);

  // S56 has only empty day headers -> not started; S55 unfinished -> stays current.
  const r = await App.resolveWeekTabs(['S55', 'S56'], fetcherFor({ S55: weekTab('S55'), S56: empty }));
  assert.equal(r.currentTitle, 'S55');
});

// ---------------------------------------------------------------------
// renderVersionInfo — the settings-menu version footer
// ---------------------------------------------------------------------

// Runs renderVersionInfo() against the fake browser with a stub Cache
// Storage, and hands back the two elements it writes into.
async function runVersionInfo(cacheKeys) {
  const harness = loadAppInFakeBrowser({});
  const saved = { version: global.CACHE_VERSION, caches: global.caches };
  global.CACHE_VERSION = 'entr-v9';
  if (cacheKeys === undefined) {
    delete global.caches;
  } else {
    global.caches = { keys: () => Promise.resolve(cacheKeys) };
  }
  try {
    await harness.App.renderVersionInfo();
    return {
      version: harness.document.getElementById('version-value').textContent,
      sw: harness.document.getElementById('version-sw').textContent,
      swClass: harness.document.getElementById('version-sw').className
    };
  } finally {
    if (saved.version === undefined) delete global.CACHE_VERSION; else global.CACHE_VERSION = saved.version;
    if (saved.caches === undefined) delete global.caches; else global.caches = saved.caches;
    harness.restore();
  }
}

test('renderVersionInfo: shows the running CACHE_VERSION and confirms a matching service worker', async () => {
  const r = await runVersionInfo(['entr-shell-entr-v9']);
  assert.equal(r.version, 'entr-v9');
  assert.match(r.sw, /à jour/);
  assert.equal(r.swClass, '', 'a matching service worker must not be flagged');
});

test('renderVersionInfo: flags a service worker still serving an older shell', async () => {
  const r = await runVersionInfo(['entr-shell-entr-v8']);
  assert.equal(r.version, 'entr-v9');
  assert.match(r.sw, /entr-v8/);
  assert.match(r.sw, /obsolète/);
  assert.equal(r.swClass, 'stale');
});

test('renderVersionInfo: copes with no shell cache and with no Cache Storage at all', async () => {
  const notInstalled = await runVersionInfo([]);
  assert.equal(notInstalled.version, 'entr-v9');
  assert.match(notInstalled.sw, /pas encore installé/);

  const noCaches = await runVersionInfo(undefined);
  assert.equal(noCaches.version, 'entr-v9');
  assert.match(noCaches.sw, /indisponible/);
});

test('renderVersionInfo: falls back to "inconnue" when config.js has not loaded', async () => {
  const harness = loadAppInFakeBrowser({});
  const saved = { version: global.CACHE_VERSION, caches: global.caches };
  delete global.CACHE_VERSION;
  delete global.caches;
  try {
    await harness.App.renderVersionInfo();
    assert.equal(harness.document.getElementById('version-value').textContent, 'inconnue');
  } finally {
    if (saved.version === undefined) delete global.CACHE_VERSION; else global.CACHE_VERSION = saved.version;
    if (saved.caches === undefined) delete global.caches; else global.caches = saved.caches;
    harness.restore();
  }
});

// ---------------------------------------------------------------------
// Source-level checks
// ---------------------------------------------------------------------

test('CACHE_VERSION is identical in config.js and sw.js, and index.html has the version footer', () => {
  const fs = require('node:fs');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const versionIn = (f) => {
    const m = read(f).match(/var CACHE_VERSION = '([^']+)'/);
    assert.ok(m, 'CACHE_VERSION literal not found in ' + f);
    return m[1];
  };
  // sw.js keeps its own copy on purpose (it has no DOM, so it can't import
  // config.js) — README's release steps say to bump both. This is the guard
  // that a release didn't bump only one of them.
  assert.equal(versionIn('sw.js'), versionIn('config.js'));

  const html = read('index.html');
  assert.match(html, /id="version-value"/);
  assert.match(html, /id="version-sw"/);
});

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
