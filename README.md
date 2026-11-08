# The Quran

A minimal, responsive Quran translation reader with a focused, one-ayah-at-a-time
reading view. No framework, dependencies,
accounts, API keys, or external font requests.

**Read online:** <https://firofame.github.io/quran-reader/>

## Run

Requires Node.js 22 or newer:

```sh
npm start
```

Open <http://localhost:3000>. Use `PORT=3001 npm start` to choose another port.
The server listens on the local machine only. Alternatively, serve this directory
with a static web server; opening the HTML directly with `file://` will not work
because browsers restrict fetching local translation files.

## Reading

- The verse takes priority in a viewport-filling reader with a compact chapter
  header. Open **Controls** for translation, text size, search, and ayah jump.
  Short ayahs and their navigation fit on screen; longer ayahs scroll naturally
  without clipping or shrinking the text. Source credits sit below the reader.
- Browse or search all 114 chapters by name, meaning, Arabic name, or number.
- Read the supplied Saheeh International or Malayalam translation.
- See the current ayah's page, ruku, manzil, hizb, and juz; sajda ayahs carry a
  subtle ۩ marker.
- The gold bar below the reader tracks your ayah position within the current
  ruku, filling at its last ayah and resetting when you enter another ruku.
- Focus on one ayah, then use **Back** / **Continue** or the left/right arrow keys
  to move through the Quran. Navigation continues across chapter boundaries.
- Search the entire current chapter and move through matching ayahs one at a
  time. Saved verses remain a browsable collection.
- Jump to an ayah, or use its verse number as a direct link, such as `#2:255`.
- Bookmark verses and revisit them in **Saved**. Click a saved verse number to
  return to its chapter.
- Adjust text size and switch between light and dark themes.
- The exact selected ayah, bookmarks, and preferences are saved in this browser's local
  storage by default. Optional cross-device synchronization can be enabled to keep your
  reading position and bookmarks synced across desktop and mobile browsers via a Cloudflare
  Worker (see [Cross-Device Sync](#cross-device-sync)).
- Press `/` to find a chapter, and Escape to clear a focused search or close
  the controls or mobile chapter drawer.

Translations are loaded from the supplied local files and retained in memory
while the page is open. There are no external API calls unless cloud sync is configured.
This is a translation reader, not an Arabic Quran text reader. Translation text is displayed unchanged.

## Cross-Device Sync

To seamlessly synchronize reading progress and bookmarks across multiple devices (for example, Opera on macOS and Opera on Android) without introducing traditional user accounts or email registrations:

- Open **Controls** in the reader and navigate to **Cross-device sync**.
- Enter your deployed Cloudflare Worker URL and a shared sync password (or generate a random key).
- The reader stores state in `localStorage` first for instant, offline-capable interactions, and synchronizes with a **Cloudflare Worker backed by a SQLite Durable Object** in the background.
- Because Durable Objects are globally addressable and SQLite-backed, synchronization is strongly consistent with atomic last-write-wins conflict resolution.

See [`worker/README.md`](worker/README.md) for complete Cloudflare Worker configuration, SQLite Durable Object schema, and deployment instructions using Wrangler.

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

Tests verify all 6,236 verses in each translation, metadata alignment, malformed
data handling, focused ayah selection, navigation across chapter boundaries,
bottom button navigation, search, deep links, saved preferences, and
static server routes.

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
