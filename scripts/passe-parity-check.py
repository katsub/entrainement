#!/usr/bin/env python3
"""
Passe parity regression check (plan §H2).

Local-only dev tool -- NOT part of the app, NOT part of GitHub Pages, NOT
CI. It re-verifies that this repo's app.js `injectPastComments` produces
byte-identical column-R ("Passe:" line) output to the old server.py's
`inject_past_exercise_comments`, using a real developer's cached Sheets
payloads.

KNOWN DELIBERATE DIVERGENCE (bug fix): app.js now carries a merged
"Series" cell (column K) down its exercise group on both sides, the way
parseDays already does, so an exercise that is not the first of a fused
group gets its "Passe:" line too. server.py required a literal non-empty
K, so it emitted nothing there. Expect mismatches on exactly those rows --
app.js filling a column R that server.py left empty is the fix working,
not a regression. Any mismatch where BOTH sides emit a "Passe:" line, or
where server.py emits one and app.js does not, is still a real failure.

This script contains NO real workout data. At runtime it:
  1. sed-equivalent-extracts inject_past_exercise_comments straight out of
     server.py's source text (server.py:1571-1691) and execs *only* that
     function body -- it never does `import server`, which would run the
     old app's DB init / FastAPI setup / credential loading as a side
     effect (see plan H2).
  2. Opens sbd_exercises.db read-only (`file:...?mode=ro`) and reads the
     two cached sheet_cache blobs for one user.
  3. Writes those blobs only to a throwaway system temp directory (never
     into this repo) so a companion Node script can run this repo's own
     injectPastComments over the identical bytes.
  4. Diffs every column-R (index 17) value between the two runs and
     reports N compared / mismatch count. 0 mismatches is the pass bar.

Requires the full gg-arena-vibe working tree (server.py + sbd_exercises.db
one level up from this repo) -- it will not find those files, and will
exit 2, in a fresh clone of this public repo on its own. That is by design:
this tool is for a developer re-verifying parity against real data after
changing server.py's or app.js's injectPastComments, not for Pages/CI.

Usage:
    python3 scripts/passe-parity-check.py
    python3 scripts/passe-parity-check.py --user lucas
    python3 scripts/passe-parity-check.py --db /path/to/sbd_exercises.db \
        --server /path/to/server.py --app-js /path/to/app.js
"""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
# entrainement/scripts/ -> entrainement/ -> gg-arena-vibe/ (parent working tree)
DEFAULT_DB = os.path.normpath(os.path.join(HERE, "..", "..", "sbd_exercises.db"))
DEFAULT_SERVER = os.path.normpath(os.path.join(HERE, "..", "..", "server.py"))
DEFAULT_APP_JS = os.path.normpath(os.path.join(HERE, "..", "app.js"))
JS_RUNNER = os.path.join(HERE, "passe-parity-run-js.js")

# server.py:1571-1691 -- inject_past_exercise_comments. If server.py is
# ever edited and this function moves, update these two line numbers.
REF_START, REF_END = 1571, 1691


def extract_reference_function(server_py_path):
    """Read-only source extraction, never `import server` (H2)."""
    with open(server_py_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    body = "".join(lines[REF_START - 1:REF_END])
    if "def inject_past_exercise_comments" not in body:
        raise RuntimeError(
            f"server.py:{REF_START}-{REF_END} no longer contains "
            "inject_past_exercise_comments -- line numbers drifted, "
            "update REF_START/REF_END in this script"
        )
    namespace = {}
    exec("import re\n" + body, namespace)
    return namespace["inject_past_exercise_comments"]


def export_payloads(db_path, user, out_dir):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        current_key = f"academia_last_sheet_{user}"
        past_key = f"academia_past_sheet_{user}"

        cur.execute("SELECT data FROM sheet_cache WHERE key = ?", (current_key,))
        row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"key {current_key!r} not found in sheet_cache")
        current_raw = row[0]

        cur.execute("SELECT data FROM sheet_cache WHERE key = ?", (past_key,))
        row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"key {past_key!r} not found in sheet_cache")
        past_raw = row[0]
    finally:
        con.close()

    current_path = os.path.join(out_dir, "current_payload.json")
    past_path = os.path.join(out_dir, "past_payload.json")
    with open(current_path, "w", encoding="utf-8") as f:
        f.write(current_raw)
    with open(past_path, "w", encoding="utf-8") as f:
        f.write(past_raw)
    return current_path, past_path


def col_r_from_result(result):
    return [row[17] if len(row) > 17 else None for row in result["values"]]


def main():
    ap = argparse.ArgumentParser(
        description="Passe parity check: diff server.py vs app.js injectPastComments on real cached data."
    )
    ap.add_argument("--db", default=DEFAULT_DB, help="path to sbd_exercises.db (opened read-only)")
    ap.add_argument("--server", default=DEFAULT_SERVER, help="path to server.py (sed-extracted, never imported)")
    ap.add_argument("--app-js", default=DEFAULT_APP_JS, help="path to app.js (must export injectPastComments)")
    ap.add_argument("--user", default="diego", help="sheet_cache key suffix, e.g. diego / lucas")
    ap.add_argument("--node", default="node", help="node executable to run the JS side")
    args = ap.parse_args()

    for label, path in (("--db", args.db), ("--server", args.server), ("--app-js", args.app_js)):
        if not os.path.isfile(path):
            print(
                f"SKIP: {label} not found at {path}. This is a local-only dev tool that "
                f"needs the full gg-arena-vibe working tree (server.py + sbd_exercises.db "
                f"one level above this repo) -- expected in a bare clone of this public repo.",
                file=sys.stderr,
            )
            sys.exit(2)

    out_dir = tempfile.mkdtemp(prefix="passe-parity-")
    try:
        current_path, past_path = export_payloads(args.db, args.user, out_dir)

        with open(current_path, encoding="utf-8") as f:
            current_data = json.load(f)
        with open(past_path, encoding="utf-8") as f:
            past_data = json.load(f)

        ref_fn = extract_reference_function(args.server)
        ref_result = ref_fn(current_data, past_data)
        ref_col_r = col_r_from_result(ref_result)

        js_out_path = os.path.join(out_dir, "js_col_r.json")
        subprocess.run(
            [args.node, JS_RUNNER, args.app_js, current_path, past_path, js_out_path],
            check=True,
        )
        with open(js_out_path, encoding="utf-8") as f:
            js_col_r = json.load(f)

        n = len(ref_col_r)
        if len(js_col_r) != n:
            print(f"FAIL: row count mismatch -- ref={n} js={len(js_col_r)}")
            sys.exit(1)

        mismatches = [i for i in range(n) if ref_col_r[i] != js_col_r[i]]
        print(f"N compared: {n}")
        print(f"Mismatches: {len(mismatches)}")
        if mismatches:
            print(f"Mismatch row indices: {mismatches}")
            sys.exit(1)
        print("PASS -- 0 mismatches")
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
