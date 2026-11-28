import { describe, expect, it } from "vitest";
import { wordAt, wordIndexes, wordPieces } from "../../src/lib/words";
import { pacedText, wordTimings } from "../../worker/pacing.ts";

describe("following the translation reading", () => {
	it("numbers the words between spaces", () => {
		expect(Array.from(wordIndexes("In  the Name"))).toEqual([0, 0, -1, -1, 1, 1, 1, -1, 2, 2, 2, 2]);
	});

	it("keeps one number for a word cut in two by a gloss", () => {
		const text = "Mim.[These letters]";
		const indexes = wordIndexes(text);
		expect(wordPieces("Mim.", 0, indexes)).toEqual([{ text: "Mim.", word: 0 }]);
		expect(wordPieces("[These letters]", 4, indexes)).toEqual([
			{ text: "[These", word: 0 },
			{ text: " ", word: -1 },
			{ text: "letters]", word: 1 },
		]);
	});

	it("finds the word being spoken and holds it through pauses", () => {
		const words: [number, number][] = [[0, 0.2], [0.3, 0.5], [0.9, 1.2]];
		expect(wordAt(words, -0.1)).toBeNull();
		expect(wordAt(words, 0.1)).toBe(0);
		expect(wordAt(words, 0.7)).toBe(1);
		expect(wordAt(words, 5)).toBe(2);
	});

	it("joins ElevenLabs alignment chunks into word times", () => {
		// The shape and timing ElevenLabs sends for "In the Name", split across chunks.
		const words = wordTimings([
			{ chars: ["I", "n", " "], char_start_times_ms: [0, 80, 120], char_durations_ms: [80, 40, 40] },
			{ chars: ["t", "h", "e", " ", "N"], char_start_times_ms: [0, 40, 53, 67, 80], char_durations_ms: [40, 13, 14, 13, 80] },
			{ chars: ["a", "m", "e"], char_start_times_ms: [0, 160, 240], char_durations_ms: [160, 80, 80] },
		]);
		expect(words).toEqual([[0, 0.12], [0.16, 0.227], [0.24, 0.64]]);
	});

	it("speaks as many words as the reader shows", () => {
		const ayah = "All the praises and thanks be to Allah, the Lord of the 'Alamin (mankind, jinns and all that exists). Guide us";
		const spoken = pacedText(ayah).split(" ").length;
		expect(spoken).toBe(Math.max(...wordIndexes(ayah)) + 1);
	});
});
