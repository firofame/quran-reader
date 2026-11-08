# The Quran — A Space for Reflection

A quiet, responsive web reader for English and Malayalam translations of the
Quran.

- Explore 114 chapters with search across chapter names, meanings, Arabic text,
  and chapter numbers.
- Switch between Saheeh International (English) and Cheriyamundam Abdul Hameed &
  Kunhi Mohammed Parappoor (Malayalam).
- Complete Tanzil chapter and ayah metadata is baked in: verses, revelation
  order, revelation place, rukus, pages, manzils, hizb quarters, juzs, and
  sajdas.

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
- The gold bar below the reader tracks your ayah position within the current
  ruku, filling at its last ayah and resetting when you enter another ruku.
- Focus on one ayah, then use **Back** / **Continue** or the left/right arrow keys
  to move through the Quran. Navigation continues across chapter boundaries.
- Search the entire current chapter and move through matching ayahs one at a
  time.
- Jump to an ayah, or use its verse number as a direct link, such as `#2:255`.
- Adjust text size and switch between light and dark themes.
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
This is a translation reader, not an Arabic Quran text reader. Translation text is displayed unchanged.

## Cross-Device Sync

Sync is off by default. Nothing is sent to the sync service until you explicitly
choose **Start syncing** or **Join sync** in the Cross-device sync panel.

After upgrading from an older version, any sync configuration that did not record
explicit consent is cleared; local reading data remains. Set up sync again and
rejoin your devices with the new setup code.

1. On your first device, open **Controls** → **Cross-device sync** and choose
   **Start syncing**. The app creates a private key and connects automatically.
2. Choose **Copy setup code**.
3. On each additional device, open **Cross-device sync**, paste the code under
   **Another device**, and choose **Join sync**.

The setup code is private: anyone with it can read or change that sync space's
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
`app.js` connects those modules to the browser UI and interaction behavior.

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

The workflow runs the checks and tests, then publishes only the HTML, CSS,
browser JavaScript, favicon, metadata, and translation files. The local server,
tests, and project configuration are not included in the published site.
The repository's **Settings → Pages → Source** must be set to **GitHub Actions**.
Relative asset URLs support the `/quran-reader/` project path and direct ayah
links such as <https://firofame.github.io/quran-reader/#2:255>.

## Sources

The supplied translation files include their original source and translator
attribution. English: Saheeh International. Malayalam:
Cheriyamundam Abdul Hameed and Kunhi Mohammed Parappoor. Source:
[Tanzil translations](https://tanzil.net/trans/). These files remain unchanged;
their respective translators' rights and terms continue to apply.

Chapter metadata: copyright © 2008–2009 Tanzil.info, licensed under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
