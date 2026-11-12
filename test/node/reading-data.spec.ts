import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createChapters, parseTranslation } from "../../public/reader.js";
import {
	createDefaultReadingData,
	DEFAULT_PRAYER_TIMES,
	findRuku,
	formatCountdown,
	getDayKey,
	getNextPrayerMoment,
	getNextPrayerReminder,
	getPrayerMoments,
	getPrayerReminderMoments,
	getPrayerSchedule,
	getRukuIndex,
	getTodayStats,
	IQAMA_REMINDER_OFFSET_MINUTES,
	normalizeReadingData,
	PRAYERS,
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
	it("uses local midnight and keeps the daily target fixed at five", () => {
		const justBeforeBoundary = new Date(2026, 10, 10, 23, 59);
		const justAfterBoundary = new Date(2026, 10, 11, 0, 1);
		expect(getDayKey(justBeforeBoundary)).toBe("2026-11-10");
		expect(getDayKey(justAfterBoundary)).toBe("2026-11-11");

		let reading = createDefaultReadingData();
		reading = { ...reading, settings: { ...reading.settings, dailyTarget: 3 } };
		const rukus = getRukuIndex(data, chapters);
		reading = recordRukuCompletion(reading, rukus[0], new Date(2026, 10, 10, 5));
		const stats = getTodayStats(reading, new Date(2026, 10, 10, 5));
		expect({ target: stats.target, completed: stats.completed, reached: stats.reached }).toEqual({
			target: 5,
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

	it("folds the retired light day, deep, and flow names away when migrating", () => {
		const migrated = normalizeReadingData(
			{
				version: 5,
				settings: { dailyTarget: 3, dayModes: { "2026-11-10": "light" } },
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
		expect(migrated.sessions.map(session => session.rukuId)).toEqual([1, 2, 3]);
		expect(migrated.sessions.every(session => !Object.hasOwn(session, "mode"))).toBe(true);
		expect(Object.hasOwn(migrated.activityByDay["2026-11-10"], "modeCounts")).toBe(false);
	});

	it("keeps valid saved fields and drops invalid records when migrating", () => {
		const migrated = normalizeReadingData(
			{
				version: 1,
				completedRukuIds: [1, 1, 999],
				settings: {
					dailyTarget: 50,
					dayBoundaryHour: 22,
					resumeAtNextUnread: false,
					anchors: [{ id: "fajr", name: "After Fajr", time: "05:10" }],
				},
			},
			chapters,
		);
		expect(migrated.version).toBe(READER_SCHEMA_VERSION);
		expect(migrated.completedRukuIds).toEqual([1]);
		expect(migrated.settings.dailyTarget).toBe(5);
		expect(migrated.settings.dayBoundaryHour).toBeUndefined();
		expect(migrated.settings.anchors).toBeUndefined();
		expect(migrated.settings.prayerTimes).toEqual(DEFAULT_PRAYER_TIMES);
		expect(Object.hasOwn(migrated.settings, "resumeAtNextUnread")).toBe(false);
	});

	it("lists the five daily prayers with their adhan and iqama times", () => {
		expect(PRAYERS.map(prayer => prayer.name)).toEqual(["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]);
		expect(DEFAULT_PRAYER_TIMES).toEqual({
			fajr: { adhan: "04:58", iqama: "05:43" },
			dhuhr: { adhan: "12:11", iqama: "13:15" },
			asr: { adhan: "15:32", iqama: "17:00" },
			maghrib: { adhan: "18:03", iqama: "18:06" },
			isha: { adhan: "19:23", iqama: "20:30" },
		});
	});

	it("keeps the saved adhan and iqama times", () => {
		const migrated = normalizeReadingData(
			{
				version: 11,
				settings: {
					prayerTimes: {
						fajr: { adhan: "04:45", iqama: "05:30" },
						dhuhr: { adhan: "13:05", iqama: "not-a-time" },
						asr: { adhan: "not-a-time", iqama: "17:10" },
						maghrib: { adhan: "18:20", iqama: "18:23" },
						isha: { adhan: "19:45", iqama: "20:50" },
					},
				},
			},
			chapters,
		);
		expect(migrated.settings.prayerTimes.fajr).toEqual({ adhan: "04:45", iqama: "05:30" });
		expect(migrated.settings.prayerTimes.maghrib).toEqual({ adhan: "18:20", iqama: "18:23" });
		expect(migrated.settings.prayerTimes.isha).toEqual({ adhan: "19:45", iqama: "20:50" });
		// An unusable time falls back to the default of that prayer.
		expect(migrated.settings.prayerTimes.dhuhr).toEqual({ adhan: "13:05", iqama: DEFAULT_PRAYER_TIMES.dhuhr.iqama });
		expect(migrated.settings.prayerTimes.asr).toEqual({ adhan: DEFAULT_PRAYER_TIMES.asr.adhan, iqama: "17:10" });
	});

	it("moves the prayer times of the first prayer list to the current defaults", () => {
		const untouched = normalizeReadingData(
			{ version: 10, settings: { prayerTimes: { fajr: "05:00", dhuhr: "12:30", asr: "15:30", maghrib: "18:00", isha: "19:30" } } },
			chapters,
		);
		expect(untouched.settings.prayerTimes).toEqual(DEFAULT_PRAYER_TIMES);

		const changed = normalizeReadingData(
			{ version: 10, settings: { prayerTimes: { fajr: "05:20", dhuhr: "12:30", asr: "15:30", maghrib: "18:00", isha: "19:30" } } },
			chapters,
		);
		// A time the reader had set is kept, the untouched ones follow the defaults.
		expect(changed.settings.prayerTimes.fajr.adhan).toBe("05:20");
		expect(changed.settings.prayerTimes.fajr.iqama).toBe(DEFAULT_PRAYER_TIMES.fajr.iqama);
		expect(changed.settings.prayerTimes.dhuhr).toEqual(DEFAULT_PRAYER_TIMES.dhuhr);
	});

	it("orders the prayers by their adhan times for the day", () => {
		const reading = createDefaultReadingData();
		const schedule = getPrayerSchedule(reading);
		expect(schedule.map(prayer => prayer.id)).toEqual(["fajr", "dhuhr", "asr", "maghrib", "isha"]);
		expect(schedule[0]).toEqual({ id: "fajr", name: "Fajr", adhan: "04:58", iqama: "05:43" });

		const moved = {
			...reading,
			settings: { ...reading.settings, prayerTimes: { ...reading.settings.prayerTimes, fajr: { adhan: "21:00", iqama: "21:05" } } },
		};
		expect(getPrayerSchedule(moved).map(prayer => prayer.id)).toEqual(["dhuhr", "asr", "maghrib", "isha", "fajr"]);
	});

	it("counts down to the next adhan or iqama", () => {
		const prayers = getPrayerSchedule(createDefaultReadingData());
		const beforeFajr = new Date(2026, 10, 12, 4, 0);
		const next = getNextPrayerMoment(prayers, beforeFajr);
		expect(next?.kind).toBe("adhan");
		expect(next?.name).toBe("Fajr");
		expect(new Date(next!.at).getHours()).toBe(4);
		expect(new Date(next!.at).getMinutes()).toBe(58);

		// Between the adhan and the iqama the countdown waits for the iqama.
		const between = getNextPrayerMoment(prayers, new Date(2026, 10, 12, 5, 0));
		expect(between?.kind).toBe("iqama");
		expect(between?.name).toBe("Fajr");
		expect(new Date(between!.at).getHours()).toBe(5);
		expect(new Date(between!.at).getMinutes()).toBe(43);

		// A moment that has passed waits for the next day.
		const passed = getNextPrayerMoment(prayers, new Date(2026, 10, 12, 23, 0));
		expect(passed?.kind).toBe("adhan");
		expect(new Date(passed!.at).getDate()).toBe(13);
	});

	it("lists an adhan and an iqama moment for every prayer", () => {
		const prayers = getPrayerSchedule(createDefaultReadingData());
		const moments = getPrayerMoments(prayers, new Date(2026, 10, 12, 0, 0));
		expect(moments).toHaveLength(10);
		expect(moments.filter(moment => moment.kind === "adhan")).toHaveLength(5);
		expect(moments.filter(moment => moment.kind === "iqama")).toHaveLength(5);
	});

	it("schedules prayer reminders at the adhan and 5 minutes before the iqama", () => {
		expect(IQAMA_REMINDER_OFFSET_MINUTES).toBe(5);
		const prayers = getPrayerSchedule(createDefaultReadingData());
		// Before Fajr adhan, the next reminder is at the adhan (04:58).
		const beforeFajr = new Date(2026, 10, 12, 4, 0);
		const adhanReminder = getNextPrayerReminder(prayers, beforeFajr);
		expect(adhanReminder?.kind).toBe("adhan");
		expect(adhanReminder?.name).toBe("Fajr");
		expect(new Date(adhanReminder!.at).getHours()).toBe(4);
		expect(new Date(adhanReminder!.at).getMinutes()).toBe(58);

		// Between adhan and 5 minutes before iqama (05:43 - 5 min = 05:38), reminder waits for 05:38.
		const between = getNextPrayerReminder(prayers, new Date(2026, 10, 12, 5, 0));
		expect(between?.kind).toBe("iqama");
		expect(between?.name).toBe("Fajr");
		expect(new Date(between!.at).getHours()).toBe(5);
		expect(new Date(between!.at).getMinutes()).toBe(38);

		// Once 05:38 has passed (e.g. 05:39), the next reminder moves forward (Dhuhr adhan).
		const afterIqamaReminder = getNextPrayerReminder(prayers, new Date(2026, 10, 12, 5, 39));
		expect(afterIqamaReminder?.kind).toBe("adhan");
		expect(afterIqamaReminder?.name).toBe("Dhuhr");
	});

	it("lists an adhan and an iqama reminder moment for every prayer", () => {
		const prayers = getPrayerSchedule(createDefaultReadingData());
		const moments = getPrayerReminderMoments(prayers, new Date(2026, 10, 12, 0, 0));
		expect(moments).toHaveLength(10);
		expect(moments.filter(moment => moment.kind === "adhan")).toHaveLength(5);
		expect(moments.filter(moment => moment.kind === "iqama")).toHaveLength(5);
		const fajrIqama = moments.find(m => m.id === "fajr" && m.kind === "iqama");
		expect(new Date(fajrIqama!.at).getHours()).toBe(5);
		expect(new Date(fajrIqama!.at).getMinutes()).toBe(38);
	});

	it("formats a countdown as minutes, seconds, and hours", () => {
		expect(formatCountdown(38 * 60 * 1000 + 12 * 1000)).toBe("38:12");
		expect(formatCountdown(3 * 60 * 1000 + 5 * 1000)).toBe("03:05");
		expect(formatCountdown(2 * 60 * 60 * 1000 + 15 * 60 * 1000)).toBe("2:15:00");
		expect(formatCountdown(-1000)).toBe("00:00");
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

describe("startup position", () => {
	it("restores the saved verse unless an explicit verse link is present", () => {
		const saved = { chapter: 1, verse: 1 };
		expect(resolveStartupPosition({ hashPosition: null, savedPosition: saved }))
			.toEqual({ position: saved, source: "saved" });
		expect(resolveStartupPosition({ hashPosition: { chapter: 2, verse: 5 }, savedPosition: saved }))
			.toEqual({ position: { chapter: 2, verse: 5 }, source: "link" });
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

	it("leaves day activity and sessions untouched", () => {
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
		const source = await readFile(fileURLToPath(new URL("../../public/en.hilali.txt", import.meta.url).href), "utf8");
		const parsed = parseTranslation(source, chapters);
		expect(parsed.flat().length).toBe(6236);
		expect(parsed[0][0].text).toMatch(/^In the Name of Allah/);
	});
});
