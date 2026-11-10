# Repository audit

## Stack, run, and deployment

- Dependency-free static web app using browser JavaScript modules, HTML, and CSS.
- Run locally with `npm start` (Node static server at `http://localhost:3000`).
- GitHub Actions checks and publishes the static site to GitHub Pages. The optional cross-device sync service is a separate Cloudflare Worker.

## Quran and translation data

- Chapter names and structural metadata are bundled in `quran-data.js`, based on Tanzil Quran Metadata 1.0 (CC BY 3.0). It includes 114 chapters, verse counts, ruku starts, juz starts, manzil starts, pages, hizb quarters, and sajda locations.
- The Uthmani Arabic text is now bundled verbatim as `ar.uthmani.txt`, with
  Tanzil's copyright and license block intact. The UI renders the Arabic ayah
  above the selected translation and links to the source/license.
- English Saheeh International and Malayalam Cheriyamundam Abdul Hameed & Kunhi Mohammed Parappoor translations are supplied as local text files and loaded by the browser. Attribution and source are in the app and README.

## Ruku, juz, and manzil verification

- The bundled Tanzil convention contains 556 ruku starts. Its per-surah ruku counts sum to 556; Al-Baqarah has 40. Automated checks verify all chapter counts and the 30 juz / 7 manzil assignments and boundaries.
- This differs from the plan's requested 558 convention. The owner selected the documented Tanzil 556 convention because the available 558 resource did not state copyright terms. The app will display the convention it actually uses.
- The bundled file has 30 juz starts and 7 manzil starts. Manzil starts match the seven chapter boundaries listed in the plan.
- Source: [Tanzil Quran Metadata](https://tanzil.net/docs/Quran_Metadata), [Tanzil metadata file](https://tanzil.net/res/text/metadata/quran-data.js), and the attribution/license header in `quran-data.js`.

## Saved progress and implementation

- Preferences are stored in localStorage under `quran-reader:v1`.
- The existing shape is `{ translation, position: { chapter, verse }, fontSize, theme }`.
- Every verse navigation saves the exact position. A valid `#chapter:verse` link overrides the saved position on load. Existing position, translation, text size, and theme survive migration; new reading history uses schema version 4.
- On load the reader opens the next unread verse rather than repeating the last one read, so a new sitting starts with nothing to click. A saved position that has not been read yet is still reopened exactly, and the behaviour can be turned off in Settings.
- Progress, activity, sessions, daily energy mode, settings, anchors, bookmarks, reflections, and weekly history are local. Export/import moves the complete reader state as one JSON backup.
- Optional sync sends only reading position and translation to the configured Worker; sync is off until the user chooses to connect.
- New fields will be added through a versioned migration that keeps the current position and preferences.

## Screens and navigation

- One reading screen shows one complete translated ayah at a time. Chapter navigation is in the left drawer, and controls include translation, text size, search, and an ayah jump.
- Previous/Continue buttons and left/right arrows navigate ayahs, including across chapter boundaries. Direct verse links use `#chapter:verse`. The last ayah of a ruku turns the next action into "Finish ruku". Space, `b`, `r` and `Escape` cover the rest of the reading shortcuts.
- Current metadata includes page, ruku, manzil, hizb, juz, and sajda. A thin bar tracks the current ayah within its ruku.
- The reader also has Journey, Notes & bookmarks, Week, Khatam plan, and Settings views. Focus mode and continuous-ruku Flow mode preserve the one-ayah deep-reading default. The weekly view separates deep reading, light days and flow reading, and counts the reflections written.
- Browser reminders request notification permission only when enabled and only schedule while the page is open. The app is an installable PWA; the service worker caches its local reading assets for offline use.
- One-verse recitation is optional and off by default. It streams Alafasy 128 kbps from Al Quran Cloud after a direct user action. See the provider's current [terms](https://alquran.cloud/terms-and-conditions).
- Ruku summaries and word-by-word meanings remain unpopulated because no sufficiently suitable and attributable source was selected. The app does not generate religious content.

## Tests

- Tests use Node's built-in test runner: `npm test`.
- Syntax validation runs with `npm run check`.
- Existing coverage includes metadata and verse parsing, navigation, state validation, local storage, synchronization, Worker behavior, deployment, and static asset serving.
- New reading-data coverage checks the selected 556 Ruku convention, all per-surah counts, Juz and Manzil boundaries, local day boundaries, energy mode, daily and lifetime totals, weekly summaries and their deep, light and flow split, schema migration, the resume and startup position rules, and the bundled Arabic verse count and Tanzil notice.
