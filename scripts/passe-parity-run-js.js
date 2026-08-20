#!/usr/bin/env node
'use strict';
// Companion to passe-parity-check.py (plan H2). Loads this repo's app.js,
// runs its injectPastComments over two payload JSON files given on argv,
// and dumps every column-R (index 17) value to an output JSON file. This
// file itself contains no data -- every path comes from argv, and both
// input/output files live in a throwaway system temp dir the Python
// caller creates and deletes, never in this repo.
const fs = require('fs');

const [, , appJsPath, currentPath, pastPath, outPath] = process.argv;
if (!appJsPath || !currentPath || !pastPath || !outPath) {
    console.error('usage: node passe-parity-run-js.js <app.js path> <current.json> <past.json> <out.json>');
    process.exit(2);
}

const { injectPastComments } = require(appJsPath);

const currentData = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
const pastData = JSON.parse(fs.readFileSync(pastPath, 'utf8'));

const result = injectPastComments(currentData, pastData);
const colR = result.values.map((row) => (row.length > 17 ? row[17] : null));

fs.writeFileSync(outPath, JSON.stringify(colR));
