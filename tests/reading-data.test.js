import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createChapters, parseTranslation } from "../reader.js";
import {
  createDefaultReadingData,
  findRuku,
  getDayKey,
  getResumePosition,
  getRukuIndex,
  getSectionRukus,
  getTodayStats,
  getWeeklySummary,
  normalizeReadingData,
  recordRukuCompletion,
  recordVerseVisit,
  resolveStartupPosition,
} from "../reading-data.js";

const context = vm.createContext({});
vm.runInContext(await readFile(new URL("../quran-data.js", import.meta.url), "utf8"), context);
const data = context.QuranData;
const chapters = createChapters(Array.from(data.Sura));
const rukus = getRukuIndex(data, chapters);

test("Tanzil ruku convention contains 556 valid rukus and 40 in Al-Baqarah", () => {
  const counts = Array(114).fill(0);
  for (const ruku of rukus) counts[ruku.chapter - 1]++;
  const bundledCounts = Array.from(data.Sura).slice(1, 115).map(row => row[3]);
  assert.equal(rukus.length, 556);
  assert.equal(counts.reduce((total, count) => total + count, 0), 556);
  assert.deepEqual(counts, bundledCounts);
  assert.equal(counts[1], 40);
  assert.deepEqual(rukus[0].start, { chapter: 1, verse: 1 });
  assert.deepEqual(rukus.at(-1).end, { chapter: 114, verse: 6 });
});

test("all ruku starts are assigned to exactly one juz and one manzil", () => {
  for (const [type, count] of [["juz", 30], ["manzil", 7]]) {
    const assignments = [];
    for (let number = 1; number <= count; number++) {
      assignments.push(...getSectionRukus(type, number, data, chapters, rukus).map(ruku => ruku.id));
    }
    assert.equal(assignments.length, 556, type);
    assert.equal(new Set(assignments).size, 556, type);
  }
  assert.deepEqual(Array.from(data.Juz).slice(1, 31).map(([chapter, verse]) => [chapter, verse]), [
    [1, 1], [2, 142], [2, 253], [3, 93], [4, 24], [4, 148], [5, 82], [6, 111], [7, 88], [8, 41],
    [9, 93], [11, 6], [12, 53], [15, 1], [17, 1], [18, 75], [21, 1], [23, 1], [25, 21], [27, 56],
    [29, 46], [33, 31], [36, 28], [39, 32], [41, 47], [46, 1], [51, 31], [58, 1], [67, 1], [78, 1],
  ]);
  assert.deepEqual(Array.from(data.Manzil).slice(1, 8).map(([chapter, verse]) => [chapter, verse]), [[1, 1], [5, 1], [10, 1], [17, 1], [26, 1], [37, 1], [50, 1]]);
});

test("day boundary follows local time and a light day lowers only that day’s target", () => {
  const justBeforeBoundary = new Date(2026, 10, 10, 3, 59);
  const justAfterBoundary = new Date(2026, 10, 10, 4, 1);
  assert.equal(getDayKey(justBeforeBoundary, 4), "2026-11-09");
  assert.equal(getDayKey(justAfterBoundary, 4), "2026-11-10");

  let reading = createDefaultReadingData();
  reading = { ...reading, settings: { ...reading.settings, dailyTarget: 3, dayModes: { "2026-11-10": "light" } } };
  const rukus = getRukuIndex(data, chapters);
  reading = recordRukuCompletion(reading, rukus[0], "light", new Date(2026, 10, 10, 5));
  const stats = getTodayStats(reading, new Date(2026, 10, 10, 5));
  assert.deepEqual({ mode: stats.mode, target: stats.target, completed: stats.completed, reached: stats.reached }, {
    mode: "light", target: 1, completed: 1, reached: true,
  });
});

test("verse visits count unique verses and reading days while ruku sessions retain repeat totals", () => {
  let reading = createDefaultReadingData();
  const first = new Date(2026, 10, 10, 8);
  reading = recordVerseVisit(reading, { chapter: 1, verse: 1 }, "deep", first);
  reading = recordVerseVisit(reading, { chapter: 1, verse: 1 }, "deep", new Date(2026, 10, 10, 8, 1));
  reading = recordVerseVisit(reading, { chapter: 1, verse: 2 }, "deep", new Date(2026, 10, 10, 8, 2));
  assert.equal(reading.totals.verseRead, 2);
  assert.equal(reading.totals.readingDays, 1);
  assert.equal(reading.activityByDay["2026-11-10"].active, true);

  const ruku = findRuku({ chapter: 1, verse: 1 }, rukus);
  reading = recordRukuCompletion(reading, ruku, "deep", new Date(2026, 10, 10, 8, 3));
  reading = recordRukuCompletion(reading, ruku, "flow", new Date(2026, 10, 10, 9));
  assert.deepEqual(reading.completedRukuIds, [1]);
  assert.equal(reading.totals.rukuRead, 2);
  assert.equal(reading.activityByDay["2026-11-10"].rukuIds.length, 1);
  assert.equal(reading.activityByDay["2026-11-10"].rukuCompletions, 2);
  assert.equal(reading.totals.readingDays, 1);
  assert.equal(getTodayStats(reading, first).completed, 1);
});

test("weekly summary counts reading days and current and previous week totals", () => {
  let reading = createDefaultReadingData();
  const rukus = getRukuIndex(data, chapters);
  reading = recordRukuCompletion(reading, rukus[0], "deep", new Date(2026, 10, 10, 8));
  reading = recordRukuCompletion(reading, rukus[1], "deep", new Date(2026, 10, 10, 9));
  const summary = getWeeklySummary(reading, new Date(2026, 10, 10, 12));
  assert.equal(summary.thisWeekRukus, 2);
  assert.equal(summary.readDays, 1);
  assert.equal(summary.previousWeekRukus, 0);
});

test("reading data migration keeps valid saved fields and drops invalid records", () => {
  const migrated = normalizeReadingData({
    version: 1,
    completedRukuIds: [1, 1, 999],
    bookmarks: [{ id: "a", chapter: 1, verse: 99 }],
    notes: [{ id: "b", rukuId: 1, text: "Reflection", createdAt: 1 }],
    settings: { dailyTarget: 50, dayBoundaryHour: 22, anchors: [{ id: "fajr", name: "After Fajr", time: "05:10" }] },
  }, chapters);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.completedRukuIds, [1]);
  assert.deepEqual(migrated.bookmarks, []);
  assert.equal(migrated.notes[0].text, "Reflection");
  assert.equal(migrated.settings.dailyTarget, 10);
  assert.equal(migrated.settings.dayBoundaryHour, 22);
  assert.equal(migrated.settings.anchors[0].name, "After Fajr");
  assert.equal(migrated.settings.resumeAtNextUnread, true);
});

test("version 2 activity migrates without dropping overall verse progress", () => {
  const migrated = normalizeReadingData({
    version: 2,
    verseReadKeys: ["1:1", "1:2"],
    activityByDay: {
      "2026-11-10": {
        active: true,
        verseKeys: ["1:1", "1:2"],
        rukuIds: [1],
        rukuCompletions: 1,
        modeCounts: { deep: 1 },
        sessionStarts: [Date.now()],
      },
    },
  }, chapters);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.verseReadKeys, ["1:1", "1:2"]);
  assert.equal(migrated.activityByDay["2026-11-10"].rukuCompletions, 1);
  assert.equal(Object.hasOwn(migrated.activityByDay["2026-11-10"], "verseKeys"), false);
});

test("resume opens the next unread verse and never rewinds to an unread stop", () => {
  let reading = createDefaultReadingData();
  reading = recordVerseVisit(reading, { chapter: 1, verse: 1 }, "deep", new Date(2026, 10, 10, 8));
  reading = recordVerseVisit(reading, { chapter: 1, verse: 2 }, "deep", new Date(2026, 10, 10, 8, 1));

  assert.deepEqual(getResumePosition({ chapter: 1, verse: 2 }, reading, chapters, rukus), { chapter: 1, verse: 3 });
  assert.deepEqual(getResumePosition({ chapter: 1, verse: 1 }, reading, chapters, rukus), { chapter: 1, verse: 3 });
  assert.deepEqual(getResumePosition({ chapter: 2, verse: 1 }, reading, chapters, rukus), { chapter: 2, verse: 1 });

  const finished = recordRukuCompletion(reading, rukus[0], "deep", new Date(2026, 10, 10, 8, 2));
  assert.deepEqual(getResumePosition({ chapter: 1, verse: 7 }, finished, chapters, rukus), { chapter: 2, verse: 1 });
});

test("resume stays inside the ruku when later verses are still unread", () => {
  let reading = createDefaultReadingData();
  reading = recordVerseVisit(reading, { chapter: 2, verse: 142 }, "deep", new Date(2026, 10, 10, 8));
  const resumed = getResumePosition({ chapter: 2, verse: 142 }, reading, chapters, rukus);
  assert.deepEqual(resumed, { chapter: 2, verse: 143 });
  assert.equal(findRuku(resumed, rukus).id, findRuku({ chapter: 2, verse: 142 }, rukus).id);
});

test("startup follows an explicit link, resumes past a read verse and honours the setting", () => {
  let reading = createDefaultReadingData();
  reading = recordVerseVisit(reading, { chapter: 1, verse: 1 }, "deep", new Date(2026, 10, 10, 8));
  const saved = { chapter: 1, verse: 1 };

  const linked = resolveStartupPosition({ hashPosition: { chapter: 2, verse: 5 }, savedPosition: saved, readingData: reading, chapters, rukus });
  assert.deepEqual(linked, { position: { chapter: 2, verse: 5 }, source: "link" });

  const ownUrl = resolveStartupPosition({ hashPosition: saved, savedPosition: saved, readingData: reading, chapters, rukus });
  assert.deepEqual(ownUrl, { position: { chapter: 1, verse: 2 }, source: "resume" });

  const unread = resolveStartupPosition({ hashPosition: { chapter: 1, verse: 9 }, savedPosition: { chapter: 1, verse: 9 }, readingData: reading, chapters, rukus });
  assert.deepEqual(unread, { position: { chapter: 1, verse: 9 }, source: "saved" });

  const optedOut = resolveStartupPosition({
    hashPosition: saved,
    savedPosition: saved,
    readingData: { ...reading, settings: { ...reading.settings, resumeAtNextUnread: false } },
    chapters,
    rukus,
  });
  assert.deepEqual(optedOut, { position: saved, source: "saved" });
});

test("bundled Tanzil Uthmani Arabic text parses as 6,236 unchanged verse rows", async () => {
  const source = await readFile(new URL("../ar.uthmani.txt", import.meta.url), "utf8");
  const parsed = parseTranslation(source, chapters);
  assert.equal(parsed.flat().length, 6236);
  assert.match(parsed[1][0].text, /^بِسْمِ/);
  assert.match(source, /Tanzil Quran Text \(Uthmani, Version 1\.1\)/);
  assert.match(source, /CHANGING IT IS NOT ALLOWED/);
});
