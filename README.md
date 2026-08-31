# Entraînement

Diego's gym-workout tracker — a static, serverless Progressive Web App that reads and writes a Google Sheet
directly from the browser. No backend, no database, no stored secrets. It replaces the old FastAPI-backed
`academia.html` app (which kept live Google credentials in a git-tracked file on a VPS) with a plain static
site hosted on GitHub Pages.

The app shows the current week's workout ("Entraînement"), the upcoming days ("À venir"), and the previous
week for reference ("Passé" — the whole previous-week sheet, plus the current week's already-completed
days), including a `Passé: …` hint line carrying last week's load for the same exercise. The "Perfs"
(charts) tab from the old app is dropped — everything else looks and behaves the same.

## How it works

- **Hosting**: static files (HTML/CSS/JS) served by GitHub Pages from this repo, `main` branch, root.
- **Auth**: Google OAuth 2.0 *implicit* flow, top-level redirect (no popup, no server, no client secret).
  The browser gets a short-lived (1 h) access token directly from Google.
- **Data**: the browser calls the Google Sheets API (`sheets.googleapis.com/v4`) directly with that token —
  read the sheet, write a single cell.
- **Cache**: sheet snapshots (up to ~1 month of week tabs), the resolved tab list, and small settings are
  kept in `localStorage` on the device. The app renders instantly from cache and refreshes in the
  background, so it opens with no network and shows the last cached workout offline. Edits need a network
  connection.
- **Install**: it's an installable PWA — "Add to Home Screen" gives it a real app icon and a standalone
  window, on iPhone and on desktop Chrome/Edge.

No workout data, credentials, or secrets are ever committed to this repo — it is public.

## Setup

**Live site**: `https://katsub.github.io/entrainement/`
(GitHub Pages → repo Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.)

**Google Cloud OAuth client** (project `gg-arena`, already provisioned):

- Client ID: `774618988902-e5jq9nc645jld1u2jv4jetqt51g0lfqf.apps.googleusercontent.com` (public identifier,
  safe to ship client-side — see `config.js`). The matching client secret is **never** used by this app and
  must never be added to this repo.
- Authorized redirect URIs registered on the client:
  - `https://katsub.github.io/entrainement/`
  - `http://localhost:8000/` (for local development)
- Scope requested: `https://www.googleapis.com/auth/spreadsheets`.
- The target spreadsheet ID lives in `config.js` (`SPREADSHEET_ID`). The ID itself is not sensitive — the
  sheet's actual access control is Google Sheets sharing permissions, unaffected by this repo being public.

If the OAuth consent screen is still in *Testing* mode, only accounts on its test-user list can sign in;
that surfaces immediately as "Access blocked … only available to testers" and is fixed by adding the
account in Cloud Console → APIs & Services → OAuth consent screen.

## Local run

From this directory:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser. Sign-in works locally because `http://localhost:8000/` is
already registered as an authorized redirect URI on the OAuth client.

No build step, no dependencies to install — it's plain HTML/CSS/JS.

## How to release a new version

1. Make your change.
2. Bump `CACHE_VERSION` in **both** `config.js` and `sw.js` (e.g. `entr-v1` → `entr-v2`). This is what makes
   the service worker discard its old cached app shell and pick up the new files — skipping it means users
   can keep seeing a stale cached version.
3. Commit and `git push` to `main`.
4. GitHub Pages redeploys automatically; the new version is live within a few minutes (Pages' CDN can hold
   `index.html` briefly). The service worker is registered network-first for the app shell, so an open tab
   picks up the update on next load/reload without needing a hard refresh.
5. To confirm a device actually picked it up, open the settings menu (gear icon): it shows the
   `CACHE_VERSION` of the JS currently running, plus the version of the shell the service worker is
   serving. If the two disagree the service-worker line turns amber — reload once more.

## Repo layout

```
index.html            structure + styles
config.js              CLIENT_ID, SPREADSHEET_ID, SCOPE, CACHE_VERSION (public identifiers only)
auth.js                OAuth implicit redirect flow + token storage
sheets.js               Sheets REST calls + tab discovery + localStorage cache
app.js                  rendering / parsing logic
sw.js                    service worker, app-shell precache
manifest.webmanifest     PWA manifest
icons/                   app + tab icons
tests/                   node --test, synthetic fixtures only — never real workout data
```
