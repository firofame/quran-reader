/**
 * Words of an ayah, for following the translation reading.
 *
 * A word is a run of characters between spaces. The Worker splits the reading
 * the same way, so word N on screen is word N in the reading's timings.
 */

/** The word each character belongs to, or -1 for spaces. */
export function wordIndexes(text: string): Int32Array {
	const indexes = new Int32Array(text.length);
	let word = -1;
	let inWord = false;
	for (let index = 0; index < text.length; index++) {
		if (/\s/.test(text[index])) {
			indexes[index] = -1;
			inWord = false;
			continue;
		}
		if (!inWord) word++;
		inWord = true;
		indexes[index] = word;
	}
	return indexes;
}

export interface WordPiece {
	text: string;
	/** The word this piece belongs to, or -1 for spaces. */
	word: number;
}

/**
 * Splits part of the ayah, which starts at `offset` in the whole ayah, into
 * words and spaces. A word cut in two by a gloss keeps one number in both parts.
 */
export function wordPieces(text: string, offset: number, indexes: Int32Array): WordPiece[] {
	const pieces: WordPiece[] = [];
	for (let index = 0; index < text.length; index++) {
		const word = indexes[offset + index] ?? -1;
		const last = pieces[pieces.length - 1];
		if (last && last.word === word) last.text += text[index];
		else pieces.push({ text: text[index], word });
	}
	return pieces;
}

/**
 * The word being spoken at `time` seconds into the reading: the last word that
 * has started, so the highlight stays put through the pauses between words.
 */
export function wordAt(words: readonly (readonly [number, number])[], time: number): number | null {
	let low = 0;
	let high = words.length - 1;
	let found = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (words[middle][0] <= time) {
			found = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return found < 0 ? null : found;
}
