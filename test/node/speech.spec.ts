import { describe, expect, it } from "vitest";
import { READER_MODEL_ID, pacedText } from "../../worker/pacing.ts";
import { TRANSLATION_PLAYBACK_RATE, translationSpeechUrl } from "../../src/lib/audio";

describe("translation reading", () => {
	it("uses Eleven v4", () => {
		expect(READER_MODEL_ID).toBe("eleven_v4");
	});

	it("lengthens the pause after each sentence and clause", () => {
		expect(pacedText("Guide us.  The Way of those; not   the astray? Yes")).toBe("Guide us... The Way of those;... not the astray?... Yes");
		expect(pacedText("Alif-Lam-Mim. [These letters are one of the miracles.]")).toBe("Alif-Lam-Mim... [These letters are one of the miracles.]");
		// An existing ellipsis is left alone.
		expect(pacedText("And then... it came.")).toBe("And then... it came.");
	});

	it("plays slower than normal and asks the Worker by ayah", () => {
		expect(TRANSLATION_PLAYBACK_RATE).toBeLessThan(1);
		expect(translationSpeechUrl({ chapter: 2, verse: 255 })).toBe("/api/speech/2/255");
	});
});
