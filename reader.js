export const TRANSLATIONS = {
  "en.sahih": { name: "Saheeh International", language: "en", file: "en.sahih.txt" },
  "ml.abdulhameed": {
    name: "Cheriyamundam Abdul Hameed & Kunhi Mohammed Parappoor",
    language: "ml",
    file: "ml.abdulhameed.txt",
  },
};

export function createChapters(rows) {
  return rows.slice(1, 115).map((row, index) => ({
    id: index + 1,
    start: row[0],
    verses: row[1],
    arabic: row[4],
    name: row[5],
    meaning: row[6],
    origin: row[7],
  }));
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

export function parseHash(hash, chapters) {
  const match = /^#(\d+):(\d+)$/.exec(hash);
  if (!match) return null;
  const position = { chapter: Number(match[1]), verse: Number(match[2]) };
  return validPosition(position, chapters) ? position : null;
}

export function normalizeSearch(text) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/['’\-]/g, "");
}

export function selectAyah(verses, verseNumber, query = "") {
  const search = normalizeSearch(query.trim());
  const matches = verses.filter(verse =>
    normalizeSearch(verse.text).includes(search) || `${verse.chapter}:${verse.verse}`.includes(search));
  const index = Math.max(0, matches.findIndex(verse => verse.verse === verseNumber));
  return { ayah: matches[index] ?? null, index, matches };
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

export function swipeDirection(deltaX, deltaY) {
  if (Math.abs(deltaX) < 50 || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return 0;
  return deltaX < 0 ? 1 : -1;
}

export function matchesChapter(chapter, query) {
  const haystack = `${chapter.id} ${chapter.name} ${chapter.meaning} ${chapter.arabic}`;
  return normalizeSearch(haystack).includes(normalizeSearch(query.trim()));
}

export function decodeState(raw, chapters) {
  const defaults = {
    translation: "en.sahih",
    position: { chapter: 1, verse: 1 },
    bookmarks: [],
    fontSize: 21,
    theme: "light",
  };
  if (raw === null) return defaults;
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved preferences are not valid.");
  const bookmarks = Array.isArray(value.bookmarks) ? value.bookmarks.filter(item => validPosition(item, chapters)) : [];
  return {
    translation: Object.hasOwn(TRANSLATIONS, value.translation) ? value.translation : defaults.translation,
    position: validPosition(value.position, chapters) ? value.position : defaults.position,
    bookmarks: bookmarks.filter((item, index) =>
      bookmarks.findIndex(other => other.chapter === item.chapter && other.verse === item.verse) === index),
    fontSize: Number.isInteger(value.fontSize) ? Math.max(17, Math.min(29, value.fontSize)) : defaults.fontSize,
    theme: value.theme === "dark" ? "dark" : "light",
  };
}
