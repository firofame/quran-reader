import type { Chapter, Position } from "./reader";
import type { QuranMetadata } from "./quran-data";

export const READER_SCHEMA_VERSION = 11;
export const DEFAULT_RUKU_COUNT = 556;
export const DEFAULT_DAILY_TARGET = 5;
export const DAY_BOUNDARY_HOUR = 0;

export type PrayerId = "fajr" | "dhuhr" | "asr" | "maghrib" | "isha";

/** The five daily prayers, in the order they follow each other. */
export const PRAYERS: Prayer[] = [
	{ id: "fajr", name: "Fajr" },
	{ id: "dhuhr", name: "Dhuhr" },
	{ id: "asr", name: "Asr" },
	{ id: "maghrib", name: "Maghrib" },
	{ id: "isha", name: "Isha" },
];

export interface Prayer {
	id: PrayerId;
	name: string;
}

export interface PrayerTimes {
	adhan: string;
	iqama: string;
}

/** A prayer with the adhan and iqama times the reader has set for it. */
export interface ScheduledPrayer extends Prayer, PrayerTimes {}

export type PrayerMomentKind = "adhan" | "iqama";

export interface PrayerMoment extends ScheduledPrayer {
	kind: PrayerMomentKind;
	time: string;
	at: number;
}

export interface PrayerWindow extends ScheduledPrayer {
	start: number;
	end: number;
	read: boolean;
}

/** The adhan and iqama times of the prayers, until the reader sets their own. */
export const DEFAULT_PRAYER_TIMES: Record<PrayerId, PrayerTimes> = {
	fajr: { adhan: "04:58", iqama: "05:43" },
	dhuhr: { adhan: "12:11", iqama: "13:15" },
	asr: { adhan: "15:32", iqama: "17:00" },
	maghrib: { adhan: "18:03", iqama: "18:06" },
	isha: { adhan: "19:23", iqama: "20:30" },
};

/** The placeholder prayer times of the first version of the prayer list. */
const RETIRED_PRAYER_TIMES: Record<PrayerId, string> = {
	fajr: "05:00",
	dhuhr: "12:30",
	asr: "15:30",
	maghrib: "18:00",
	isha: "19:30",
};

/**
 * Sessions recorded under the retired light day, deep, and flow names still
 * count as regular reading, so saved history keeps its totals.
 */
const RETIRED_MODES = new Set(["full", "flow", "deep", "light"]);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const VERSE_KEY = /^(\d{1,3}):(\d{1,3})$/;
const TIME_KEY = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ActivityRow {
	active: boolean;
	rukuIds: number[];
	rukuCompletions: number;
	sessionStarts: number[];
	lastReadAt: number;
}

export interface ReadingSession {
	date: string;
	rukuId: number;
	completedAt: number;
}

export interface ReadingTotals {
	rukuRead: number;
	verseRead: number;
	readingDays: number;
}

export interface ReadingSettings {
	dailyTarget: number;
	prayerTimes: Record<PrayerId, PrayerTimes>;
	remindersEnabled: boolean;
	shortcutsSeen: boolean;
}

export interface ReadingData {
	version: number;
	completedRukuIds: number[];
	verseReadKeys: string[];
	totals: ReadingTotals;
	activityByDay: Record<string, ActivityRow>;
	sessions: ReadingSession[];
	settings: ReadingSettings;
}

export interface Ruku {
	id: number;
	chapter: number;
	localNumber: number;
	start: Position;
	end: Position;
	chapterMeta: Chapter;
	chapters: readonly Chapter[];
}

export function createDefaultReadingData(): ReadingData {
	return {
		version: READER_SCHEMA_VERSION,
		completedRukuIds: [],
		verseReadKeys: [],
		totals: { rukuRead: 0, verseRead: 0, readingDays: 0 },
		activityByDay: {},
		sessions: [],
		settings: {
			dailyTarget: DEFAULT_DAILY_TARGET,
			prayerTimes: createDefaultPrayerTimes(),
			remindersEnabled: false,
			shortcutsSeen: false,
		},
	};
}

function createDefaultPrayerTimes(): Record<PrayerId, PrayerTimes> {
	return Object.fromEntries(PRAYERS.map(prayer => [prayer.id, { ...DEFAULT_PRAYER_TIMES[prayer.id] }])) as Record<PrayerId, PrayerTimes>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function validDateKey(value: unknown): value is string {
	if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
	const [year, month, day] = value.split("-").map(Number);
	const date = new Date(year, month - 1, day, 12);
	return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function uniqueIntegers(values: unknown, maximum = Number.MAX_SAFE_INTEGER): number[] {
	if (!Array.isArray(values)) return [];
	return [...new Set(values.filter(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum))].sort((a, b) => a - b);
}

function validVerseKey(value: unknown, chapters: readonly Chapter[]): value is string {
	if (typeof value !== "string") return false;
	const match = VERSE_KEY.exec(value);
	if (!match) return false;
	const chapter = Number(match[1]);
	const verse = Number(match[2]);
	return Boolean(chapters[chapter - 1] && verse >= 1 && verse <= chapters[chapter - 1].verses);
}

function cleanActivity(row: unknown, rukuCount: number): ActivityRow | null {
	if (!isObject(row)) return null;
	return {
		active: Boolean(row.active),
		rukuIds: uniqueIntegers(row.rukuIds, rukuCount),
		rukuCompletions: boundedInteger(row.rukuCompletions, 0, 0, 1000000),
		sessionStarts: (Array.isArray(row.sessionStarts) ? row.sessionStarts : [])
			.filter(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0)
			.slice(-30),
		lastReadAt: typeof row.lastReadAt === "number" && Number.isSafeInteger(row.lastReadAt) && row.lastReadAt > 0 ? row.lastReadAt : 0,
	};
}

function validTime(value: unknown): value is string {
	return typeof value === "string" && TIME_KEY.test(value);
}

/**
 * Keeps the saved prayer times and falls back to the default time of every
 * prayer whose saved time is missing or not a valid time of day. Times saved
 * by the first version of the prayer list are replaced by the current
 * defaults, unless the reader had changed them.
 */
function cleanPrayerTimes(value: unknown): Record<PrayerId, PrayerTimes> {
	const times = {} as Record<PrayerId, PrayerTimes>;
	for (const prayer of PRAYERS) {
		const defaults = DEFAULT_PRAYER_TIMES[prayer.id];
		const saved = isObject(value) ? value[prayer.id] : null;
		if (isObject(saved)) {
			times[prayer.id] = {
				adhan: validTime(saved.adhan) ? saved.adhan : defaults.adhan,
				iqama: validTime(saved.iqama) ? saved.iqama : defaults.iqama,
			};
			continue;
		}
		const adhan = validTime(saved) && saved !== RETIRED_PRAYER_TIMES[prayer.id] ? saved : defaults.adhan;
		times[prayer.id] = { adhan, iqama: defaults.iqama };
	}
	return times;
}

export function normalizeReadingData(raw: unknown, chapters: readonly Chapter[], rukuCount = DEFAULT_RUKU_COUNT): ReadingData {
	const defaults = createDefaultReadingData();
	if (!isObject(raw)) return defaults;
	const settings = isObject(raw.settings) ? raw.settings : {};
	const prayerTimes = cleanPrayerTimes(settings.prayerTimes);
	const activityByDay: Record<string, ActivityRow> = {};
	if (isObject(raw.activityByDay)) {
		const days = Object.entries(raw.activityByDay).filter(([date]) => validDateKey(date)).sort(([left], [right]) => left.localeCompare(right)).slice(-400);
		for (const [date, row] of days) {
			const clean = cleanActivity(row, rukuCount);
			if (clean) activityByDay[date] = clean;
		}
	}
	const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).flatMap(session => {
		if (!isObject(session) || typeof session.rukuId !== "number" || !Number.isSafeInteger(session.rukuId) || session.rukuId < 1 || session.rukuId > rukuCount) return [];
		if (!validDateKey(session.date)) return [];
		if (typeof session.mode === "string" && !RETIRED_MODES.has(session.mode)) return [];
		return [{
			date: session.date,
			rukuId: session.rukuId,
			completedAt: typeof session.completedAt === "number" && Number.isSafeInteger(session.completedAt) ? session.completedAt : 0,
		}];
	}).slice(-5000);
	const verseReadKeys = [...new Set((Array.isArray(raw.verseReadKeys) ? raw.verseReadKeys : []).filter(key => validVerseKey(key, chapters)))];
	return {
		version: READER_SCHEMA_VERSION,
		completedRukuIds: uniqueIntegers(raw.completedRukuIds, rukuCount),
		verseReadKeys,
		totals: {
			rukuRead: boundedInteger(isObject(raw.totals) ? raw.totals.rukuRead : undefined, sessions.length, 0, 100000000),
			verseRead: boundedInteger(isObject(raw.totals) ? raw.totals.verseRead : undefined, verseReadKeys.length, 0, 100000000),
			readingDays: boundedInteger(isObject(raw.totals) ? raw.totals.readingDays : undefined, Object.values(activityByDay).filter(day => day.active).length, 0, 1000000),
		},
		activityByDay,
		sessions,
		settings: {
			dailyTarget: DEFAULT_DAILY_TARGET,
			prayerTimes,
			remindersEnabled: Boolean(settings.remindersEnabled),
			shortcutsSeen: Boolean(settings.shortcutsSeen),
		},
	};
}

/**
 * Lists the five prayers in the order they occur in the day, each with the
 * adhan and iqama times the reader has set for it.
 */
export function getPrayerSchedule(readingData: ReadingData): ScheduledPrayer[] {
	const times = readingData?.settings?.prayerTimes ?? {};
	return PRAYERS
		.map(prayer => {
			const saved = times[prayer.id] ?? {};
			return {
				...prayer,
				adhan: saved.adhan ?? DEFAULT_PRAYER_TIMES[prayer.id].adhan,
				iqama: saved.iqama ?? DEFAULT_PRAYER_TIMES[prayer.id].iqama,
			};
		})
		.sort((left, right) => left.adhan.localeCompare(right.adhan));
}

/**
 * The adhan and iqama moments of every prayer, each with the moment it next
 * passes.
 */
export function getPrayerMoments(prayers: readonly ScheduledPrayer[], date = new Date()): PrayerMoment[] {
	return prayers.flatMap(prayer => (["adhan", "iqama"] as const).map(kind => {
		const time = kind === "adhan" ? prayer.adhan : prayer.iqama;
		const [hour, minute] = time.split(":").map(Number);
		const moment = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
		if (moment.getTime() <= date.getTime()) moment.setDate(moment.getDate() + 1);
		return { ...prayer, kind, time, at: moment.getTime() };
	}));
}

/** The next adhan or iqama moment of the day. */
export function getNextPrayerMoment(prayers: readonly ScheduledPrayer[], date = new Date()): PrayerMoment | null {
	return getPrayerMoments(prayers, date).sort((left, right) => left.at - right.at)[0] ?? null;
}

export const IQAMA_REMINDER_OFFSET_MINUTES = 5;

/**
 * The reminder moments of every prayer: at the adhan, and five minutes before
 * the iqama to allow time for wudu and reaching the masjid.
 */
export function getPrayerReminderMoments(prayers: readonly ScheduledPrayer[], date = new Date(), offsetMinutes = IQAMA_REMINDER_OFFSET_MINUTES): PrayerMoment[] {
	return prayers.flatMap(prayer => (["adhan", "iqama"] as const).map(kind => {
		const time = kind === "adhan" ? prayer.adhan : prayer.iqama;
		const [hour, minute] = time.split(":").map(Number);
		const moment = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
		if (kind === "iqama") moment.setMinutes(moment.getMinutes() - offsetMinutes);
		while (moment.getTime() <= date.getTime()) moment.setDate(moment.getDate() + 1);
		return { ...prayer, kind, time, at: moment.getTime() };
	}));
}

/** The next prayer reminder moment of the day. */
export function getNextPrayerReminder(prayers: readonly ScheduledPrayer[], date = new Date(), offsetMinutes = IQAMA_REMINDER_OFFSET_MINUTES): PrayerMoment | null {
	return getPrayerReminderMoments(prayers, date, offsetMinutes).sort((left, right) => left.at - right.at)[0] ?? null;
}

/**
 * Formats a remaining duration as a countdown, such as "38:12" or "2:15:00".
 */
export function formatCountdown(milliseconds: number): string {
	const total = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function getDayKey(date = new Date()): string {
	const adjusted = new Date(date.getTime() - DAY_BOUNDARY_HOUR * 60 * 60 * 1000);
	return `${adjusted.getFullYear()}-${String(adjusted.getMonth() + 1).padStart(2, "0")}-${String(adjusted.getDate()).padStart(2, "0")}`;
}

export interface TodayStats {
	date: string;
	target: number;
	completed: number;
	bonus: number;
	reached: boolean;
}

export function getTodayStats(readingData: ReadingData, date = new Date()): TodayStats {
	const key = getDayKey(date);
	const activity = readingData.activityByDay[key];
	const target = DEFAULT_DAILY_TARGET;
	const completed = activity?.rukuIds.length ?? 0;
	return { date: key, target, completed, bonus: Math.max(0, completed - target), reached: completed >= target };
}

export function recordVerseVisit(readingData: ReadingData, position: Position, date = new Date()): ReadingData {
	const key = `${position.chapter}:${position.verse}`;
	const day = getDayKey(date);
	const wasRead = readingData.verseReadKeys.includes(key);
	const prior = readingData.activityByDay[day] ?? {
		active: false, rukuIds: [], rukuCompletions: 0,
		sessionStarts: [], lastReadAt: 0,
	};
	const sessions = prior.sessionStarts.slice();
	const lastSession = sessions.at(-1);
	if (lastSession === undefined || date.getTime() - lastSession >= 30 * 60 * 1000) sessions.push(date.getTime());
	const activityByDay = {
		...readingData.activityByDay,
		[day]: {
			...prior,
			active: true,
			sessionStarts: sessions.slice(-30),
			lastReadAt: date.getTime(),
		},
	};
	pruneActivity(activityByDay, day);
	return {
		...readingData,
		verseReadKeys: wasRead ? readingData.verseReadKeys : [...readingData.verseReadKeys, key],
		totals: {
			...readingData.totals,
			verseRead: readingData.totals.verseRead + Number(!wasRead),
			readingDays: readingData.totals.readingDays + Number(!prior.active),
		},
		activityByDay,
	};
}

/** Lists every verse covered by a ruku, as `chapter:verse` keys. */
function rukuVerseKeys(ruku: Ruku): string[] {
	const keys: string[] = [];
	for (let chapter = ruku.start.chapter; chapter <= ruku.end.chapter; chapter++) {
		const first = chapter === ruku.start.chapter ? ruku.start.verse : 1;
		const last = chapter === ruku.end.chapter ? ruku.end.verse : Number.MAX_SAFE_INTEGER;
		const max = Math.min(last, Number.MAX_SAFE_INTEGER);
		const chapterVerseCount = ruku.chapters[chapter - 1]?.verses ?? max;
		for (let verse = first; verse <= Math.min(max, chapterVerseCount); verse++) {
			keys.push(`${chapter}:${verse}`);
		}
	}
	return keys;
}

/**
 * Marks every ruku before `currentRukuId` as read.
 *
 * This is a one-time backfill for a reader who has already read further than
 * this device knows about. The days are unknown, so only the cumulative facts
 * are updated: the completed rukus, the verses read, and the lifetime totals.
 * The activity history is left untouched rather than inventing a
 * reading timeline.
 */
export function recordRukusAsRead(readingData: ReadingData, currentRukuId: number, rukus: readonly Ruku[]): ReadingData {
	const completed = new Set(readingData.completedRukuIds);
	const verseReadKeys = new Set(readingData.verseReadKeys);
	const pending = rukus.filter(ruku => ruku.id < currentRukuId && !completed.has(ruku.id));
	for (const ruku of pending) {
		completed.add(ruku.id);
		for (const key of rukuVerseKeys(ruku)) verseReadKeys.add(key);
	}
	return {
		...readingData,
		completedRukuIds: [...completed].sort((a, b) => a - b),
		verseReadKeys: [...verseReadKeys],
		totals: {
			...readingData.totals,
			rukuRead: readingData.totals.rukuRead + pending.length,
			verseRead: verseReadKeys.size,
		},
	};
}

/** Counts the rukus before the current one that are not recorded as read yet. */
export function pendingEarlierRukus(readingData: ReadingData, currentRukuId: number | null, rukus: readonly Ruku[]): number {
	if (!currentRukuId || currentRukuId <= 1) return 0;
	const completed = new Set(readingData.completedRukuIds);
	let pending = 0;
	for (const ruku of rukus) {
		if (ruku.id >= currentRukuId) break;
		if (!completed.has(ruku.id)) pending++;
	}
	return pending;
}

export function recordRukuCompletion(readingData: ReadingData, ruku: Ruku, date = new Date()): ReadingData {
	const day = getDayKey(date);
	const prior = readingData.activityByDay[day] ?? {
		active: false, rukuIds: [], rukuCompletions: 0,
		sessionStarts: [], lastReadAt: 0,
	};
	const verseReadKeys = new Set(readingData.verseReadKeys);
	for (const key of rukuVerseKeys(ruku)) {
		verseReadKeys.add(key);
	}
	const isNewDailyRuku = !prior.rukuIds.includes(ruku.id);
	const isNewDailyReadingDay = !prior.active;
	const activityByDay = {
		...readingData.activityByDay,
		[day]: {
			...prior,
			active: true,
			rukuIds: isNewDailyRuku ? [...prior.rukuIds, ruku.id] : prior.rukuIds,
			rukuCompletions: prior.rukuCompletions + 1,
			sessionStarts: prior.sessionStarts.length ? prior.sessionStarts : [date.getTime()],
			lastReadAt: date.getTime(),
		},
	};
	pruneActivity(activityByDay, day);
	const newSession: ReadingSession = { date: day, rukuId: ruku.id, completedAt: date.getTime() };
	return {
		...readingData,
		completedRukuIds: readingData.completedRukuIds.includes(ruku.id)
			? readingData.completedRukuIds
			: [...readingData.completedRukuIds, ruku.id].sort((a, b) => a - b),
		verseReadKeys: [...verseReadKeys],
		totals: {
			...readingData.totals,
			rukuRead: readingData.totals.rukuRead + 1,
			verseRead: verseReadKeys.size,
			readingDays: readingData.totals.readingDays + Number(isNewDailyReadingDay),
		},
		activityByDay,
		sessions: [...readingData.sessions, newSession].slice(-5000),
	};
}

function pruneActivity(activityByDay: Record<string, ActivityRow>, currentDay: string): void {
	const keys = Object.keys(activityByDay).sort();
	while (keys.length > 400) {
		const oldest = keys.shift();
		if (oldest !== undefined && oldest !== currentDay) delete activityByDay[oldest];
	}
}

export function getRukuIndex(data: QuranMetadata, chapters: readonly Chapter[]): Ruku[] {
	const starts = data.Ruku.slice(1).filter(([chapter, verse]) => Boolean(chapters[chapter - 1]) && verse >= 1 && verse <= chapters[chapter - 1].verses);
	const positionAt = (globalIndex: number): Position => {
		const chapter = [...chapters].reverse().find(item => item.start <= globalIndex)!;
		return { chapter: chapter.id, verse: globalIndex - chapter.start + 1 };
	};
	return starts.map(([chapter, verse], index) => {
		const next = starts[index + 1];
		const chapterMeta = chapters[chapter - 1];
		const nextGlobal = next ? chapters[next[0] - 1].start + next[1] - 1 : null;
		const lastChapter = chapters.at(-1)!;
		const finalGlobal = lastChapter.start + lastChapter.verses - 1;
		const end = positionAt((nextGlobal ?? finalGlobal + 1) - 1);
		const localNumber = starts.slice(0, index + 1).filter(start => start[0] === chapter).length;
		return {
			id: index + 1,
			chapter,
			localNumber,
			start: { chapter, verse },
			end,
			chapterMeta,
			chapters,
		};
	});
}

export function findRuku(position: Position, rukus: readonly Ruku[]): Ruku | null {
	let found: Ruku | null = null;
	for (const ruku of rukus) {
		if (ruku.start.chapter < position.chapter || (ruku.start.chapter === position.chapter && ruku.start.verse <= position.verse)) found = ruku;
		else break;
	}
	return found;
}

export function isRukuEnd(position: Position, ruku: Ruku | null): boolean {
	return Boolean(ruku && position.chapter === ruku.end.chapter && position.verse === ruku.end.verse);
}

export interface StartupPosition {
	position: Position;
	source: "link" | "saved";
}

export function resolveStartupPosition({ hashPosition, savedPosition }: { hashPosition: Position | null; savedPosition: Position }): StartupPosition {
	return hashPosition
		? { position: hashPosition, source: "link" }
		: { position: savedPosition, source: "saved" };
}
