/** What reads the translation, and how it is paced. Kept free of Worker types so it can be tested in Node. */

/** The premade voice that reads the translation: George, a warm narrator. */
export const READER_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
/** Eleven v4 Turbo, the fast model of the v4 family. */
export const READER_MODEL_ID = "eleven_v4_turbo";
/**
 * Turns the translation into the text the voice reads.
 *
 * Eleven v4 pauses at ellipses, so every sentence and clause ends with a
 * longer pause, which gives the listener time to take each phrase in.
 */
export function pacedText(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/(?<!\.)\.\s+(?=\S)/g, "... ")
		.replace(/([;:!?])\s+(?=\S)/g, "$1... ");
}
