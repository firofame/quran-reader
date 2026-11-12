import { READER_SCHEMA_VERSION, normalizeReadingData } from "./reading-data.js";

export const TRANSLATIONS = {
  "en.hilali": { name: "Hilali & Khan", language: "en-US", file: "en.hilali.txt" },
};

export function createChapters(rows) {
  return rows.slice(1, 115).map((row, index) => ({
    id: index + 1,
    start: row[0],
    verses: row[1],
    name: row[5],
    meaning: row[6],
    origin: row[7],
  }));
}

function markerNumberAt(markers, position) {
  let number = null;
  for (let index = 1; index < markers.length; index++) {
    const [chapter, verse] = markers[index];
    if (chapter < position.chapter || (chapter === position.chapter && verse <= position.verse)) {
      number = index;
    }
  }
  return number;
}

export function getVerseMetadata(position, data) {
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

export function getRukuProgress(position, data, chapters) {
  if (!validPosition(position, chapters)) {
    throw new Error("Cannot calculate ruku progress for an invalid ayah.");
  }
  const ruku = markerNumberAt(data.Ruku, position);
  if (ruku === null) throw new Error("Ruku metadata is missing for this ayah.");
  const [startChapter, startVerse] = data.Ruku[ruku];
  const start = chapters[startChapter - 1].start + startVerse - 1;
  const next = data.Ruku[ruku + 1];
  const lastChapter = chapters.at(-1);
  const end = next
    ? chapters[next[0] - 1].start + next[1] - 1
    : lastChapter.start + lastChapter.verses;
  return {
    value: chapters[position.chapter - 1].start + position.verse - start,
    max: end - start,
  };
}

export function validPosition(position, chapters) {
  if (!position || !Number.isInteger(position.chapter) || !Number.isInteger(position.verse)) return false;
  const chapter = chapters[position.chapter - 1];
  return Boolean(chapter && position.verse >= 1 && position.verse <= chapter.verses);
}

export function parseTranslation(text, chapters) {
  const result = chapters.map(() => []);
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

export function splitTranslationParagraphs(text, language) {
  if (text.length < 500) return [text];
  const paragraphs = [];
  let paragraph = "";
  let quoted = false;
  for (const { segment } of new Intl.Segmenter(language, { granularity: "sentence" }).segment(text)) {
    if (paragraph && paragraph.length + segment.length > 300 && !quoted) {
      paragraphs.push(paragraph);
      paragraph = "";
    }
    paragraph += segment;
    for (const character of segment) {
      if ('"\u201c\u201d'.includes(character)) quoted = !quoted;
    }
  }
  if (paragraph) paragraphs.push(paragraph);
  return paragraphs;
}

export function parseHash(hash, chapters) {
  const match = /^#(\d+):(\d+)$/.exec(hash);
  if (!match) return null;
  const position = { chapter: Number(match[1]), verse: Number(match[2]) };
  return validPosition(position, chapters) ? position : null;
}

export function normalizeSearch(text) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/['’\-]/g, "");
}

export function findAyah(verses, verseNumber) {
  return verses.find(verse => verse.verse === verseNumber) ?? verses[0] ?? null;
}

export function adjacentPosition(position, direction, chapters) {
  if (!validPosition(position, chapters) || ![-1, 1].includes(direction)) {
    throw new Error("Cannot navigate from an invalid ayah or direction.");
  }
  const verse = position.verse + direction;
  if (verse >= 1 && verse <= chapters[position.chapter - 1].verses) {
    return { chapter: position.chapter, verse };
  }
  const next = chapters[position.chapter + direction - 1];
  return next ? { chapter: next.id, verse: direction === 1 ? 1 : next.verses } : null;
}

export function matchesChapter(chapter, query) {
  const haystack = `${chapter.id} ${chapter.name} ${chapter.meaning}`;
  return normalizeSearch(haystack).includes(normalizeSearch(query.trim()));
}

export function decodeState(raw, chapters) {
  const defaults = {
    schemaVersion: READER_SCHEMA_VERSION,
    translation: "en.hilali",
    position: { chapter: 1, verse: 1 },
    fontSize: 21,
    theme: "light",
    readingData: normalizeReadingData(null, chapters),
  };
  if (raw === null) return defaults;
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved preferences are not valid.");
  return {
    schemaVersion: READER_SCHEMA_VERSION,
    translation: Object.hasOwn(TRANSLATIONS, value.translation) ? value.translation : defaults.translation,
    position: validPosition(value.position, chapters) ? value.position : defaults.position,
    fontSize: Number.isInteger(value.fontSize) ? Math.max(17, Math.min(29, value.fontSize)) : defaults.fontSize,
    theme: value.theme === "dark" ? "dark" : "light",
    readingData: normalizeReadingData(value.readingData, chapters),
  };
}
