import { normalizeReadingData, READER_SCHEMA_VERSION } from "./reading-data";
import type { ReadingData } from "./reading-data";
import type { Marker, QuranMetadata, SuraRow } from "./quran-data";

export const TRANSLATIONS = {
	"en.hilali": { name: "Hilali & Khan", language: "en-US", file: "en.hilali.txt" },
} as const;

export type TranslationId = keyof typeof TRANSLATIONS;

export interface Position {
	chapter: number;
	verse: number;
}

export interface Chapter {
	id: number;
	start: number;
	verses: number;
	name: string;
	meaning: string;
	origin: string;
}

export interface Verse {
	chapter: number;
	verse: number;
	text: string;
}

export interface VerseMetadata {
	page: number | null;
	ruku: number | null;
	manzil: number | null;
	hizb: number | null;
	juz: number | null;
	sajda: boolean;
}

export interface GlossSegment {
	text: string;
	gloss: boolean;
}

export type Theme = "light" | "dark";

export interface ReaderState {
	schemaVersion: number;
	translation: TranslationId;
	position: Position;
	fontSize: number;
	theme: Theme;
	readingData: ReadingData;
}

export type ReaderAction =
	| { type: "position/set"; position: Position }
	| { type: "translation/set"; translation: TranslationId }
	| { type: "font-size/adjust"; delta: number }
	| { type: "theme/toggle" }
	| { type: "reading-data/update"; update: (readingData: ReadingData) => ReadingData };

export function createChapters(rows: readonly SuraRow[]): Chapter[] {
	return rows.slice(1, 115).map((row, index) => ({
		id: index + 1,
		start: row[0],
		verses: row[1],
		name: row[5],
		meaning: row[6],
		origin: row[7],
	}));
}

function markerNumberAt(markers: readonly Marker[], position: Position): number | null {
	let number = null;
	for (let index = 1; index < markers.length; index++) {
		const [chapter, verse] = markers[index];
		if (chapter < position.chapter || (chapter === position.chapter && verse <= position.verse)) {
			number = index;
		}
	}
	return number;
}

export function getVerseMetadata(position: Position, data: QuranMetadata): VerseMetadata {
	const hizbQuarter = markerNumberAt(data.HizbQaurter, position);
	const sajda = data.Sajda.some(([chapter, verse]) =>
		chapter === position.chapter && verse === position.verse);
	return {
		page: markerNumberAt(data.Page, position),
		ruku: markerNumberAt(data.Ruku, position),
		manzil: markerNumberAt(data.Manzil, position),
		hizb: hizbQuarter === null ? null : Math.floor((hizbQuarter - 1) / 4) + 1,
		juz: markerNumberAt(data.Juz, position),
		sajda,
	};
}

export function getRukuProgress(position: Position, data: QuranMetadata, chapters: readonly Chapter[]): { value: number; max: number } {
	if (!validPosition(position, chapters)) {
		throw new Error("Cannot calculate ruku progress for an invalid ayah.");
	}
	const ruku = markerNumberAt(data.Ruku, position);
	if (ruku === null) throw new Error("Ruku metadata is missing for this ayah.");
	const [startChapter, startVerse] = data.Ruku[ruku];
	const start = chapters[startChapter - 1].start + startVerse - 1;
	const next = data.Ruku[ruku + 1];
	const lastChapter = chapters.at(-1)!;
	const end = next
		? chapters[next[0] - 1].start + next[1] - 1
		: lastChapter.start + lastChapter.verses;
	return {
		value: chapters[position.chapter - 1].start + position.verse - start,
		max: end - start,
	};
}

export function validPosition(position: Position | null | undefined, chapters: readonly Chapter[]): position is Position {
	if (!position || !Number.isInteger(position.chapter) || !Number.isInteger(position.verse)) return false;
	const chapter = chapters[position.chapter - 1];
	return Boolean(chapter && position.verse >= 1 && position.verse <= chapter.verses);
}

export function parseTranslation(text: string, chapters: readonly Chapter[]): Verse[][] {
	const result = chapters.map(() => [] as Verse[]);
	let count = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const match = /^(\d+)\|(\d+)\|(.+)$/.exec(line);
		if (!match) throw new Error("The translation contains an unreadable verse.");
		const chapter = Number(match[1]);
		const verse = Number(match[2]);
		if (!validPosition({ chapter, verse }, chapters) || result[chapter - 1].length !== verse - 1) {
			throw new Error("The translation contains a missing, duplicate, or out-of-order verse.");
		}
		result[chapter - 1].push({ chapter, verse, text: match[3] });
		count++;
	}
	const expected = chapters.reduce((total, chapter) => total + chapter.verses, 0);
	if (count !== expected || result.some((verses, index) => verses.length !== chapters[index].verses)) {
		throw new Error("The translation is incomplete. Please reload and try again.");
	}
	return result;
}

export function splitTranslationGlosses(text: string): GlossSegment[] {
	const segments: GlossSegment[] = [];
	let glossStart = -1;
	let plainStart = 0;
	let depth = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === "(" || character === "[") {
			if (depth === 0) {
				if (index > plainStart) segments.push({ text: text.slice(plainStart, index), gloss: false });
				glossStart = index;
			}
			depth++;
		} else if ((character === ")" || character === "]") && depth > 0) {
			depth--;
			if (depth === 0) {
				segments.push({ text: text.slice(glossStart, index + 1), gloss: true });
				plainStart = index + 1;
			}
		}
	}
	if (depth > 0) segments.push({ text: text.slice(glossStart), gloss: true });
	else if (plainStart < text.length) segments.push({ text: text.slice(plainStart), gloss: false });
	return segments;
}

export function splitTranslationParagraphs(text: string, language: string): string[] {
	if (text.length < 500) return [text];
	const paragraphs: string[] = [];
	let paragraph = "";
	let quoted = false;
	let depth = 0;
	for (const { segment } of new Intl.Segmenter(language, { granularity: "sentence" }).segment(text)) {
		if (paragraph && paragraph.length + segment.length > 300 && !quoted && depth === 0) {
			paragraphs.push(paragraph);
			paragraph = "";
		}
		paragraph += segment;
		for (const character of segment) {
			if ('"\u201c\u201d'.includes(character)) quoted = !quoted;
			if (character === "(" || character === "[") depth++;
			else if ((character === ")" || character === "]") && depth > 0) depth--;
		}
	}
	if (paragraph) paragraphs.push(paragraph);
	return paragraphs;
}

export function parseHash(hash: string, chapters: readonly Chapter[]): Position | null {
	const match = /^#(\d+):(\d+)$/.exec(hash);
	if (!match) return null;
	const position = { chapter: Number(match[1]), verse: Number(match[2]) };
	return validPosition(position, chapters) ? position : null;
}

export function normalizeSearch(text: string): string {
	return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/['’\-]/g, "");
}

export function findAyah(verses: readonly Verse[], verseNumber: number): Verse | null {
	return verses.find(verse => verse.verse === verseNumber) ?? verses[0] ?? null;
}

export function adjacentPosition(position: Position, direction: number, chapters: readonly Chapter[]): Position | null {
	if (!validPosition(position, chapters) || (direction !== -1 && direction !== 1)) {
		throw new Error("Cannot navigate from an invalid ayah or direction.");
	}
	const verse = position.verse + direction;
	if (verse >= 1 && verse <= chapters[position.chapter - 1].verses) {
		return { chapter: position.chapter, verse };
	}
	const next = chapters[position.chapter + direction - 1];
	return next ? { chapter: next.id, verse: direction === 1 ? 1 : next.verses } : null;
}

export function matchesChapter(chapter: Chapter, query: string): boolean {
	const haystack = `${chapter.id} ${chapter.name} ${chapter.meaning}`;
	return normalizeSearch(haystack).includes(normalizeSearch(query.trim()));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeState(raw: string | null, chapters: readonly Chapter[]): ReaderState {
	const defaults: ReaderState = {
		schemaVersion: READER_SCHEMA_VERSION,
		translation: "en.hilali",
		position: { chapter: 1, verse: 1 },
		fontSize: 21,
		theme: "light",
		readingData: normalizeReadingData(null, chapters),
	};
	if (raw === null) return defaults;
	const value: unknown = JSON.parse(raw);
	if (!isObject(value)) throw new Error("Saved preferences are not valid.");
	const position = isObject(value.position)
		? { chapter: value.position.chapter as number, verse: value.position.verse as number }
		: null;
	return {
		schemaVersion: READER_SCHEMA_VERSION,
		translation: Object.hasOwn(TRANSLATIONS, value.translation as PropertyKey)
			? value.translation as TranslationId
			: defaults.translation,
		position: validPosition(position, chapters) ? position : defaults.position,
		fontSize: typeof value.fontSize === "number" && Number.isInteger(value.fontSize)
			? Math.max(17, Math.min(29, value.fontSize))
			: defaults.fontSize,
		theme: value.theme === "dark" ? "dark" : "light",
		readingData: normalizeReadingData(value.readingData, chapters),
	};
}
