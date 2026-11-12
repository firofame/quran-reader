# Repository audit

## Stack, run, and deployment

- The reader is a dependency-free static web app using browser JavaScript modules, HTML, and CSS. It lives in `public/` and is served by a Cloudflare Worker as Workers Static Assets.
- One Cloudflare Worker serves the reader as Workers Static Assets. It also answers `/health`; the cross-device sync API and its Durable Object have been removed.
- Run locally with `npm run dev` (Wrangler at `http://localhost:8787`); no Cloudflare account is needed.
- GitHub Actions checks every pull request. Merging to `main` deploys the Worker and its assets to Cloudflare.

## Quran and translation data

- Chapter names and structural metadata are bundled in `public/quran-data.js`, based on Tanzil Quran Metadata 1.0 (CC BY 3.0). It includes 114 chapters, verse counts, ruku starts, juz starts, manzil starts, pages, hizb quarters, and sajda locations.
- The reader shows only the English Saheeh International translation, supplied as `public/en.sahih.txt` and loaded by the browser. The Arabic Uthmani text and the Malayalam translation were removed; their bundled files, the Arabic ayah rendering, and the Arabic typeface and size settings are gone. Attribution and source are in the app and README.

## Ruku, juz, and manzil verification

- The bundled Tanzil convention contains 556 ruku starts. Its per-surah ruku counts sum to 556; Al-Baqarah has 40. Automated checks verify all chapter counts and the 30 juz / 7 manzil assignments and boundaries.
- This differs from the plan's requested 558 convention. The owner selected the documented Tanzil 556 convention because the available 558 resource did not state copyright terms. The app will display the convention it actually uses.
- The bundled file has 30 juz starts and 7 manzil starts. Manzil starts match the seven chapter boundaries listed in the plan.
- Source: [Tanzil Quran Metadata](https://tanzil.net/docs/Quran_Metadata), [Tanzil metadata file](https://tanzil.net/res/text/metadata/quran-data.js), and the attribution/license header in `public/quran-data.js`.

## Saved progress and implementation

- Preferences are stored in localStorage under `quran-reader:v1`.
- The existing shape is `{ translation, position: { chapter, verse }, fontSize, theme }`.
- Every verse navigation saves the exact position. A valid `#chapter:verse` link overrides the saved position on load. Existing position, translation, text size, and theme survive migration; new reading history uses schema version 11.
- On load the reader opens the exact saved verse. A valid explicit verse link opens its linked verse.
- Progress, activity, sessions, settings, and prayer times are stored locally in this browser.
- Reading data stays in this browser. The reader sends no reading position or translation to a server.
- New fields will be added through a versioned migration that keeps the current position and preferences.

## Screens and navigation

- One reading screen shows one complete translated ayah at a time. Chapter navigation is in the left drawer, with a small play/pause control beside each ayah reference. Text size and the catch-up action live in Settings. There is no translation picker, because Saheeh International is the only translation.
- Previous/Continue buttons and left/right arrows navigate ayahs, including across chapter boundaries. Direct verse links use `#chapter:verse`. The last ayah of a ruku turns the next action into "Finish ruku". Space and `Escape` cover the rest of the reading shortcuts.
- Current metadata includes page, ruku, manzil, hizb, juz, and sajda. A small ring in the daily panel tracks the current ayah within its ruku. The daily panel also counts down to the next adhan or iqama moment.
- The reader also has a Settings view for reading preferences and the five daily prayers. The manual reading anchors have been replaced by the fixed prayers, Fajr, Dhuhr, Asr, Maghrib, and Isha; each prayer keeps its adhan and iqama times, and only those times can be adjusted.
- Browser reminders request notification permission only when enabled and only schedule while the page is open. They fire at the adhan and at the iqama of every prayer. The app is an installable PWA; the service worker caches its local reading assets for offline use.
- One-verse recitation is available from the play icon beside each ayah. It streams Alafasy 128 kbps from Al Quran Cloud after a direct user action. See the provider's current [terms](https://alquran.cloud/terms-and-conditions).
- Word-by-word meanings remain unpopulated because no sufficiently suitable and attributable source was selected. The app does not generate religious content.

## Tests

- Tests use Node's built-in test runner: `npm test`.
- Syntax validation runs with `npm run check`.
- Existing coverage includes metadata and verse parsing, navigation, state validation, local storage, Worker behavior, deployment, and static asset serving.
- New reading-data coverage checks the selected 556 Ruku convention, all per-surah counts, Juz and Manzil boundaries, local day boundaries, daily and lifetime totals, schema migration, startup position rules, and the bundled English verse count.
