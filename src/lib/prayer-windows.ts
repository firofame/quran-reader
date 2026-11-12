import { DAY_BOUNDARY_HOUR, getDayKey } from "./reading-data";
import type { PrayerWindow, ReadingData, ScheduledPrayer } from "./reading-data";

/**
 * Places every prayer of the current reading day on the clock, from its adhan
 * to the adhan of the next prayer, and records whether the reader read during
 * it.
 */
export function prayerWindows(prayers: readonly ScheduledPrayer[], readingData: ReadingData, date = new Date()): PrayerWindow[] {
	const boundary = DAY_BOUNDARY_HOUR;
	const today = getDayKey(date);
	const [year, month, day] = today.split("-").map(Number);
	const dayStart = new Date(year, month - 1, day, boundary).getTime();
	const dayEnd = new Date(year, month - 1, day + 1, boundary).getTime();
	const occurrence = (time: string) => {
		const [hour, minute] = time.split(":").map(Number);
		const value = new Date(year, month - 1, day, hour, minute);
		if (hour < boundary) value.setDate(value.getDate() + 1);
		return value.getTime();
	};
	const sessions = readingData.activityByDay[today]?.sessionStarts ?? [];
	return prayers.map((prayer, index) => {
		const next = prayers[(index + 1) % prayers.length];
		const start = occurrence(prayer.adhan);
		let end = occurrence(next.adhan);
		if (end <= start) end += 24 * 60 * 60 * 1000;
		return {
			...prayer,
			start,
			end: Math.min(end, dayEnd),
			read: start >= dayStart && sessions.some(timestamp => timestamp >= start && timestamp < end),
		};
	});
}
