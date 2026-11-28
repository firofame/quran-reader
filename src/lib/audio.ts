import type { Chapter, Position } from "./reader";

/** The one-ayah recitation CDN (Al Quran Cloud, Alafasy 128 kbps). */
const RECITATION_BASE = "https://cdn.islamic.network/quran/audio/128/ar.alafasy/";

export function recitationUrl(position: Position, chapters: readonly Chapter[]): string {
	const chapter = chapters[position.chapter - 1];
	// Tanzil's chapter start is zero-based, while the audio CDN expects a
	// one-based global ayah number (for example, 2:254 is ayah 261).
	const ayahNumber = chapter.start + position.verse;
	return `${RECITATION_BASE}${ayahNumber}.mp3`;
}

/**
 * How fast the translation reading plays. Eleven v4 has no speed setting, so
 * the reading is slowed in the browser, with the pitch kept, to give each
 * phrase time to be taken in.
 */
export const TRANSLATION_PLAYBACK_RATE = 0.8;

/** The Worker route that reads an ayah's English translation aloud. */
export function translationSpeechUrl(position: Position): string {
	return `/api/speech/${position.chapter}/${position.verse}`;
}
