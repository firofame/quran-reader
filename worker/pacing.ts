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

/** One piece of a reading's timing, as ElevenLabs sends it with each audio chunk. */
export interface AlignmentChunk {
	chars: string[];
	char_start_times_ms: number[];
	char_durations_ms: number[];
}

/**
 * When each word is spoken, as [start, end] seconds from the start of the reading.
 *
 * Each chunk's times start again at zero, and the chunks follow on from each
 * other, so every chunk is moved along by the length of the ones before it.
 * Words are the runs of characters between spaces, which is how the reader
 * splits the ayah too: the pacing only adds dots to the end of a word.
 */
export function wordTimings(chunks: readonly AlignmentChunk[]): [number, number][] {
	const words: [number, number][] = [];
	let offset = 0;
	let inWord = false;
	for (const chunk of chunks) {
		let chunkEnd = 0;
		chunk.chars.forEach((character, index) => {
			const start = offset + (chunk.char_start_times_ms[index] ?? 0);
			const end = start + (chunk.char_durations_ms[index] ?? 0);
			chunkEnd = Math.max(chunkEnd, end - offset);
			if (/\s/.test(character)) {
				inWord = false;
				return;
			}
			if (!inWord) words.push([start, end]);
			else words[words.length - 1][1] = end;
			inWord = true;
		});
		offset += chunkEnd;
	}
	return words.map(([start, end]) => [Math.round(start) / 1000, Math.round(end) / 1000]);
}
