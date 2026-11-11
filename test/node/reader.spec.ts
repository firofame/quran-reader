import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
	TRANSLATIONS,
	adjacentPosition,
	createChapters,
	decodeState,
	getRukuProgress,
	getVerseMetadata,
	matchesChapter,
	parseHash,
	parseTranslation,
	selectAyah,
	splitTranslationParagraphs,
	validPosition,
} from "../../public/reader.js";
import { reduceReaderState } from "../../public/reader-state.js";
import { createPreferencesStore, PREFERENCES_KEY } from "../../public/preferences-store.js";
import { createTranslationRepository } from "../../public/translation-repository.js";
import { createDefaultReadingData, READER_SCHEMA_VERSION } from "../../public/reading-data.js";

const context: any = vm.createContext({});
vm.runInContext(await readFile(fileURLToPath(new URL("../../public/quran-data.js", import.meta.url).href), "utf8"), context);
const chapters = createChapters(Array.from(context.QuranData.Sura));

describe("chapter metadata", () => {
	it("contains exactly 114 chapters and 6,236 verses", () => {
		expect(chapters.length).toBe(114);
		expect(chapters.reduce((total, chapter) => total + chapter.verses, 0)).toBe(6236);
		expect(chapters[0].name).toBe("Al-Faatiha");
		expect(chapters[113].verses).toBe(6);
	});

	it("follows page, ruku, manzil, hizb, juz, and sajda boundaries", () => {
		const data = context.QuranData;
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
		const data = context.QuranData;
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
		expect(() => getRukuProgress({ chapter: 1, verse: 1 }, { Ruku: [[]] }, chapters)).toThrow(/metadata is missing/);
	});

	it("covers all 6,236 ayahs with the correct ruku length", () => {
		const data = context.QuranData;
		let position: any = { chapter: 1, verse: 1 };
		let count = 0;
		for (let ruku = 1; ruku < data.Ruku.length; ruku++) {
			const [chapter, verse] = data.Ruku[ruku];
			expect(position).toEqual({ chapter, verse });
			const next = data.Ruku[ruku + 1];
			const lastChapter = chapters.at(-1);
			const end = next
				? chapters[next[0] - 1].start + next[1] - 1
				: lastChapter.start + lastChapter.verses;
			const length = end - (chapters[chapter - 1].start + verse - 1);
			for (let value = 1; value <= length; value++) {
				expect(getRukuProgress(position, data, chapters), `${position.chapter}:${position.verse}`).toEqual({
					value,
					max: length,
				});
				position = adjacentPosition(position, 1, chapters);
				count++;
			}
		}
		expect(count).toBe(6236);
		expect(position).toBeNull();
	});
});

describe("translations", () => {
	it("ships the Saheeh International translation only", async () => {
		expect(Object.keys(TRANSLATIONS)).toEqual(["en.sahih"]);
		const html = await readFile(fileURLToPath(new URL("../../public/index.html", import.meta.url).href), "utf8");
		expect(html).not.toMatch(/id="translation"/);
		expect(html).not.toMatch(/abdulhameed/i);
	});

	for (const [id, translation] of Object.entries(TRANSLATIONS)) {
		it(`${id}: every supplied verse maps to its chapter without modifying its text`, async () => {
			const source = await readFile(fileURLToPath(new URL(`../../public/${translation.file}`, import.meta.url).href), "utf8");
			const data = parseTranslation(source, chapters);
			const originalVerses = source.split(/\r?\n/).filter(line => /^\d+\|/.test(line));
			expect(data.flat().length).toBe(6236);
			expect(data.flat().map((item: any) => `${item.chapter}|${item.verse}|${item.text}`)).toEqual(originalVerses);
			for (const verse of data.flat()) {
				const paragraphs = splitTranslationParagraphs(verse.text, translation.language);
				expect(paragraphs.join(""), `${id} ${verse.chapter}:${verse.verse}`).toBe(verse.text);
				expect(paragraphs.every((paragraph: string) => paragraph.trim().length > 0)).toBe(true);
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
			expect(paragraphs.some((paragraph: string) => paragraph.includes(quote))).toBe(true);
			expect(paragraphs.slice(0, -1).every((paragraph: string) => /[.!?]["\u201d]?\s+$/.test(paragraph))).toBe(true);
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
	it("selects exactly one ayah and navigates search matches", () => {
		const verses = [
			{ chapter: 1, verse: 1, text: "Mercy and guidance" },
			{ chapter: 1, verse: 2, text: "Praise" },
			{ chapter: 1, verse: 3, text: "The Merciful" },
		];
		expect(selectAyah(verses, 2).ayah).toBe(verses[1]);
		const results = selectAyah(verses, 2, "merc");
		expect(results.ayah).toBe(verses[0]);
		expect(results.index).toBe(0);
		expect(results.matches.length).toBe(2);
		const next = selectAyah(verses, 3, "MERC");
		expect(next.ayah).toBe(verses[2]);
		expect(next.index).toBe(1);
		expect(selectAyah(verses, 2, "1:2").ayah).toBe(verses[1]);
		expect(selectAyah(verses, 1, "missing").ayah).toBeNull();
		expect(selectAyah(verses, 1, "missing").matches.length).toBe(0);
	});

	it("crosses chapter boundaries without skipping any of the 6,236 ayahs", () => {
		expect(adjacentPosition({ chapter: 1, verse: 7 }, 1, chapters)).toEqual({ chapter: 2, verse: 1 });
		expect(adjacentPosition({ chapter: 2, verse: 1 }, -1, chapters)).toEqual({ chapter: 1, verse: 7 });
		expect(adjacentPosition({ chapter: 1, verse: 1 }, -1, chapters)).toBeNull();
		expect(adjacentPosition({ chapter: 114, verse: 6 }, 1, chapters)).toBeNull();
		let position: any = { chapter: 1, verse: 1 };
		let count = 1;
		while (true) {
			const next = adjacentPosition(position, 1, chapters);
			if (!next) break;
			expect(adjacentPosition(next, -1, chapters)).toEqual(position);
			position = next;
			count++;
		}
		expect(count).toBe(6236);
		expect(position).toEqual({ chapter: 114, verse: 6 });
		expect(() => adjacentPosition({ chapter: 1, verse: 8 }, 1, chapters)).toThrow(/invalid/);
		expect(() => adjacentPosition({ chapter: 1, verse: 1 }, 0, chapters)).toThrow(/invalid/);
	});

	it("moves the bottom previous and next buttons consecutively and disables them at the boundaries", () => {
		let state = { translation: "en.sahih", position: { chapter: 1, verse: 1 }, fontSize: 21, theme: "light" };

		// At the start of the Quran, previous button has no target (disabled)
		const prevAtStart = adjacentPosition(state.position, -1, chapters);
		expect(prevAtStart).toBeNull();

		// Next button navigates to next ayah in chapter
		const nextTarget = adjacentPosition(state.position, 1, chapters);
		expect(nextTarget).toEqual({ chapter: 1, verse: 2 });
		state = reduceReaderState(state, { type: "position/set", position: nextTarget }, chapters);
		expect(state.position).toEqual({ chapter: 1, verse: 2 });

		// Previous button navigates back
		const prevTarget = adjacentPosition(state.position, -1, chapters);
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
		const startOfCh2 = adjacentPosition(endOfCh1, 1, chapters);
		expect(startOfCh2).toEqual({ chapter: 2, verse: 1 });

		// Start of chapter 2 back to end of chapter 1
		const backToCh1 = adjacentPosition(startOfCh2, -1, chapters);
		expect(backToCh1).toEqual({ chapter: 1, verse: 7 });

		// Traversing all chapter boundaries forward and backward
		for (let c = 1; c < chapters.length; c++) {
			const lastVerse = { chapter: c, verse: chapters[c - 1].verses };
			const nextChapterFirstVerse = adjacentPosition(lastVerse, 1, chapters);
			expect(nextChapterFirstVerse).toEqual({ chapter: c + 1, verse: 1 });
			expect(adjacentPosition(nextChapterFirstVerse, -1, chapters)).toEqual(lastVerse);
		}
	});

	it("moves between search matches and disables at the ends", () => {
		const verses = [
			{ chapter: 2, verse: 1, text: "Alif, Lam, Meem." },
			{ chapter: 2, verse: 2, text: "This is the Book about which there is no doubt, guidance for the conscious of Allah." },
			{ chapter: 2, verse: 3, text: "Who believe in the unseen..." },
			{ chapter: 2, verse: 4, text: "And who believe in what has been revealed to you..." },
			{ chapter: 2, verse: 5, text: "Those are upon guidance from their Lord..." },
		];
		// Search for "guidance" matches verses 2 and 5 (indices 0 and 1)
		const search1 = selectAyah(verses, 2, "guidance");
		expect(search1.matches.length).toBe(2);
		expect(search1.index).toBe(0);
		expect(search1.ayah.verse).toBe(2);

		// At first match, previous match is undefined (button disabled: "No more matches")
		const prevMatch = search1.matches[search1.index - 1];
		expect(prevMatch).toBeUndefined();

		// Next match is verse 5
		const nextMatch = search1.matches[search1.index + 1];
		expect(nextMatch).toEqual(verses[4]);

		// Navigating to verse 5
		const search2 = selectAyah(verses, nextMatch.verse, "guidance");
		expect(search2.index).toBe(1);
		expect(search2.ayah.verse).toBe(5);

		// At last match, next match is undefined (button disabled: "No more matches")
		expect(search2.matches[search2.index + 1]).toBeUndefined();
		// Previous match is verse 2
		expect(search2.matches[search2.index - 1]).toEqual(verses[1]);
	});
});

describe("reading comfort", () => {
	it("does not trigger navigation on touch scrolling or swipe gestures", async () => {
		const appSource = await readFile(fileURLToPath(new URL("../../public/app.js", import.meta.url).href), "utf8");
		const readerSource = await readFile(fileURLToPath(new URL("../../public/reader.js", import.meta.url).href), "utf8");

		// Ensure no touch event listeners exist in app.js
		expect(appSource).not.toMatch(/addEventListener\(\s*["']touch/i);
		// Ensure no pointer dragging listeners exist in app.js
		expect(appSource).not.toMatch(/addEventListener\(\s*["']pointer/i);
		// Ensure no gesture/swipe helper or tracking state exists
		expect(appSource).not.toMatch(/swipeDirection/);
		expect(appSource).not.toMatch(/ayahTouch/);
		expect(readerSource).not.toMatch(/swipeDirection/);
	});

	it("keeps text selection and copying working without dragging or selection locks", async () => {
		const cssSource = await readFile(fileURLToPath(new URL("../../public/styles.css", import.meta.url).href), "utf8");
		const appSource = await readFile(fileURLToPath(new URL("../../public/app.js", import.meta.url).href), "utf8");

		// No user-select: none disabling selection in reader or verses
		expect(cssSource).not.toMatch(/user-select:\s*none/i);
		// No grab/grabbing cursors on reading content or verses
		expect(cssSource).not.toMatch(/cursor:\s*grab/i);
		expect(cssSource).not.toMatch(/cursor:\s*grabbing/i);
		expect(appSource).not.toMatch(/is-dragging/i);
	});

	it("applies no page-flip animation or 3D transform during navigation", async () => {
		const cssSource = await readFile(fileURLToPath(new URL("../../public/styles.css", import.meta.url).href), "utf8");
		const appSource = await readFile(fileURLToPath(new URL("../../public/app.js", import.meta.url).href), "utf8");

		// No 3D rotation, page-turn, or page-preview CSS classes
		expect(cssSource).not.toMatch(/page-turn/i);
		expect(cssSource).not.toMatch(/page-preview/i);
		expect(cssSource).not.toMatch(/rotateY/i);
		expect(cssSource).not.toMatch(/perspective:/i);
		// No animation classes or turn routines in app.js
		expect(appSource).not.toMatch(/pageTurn/i);
		expect(appSource).not.toMatch(/page-turn/i);
		expect(appSource).not.toMatch(/beginPageTurn/i);
		expect(appSource).not.toMatch(/settlePageTurn/i);
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
		expect(saved.translation).toBe("en.sahih");
		expect(saved.position).toEqual({ chapter: 1, verse: 1 });
		expect(saved.fontSize).toBe(29);
		expect(saved.theme).toBe("dark");
		expect(decodeState(null, chapters).fontSize).toBe(21);
		expect(() => decodeState("{broken", chapters)).toThrow();
		expect(() => decodeState("null", chapters)).toThrow();
	});

	it("uses Saheeh International for new and removed translation preferences", () => {
		expect(decodeState(null, chapters).translation).toBe("en.sahih");
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
		}).toEqual({ ...saved, translation: "en.sahih" });
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
				translation: "en.sahih",
			},
			chapters,
		);
		expect(translated.translation).toBe("en.sahih");
		expect(reduceReaderState(translated, { type: "font-size/adjust", delta: 20 }, chapters).fontSize).toBe(29);
		expect(reduceReaderState(initial, { type: "font-size/adjust", delta: -20 }, chapters).fontSize).toBe(17);
		expect(reduceReaderState(initial, { type: "theme/toggle" }, chapters).theme).toBe("dark");
		expect(() => reduceReaderState(initial, { type: "position/set", position: { chapter: 1, verse: 8 } }, chapters)).toThrow(
			/invalid ayah/,
		);
		expect(() => reduceReaderState(initial, { type: "translation/set", translation: "missing" }, chapters)).toThrow(
			/unsupported/,
		);
		expect(() => reduceReaderState(initial, { type: "font-size/adjust", delta: 1.5 }, chapters)).toThrow(/integer/);
		expect(() => reduceReaderState(initial, { type: "unknown" }, chapters)).toThrow(/Unknown reader state action/);
	});
});

describe("preferences storage", () => {
	it("keeps the existing key and propagates storage failures", () => {
		const values = new Map();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		};
		const preferences = createPreferencesStore(storage, chapters);
		expect(preferences.load().translation).toBe("en.sahih");
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
				},
				chapters,
			).load(),
		).toThrow(/Storage unavailable/);
	});
});

describe("translation repository", () => {
	it("caches successful loads and shares concurrent requests", async () => {
		const source = await readFile(fileURLToPath(new URL("../../public/en.sahih.txt", import.meta.url).href), "utf8");
		let requests = 0;
		const repository = createTranslationRepository((async (file: string) => {
			requests++;
			expect(file).toBe("en.sahih.txt");
			await Promise.resolve();
			return { ok: true, status: 200, text: async () => source };
		}) as any);
		const [first, second] = await Promise.all([
			repository.load("en.sahih", chapters),
			repository.load("en.sahih", chapters),
		]);
		expect(first).toBe(second);
		expect(repository.getLoaded("en.sahih")).toBe(first);
		expect(requests).toBe(1);
		expect(await repository.load("en.sahih", chapters)).toBe(first);
		expect(requests).toBe(1);
		await expect(repository.load("missing", chapters)).rejects.toThrow(/Unknown translation/);
	});

	it("reports failed requests and retries them", async () => {
		const source = await readFile(fileURLToPath(new URL("../../public/en.sahih.txt", import.meta.url).href), "utf8");
		let requests = 0;
		const repository = createTranslationRepository((async () => {
			requests++;
			if (requests === 1) return { ok: false, status: 503 };
			return { ok: true, status: 200, text: async () => source };
		}) as any);
		await expect(repository.load("en.sahih", chapters)).rejects.toThrow(/503/);
		expect(repository.getLoaded("en.sahih")).toBeUndefined();
		expect((await repository.load("en.sahih", chapters)).flat().length).toBe(6236);
		expect(requests).toBe(2);
	});
});
