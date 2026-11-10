import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { TRANSLATIONS, createChapters, getVerseMetadata, getRukuProgress, parseTranslation, splitTranslationParagraphs, parseHash, validPosition, matchesChapter, decodeState, selectAyah, adjacentPosition } from "../reader.js";
import { reduceReaderState } from "../reader-state.js";
import { createPreferencesStore, PREFERENCES_KEY } from "../preferences-store.js";
import { createTranslationRepository } from "../translation-repository.js";
import { createReaderServer } from "../server.js";
import { createDefaultReadingData, READER_SCHEMA_VERSION } from "../reading-data.js";

const context = vm.createContext({});
vm.runInContext(await readFile(new URL("../quran-data.js", import.meta.url), "utf8"), context);
const chapters = createChapters(Array.from(context.QuranData.Sura));

test("metadata contains exactly 114 chapters and 6,236 verses", () => {
  assert.equal(chapters.length, 114);
  assert.equal(chapters.reduce((total, chapter) => total + chapter.verses, 0), 6236);
  assert.equal(chapters[0].name, "Al-Faatiha");
  assert.equal(chapters[113].verses, 6);
});

test("verse metadata follows page, ruku, manzil, hizb, juz, and sajda boundaries", () => {
  const data = context.QuranData;
  assert.deepEqual(getVerseMetadata({ chapter: 1, verse: 1 }, data), {
    page: 1, ruku: 1, manzil: 1, hizb: 1, juz: 1, sajda: false,
  });
  const pageStart = getVerseMetadata({ chapter: 2, verse: 1 }, data);
  assert.equal(pageStart.page, 2);
  assert.equal(pageStart.ruku, 2);
  assert.equal(pageStart.hizb, 1);
  assert.equal(pageStart.juz, 1);
  const juzStart = getVerseMetadata({ chapter: 2, verse: 142 }, data);
  assert.equal(juzStart.hizb, 3);
  assert.equal(juzStart.juz, 2);
  assert.equal(getVerseMetadata({ chapter: 7, verse: 206 }, data).sajda, true);
  assert.equal(getVerseMetadata({ chapter: 32, verse: 15 }, data).sajda, true);
  assert.equal(getVerseMetadata({ chapter: 32, verse: 14 }, data).sajda, false);
});

test("ruku progress fills within each ruku and resets across ruku and chapter boundaries", () => {
  const data = context.QuranData;
  for (const [chapter, verse, value, max] of [
    [1, 1, 1, 7], [1, 7, 7, 7],
    [2, 1, 1, 7], [2, 7, 7, 7], [2, 8, 1, 13],
    [2, 14, 7, 13], [2, 20, 13, 13], [2, 21, 1, 9],
    [2, 284, 1, 3], [2, 286, 3, 3], [3, 1, 1, 9],
    [73, 20, 1, 1], [114, 1, 1, 6], [114, 6, 6, 6],
  ]) {
    assert.deepEqual(getRukuProgress({ chapter, verse }, data, chapters), { value, max }, `${chapter}:${verse}`);
  }
  assert.throws(() => getRukuProgress({ chapter: 1, verse: 8 }, data, chapters), /invalid ayah/);
  assert.throws(() => getRukuProgress({ chapter: 1, verse: 1 }, { Ruku: [[]] }, chapters), /metadata is missing/);
});

test("ruku progress covers all 6,236 ayahs with the correct ruku length", () => {
  const data = context.QuranData;
  let position = { chapter: 1, verse: 1 };
  let count = 0;
  for (let ruku = 1; ruku < data.Ruku.length; ruku++) {
    const [chapter, verse] = data.Ruku[ruku];
    assert.deepEqual(position, { chapter, verse });
    const next = data.Ruku[ruku + 1];
    const lastChapter = chapters.at(-1);
    const end = next
      ? chapters[next[0] - 1].start + next[1] - 1
      : lastChapter.start + lastChapter.verses;
    const length = end - (chapters[chapter - 1].start + verse - 1);
    for (let value = 1; value <= length; value++) {
      assert.deepEqual(getRukuProgress(position, data, chapters), { value, max: length }, `${position.chapter}:${position.verse}`);
      position = adjacentPosition(position, 1, chapters);
      count++;
    }
  }
  assert.equal(count, 6236);
  assert.equal(position, null);
});

test("translation options match the supported English and Malayalam translations", async () => {
  assert.deepEqual(Object.keys(TRANSLATIONS), ["en.sahih", "ml.abdulhameed"]);
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const select = /<select id="translation">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select);
  const options = Array.from(select[1].matchAll(/<option value="([^"]+)">/g), match => match[1]);
  assert.deepEqual(options, Object.keys(TRANSLATIONS));
});

for (const [id, translation] of Object.entries(TRANSLATIONS)) {
  test(`${id}: every supplied verse maps to its chapter without modifying its text`, async () => {
    const source = await readFile(new URL(`../${translation.file}`, import.meta.url), "utf8");
    const data = parseTranslation(source, chapters);
    const originalVerses = source.split(/\r?\n/).filter(line => /^\d+\|/.test(line));
    assert.equal(data.flat().length, 6236);
    assert.deepEqual(data.flat().map(item => `${item.chapter}|${item.verse}|${item.text}`), originalVerses);
    for (const verse of data.flat()) {
      const paragraphs = splitTranslationParagraphs(verse.text, translation.language);
      assert.equal(paragraphs.join(""), verse.text, `${id} ${verse.chapter}:${verse.verse}`);
      assert.ok(paragraphs.every(paragraph => paragraph.trim().length > 0));
      if (verse.text.length < 500) assert.deepEqual(paragraphs, [verse.text]);
    }
    assert.ok(splitTranslationParagraphs(data[1][216].text, translation.language).length > 1);
    for (const chapter of chapters) {
      assert.equal(data[chapter.id - 1].length, chapter.verses);
      assert.equal(data.flat()[chapter.start].chapter, chapter.id);
    }
    assert.equal(data[113][5].verse, 6);
  });
}

test("paragraphs group complete sentences without splitting quoted passages or changing whitespace", () => {
  const quotation = 'She said, "This first sentence belongs to the quotation. This second sentence belongs here too. This last sentence closes the quotation." ';
  const sentence = "The next sentence begins another complete thought and remains unchanged. ";
  for (const quote of [quotation, quotation.replace('"', "\u201c").replace('"', "\u201d")]) {
    const text = sentence.repeat(3) + quote + "\t" + sentence.repeat(4);
    const paragraphs = splitTranslationParagraphs(text, "en");
    assert.ok(paragraphs.length > 1);
    assert.equal(paragraphs.join(""), text);
    assert.ok(paragraphs.some(paragraph => paragraph.includes(quote)));
    assert.ok(paragraphs.slice(0, -1).every(paragraph => /[.!?]["\u201d]?\s+$/.test(paragraph)));
  }
});

test("short ayahs, long single sentences, and open quotations stay intact", () => {
  for (const text of [
    "A brief sentence. Another brief sentence.",
    "a".repeat(499),
    "a".repeat(600) + ".",
    '"An open quotation. ' + "Another sentence in the quotation. ".repeat(20),
  ]) {
    assert.deepEqual(splitTranslationParagraphs(text, "en"), [text]);
  }
});

test("parser rejects truncated, duplicate, invalid, and out-of-order verses", () => {
  assert.throws(() => parseTranslation("1|1|Text", chapters), /incomplete/);
  assert.throws(() => parseTranslation("1|1|Text\n1|1|Again", chapters), /duplicate/);
  assert.throws(() => parseTranslation("115|1|Text", chapters), /out-of-order/);
  assert.throws(() => parseTranslation("1|2|Text", chapters), /out-of-order/);
  assert.throws(() => parseTranslation("not a translation", chapters), /unreadable/);
});

test("verse links validate chapter boundaries", () => {
  assert.deepEqual(parseHash("#2:286", chapters), { chapter: 2, verse: 286 });
  assert.deepEqual(parseHash("#114:6", chapters), { chapter: 114, verse: 6 });
  for (const hash of ["", "#0:1", "#115:1", "#1:8", "#2:0", "#2:287", "#1:1junk"]) {
    assert.equal(parseHash(hash, chapters), null);
  }
  assert.equal(validPosition({ chapter: 1.5, verse: 1 }, chapters), false);
});

test("focused reading selects exactly one ayah and navigates search matches", () => {
  const verses = [
    { chapter: 1, verse: 1, text: "Mercy and guidance" },
    { chapter: 1, verse: 2, text: "Praise" },
    { chapter: 1, verse: 3, text: "The Merciful" },
  ];
  assert.equal(selectAyah(verses, 2).ayah, verses[1]);
  const results = selectAyah(verses, 2, "merc");
  assert.equal(results.ayah, verses[0]);
  assert.equal(results.index, 0);
  assert.equal(results.matches.length, 2);
  const next = selectAyah(verses, 3, "MERC");
  assert.equal(next.ayah, verses[2]);
  assert.equal(next.index, 1);
  assert.equal(selectAyah(verses, 2, "1:2").ayah, verses[1]);
  assert.equal(selectAyah(verses, 1, "missing").ayah, null);
  assert.equal(selectAyah(verses, 1, "missing").matches.length, 0);
});

test("ayah navigation crosses chapter boundaries without skipping any of the 6,236 ayahs", () => {
  assert.deepEqual(adjacentPosition({ chapter: 1, verse: 7 }, 1, chapters), { chapter: 2, verse: 1 });
  assert.deepEqual(adjacentPosition({ chapter: 2, verse: 1 }, -1, chapters), { chapter: 1, verse: 7 });
  assert.equal(adjacentPosition({ chapter: 1, verse: 1 }, -1, chapters), null);
  assert.equal(adjacentPosition({ chapter: 114, verse: 6 }, 1, chapters), null);
  let position = { chapter: 1, verse: 1 };
  let count = 1;
  while (true) {
    const next = adjacentPosition(position, 1, chapters);
    if (!next) break;
    assert.deepEqual(adjacentPosition(next, -1, chapters), position);
    position = next;
    count++;
  }
  assert.equal(count, 6236);
  assert.deepEqual(position, { chapter: 114, verse: 6 });
  assert.throws(() => adjacentPosition({ chapter: 1, verse: 8 }, 1, chapters), /invalid/);
  assert.throws(() => adjacentPosition({ chapter: 1, verse: 1 }, 0, chapters), /invalid/);
});

test("bottom previous and next buttons navigate consecutively and disable at boundaries", () => {
  let state = { translation: "en.sahih", position: { chapter: 1, verse: 1 }, fontSize: 21, theme: "light" };

  // At the start of the Quran, previous button has no target (disabled)
  const prevAtStart = adjacentPosition(state.position, -1, chapters);
  assert.equal(prevAtStart, null);

  // Next button navigates to next ayah in chapter
  const nextTarget = adjacentPosition(state.position, 1, chapters);
  assert.deepEqual(nextTarget, { chapter: 1, verse: 2 });
  state = reduceReaderState(state, { type: "position/set", position: nextTarget }, chapters);
  assert.deepEqual(state.position, { chapter: 1, verse: 2 });

  // Previous button navigates back
  const prevTarget = adjacentPosition(state.position, -1, chapters);
  assert.deepEqual(prevTarget, { chapter: 1, verse: 1 });
  state = reduceReaderState(state, { type: "position/set", position: prevTarget }, chapters);
  assert.deepEqual(state.position, { chapter: 1, verse: 1 });

  // At the final ayah of the Quran (114:6), next button has no target (disabled)
  const finalPosition = { chapter: 114, verse: 6 };
  assert.equal(adjacentPosition(finalPosition, 1, chapters), null);
  assert.deepEqual(adjacentPosition(finalPosition, -1, chapters), { chapter: 114, verse: 5 });
});

test("bottom navigation handles chapter boundaries seamlessly in both directions", () => {
  // End of chapter 1 to start of chapter 2
  const endOfCh1 = { chapter: 1, verse: 7 };
  const startOfCh2 = adjacentPosition(endOfCh1, 1, chapters);
  assert.deepEqual(startOfCh2, { chapter: 2, verse: 1 });

  // Start of chapter 2 back to end of chapter 1
  const backToCh1 = adjacentPosition(startOfCh2, -1, chapters);
  assert.deepEqual(backToCh1, { chapter: 1, verse: 7 });

  // Traversing all chapter boundaries forward and backward
  for (let c = 1; c < chapters.length; c++) {
    const lastVerse = { chapter: c, verse: chapters[c - 1].verses };
    const nextChapterFirstVerse = adjacentPosition(lastVerse, 1, chapters);
    assert.deepEqual(nextChapterFirstVerse, { chapter: c + 1, verse: 1 });
    assert.deepEqual(adjacentPosition(nextChapterFirstVerse, -1, chapters), lastVerse);
  }
});

test("search navigation moves between search matches and disables at ends", () => {
  const verses = [
    { chapter: 2, verse: 1, text: "Alif, Lam, Meem." },
    { chapter: 2, verse: 2, text: "This is the Book about which there is no doubt, guidance for the conscious of Allah." },
    { chapter: 2, verse: 3, text: "Who believe in the unseen..." },
    { chapter: 2, verse: 4, text: "And who believe in what has been revealed to you..." },
    { chapter: 2, verse: 5, text: "Those are upon guidance from their Lord..." },
  ];
  // Search for "guidance" matches verses 2 and 5 (indices 0 and 1)
  const search1 = selectAyah(verses, 2, "guidance");
  assert.equal(search1.matches.length, 2);
  assert.equal(search1.index, 0);
  assert.equal(search1.ayah.verse, 2);

  // At first match, previous match is undefined (button disabled: "No more matches")
  const prevMatch = search1.matches[search1.index - 1];
  assert.equal(prevMatch, undefined);

  // Next match is verse 5
  const nextMatch = search1.matches[search1.index + 1];
  assert.deepEqual(nextMatch, verses[4]);

  // Navigating to verse 5
  const search2 = selectAyah(verses, nextMatch.verse, "guidance");
  assert.equal(search2.index, 1);
  assert.equal(search2.ayah.verse, 5);

  // At last match, next match is undefined (button disabled: "No more matches")
  assert.equal(search2.matches[search2.index + 1], undefined);
  // Previous match is verse 2
  assert.deepEqual(search2.matches[search2.index - 1], verses[1]);
});

test("touch scrolling and swipe gestures do not trigger navigation", async () => {
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const readerSource = await readFile(new URL("../reader.js", import.meta.url), "utf8");

  // Ensure no touch event listeners exist in app.js
  assert.doesNotMatch(appSource, /addEventListener\(\s*["']touch/i);
  // Ensure no pointer dragging listeners exist in app.js
  assert.doesNotMatch(appSource, /addEventListener\(\s*["']pointer/i);
  // Ensure no gesture/swipe helper or tracking state exists
  assert.doesNotMatch(appSource, /swipeDirection/);
  assert.doesNotMatch(appSource, /ayahTouch/);
  assert.doesNotMatch(readerSource, /swipeDirection/);
});

test("text selection and copying work normally without dragging or selection locks", async () => {
  const cssSource = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");

  // No user-select: none disabling selection in reader or verses
  assert.doesNotMatch(cssSource, /user-select:\s*none/i);
  // No grab/grabbing cursors on reading content or verses
  assert.doesNotMatch(cssSource, /cursor:\s*grab/i);
  assert.doesNotMatch(cssSource, /cursor:\s*grabbing/i);
  assert.doesNotMatch(appSource, /is-dragging/i);
});

test("no page-flip animation or 3D transform is applied during navigation", async () => {
  const cssSource = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");

  // No 3D rotation, page-turn, or page-preview CSS classes
  assert.doesNotMatch(cssSource, /page-turn/i);
  assert.doesNotMatch(cssSource, /page-preview/i);
  assert.doesNotMatch(cssSource, /rotateY/i);
  assert.doesNotMatch(cssSource, /perspective:/i);
  // No animation classes or turn routines in app.js
  assert.doesNotMatch(appSource, /pageTurn/i);
  assert.doesNotMatch(appSource, /page-turn/i);
  assert.doesNotMatch(appSource, /beginPageTurn/i);
  assert.doesNotMatch(appSource, /settlePageTurn/i);
});

test("chapter search supports names, punctuation, meaning, Arabic, and numbers", () => {
  assert.ok(matchesChapter(chapters[0], "al faatiha".replace(" ", "-")));
  assert.ok(matchesChapter(chapters[0], "opening"));
  assert.ok(matchesChapter(chapters[0], "الفاتحة"));
  assert.ok(matchesChapter(chapters[111], "112"));
  assert.ok(matchesChapter(chapters[5], "al anaam".replace(" ", "-")));
  assert.ok(!matchesChapter(chapters[0], "unmatched"));
});

test("saved preferences are validated, clamped, and deduplicated", () => {
  const saved = decodeState(JSON.stringify({
    translation: "missing",
    position: { chapter: 200, verse: 1 },
    fontSize: 100,
    theme: "dark",
  }), chapters);
  assert.equal(saved.translation, "en.sahih");
  assert.deepEqual(saved.position, { chapter: 1, verse: 1 });
  assert.equal(saved.fontSize, 29);
  assert.equal(saved.theme, "dark");
  assert.equal(decodeState(null, chapters).fontSize, 21);
  assert.throws(() => decodeState("{broken", chapters));
  assert.throws(() => decodeState("null", chapters));
});

test("new and removed translation preferences use Saheeh International without losing saved data", () => {
  assert.equal(decodeState(null, chapters).translation, "en.sahih");
  const saved = {
    translation: "en.itani",
    position: { chapter: 2, verse: 255 },
    fontSize: 25,
    theme: "dark",
  };
  const migrated = decodeState(JSON.stringify(saved), chapters);
  assert.deepEqual({ translation: migrated.translation, position: migrated.position, fontSize: migrated.fontSize, theme: migrated.theme }, { ...saved, translation: "en.sahih" });
  assert.equal(migrated.schemaVersion, READER_SCHEMA_VERSION);
  assert.deepEqual(migrated.readingData, createDefaultReadingData());
  for (const translation of Object.keys(TRANSLATIONS)) {
    assert.equal(decodeState(JSON.stringify({ ...saved, translation }), chapters).translation, translation);
  }
});

test("reader state changes are validated, immutable, and bounded", () => {
  const initial = decodeState(null, chapters);
  const positioned = reduceReaderState(initial, {
    type: "position/set",
    position: { chapter: 2, verse: 255 },
  }, chapters);
  assert.deepEqual(initial.position, { chapter: 1, verse: 1 });
  assert.deepEqual(positioned.position, { chapter: 2, verse: 255 });

  const translated = reduceReaderState(positioned, {
    type: "translation/set",
    translation: "ml.abdulhameed",
  }, chapters);
  assert.equal(translated.translation, "ml.abdulhameed");
  assert.equal(reduceReaderState(translated, { type: "font-size/adjust", delta: 20 }, chapters).fontSize, 29);
  assert.equal(reduceReaderState(initial, { type: "font-size/adjust", delta: -20 }, chapters).fontSize, 17);
  assert.equal(reduceReaderState(initial, { type: "theme/toggle" }, chapters).theme, "dark");
  assert.throws(() => reduceReaderState(initial, { type: "position/set", position: { chapter: 1, verse: 8 } }, chapters), /invalid ayah/);
  assert.throws(() => reduceReaderState(initial, { type: "translation/set", translation: "missing" }, chapters), /unsupported/);
  assert.throws(() => reduceReaderState(initial, { type: "font-size/adjust", delta: 1.5 }, chapters), /integer/);
  assert.throws(() => reduceReaderState(initial, { type: "unknown" }, chapters), /Unknown reader state action/);
});

test("preference storage keeps the existing key and propagates storage failures", () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const preferences = createPreferencesStore(storage, chapters);
  assert.equal(preferences.load().translation, "en.sahih");
  const saved = {
    ...decodeState(null, chapters),
    position: { chapter: 2, verse: 255 },
  };
  preferences.save(saved);
  assert.equal(values.has("quran-reader:v1"), true);
  assert.equal(PREFERENCES_KEY, "quran-reader:v1");
  assert.deepEqual(preferences.load(), saved);
  assert.throws(() => createPreferencesStore({ getItem() { throw new Error("Storage unavailable."); } }, chapters).load(), /Storage unavailable/);
});

test("translation repository caches successful loads and shares concurrent requests", async () => {
  const source = await readFile(new URL("../en.sahih.txt", import.meta.url), "utf8");
  let requests = 0;
  const repository = createTranslationRepository(async file => {
    requests++;
    assert.equal(file, "en.sahih.txt");
    await Promise.resolve();
    return { ok: true, status: 200, text: async () => source };
  });
  const [first, second] = await Promise.all([
    repository.load("en.sahih", chapters),
    repository.load("en.sahih", chapters),
  ]);
  assert.strictEqual(first, second);
  assert.strictEqual(repository.getLoaded("en.sahih"), first);
  assert.equal(requests, 1);
  assert.equal((await repository.load("en.sahih", chapters)), first);
  assert.equal(requests, 1);
  await assert.rejects(repository.load("missing", chapters), /Unknown translation/);
});

test("translation repository reports failed requests and retries them", async () => {
  const source = await readFile(new URL("../en.sahih.txt", import.meta.url), "utf8");
  let requests = 0;
  const repository = createTranslationRepository(async () => {
    requests++;
    if (requests === 1) return { ok: false, status: 503 };
    return { ok: true, status: 200, text: async () => source };
  });
  await assert.rejects(repository.load("en.sahih", chapters), /503/);
  assert.equal(repository.getLoaded("en.sahih"), undefined);
  assert.equal((await repository.load("en.sahih", chapters)).flat().length, 6236);
  assert.equal(requests, 2);
});

test("static server serves local assets and rejects unlisted paths and methods", async t => {
  const server = createReaderServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/", "/app.js", "/reader.js", "/reader-state.js", "/reading-data.js", "/preferences-store.js", "/translation-repository.js", "/styles.css", "/quran-data.js", "/ar.uthmani.txt", "/service-worker.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/favicon.svg", ...Object.values(TRANSLATIONS).map(item => `/${item.file}`)]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/.DS_Store`)).status, 404);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  assert.equal((await fetch(`${base}/en.itani.txt`)).status, 404);
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
  const head = await fetch(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});
