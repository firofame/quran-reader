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

/** The Worker route that says when each word of the translation reading is spoken. */
export function translationWordsUrl(position: Position): string {
	return `${translationSpeechUrl(position)}/words`;
}

const TRANSLATION_FAILED = "The translation could not be read aloud. Check your connection and try again.";

/**
 * Why a translation reading failed, in words for the reader. Asks the Worker
 * whether ElevenLabs has run out of credits, since the audio element cannot
 * say why a reading failed.
 */
export async function translationErrorMessage(fetchStatus: typeof fetch = fetch): Promise<string> {
	try {
		const response = await fetchStatus("/api/speech/status");
		if (!response.ok) return TRANSLATION_FAILED;
		const status = await response.json() as { configured?: boolean; outOfCredits?: boolean | null; resetsAt?: string | null };
		if (status.configured === false) return "Reading aloud is not set up on this site yet.";
		if (status.outOfCredits !== true) return TRANSLATION_FAILED;
		const reset = status.resetsAt ? new Date(status.resetsAt) : null;
		const when = reset && !Number.isNaN(reset.getTime())
			? ` It will work again after ${reset.toLocaleDateString(undefined, { day: "numeric", month: "long" })}.`
			: "";
		return `Reading aloud has used up this month’s ElevenLabs credits.${when} Ayahs already heard still play.`;
	} catch {
		return TRANSLATION_FAILED;
	}
}
