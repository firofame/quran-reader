# The Quran — A Space for Reflection

A quiet, responsive Quran reader with the original Arabic text and English or
Malayalam translations.

- Explore 114 chapters with search across chapter names, meanings, Arabic text,
  and chapter numbers.
- Switch between Saheeh International (English) and Cheriyamundam Abdul Hameed &
  Kunhi Mohammed Parappoor (Malayalam).
- Complete Tanzil chapter and ayah metadata is baked in: verses, revelation
  order, revelation place, rukus, pages, manzils, hizb quarters, juzs, and
  sajdas.
- The original Uthmani Arabic text appears above the selected translation.
- Resume the saved ayah, see overall and daily ruku progress, and finish with an
  optional reflection. Reading progress, bookmarks, notes, settings, and recent
  activity stay in this browser by default.
- Journey, weekly review, Friday Al-Kahf progress, manual reading anchors,
  optional browser reminders, and a separate seven-day Flow plan.
- Optional one-ayah recitation is off by default and only plays after a direct
  click. The reader never starts audio automatically.
- Installable PWA with an offline cache for the reader, text, and translations.

---

## Getting Started

Start the local static server:

```sh
npm start
```

Then open `http://localhost:3000` in your browser.
Opening `index.html` directly with a `file://` URL will not work because the
browser blocks the reader's local data-file requests.

## Reader Features

- See the current ayah's page, ruku, manzil, hizb, and juz; sajda ayahs carry a
  subtle ۩ marker.
- The gold bar above the ayah tracks your position within the current ruku,
  filling at its last ayah and resetting when you enter another ruku.
- Focus on one ayah, then use **Back** / **Continue** or the left/right arrow keys
  to move through the Quran. Navigation continues across chapter boundaries.
- Search the entire current chapter and move through matching ayahs one at a
  time.
- Jump to an ayah, or use its verse number as a direct link, such as `#2:255`.
- Adjust text size and switch between light and dark themes.
- Read in a centered column no wider than 680px, with start-aligned translation
  text (left for English and Malayalam), normal letter spacing, and 26px between
  paragraphs. Default English text is 22px with 1.8 line height, or 20px on
  phones up to 430px wide. Text-size controls still apply; Malayalam retains its
  script-specific font and more generous line height.
- Long translations (500 or more characters) are grouped at locale-aware
  sentence boundaries, aiming for about 300 characters per paragraph. Quoted
  passages and individual sentences can exceed that target rather than being
  split. All source wording, punctuation, and whitespace are preserved; these
  are display-only reading pauses, not editorial interpretations of meaning.
- A small progress bar beneath the current ayah count tracks the surah. A brief,
  motion-free fade signals a new ayah; reduced-motion preferences disable it.
- The exact selected ayah and preferences are saved in this browser's local
  storage by default. Cross-device synchronization is off until you choose to
  start or join it; see [Cross-Device Sync](#cross-device-sync).
- Press `/` to find a chapter, and Escape to clear a focused search or close
  the controls or mobile chapter drawer.

Translations are loaded from the supplied local files and retained in memory
while the page is open. A fresh installation makes no cloud requests. After you
choose **Start syncing** or **Join sync**, the app sends your reading position
and selected translation identifier to the Quran Reader sync service;
translation text remains local.
Arabic and translation text are displayed together, with Arabic above the
translation. Translation wording is unchanged; paragraph breaks are added only
for display. Optional sentence-by-sentence Focus Reading is not implemented:
complete ayahs remain visible.

## Reading data and sources

- Arabic text: Tanzil Project, Uthmani text 1.1, CC BY 3.0. It is bundled
  verbatim with Tanzil's copyright and license notice; changing the text is not
  allowed. See the in-app attribution and [Tanzil's terms](https://tanzil.net/docs/Text_License).
- Structural metadata: Tanzil Quran Metadata 1.0, CC BY 3.0. The app uses the
  documented Tanzil convention of **556 rukus** (40 in Al-Baqarah), with 30
  juzs and 7 manzils. This is the 556-division convention, not the separate 558
  convention referenced in the improvement brief.
- Translations: English Saheeh International; Malayalam Cheriyamundam Abdul
  Hameed and Kunhi Mohammed Parappoor. Files and attribution are supplied by the
  project and are not modified.
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

## Cross-Device Sync

Sync is off by default. Nothing is sent to the sync service until you explicitly
choose **Start syncing** or **Join sync** in the Cross-device sync panel.

After upgrading from an older version, sync configuration without explicit
consent, or configuration pointing to a different service, is cleared before
any sync request. Local reading data remains. Set up sync again and rejoin your
devices with the new setup code.

1. On your first device, open **Controls** → **Cross-device sync** and choose
   **Start syncing**. The app creates a private key and connects automatically.
2. Choose **Copy setup code**.
3. On each additional device, open **Cross-device sync**, paste the code under
   **Another device**, and choose **Join sync**.

Setup codes connect only to the project's service at
`https://quran.firofame.workers.dev`; custom-server codes are not accepted.
The code is Base64url-encoded, not encrypted. Keep it private: anyone with it can read or change that sync space's
reading position and translation choice. Reading changes are saved locally first
and remain available offline. Position and translation updates use bounded
timestamp-based conflict resolution.

The sync service is hosted by the project, so readers do not need a Cloudflare
account or a Worker URL. See [`worker/README.md`](worker/README.md) for maintainer
deployment and service details.

## Architecture

The app remains a dependency-free static site. `reader.js` contains pure Quran
data, parsing, search, and navigation logic. `reader-state.js` owns validated
state transitions; `preferences-store.js` isolates browser persistence;
`sync-client.js` manages background cross-device synchronization and conflict resolution;
and `translation-repository.js` loads, validates, and caches translation data.
`reading-data.js` validates the versioned local reading history and computes
progress, pace, and section membership. `app.js` connects those modules to the
browser UI and interaction behavior.
Paragraph grouping uses the browser's standard `Intl.Segmenter` API.

## Validate

```sh
npm run check
npm test
```

Pull requests targeting `main` run these checks automatically through the
[validation workflow](.github/workflows/validate.yml).

## Publish

[GitHub Pages](https://firofame.github.io/quran-reader/) is deployed automatically
by [the Pages workflow](.github/workflows/pages.yml) when changes are pushed to
`main`. It can also be run manually from the repository's Actions tab.

The workflow runs the checks and tests, then publishes the HTML, CSS, browser
JavaScript, Quran metadata and Arabic text, translations, manifest, icons, and
service worker. The local server, tests, and project configuration are not
included in the published site.
The repository's **Settings → Pages → Source** must be set to **GitHub Actions**.
Relative asset URLs support the `/quran-reader/` project path and direct ayah
links such as <https://firofame.github.io/quran-reader/#2:255>.

## Sources

The supplied Arabic and translation files include their original source and
attribution. Arabic: Tanzil Uthmani text v1.1. English: Saheeh International. Malayalam:
Cheriyamundam Abdul Hameed and Kunhi Mohammed Parappoor. Source:
[Tanzil translations](https://tanzil.net/trans/). These files remain unchanged;
their respective translators' rights and terms continue to apply.

Chapter metadata: copyright © 2008–2009 Tanzil.info, licensed under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
