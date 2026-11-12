import { describe, expect, it } from "vitest";
import {
	SPEECH_SAMPLE_RATE,
	createWordGrouper,
	decodeAudio,
	pairWords,
	readReading,
	wordAt,
} from "../../public/speech.js";

/** The elements a reading is paired with, standing in for the words on the page. */
function elements(...texts: string[]) {
	return texts.map(text => ({ textContent: text }));
}

describe("collecting the words of a reading", () => {
	it("joins the characters of a word and times it as a whole", () => {
		const grouper = createWordGrouper();
		grouper.add("In the", [0, 0.1, 0.2, 0.3], [0.1, 0.2, 0.3, 0.4]);
		expect(grouper.words()).toEqual([
			{ text: "In", start: 0, end: 0.2 },
			{ text: "the", start: 0.3, end: 0.4 },
		]);
	});

	it("keeps a word open when it is split across two pieces of audio", () => {
		const grouper = createWordGrouper();
		grouper.add("the n", [0, 0.1, 0.2, 0.3, 0.4], [0.1, 0.2, 0.3, 0.4, 0.5]);
		grouper.add("ame", [0.5, 0.6, 0.7], [0.6, 0.7, 0.8]);
		expect(grouper.words()).toEqual([
			{ text: "the", start: 0, end: 0.3 },
			{ text: "name", start: 0.4, end: 0.8 },
		]);
	});

	it("reads the words that are spoken at a moment", () => {
		const grouper = createWordGrouper();
		grouper.add(
			"In the name",
			[0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75],
			[0.1, 0.2, 0.3, 0.35, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75, 0.9],
		);
		const words = grouper.words();
		expect(words).toEqual([
			{ text: "In", start: 0, end: 0.2 },
			{ text: "the", start: 0.3, end: 0.5 },
			{ text: "name", start: 0.6, end: 0.9 },
		]);
		expect(wordAt(words, 0)?.text).toBe("In");
		expect(wordAt(words, 0.35)?.text).toBe("the");
		expect(wordAt(words, 0.7)?.text).toBe("name");
		expect(wordAt(words, 2)).toBeNull();
	});
});

describe("pairing a reading with the page", () => {
	it("matches the words of a reading with the words on the page", () => {
		const words = [
			{ text: "In", start: 0, end: 0.2 },
			{ text: "the", start: 0.3, end: 0.4 },
		];
		const page = elements("In", "the");
		const paired = pairWords(words, page);
		expect(paired).toHaveLength(2);
		expect(paired[0].element).toBe(page[0]);
		expect(paired[0].start).toBe(0);
	});

	it("leaves the reading unhighlighted when the page does not match", () => {
		const words = [{ text: "In", start: 0, end: 0.2 }];
		expect(pairWords(words, elements("Something else"))).toEqual([]);
		expect(pairWords(words, elements("In", "the"))).toEqual([]);
	});
});

describe("reading the stream from the Worker", () => {
	it("reads the lines of JSON as they arrive", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// The second line is cut in half, to show that a piece of JSON
				// is held until the rest of it arrives.
				controller.enqueue(encoder.encode('{"audio":"AAEC","characters":"In","starts":[0],"ends":[0.1]}\n{"audio":"Aw'));
				controller.enqueue(encoder.encode('QF","characters":" ","starts":[0.1],"ends":[0.2]}\n'));
				controller.close();
			},
		});
		const chunks: unknown[] = [];
		for await (const chunk of readReading({ body } as Response)) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual([
			{ audio: "AAEC", characters: "In", starts: [0], ends: [0.1] },
			{ audio: "AwQF", characters: " ", starts: [0.1], ends: [0.2] },
		]);
	});
});

describe("decoding the audio of a reading", () => {
	it("turns 16-bit samples into the floats the browser plays", () => {
		// Two samples: the largest and the smallest a 16-bit sample can hold.
		const base64 = btoa(String.fromCharCode(0xff, 0x7f, 0x00, 0x80));
		const audio = decodeAudio(base64, SPEECH_SAMPLE_RATE);
		expect(audio.samples).toHaveLength(2);
		expect(audio.samples[0]).toBeCloseTo(0.99997, 4);
		expect(audio.samples[1]).toBeCloseTo(-1, 4);
		expect(audio.duration).toBeCloseTo(2 / SPEECH_SAMPLE_RATE, 8);
	});
});
