/**
 * Helpers for reading a translation aloud.
 *
 * The Worker sends the reading as lines of JSON. Each line carries a piece of
 * the audio and the time of every character that piece speaks.
 */

/** The sample rate of the audio the Worker asks ElevenLabs for. */
export const SPEECH_SAMPLE_RATE = 22050;

/**
 * A word of a reading, with the time it is spoken.
 *
 * @typedef {{ text: string, start: number, end: number }} SpokenWord
 */

/**
 * Collects the characters of a reading into words with their timings.
 *
 * ElevenLabs times every character, so a word runs from the start of its
 * first character to the end of its last one. A word can be split across two
 * pieces of audio, so the grouper keeps it open until a space arrives.
 *
 * @returns {{ add: (characters: string, starts: number[], ends: number[]) => void, words: () => SpokenWord[] }}
 */
export function createWordGrouper() {
	/** @type {SpokenWord[]} */
	const words = [];
	/** @type {SpokenWord | null} */
	let open = null;

	return {
		add(characters, starts, ends) {
			for (let index = 0; index < characters.length; index += 1) {
				const character = characters[index];
				if (/\s/.test(character)) {
					open = null;
					continue;
				}
				if (!open) {
					open = { text: character, start: starts[index] ?? 0, end: ends[index] ?? 0 };
					words.push(open);
					continue;
				}
				open.text += character;
				open.end = ends[index] ?? open.end;
			}
		},
		words() {
			return words;
		},
	};
}

/** Turns base64 into the bytes it stands for. */
function base64ToBytes(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/**
 * Turns a piece of the reading into the samples the browser can play.
 *
 * ElevenLabs sends 16-bit PCM, which is played back as floats between -1
 * and 1.
 *
 * @returns {{ samples: Float32Array, sampleRate: number, duration: number }}
 */
export function decodeAudio(base64, sampleRate = SPEECH_SAMPLE_RATE) {
	const bytes = base64ToBytes(base64);
	const samples = new Float32Array(Math.floor(bytes.length / 2));
	for (let index = 0; index < samples.length; index += 1) {
		const low = bytes[index * 2];
		const high = bytes[index * 2 + 1];
		// The shift brings the sample back to the sign it was stored with.
		const sample = (high << 8 | low) << 16 >> 16;
		samples[index] = sample / 32768;
	}
	return { samples, sampleRate, duration: samples.length / sampleRate };
}

/**
 * Reads the lines of JSON that carry the reading.
 *
 * Each line is one piece of the audio, with the timing of its characters.
 */
export async function* readReading(response) {
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) yield JSON.parse(line);
			newline = buffer.indexOf("\n");
		}
	}

	const rest = buffer.trim();
	if (rest) yield JSON.parse(rest);
}

/**
 * Pairs the words of a reading with the words on the page.
 *
 * The page holds the text of the ayah in paragraphs, and the reading speaks
 * it as one passage. The two hold the same words in the same order, so they
 * are matched by position, and a mismatch leaves the reading unhighlighted.
 *
 * @param {SpokenWord[]} words
 * @param {{ textContent: string }[]} elements
 */
export function pairWords(words, elements) {
	if (words.length !== elements.length) return [];
	const paired = [];
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index];
		const element = elements[index];
		if (element.textContent !== word.text) return [];
		paired.push({ text: word.text, start: word.start, end: word.end, element });
	}
	return paired;
}

/**
 * Finds the word that is being spoken at a moment in the reading.
 *
 * The words arrive in order, so the search starts at the first word and stops
 * at the first word that has not been reached yet.
 *
 * @param {SpokenWord[]} words
 */
export function wordAt(words, position) {
	let index = 0;
	while (index < words.length && words[index].end <= position) index += 1;
	const word = words[index];
	if (!word || position < word.start) return null;
	return word;
}
