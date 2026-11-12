import { DEFAULT_RUKU_COUNT, getRukuIndex } from "./reading-data";
import type { Ruku } from "./reading-data";
import { createChapters } from "./reader";
import type { Chapter } from "./reader";
import { QuranData } from "./quran-data";

export const chapters: Chapter[] = createChapters(QuranData.Sura);
export const rukus: Ruku[] = getRukuIndex(QuranData, chapters);

if (rukus.length !== DEFAULT_RUKU_COUNT) {
	console.warn(`Expected ${DEFAULT_RUKU_COUNT} Tanzil rukus; found ${rukus.length}.`);
}
