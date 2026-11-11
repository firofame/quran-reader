import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createChapters, parseTranslation } from "../../public/reader.js";
import {
	createDefaultReadingData,
	findRuku,
	getDayKey,
	getResumePosition,
	getRukuIndex,
	getTodayStats,
	getWeeklySummary,
	normalizeReadingData,
	READER_SCHEMA_VERSION,
	recordRukuCompletion,
	recordRukusAsRead,
	recordVerseVisit,
	resolveStartupPosition,
} from "../../public/reading-data.js";

const context: any = vm.createContext({});
vm.runInContext(await readFile(fileURLToPath(new URL("../../public/quran-data.js", import.meta.url).href), "utf8"), context);
const data = context.QuranData;
const chapters = createChapters(Array.from(data.Sura));
const rukus = getRukuIndex(data, chapters);

describe("Tanzil metadata", () => {
	it("uses the 556 ruku convention with 40 rukus in Al-Baqarah", () => {
		const counts = Array(114).fill(0);
		for (const ruku of rukus) counts[ruku.chapter - 1]++;
		const bundledCounts = Array.from(data.Sura).slice(1, 115).map((row: any) => row[3]);
		expect(rukus.length).toBe(556);
		expect(counts.reduce((total, count) => total + count, 0)).toBe(556);
		expect(counts).toEqual(bundledCounts);
		expect(counts[1]).toBe(40);
		expect(rukus[0].start).toEqual({ chapter: 1, verse: 1 });
		expect(rukus.at(-1).end).toEqual({ chapter: 114, verse: 6 });
	});

});

describe("reading history", () => {
	it("follows the day boundary in local time and uses the daily target", () => {
		const justBeforeBoundary = new Date(2026, 10, 10, 3, 59);
		const justAfterBoundary = new Date(2026, 10, 10, 4, 1);
		expect(getDayKey(justBeforeBoundary, 4)).toBe("2026-11-09");
		expect(getDayKey(justAfterBoundary, 4)).toBe("2026-11-10");

		let reading = createDefaultReadingData();
		reading = { ...reading, settings: { ...reading.settings, dailyTarget: 3 } };
		const rukus = getRukuIndex(data, chapters);
		reading = recordRukuCompletion(reading, rukus[0], new Date(2026, 10, 10, 5));
		const stats = getTodayStats(reading, new Date(2026, 10, 10, 5));
		expect({ target: stats.target, completed: stats.completed, reached: stats.reached }).toEqual({
			target: 3,
			completed: 1,
			reached: false,
		});
	});

	it("counts unique verses and reading days while ruku sessions retain repeat totals", () => {
		let reading = createDefaultReadingData();
		const first = new Date(2026, 10, 10, 8);
		reading = recordVerseVisit(reading, { chapter: 1, verse: 1 }, first);
		reading = recordVerseVisit(reading, { chapter: 1, verse: 1 }, new Date(2026, 10, 10, 8, 1));
		reading = recordVerseVisit(reading, { chapter: 1, verse: 2 }, new Date(2026, 10, 10, 8, 2));
		expect(reading.totals.verseRead).toBe(2);
		expect(reading.totals.readingDays).toBe(1);
		expect(reading.activityByDay["2026-11-10"].active).toBe(true);

		const ruku = findRuku({ chapter: 1, verse: 1 }, rukus);
		reading = recordRukuCompletion(reading, ruku, new Date(2026, 10, 10, 8, 3));
		reading = recordRukuCompletion(reading, ruku, new Date(2026, 10, 10, 9));
		expect(reading.completedRukuIds).toEqual([1]);
		expect(reading.totals.rukuRead).toBe(2);
		expect(reading.activityByDay["2026-11-10"].rukuIds.length).toBe(1);
		expect(reading.activityByDay["2026-11-10"].rukuCompletions).toBe(2);
		expect(reading.totals.readingDays).toBe(1);
		expect(getTodayStats(reading, first).completed).toBe(1);
	});

	it("counts reading days and current and previous week totals in the weekly summary", () => {
		let reading = createDefaultReadingData();
		const rukus = getRukuIndex(data, chapters);
		reading = recordRukuCompletion(reading, rukus[0], new Date(2026, 10, 10, 8));
		reading = recordRukuCompletion(reading, rukus[1], new Date(2026, 10, 10, 9));
		const summary = getWeeklySummary(reading, new Date(2026, 10, 10, 12));
		expect(summary.thisWeekRukus).toBe(2);
		expect(summary.readDays).toBe(1);
		expect(summary.previousWeekRukus).toBe(0);
	});

	it("folds the retired light day, deep, and flow names away when migrating", () => {
		const migrated = normalizeReadingData(
			{
				version: 5,
				settings: { dailyTarget: 3, dayModes: { "2026-11-10": "light" }, weeklyPlanEnabled: false },
				sessions: [
					{ date: "2026-11-10", rukuId: 1, mode: "light", completedAt: 1 },
					{ date: "2026-11-10", rukuId: 2, mode: "deep", completedAt: 2 },
					{ date: "2026-11-10", rukuId: 3, mode: "flow", completedAt: 3 },
				],
				activityByDay: {
					"2026-11-10": {
						active: true,
						rukuIds: [1, 2],
						rukuCompletions: 3,
						modeCounts: { deep: 1, light: 1, flow: 1 },
					},
				},
			},
			chapters,
		);
		expect(migrated.version).toBe(READER_SCHEMA_VERSION);
		expect(migrated.settings.dayModes).toBeUndefined();
		expect(migrated.settings.weeklyPlanEnabled).toBeUndefined();
		expect(migrated.sessions.map(session => session.rukuId)).toEqual([1, 2, 3]);
		expect(migrated.sessions.every(session => !Object.hasOwn(session, "mode"))).toBe(true);
		expect(Object.hasOwn(migrated.activityByDay["2026-11-10"], "modeCounts")).toBe(false);
	});

	it("keeps valid saved fields and drops invalid records when migrating", () => {
		const migrated = normalizeReadingData(
			{
				version: 1,
				completedRukuIds: [1, 1, 999],
				settings: { dailyTarget: 50, dayBoundaryHour: 22, anchors: [{ id: "fajr", name: "After Fajr", time: "05:10" }] },
			},
			chapters,
		);
		expect(migrated.version).toBe(READER_SCHEMA_VERSION);
		expect(migrated.completedRukuIds).toEqual([1]);
		expect(migrated.settings.dailyTarget).toBe(10);
		expect(migrated.settings.dayBoundaryHour).toBe(22);
		expect(migrated.settings.anchors[0].name).toBe("After Fajr");
		expect(migrated.settings.resumeAtNextUnread).toBe(true);
	});

	it("migrates version 2 activity without dropping overall verse progress", () => {
		const migrated = normalizeReadingData(
			{
				version: 2,
				verseReadKeys: ["1:1", "1:2"],
				activityByDay: {
					"2026-11-10": {
						active: true,
						verseKeys: ["1:1", "1:2"],
						rukuIds: [1],
						rukuCompletions: 1,
						modeCounts: { full: 1 },
						sessionStarts: [Date.now()],
					},
				},
			},
			chapters,
		);
		expect(migrated.version).toBe(READER_SCHEMA_VERSION);
		expect(migrated.verseReadKeys).toEqual(["1:1", "1:2"]);
		expect(migrated.activityByDay["2026-11-10"].rukuCompletions).toBe(1);
		expect(Object.hasOwn(migrated.activityByDay["2026-11-10"], "verseKeys")).toBe(false);
		expect(Object.hasOwn(migrated.activityByDay["2026-11-10"], "modeCounts")).toBe(false);
	});
});

describe("resume position", () => {
	it("opens the next unread verse and never rewinds to an unread stop", () => {
		let reading = createDefaultReadingData();
		reading = recordVerseVisit(reading, { chapter: 1, verse: 1 }, new Date(2026, 10, 10, 8));
		reading = recordVerseVisit(reading, { chapter: 1, verse: 2 }, new Date(2026, 10, 10, 8, 1));

		expect(getResumePosition({ chapter: 1, verse: 2 }, reading, chapters, rukus)).toEqual({ chapter: 1, verse: 3 });
		expect(getResumePosition({ chapter: 1, verse: 1 }, reading, chapters, rukus)).toEqual({ chapter: 1, verse: 3 });
		expect(getResumePosition({ chapter: 2, verse: 1 }, reading, chapters, rukus)).toEqual({ chapter: 2, verse: 1 });

		const finished = recordRukuCompletion(reading, rukus[0], new Date(2026, 10, 10, 8, 2));
		expect(getResumePosition({ chapter: 1, verse: 7 }, finished, chapters, rukus)).toEqual({ chapter: 2, verse: 1 });
	});

	it("stays inside the ruku when later verses are still unread", () => {
		let reading = createDefaultReadingData();
		reading = recordVerseVisit(reading, { chapter: 2, verse: 142 }, new Date(2026, 10, 10, 8));
		const resumed = getResumePosition({ chapter: 2, verse: 142 }, reading, chapters, rukus);
		expect(resumed).toEqual({ chapter: 2, verse: 143 });
		expect(findRuku(resumed, rukus).id).toBe(findRuku({ chapter: 2, verse: 142 }, rukus).id);
	});

	it("follows an explicit link, resumes past a read verse and honours the setting", () => {
		let reading = createDefaultReadingData();
		reading = recordVerseVisit(reading, { chapter: 1, verse: 1 }, new Date(2026, 10, 10, 8));
		const saved = { chapter: 1, verse: 1 };

		const linked = resolveStartupPosition({
			hashPosition: { chapter: 2, verse: 5 },
			savedPosition: saved,
			readingData: reading,
			chapters,
			rukus,
		});
		expect(linked).toEqual({ position: { chapter: 2, verse: 5 }, source: "link" });

		const ownUrl = resolveStartupPosition({ hashPosition: saved, savedPosition: saved, readingData: reading, chapters, rukus });
		expect(ownUrl).toEqual({ position: { chapter: 1, verse: 2 }, source: "resume" });

		const unread = resolveStartupPosition({
			hashPosition: { chapter: 1, verse: 9 },
			savedPosition: { chapter: 1, verse: 9 },
			readingData: reading,
			chapters,
			rukus,
		});
		expect(unread).toEqual({ position: { chapter: 1, verse: 9 }, source: "saved" });

		const optedOut = resolveStartupPosition({
			hashPosition: saved,
			savedPosition: saved,
			readingData: { ...reading, settings: { ...reading.settings, resumeAtNextUnread: false } },
			chapters,
			rukus,
		});
		expect(optedOut).toEqual({ position: saved, source: "saved" });
	});
});

describe("backfill", () => {
	it("marks every earlier ruku as read and catches up the totals", () => {
		const reading = createDefaultReadingData();
		const updated = recordRukusAsRead(reading, 33, rukus);

		expect(updated.completedRukuIds).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
		expect(updated.totals.rukuRead).toBe(32);
		// Rukus 1 to 32 cover Al-Fatihah and the first 242 verses of Al-Baqarah.
		expect(updated.verseReadKeys.length).toBe(249);
		expect(updated.verseReadKeys).toContain("1:1");
		expect(updated.verseReadKeys).toContain("2:242");
		// The ruku the reader is in the middle of is not completed yet.
		expect(updated.verseReadKeys).not.toContain("2:243");
	});

	it("leaves the daily and weekly history untouched", () => {
		const reading = createDefaultReadingData();
		const updated = recordRukusAsRead(reading, 33, rukus);

		expect(updated.activityByDay).toEqual({});
		expect(updated.sessions).toEqual([]);
		expect(updated.totals.readingDays).toBe(0);
	});

	it("keeps the verses that were already read and skips the current ruku", () => {
		let reading = createDefaultReadingData();
		reading = recordVerseVisit(reading, { chapter: 1, verse: 1 }, new Date(2026, 10, 10, 8));
		const updated = recordRukusAsRead(reading, 3, rukus);

		expect(updated.completedRukuIds).toEqual([1, 2]);
		expect(updated.verseReadKeys).toContain("1:1");
		expect(updated.totals.verseRead).toBe(updated.verseReadKeys.length);
	});

	it("does nothing when the earlier rukus are already recorded", () => {
		const reading = createDefaultReadingData();
		const once = recordRukusAsRead(reading, 5, rukus);
		const twice = recordRukusAsRead(once, 5, rukus);

		expect(twice.completedRukuIds).toEqual(once.completedRukuIds);
		expect(twice.totals.rukuRead).toBe(once.totals.rukuRead);
		expect(twice.verseReadKeys.length).toBe(once.verseReadKeys.length);
	});

	it("marks nothing before the first ruku", () => {
		const reading = createDefaultReadingData();
		const updated = recordRukusAsRead(reading, 1, rukus);

		expect(updated.completedRukuIds).toEqual([]);
		expect(updated.totals.rukuRead).toBe(0);
	});
});

describe("bundled English text", () => {
	it("parses as 6,236 unchanged verse rows", async () => {
		const source = await readFile(fileURLToPath(new URL("../../public/en.sahih.txt", import.meta.url).href), "utf8");
		const parsed = parseTranslation(source, chapters);
		expect(parsed.flat().length).toBe(6236);
		expect(parsed[0][0].text).toMatch(/^In the name of Allah/);
	});
});
