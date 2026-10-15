import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { TRANSLATIONS, createChapters, parseTranslation, parseHash, validPosition, matchesChapter, decodeState, selectAyah, adjacentPosition } from "../reader.js";
import { createReaderServer } from "../server.js";

const context = vm.createContext({});
vm.runInContext(await readFile(new URL("../quran-data.js", import.meta.url), "utf8"), context);
const chapters = createChapters(Array.from(context.QuranData.Sura));

test("metadata contains exactly 114 chapters and 6,236 verses", () => {
  assert.equal(chapters.length, 114);
  assert.equal(chapters.reduce((total, chapter) => total + chapter.verses, 0), 6236);
  assert.equal(chapters[0].name, "Al-Faatiha");
  assert.equal(chapters[113].verses, 6);
});

for (const [id, translation] of Object.entries(TRANSLATIONS)) {
  test(`${id}: every supplied verse maps to its chapter without modifying its text`, async () => {
    const source = await readFile(new URL(`../${translation.file}`, import.meta.url), "utf8");
    const data = parseTranslation(source, chapters);
    const originalVerses = source.split(/\r?\n/).filter(line => /^\d+\|/.test(line));
    assert.equal(data.flat().length, 6236);
    assert.deepEqual(data.flat().map(item => `${item.chapter}|${item.verse}|${item.text}`), originalVerses);
    for (const chapter of chapters) {
      assert.equal(data[chapter.id - 1].length, chapter.verses);
      assert.equal(data.flat()[chapter.start].chapter, chapter.id);
    }
    assert.equal(data[113][5].verse, 6);
  });
}

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
    bookmarks: [{ chapter: 1, verse: 2 }, { chapter: 1, verse: 2 }, { chapter: 1, verse: 8 }, null],
    fontSize: 100,
    theme: "dark",
  }), chapters);
  assert.equal(saved.translation, "en.itani");
  assert.deepEqual(saved.position, { chapter: 1, verse: 1 });
  assert.deepEqual(saved.bookmarks, [{ chapter: 1, verse: 2 }]);
  assert.equal(saved.fontSize, 29);
  assert.equal(saved.theme, "dark");
  assert.equal(decodeState(null, chapters).fontSize, 21);
  assert.throws(() => decodeState("{broken", chapters));
  assert.throws(() => decodeState("null", chapters));
});

test("static server serves local assets and rejects unlisted paths and methods", async t => {
  const server = createReaderServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/", "/app.js", "/reader.js", "/styles.css", "/quran-data.js", "/favicon.svg", ...Object.values(TRANSLATIONS).map(item => `/${item.file}`)]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/.DS_Store`)).status, 404);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
  const head = await fetch(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});
