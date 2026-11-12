import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	TRANSLATIONS,
	adjacentPosition,
	createChapters,
	decodeState,
	findAyah,
	getRukuProgress,
	getVerseMetadata,
	matchesChapter,
	parseHash,
	parseTranslation,
	splitTranslationGlosses,
	splitTranslationParagraphs,
	validPosition,
} from "../../src/lib/reader";
import type { TranslationId } from "../../src/lib/reader";
import { reduceReaderState } from "../../src/lib/reader-state";
import type { ReaderAction } from "../../src/lib/reader";
import { createPreferencesStore, PREFERENCES_KEY } from "../../src/lib/preferences-store";
import type { PreferencesStorage } from "../../src/lib/preferences-store";
import { createTranslationRepository } from "../../src/lib/translation-repository";
import type { TranslationFetch } from "../../src/lib/translation-repository";
import { createDefaultReadingData, READER_SCHEMA_VERSION } from "../../src/lib/reading-data";
import { QuranData } from "../../src/lib/quran-data";

const chapters = createChapters(QuranData.Sura);

describe("chapter metadata", () => {
	it("contains exactly 114 chapters and 6,236 verses", () => {
		expect(chapters.length).toBe(114);
		expect(chapters.reduce((total, chapter) => total + chapter.verses, 0)).toBe(6236);
		expect(chapters[0].name).toBe("Al-Faatiha");
		expect(chapters[113].verses).toBe(6);
	});

	it("follows page, ruku, manzil, hizb, juz, and sajda boundaries", () => {
		const data = QuranData;
		expect(getVerseMetadata({ chapter: 1, verse: 1 }, data)).toEqual({
			page: 1, ruku: 1, manzil: 1, hizb: 1, juz: 1, sajda: false,
		});
		const pageStart = getVerseMetadata({ chapter: 2, verse: 1 }, data);
		expect(pageStart.page).toBe(2);
		expect(pageStart.ruku).toBe(2);
		expect(pageStart.hizb).toBe(1);
		expect(pageStart.juz).toBe(1);
		const juzStart = getVerseMetadata({ chapter: 2, verse: 142 }, data);
		expect(juzStart.hizb).toBe(3);
		expect(juzStart.juz).toBe(2);
		expect(getVerseMetadata({ chapter: 7, verse: 206 }, data).sajda).toBe(true);
		expect(getVerseMetadata({ chapter: 32, verse: 15 }, data).sajda).toBe(true);
		expect(getVerseMetadata({ chapter: 32, verse: 14 }, data).sajda).toBe(false);
	});
});

describe("ruku progress", () => {
	it("fills within each ruku and resets across ruku and chapter boundaries", () => {
		const data = QuranData;
		for (const [chapter, verse, value, max] of [
			[1, 1, 1, 7], [1, 7, 7, 7],
			[2, 1, 1, 7], [2, 7, 7, 7], [2, 8, 1, 13],
			[2, 14, 7, 13], [2, 20, 13, 13], [2, 21, 1, 9],
			[2, 284, 1, 3], [2, 286, 3, 3], [3, 1, 1, 9],
			[73, 20, 1, 1], [114, 1, 1, 6], [114, 6, 6, 6],
		]) {
			expect(getRukuProgress({ chapter, verse }, data, chapters), `${chapter}:${verse}`).toEqual({ value, max });
		}
		expect(() => getRukuProgress({ chapter: 1, verse: 8 }, data, chapters)).toThrow(/invalid ayah/);
		expect(() => getRukuProgress({ chapter: 1, verse: 1 }, { Ruku: [[]] } as unknown as typeof QuranData, chapters)).toThrow(/metadata is missing/);
	});

	it("covers all 6,236 ayahs with the correct ruku length", () => {
		const data = QuranData;
		let position = { chapter: 1, verse: 1 };
		let count = 0;
		for (let ruku = 1; ruku < data.Ruku.length; ruku++) {
			const [chapter, verse] = data.Ruku[ruku];
			expect(position).toEqual({ chapter, verse });
			const next = data.Ruku[ruku + 1];
			const lastChapter = chapters.at(-1)!;
			const end = next
				? chapters[next[0] - 1].start + next[1] - 1
				: lastChapter.start + lastChapter.verses;
			const length = end - (chapters[chapter - 1].start + verse - 1);
			for (let value = 1; value <= length; value++) {
				expect(getRukuProgress(position, data, chapters), `${position.chapter}:${position.verse}`).toEqual({
					value,
					max: length,
				});
				position = adjacentPosition(position, 1, chapters)!;
				count++;
			}
		}
		expect(count).toBe(6236);
		expect(position).toBeNull();
	});
});

describe("translations", () => {
	it("ships the Hilali & Khan translation only", () => {
		expect(Object.keys(TRANSLATIONS)).toEqual(["en.hilali"]);
	});

	for (const [id, translation] of Object.entries(TRANSLATIONS)) {
		it(`${id}: every supplied verse maps to its chapter without modifying its text`, async () => {
			const source = await readFile(fileURLToPath(new URL("../../public/en.hilali.txt", import.meta.url).href), "utf8");
			const data = parseTranslation(source, chapters);
			const originalVerses = source.split(/\r?\n/).filter(line => /^\d+\|/.test(line));
			expect(data.flat().length).toBe(6236);
			expect(data.flat().map(item => `${item.chapter}|${item.verse}|${item.text}`)).toEqual(originalVerses);
			for (const verse of data.flat()) {
				const paragraphs = splitTranslationParagraphs(verse.text, translation.language);
				expect(paragraphs.join(""), `${id} ${verse.chapter}:${verse.verse}`).toBe(verse.text);
				expect(paragraphs.every(paragraph => paragraph.trim().length > 0)).toBe(true);
				if (verse.text.length < 500) expect(paragraphs).toEqual([verse.text]);
			}
			expect(splitTranslationParagraphs(data[1][216].text, translation.language).length > 1).toBe(true);
			for (const chapter of chapters) {
				expect(data[chapter.id - 1].length).toBe(chapter.verses);
				expect(data.flat()[chapter.start].chapter).toBe(chapter.id);
			}
			expect(data[113][5].verse).toBe(6);
		});
	}

	it("groups complete sentences without splitting quoted passages or changing whitespace", () => {
		const quotation = 'She said, "This first sentence belongs to the quotation. This second sentence belongs here too. This last sentence closes the quotation." ';
		const sentence = "The next sentence begins another complete thought and remains unchanged. ";
		for (const quote of [quotation, quotation.replace('"', "\u201c").replace('"', "\u201d")]) {
			const text = sentence.repeat(3) + quote + "\t" + sentence.repeat(4);
			const paragraphs = splitTranslationParagraphs(text, "en");
			expect(paragraphs.length > 1).toBe(true);
			expect(paragraphs.join("")).toBe(text);
			expect(paragraphs.some(paragraph => paragraph.includes(quote))).toBe(true);
			expect(paragraphs.slice(0, -1).every(paragraph => /[.!?]["\u201d]?\s+$/.test(paragraph))).toBe(true);
		}
	});

	it("keeps short ayahs, long single sentences, and open quotations intact", () => {
		for (const text of [
			"A brief sentence. Another brief sentence.",
			"a".repeat(499),
			"a".repeat(600) + ".",
			'"An open quotation. ' + "Another sentence in the quotation. ".repeat(20),
		]) {
			expect(splitTranslationParagraphs(text, "en")).toEqual([text]);
		}
	});
});

describe("glosses", () => {
	it("segments every verse into glosses without altering any character", async () => {
		const source = await readFile(fileURLToPath(new URL("../../public/en.hilali.txt", import.meta.url).href), "utf8");
		const data = parseTranslation(source, chapters);
		for (const verse of data.flat()) {
			const segments = splitTranslationGlosses(verse.text);
			expect(segments.map(segment => segment.text).join(""), `en.hilali ${verse.chapter}:${verse.verse}`).toBe(verse.text);
			expect(segments.every(segment => segment.text.length > 0)).toBe(true);
		}
	});

	it("never splits a gloss across paragraph boundaries", async () => {
		const source = await readFile(fileURLToPath(new URL("../../public/en.hilali.txt", import.meta.url).href), "utf8");
		const data = parseTranslation(source, chapters);
		for (const verse of data.flat()) {
			const paragraphs = splitTranslationParagraphs(verse.text, TRANSLATIONS["en.hilali"].language);
			let verseDepth = 0;
			for (const character of verse.text) {
				if (character === "(" || character === "[") verseDepth++;
				else if ((character === ")" || character === "]") && verseDepth > 0) verseDepth--;
			}
			let depth = 0;
			for (const [index, paragraph] of paragraphs.entries()) {
				for (const character of paragraph) {
					if (character === "(" || character === "[") depth++;
					else if ((character === ")" || character === "]") && depth > 0) depth--;
				}
				expect(depth, `en.hilali ${verse.chapter}:${verse.verse} depth never goes negative`).toBeGreaterThanOrEqual(0);
				const isLastParagraph = index === paragraphs.length - 1;
				expect(depth, `en.hilali ${verse.chapter}:${verse.verse} gloss does not cross a paragraph boundary`).toBe(isLastParagraph ? verseDepth : 0);
			}
		}
	});

	it("keeps nested brackets inside a single gloss and tolerates unbalanced input", () => {
		expect(splitTranslationGlosses("Plain sentence.")).toEqual([{ text: "Plain sentence.", gloss: false }]);
		expect(splitTranslationGlosses("This is the Book (the Quran), a guidance to the Al-Muttaqun [the pious (abstaining from sin) and righteous].")).toEqual([
			{ text: "This is the Book ", gloss: false },
			{ text: "(the Quran)", gloss: true },
			{ text: ", a guidance to the Al-Muttaqun ", gloss: false },
			{ text: "[the pious (abstaining from sin) and righteous]", gloss: true },
			{ text: ".", gloss: false },
		]);
		expect(splitTranslationGlosses("adjacent (a)(b) glosses")).toEqual([
			{ text: "adjacent ", gloss: false },
			{ text: "(a)", gloss: true },
			{ text: "(b)", gloss: true },
			{ text: " glosses", gloss: false },
		]);
		expect(splitTranslationGlosses("O you who believe (in Allah's Oneness and in His Messenger (Muhammad SAW)!")).toEqual([
			{ text: "O you who believe ", gloss: false },
			{ text: "(in Allah's Oneness and in His Messenger (Muhammad SAW)!", gloss: true },
		]);
		expect(splitTranslationGlosses("unclosed (gloss is left as plain text")).toEqual([
			{ text: "unclosed ", gloss: false },
			{ text: "(gloss is left as plain text", gloss: true },
		]);
		expect(splitTranslationGlosses("a stray ) bracket")).toEqual([{ text: "a stray ) bracket", gloss: false }]);
	});
});

describe("parsing", () => {
	it("rejects truncated, duplicate, invalid, and out-of-order verses", () => {
		expect(() => parseTranslation("1|1|Text", chapters)).toThrow(/incomplete/);
		expect(() => parseTranslation("1|1|Text\n1|1|Again", chapters)).toThrow(/duplicate/);
		expect(() => parseTranslation("115|1|Text", chapters)).toThrow(/out-of-order/);
		expect(() => parseTranslation("1|2|Text", chapters)).toThrow(/out-of-order/);
		expect(() => parseTranslation("not a translation", chapters)).toThrow(/unreadable/);
	});

	it("validates chapter boundaries in verse links", () => {
		expect(parseHash("#2:286", chapters)).toEqual({ chapter: 2, verse: 286 });
		expect(parseHash("#114:6", chapters)).toEqual({ chapter: 114, verse: 6 });
		for (const hash of ["", "#0:1", "#115:1", "#1:8", "#2:0", "#2:287", "#1:1junk"]) {
			expect(parseHash(hash, chapters)).toBeNull();
		}
		expect(validPosition({ chapter: 1.5, verse: 1 }, chapters)).toBe(false);
	});
});

describe("navigation", () => {
	it("selects exactly one ayah by its verse number", () => {
		const verses = [
			{ chapter: 1, verse: 1, text: "Mercy and guidance" },
			{ chapter: 1, verse: 2, text: "Praise" },
			{ chapter: 1, verse: 3, text: "The Merciful" },
		];
		expect(findAyah(verses, 1)).toBe(verses[0]);
		expect(findAyah(verses, 2)).toBe(verses[1]);
		expect(findAyah(verses, 3)).toBe(verses[2]);
		expect(findAyah(verses, 9)).toBe(verses[0]);
		expect(findAyah([], 1)).toBeNull();
	});

	it("crosses chapter boundaries without skipping any of the 6,236 ayahs", () => {
		expect(adjacentPosition({ chapter: 1, verse: 7 }, 1, chapters)).toEqual({ chapter: 2, verse: 1 });
		expect(adjacentPosition({ chapter: 2, verse: 1 }, -1, chapters)).toEqual({ chapter: 1, verse: 7 });
		expect(adjacentPosition({ chapter: 1, verse: 1 }, -1, chapters)).toBeNull();
		expect(adjacentPosition({ chapter: 114, verse: 6 }, 1, chapters)).toBeNull();
		let position = { chapter: 1, verse: 1 };
		let count = 1;
		while (true) {
			const next = adjacentPosition(position, 1, chapters);
			if (!next) break;
			expect(adjacentPosition(next, -1, chapters)).toEqual(position);
			position = next;
			count++;
		}		expect(count).toBe(6236);
		expect(position).toEqual({ chapter: 114, verse: 6 });
		expect(() => adjacentPosition({ chapter: 1, verse: 8 }, 1, chapters)).toThrow(/invalid/);
		expect(() => adjacentPosition({ chapter: 1, verse: 1 }, 0, chapters)).toThrow(/invalid/);
	});

	it("moves the bottom previous and next buttons consecutively and disables them at the boundaries", () => {
		let state = { ...decodeState(null, chapters), position: { chapter: 1, verse: 1 } };

		// At the start of the Quran, previous button has no target (disabled)
		const prevAtStart = adjacentPosition(state.position, -1, chapters);
		expect(prevAtStart).toBeNull();

		// Next button navigates to next ayah in chapter
		const nextTarget = adjacentPosition(state.position, 1, chapters)!;
		expect(nextTarget).toEqual({ chapter: 1, verse: 2 });
		state = reduceReaderState(state, { type: "position/set", position: nextTarget }, chapters);
		expect(state.position).toEqual({ chapter: 1, verse: 2 });

		// Previous button navigates back
		const prevTarget = adjacentPosition(state.position, -1, chapters)!;
		expect(prevTarget).toEqual({ chapter: 1, verse: 1 });
		state = reduceReaderState(state, { type: "position/set", position: prevTarget }, chapters);
		expect(state.position).toEqual({ chapter: 1, verse: 1 });

		// At the final ayah of the Quran (114:6), next button has no target (disabled)
		const finalPosition = { chapter: 114, verse: 6 };
		expect(adjacentPosition(finalPosition, 1, chapters)).toBeNull();
		expect(adjacentPosition(finalPosition, -1, chapters)).toEqual({ chapter: 114, verse: 5 });
	});

	it("handles chapter boundaries seamlessly in both directions", () => {
		// End of chapter 1 to start of chapter 2
		const endOfCh1 = { chapter: 1, verse: 7 };
		const startOfCh2 = adjacentPosition(endOfCh1, 1, chapters)!;
		expect(startOfCh2).toEqual({ chapter: 2, verse: 1 });

		// Start of chapter 2 back to end of chapter 1
		const backToCh1 = adjacentPosition(startOfCh2, -1, chapters)!;
		expect(backToCh1).toEqual({ chapter: 1, verse: 7 });

		// Traversing all chapter boundaries forward and backward
		for (let c = 1; c < chapters.length; c++) {
			const lastVerse = { chapter: c, verse: chapters[c - 1].verses };
			const nextChapterFirstVerse = adjacentPosition(lastVerse, 1, chapters)!;
			expect(nextChapterFirstVerse).toEqual({ chapter: c + 1, verse: 1 });
			expect(adjacentPosition(nextChapterFirstVerse, -1, chapters)).toEqual(lastVerse);
		}
	});

	it("moves between consecutive ayahs and stops at the chapter edges", () => {
		const verses = [
			{ chapter: 2, verse: 1, text: "Alif, Lam, Meem." },
			{ chapter: 2, verse: 2, text: "This is the Book about which there is no doubt, guidance for the conscious of Allah." },
			{ chapter: 2, verse: 3, text: "Who believe in the unseen..." },
		];
		const first = findAyah(verses, 2)!;
		expect(first.verse).toBe(2);

		// The previous ayah is the one before it.
		expect(verses[verses.indexOf(first) - 1].verse).toBe(1);

		// The next ayah is the one after it.
		const next = findAyah(verses, first.verse + 1)!;
		expect(next.verse).toBe(3);

		// Past the last ayah of the chapter there is nothing left to open.
		expect(findAyah(verses, 4)!.verse).toBe(1);
	});
});

describe("chapter search", () => {
	it("supports names, punctuation, meaning, and numbers", () => {
		expect(matchesChapter(chapters[0], "al faatiha".replace(" ", "-"))).toBeTruthy();
		expect(matchesChapter(chapters[0], "opening")).toBeTruthy();
		expect(matchesChapter(chapters[0], "الفاتحة")).toBeFalsy();
		expect(matchesChapter(chapters[111], "112")).toBeTruthy();
		expect(matchesChapter(chapters[5], "al anaam".replace(" ", "-"))).toBeTruthy();
		expect(matchesChapter(chapters[0], "unmatched")).toBeFalsy();
	});
});

describe("saved state", () => {
	it("validates, clamps, and deduplicates saved preferences", () => {
		const saved = decodeState(
			JSON.stringify({
				translation: "missing",
				position: { chapter: 200, verse: 1 },
				fontSize: 100,
				theme: "dark",
			}),
			chapters,
		);
		expect(saved.translation).toBe("en.hilali");
		expect(saved.position).toEqual({ chapter: 1, verse: 1 });
		expect(saved.fontSize).toBe(29);
		expect(saved.theme).toBe("dark");
		expect(decodeState(null, chapters).fontSize).toBe(21);
		expect(() => decodeState("{broken", chapters)).toThrow();
		expect(() => decodeState("null", chapters)).toThrow();
	});

	it("uses Hilali & Khan for new and removed translation preferences", () => {
		expect(decodeState(null, chapters).translation).toBe("en.hilali");
		const saved = {
			translation: "en.itani",
			position: { chapter: 2, verse: 255 },
			fontSize: 25,
			theme: "dark",
		};
		const migrated = decodeState(JSON.stringify(saved), chapters);
		expect({
			translation: migrated.translation,
			position: migrated.position,
			fontSize: migrated.fontSize,
			theme: migrated.theme,
		}).toEqual({ ...saved, translation: "en.hilali" });
		expect(migrated.schemaVersion).toBe(READER_SCHEMA_VERSION);
		expect(migrated.readingData).toEqual(createDefaultReadingData());
		for (const translation of Object.keys(TRANSLATIONS)) {
			expect(decodeState(JSON.stringify({ ...saved, translation }), chapters).translation).toBe(translation);
		}
	});

	it("validates, keeps immutable, and bounds reader state changes", () => {
		const initial = decodeState(null, chapters);
		const positioned = reduceReaderState(
			initial,
			{
				type: "position/set",
				position: { chapter: 2, verse: 255 },
			},
			chapters,
		);
		expect(initial.position).toEqual({ chapter: 1, verse: 1 });
		expect(positioned.position).toEqual({ chapter: 2, verse: 255 });

		const translated = reduceReaderState(
			positioned,
			{
				type: "translation/set",
				translation: "en.hilali",
			},
			chapters,
		);
		expect(translated.translation).toBe("en.hilali");
		expect(reduceReaderState(translated, { type: "font-size/adjust", delta: 20 }, chapters).fontSize).toBe(29);
		expect(reduceReaderState(initial, { type: "font-size/adjust", delta: -20 }, chapters).fontSize).toBe(17);
		expect(reduceReaderState(initial, { type: "theme/toggle" }, chapters).theme).toBe("dark");
		expect(() => reduceReaderState(initial, { type: "position/set", position: { chapter: 1, verse: 8 } }, chapters)).toThrow(
			/invalid ayah/,
		);
		expect(() => reduceReaderState(initial, { type: "translation/set", translation: "missing" as TranslationId }, chapters)).toThrow(
			/unsupported/,
		);
		expect(() => reduceReaderState(initial, { type: "font-size/adjust", delta: 1.5 }, chapters)).toThrow(/integer/);
		expect(() => reduceReaderState(initial, { type: "unknown" } as unknown as ReaderAction, chapters)).toThrow(/Unknown reader state action/);
	});
});

describe("preferences storage", () => {
	it("keeps the existing key and propagates storage failures", () => {
		const values = new Map<string, string>();
		const storage: PreferencesStorage = {
			getItem: key => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
		};
		const preferences = createPreferencesStore(storage, chapters);
		expect(preferences.load().translation).toBe("en.hilali");
		const saved = {
			...decodeState(null, chapters),
			position: { chapter: 2, verse: 255 },
		};
		preferences.save(saved);
		expect(values.has("quran-reader:v1")).toBe(true);
		expect(PREFERENCES_KEY).toBe("quran-reader:v1");
		expect(preferences.load()).toEqual(saved);
		expect(() =>
			createPreferencesStore(
				{
					getItem() {
						throw new Error("Storage unavailable.");
					},
					setItem() {
						throw new Error("Storage unavailable.");
					},
				},
				chapters,
			).load(),
		).toThrow(/Storage unavailable/);
	});
});

describe("translation repository", () => {
	it("caches successful loads and shares concurrent requests", async () => {
		const source = await readFile(fileURLToPath(new URL("../../public/en.hilali.txt", import.meta.url).href), "utf8");
		let requests = 0;
		const fetchMock: TranslationFetch = async file => {
			requests++;
			expect(file).toBe("en.hilali.txt");
			await Promise.resolve();
			return new Response(source, { status: 200 });
		};
		const repository = createTranslationRepository(fetchMock);
		const [first, second] = await Promise.all([
			repository.load("en.hilali", chapters),
			repository.load("en.hilali", chapters),
		]);
		expect(first).toBe(second);
		expect(repository.getLoaded("en.hilali")).toBe(first);
		expect(requests).toBe(1);
		expect(await repository.load("en.hilali", chapters)).toBe(first);
		expect(requests).toBe(1);
		await expect(repository.load("missing", chapters)).rejects.toThrow(/Unknown translation/);
	});

	it("reports failed requests and retries them", async () => {
		const source = await readFile(fileURLToPath(new URL("../../public/en.hilali.txt", import.meta.url).href), "utf8");
		let requests = 0;
		const fetchMock: TranslationFetch = async () => {
			requests++;
			if (requests === 1) return new Response(null, { status: 503 });
			return new Response(source, { status: 200 });
		};
		const repository = createTranslationRepository(fetchMock);
		await expect(repository.load("en.hilali", chapters)).rejects.toThrow(/503/);
		expect(repository.getLoaded("en.hilali")).toBeUndefined();
		expect((await repository.load("en.hilali", chapters)).flat().length).toBe(6236);
		expect(requests).toBe(2);
	});
});
