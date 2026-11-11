# The Quran — A Space for Reflection

A quiet, responsive Quran reader with the English Saheeh International
translation.

- Explore 114 chapters with search across chapter names, meanings, and chapter
  numbers.
- Read the Saheeh International (English) translation of all 6,236 ayahs.
- Complete Tanzil chapter and ayah metadata is baked in: verses, revelation
  order, revelation place, rukus, pages, manzils, hizb quarters, juzs, and
  sajdas.
- Resume the saved ayah, see overall and daily ruku progress, and finish with an
  optional reflection. Reading progress, bookmarks, notes, settings, and recent
  activity stay in this browser by default.
- Journey, weekly review, Friday Al-Kahf progress, manual reading anchors,
  optional browser reminders, and a separate seven-day Flow plan. The weekly
  review separates deep reading, light days, and flow reading, and counts the
  reflections written.
- Optional one-ayah recitation is off by default and only plays after a direct
  click. The reader never starts audio automatically.
- Installable PWA with an offline cache for the reader and the translation.

---

## Getting Started

Install the dependencies and start the local Worker:

```sh
npm install
npm run dev
```

Wrangler serves the reader at `http://localhost:8787`. The Worker runs locally
without a Cloudflare account.

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the Worker and the reader locally with hot reload. |
| `npm test` | Runs the Vitest suites for the Worker and the reader modules. |
| `npm run check` | Syntax-checks the reader modules and type-checks the Worker. |
| `npm run typecheck` | Type-checks `src/` and `test/` with the generated Worker types. |
| `npm run cf-typegen` | Regenerates `worker-configuration.d.ts` after a config change. |
| `npm run deploy` | Publishes the Worker and its assets. |


## Reader Features

- See the current ayah's page, ruku, manzil, hizb, and juz; sajda ayahs carry a
  subtle ۩ marker.
- The gold bar above the ayah tracks your position within the current ruku,
  filling at its last ayah and resetting when you enter another ruku.
- Focus on one ayah, then use **Back** / **Continue** or the left/right arrow keys
  to move through the Quran. Navigation continues across chapter boundaries.
- Jump to an ayah, or use its verse number as a direct link, such as `#2:255`.
- Adjust text size and switch between light and dark themes. Both live in
  Settings, so the reading screen stays free of controls.
- Read in a centered column no wider than 680px, with start-aligned translation
  text, normal letter spacing, and 26px between paragraphs. Default English text
  is 22px with 1.8 line height, or 20px on phones up to 430px wide.
  Text-size controls still apply.
- Long translations (500 or more characters) are grouped at locale-aware
  sentence boundaries, aiming for about 300 characters per paragraph. Quoted
  passages and individual sentences can exceed that target rather than being
  split. All source wording, punctuation, and whitespace are preserved; these
  are display-only reading pauses, not editorial interpretations of meaning.
- A small progress bar beneath the current ayah count tracks the surah. A brief,
  motion-free fade signals a new ayah; reduced-motion preferences disable it.
- The exact selected ayah and preferences are saved in this browser's local
  storage. Nothing is sent to a server.
- If you have already read further on another device, **Mark earlier rukus as
  read** in Settings catches up the overall progress and the lifetime
  totals on this device. The daily and weekly history is left unchanged,
  because the days are not known.
- Reopening the app opens the next unread ayah, so a new sitting starts with
  nothing to click. An ayah that has not been read yet is reopened exactly as
  it was, and an explicit ayah link still wins. This can be turned off in
  Settings.
- Press `/` to find a chapter, `Space` or `→` for the next ayah, `←` for the
  previous one, `b` to bookmark the current ayah, `r` to read it again, and
  `Escape` for the small reading menu.

Translations are loaded from the supplied local file and retained in memory
while the page is open. The app makes no cloud requests for your reading data.
Translation wording is unchanged; paragraph breaks are added only for display.
Optional sentence-by-sentence Focus Reading is not implemented: complete ayahs
remain visible.

## Reading data and sources

- Structural metadata: Tanzil Quran Metadata 1.0, CC BY 3.0. The app uses the
  documented Tanzil convention of **556 rukus** (40 in Al-Baqarah), with 30
  juzs and 7 manzils. This is the 556-division convention, not the separate 558
  convention referenced in the improvement brief.
- Translation: English Saheeh International. The file and its attribution are
  supplied by the project and are not modified.
- Optional recitation: Mishary Rashid Alafasy at 128 kbps, streamed from Al
  Quran Cloud. Its [terms](https://alquran.cloud/terms-and-conditions) permit
  streaming for personal and educational use. The recitation button is hidden
  until enabled in Settings.

The app does not bundle word-by-word meanings or ruku themes: available sources
did not provide a suitable, clearly attributable dataset under terms that fit
this offline-first reader. No religious summaries are generated. This leaves
the context card empty unless a suitable sourced collection is added later.

The first service-worker visit needs a connection to cache the static app and
text. Once installed and cached, reading works offline. Recitation streaming
requires a connection.

## Architecture

The project is a single Cloudflare Worker. [`public/`](public) holds the reader
itself — plain HTML, CSS, and browser JavaScript modules with no build step —
and is served as Workers Static Assets. [`src/index.ts`](src/index.ts) answers
`/health` and the JSON fallback for unknown paths.

The reader modules keep their responsibilities: `reader.js` contains pure Quran
data, parsing, and navigation logic; `reader-state.js` owns validated
state transitions; `preferences-store.js` isolates browser persistence; and
`translation-repository.js` loads, validates, and caches translation data.
`reading-data.js` validates the versioned local reading history and computes
progress, pace, and section membership. `app.js` connects those modules to the
browser UI and interaction behavior.
Paragraph grouping uses the browser's standard `Intl.Segmenter` API.

Tests run in two Vitest projects: `test/worker/` runs inside the Workers
runtime, and `test/node/` covers the reader modules and the deployment helpers
in Node.

## Validate

```sh
npm run check
npm test
```

Pull requests targeting `main` run these checks automatically through the
[validation workflow](.github/workflows/validate.yml).

## Publish

The Worker and its static assets are published together by
[the deploy workflow](.github/workflows/deploy.yml). Merging to `main` deploys
automatically: the workflow validates the revision, confirms the maintainer
authorization, checks that the existing Worker identity is preserved, deploys,
and then verifies the production identity and health.

Production reuses the existing `quran` Worker, so the reader stays on the same
hostname. The retired sync Durable Object and its stored data are deleted by the
`v2` migration the next time the Worker is deployed.

Pull requests get an isolated preview Worker, and the reader is never published
from a fork.


## Sources

The supplied translation file includes its original source and attribution.
English: Saheeh International. Source:
[Tanzil translations](https://tanzil.net/trans/). The file remains unchanged;
the translator's rights and terms continue to apply.

Chapter metadata: copyright © 2008–2009 Tanzil.info, licensed under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
