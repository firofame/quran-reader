export const READER_SCHEMA_VERSION = 10;
export const DEFAULT_RUKU_COUNT = 556;
export const DEFAULT_DAILY_TARGET = 5;
export const DAY_BOUNDARY_HOUR = 0;

/** The five daily prayers, in the order they follow each other. */
export const PRAYERS = [
  { id: "fajr", name: "Fajr" },
  { id: "dhuhr", name: "Dhuhr" },
  { id: "asr", name: "Asr" },
  { id: "maghrib", name: "Maghrib" },
  { id: "isha", name: "Isha" },
];

/** The times the prayers start with, until the reader sets their own. */
export const DEFAULT_PRAYER_TIMES = {
  fajr: "05:00",
  dhuhr: "12:30",
  asr: "15:30",
  maghrib: "18:00",
  isha: "19:30",
};

/**
 * Sessions recorded under the retired light day, deep, and flow names still
 * count as regular reading, so saved history keeps its totals.
 */
const RETIRED_MODES = new Set(["full", "flow", "deep", "light"]);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const VERSE_KEY = /^(\d{1,3}):(\d{1,3})$/;
const TIME_KEY = /^([01]\d|2[0-3]):[0-5]\d$/;

export function createDefaultReadingData() {
  return {
    version: READER_SCHEMA_VERSION,
    completedRukuIds: [],
    verseReadKeys: [],
    totals: { rukuRead: 0, verseRead: 0, readingDays: 0 },
    activityByDay: {},
    sessions: [],
    settings: {
      dailyTarget: DEFAULT_DAILY_TARGET,
      prayerTimes: { ...DEFAULT_PRAYER_TIMES },
      remindersEnabled: false,
      shortcutsSeen: false,
    },
  };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function validDateKey(value) {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function uniqueIntegers(values, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(value => Number.isSafeInteger(value) && value > 0 && value <= maximum))].sort((a, b) => a - b);
}

function validVerseKey(value, chapters) {
  if (typeof value !== "string") return false;
  const match = VERSE_KEY.exec(value);
  if (!match) return false;
  const chapter = Number(match[1]);
  const verse = Number(match[2]);
  return Boolean(chapters[chapter - 1] && verse >= 1 && verse <= chapters[chapter - 1].verses);
}

function cleanActivity(row, chapters, rukuCount) {
  if (!isObject(row)) return null;
  return {
    active: Boolean(row.active),
    rukuIds: uniqueIntegers(row.rukuIds, rukuCount),
    rukuCompletions: boundedInteger(row.rukuCompletions, 0, 0, 1000000),
    sessionStarts: (Array.isArray(row.sessionStarts) ? row.sessionStarts : [])
      .filter(value => Number.isSafeInteger(value) && value > 0)
      .slice(-30),
    lastReadAt: Number.isSafeInteger(row.lastReadAt) && row.lastReadAt > 0 ? row.lastReadAt : 0,
  };
}

/**
 * Keeps the saved prayer times and falls back to the default time of every
 * prayer whose saved time is missing or not a valid time of day.
 */
function cleanPrayerTimes(value) {
  const times = { ...DEFAULT_PRAYER_TIMES };
  if (!isObject(value)) return times;
  for (const prayer of PRAYERS) {
    const time = value[prayer.id];
    if (typeof time === "string" && TIME_KEY.test(time)) times[prayer.id] = time;
  }
  return times;
}

export function normalizeReadingData(raw, chapters, rukuCount = DEFAULT_RUKU_COUNT) {
  const defaults = createDefaultReadingData();
  if (!isObject(raw)) return defaults;
  const settings = isObject(raw.settings) ? raw.settings : {};
  const prayerTimes = cleanPrayerTimes(settings.prayerTimes);
  const activityByDay = {};
  if (isObject(raw.activityByDay)) {
    const days = Object.entries(raw.activityByDay).filter(([date]) => validDateKey(date)).sort(([left], [right]) => left.localeCompare(right)).slice(-400);
    for (const [date, row] of days) {
      const clean = cleanActivity(row, chapters, rukuCount);
      if (clean) activityByDay[date] = clean;
    }
  }
  const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).flatMap(session => {
    if (!isObject(session) || !Number.isSafeInteger(session.rukuId) || session.rukuId < 1 || session.rukuId > rukuCount) return [];
    if (!validDateKey(session.date)) return [];
    if (!RETIRED_MODES.has(session.mode)) return [];
    return [{
      date: session.date,
      rukuId: session.rukuId,
      completedAt: Number.isSafeInteger(session.completedAt) ? session.completedAt : 0,
    }];
  }).slice(-5000);
  const verseReadKeys = [...new Set((Array.isArray(raw.verseReadKeys) ? raw.verseReadKeys : []).filter(key => validVerseKey(key, chapters)))];
  return {
    version: READER_SCHEMA_VERSION,
    completedRukuIds: uniqueIntegers(raw.completedRukuIds, rukuCount),
    verseReadKeys,
    totals: {
      rukuRead: boundedInteger(raw.totals?.rukuRead, sessions.length, 0, 100000000),
      verseRead: boundedInteger(raw.totals?.verseRead, verseReadKeys.length, 0, 100000000),
      readingDays: boundedInteger(raw.totals?.readingDays, Object.values(activityByDay).filter(day => day.active).length, 0, 1000000),
    },
    activityByDay,
    sessions,
    settings: {
      dailyTarget: DEFAULT_DAILY_TARGET,
      prayerTimes,
      remindersEnabled: Boolean(settings.remindersEnabled),
      shortcutsSeen: Boolean(settings.shortcutsSeen),
    },
  };
}

/**
 * Lists the five prayers in the order they occur in the day, each with the
 * time the reader has set for it.
 */
export function getPrayerSchedule(readingData) {
  const times = readingData?.settings?.prayerTimes ?? {};
  return PRAYERS
    .map(prayer => ({ ...prayer, time: times[prayer.id] ?? DEFAULT_PRAYER_TIMES[prayer.id] }))
    .sort((left, right) => left.time.localeCompare(right.time));
}

export function getDayKey(date = new Date()) {
  const adjusted = new Date(date.getTime() - DAY_BOUNDARY_HOUR * 60 * 60 * 1000);
  return `${adjusted.getFullYear()}-${String(adjusted.getMonth() + 1).padStart(2, "0")}-${String(adjusted.getDate()).padStart(2, "0")}`;
}

export function getTodayStats(readingData, date = new Date()) {
  const key = getDayKey(date);
  const activity = readingData.activityByDay[key];
  const target = DEFAULT_DAILY_TARGET;
  const completed = activity?.rukuIds.length ?? 0;
  return { date: key, target, completed, bonus: Math.max(0, completed - target), reached: completed >= target };
}

export function recordVerseVisit(readingData, position, date = new Date()) {
  const key = `${position.chapter}:${position.verse}`;
  const day = getDayKey(date);
  const wasRead = readingData.verseReadKeys.includes(key);
  const prior = readingData.activityByDay[day] ?? {
    active: false, rukuIds: [], rukuCompletions: 0,
    sessionStarts: [], lastReadAt: 0,
  };
  const sessions = prior.sessionStarts.slice();
  if (!sessions.length || date.getTime() - sessions.at(-1) >= 30 * 60 * 1000) sessions.push(date.getTime());
  const activityByDay = {
    ...readingData.activityByDay,
    [day]: {
      ...prior,
      active: true,
      sessionStarts: sessions.slice(-30),
      lastReadAt: date.getTime(),
    },
  };
  pruneActivity(activityByDay, day);
  return {
    ...readingData,
    verseReadKeys: wasRead ? readingData.verseReadKeys : [...readingData.verseReadKeys, key],
    totals: {
      ...readingData.totals,
      verseRead: readingData.totals.verseRead + Number(!wasRead),
      readingDays: readingData.totals.readingDays + Number(!prior.active),
    },
    activityByDay,
  };
}

/** Lists every verse covered by a ruku, as `chapter:verse` keys. */
function rukuVerseKeys(ruku) {
  const keys = [];
  for (let chapter = ruku.start.chapter; chapter <= ruku.end.chapter; chapter++) {
    const first = chapter === ruku.start.chapter ? ruku.start.verse : 1;
    const last = chapter === ruku.end.chapter ? ruku.end.verse : Number.MAX_SAFE_INTEGER;
    const max = Math.min(last, Number.MAX_SAFE_INTEGER);
    const chapterVerseCount = ruku.chapters[chapter - 1]?.verses ?? max;
    for (let verse = first; verse <= Math.min(max, chapterVerseCount); verse++) {
      keys.push(`${chapter}:${verse}`);
    }
  }
  return keys;
}

/**
 * Marks every ruku before `currentRukuId` as read.
 *
 * This is a one-time backfill for a reader who has already read further than
 * this device knows about. The days are unknown, so only the cumulative facts
 * are updated: the completed rukus, the verses read, and the lifetime totals.
 * The activity history is left untouched rather than inventing a
 * reading timeline.
 */
export function recordRukusAsRead(readingData, currentRukuId, rukus) {
  const completed = new Set(readingData.completedRukuIds);
  const verseReadKeys = new Set(readingData.verseReadKeys);
  const pending = rukus.filter(ruku => ruku.id < currentRukuId && !completed.has(ruku.id));
  for (const ruku of pending) {
    completed.add(ruku.id);
    for (const key of rukuVerseKeys(ruku)) verseReadKeys.add(key);
  }
  return {
    ...readingData,
    completedRukuIds: [...completed].sort((a, b) => a - b),
    verseReadKeys: [...verseReadKeys],
    totals: {
      ...readingData.totals,
      rukuRead: readingData.totals.rukuRead + pending.length,
      verseRead: verseReadKeys.size,
    },
  };
}

export function recordRukuCompletion(readingData, ruku, date = new Date()) {
  const day = getDayKey(date);
  const prior = readingData.activityByDay[day] ?? {
    active: false, rukuIds: [], rukuCompletions: 0,
    sessionStarts: [], lastReadAt: 0,
  };
  let verseReadKeys = new Set(readingData.verseReadKeys);
  for (const key of rukuVerseKeys(ruku)) {
    verseReadKeys.add(key);
  }
  const isNewDailyRuku = !prior.rukuIds.includes(ruku.id);
  const isNewDailyReadingDay = !prior.active;
  const activityByDay = {
    ...readingData.activityByDay,
    [day]: {
      ...prior,
      active: true,
      rukuIds: isNewDailyRuku ? [...prior.rukuIds, ruku.id] : prior.rukuIds,
      rukuCompletions: prior.rukuCompletions + 1,
      sessionStarts: prior.sessionStarts.length ? prior.sessionStarts : [date.getTime()],
      lastReadAt: date.getTime(),
    },
  };
  pruneActivity(activityByDay, day);
  const newSession = { date: day, rukuId: ruku.id, completedAt: date.getTime() };
  return {
    ...readingData,
    completedRukuIds: readingData.completedRukuIds.includes(ruku.id)
      ? readingData.completedRukuIds
      : [...readingData.completedRukuIds, ruku.id].sort((a, b) => a - b),
    verseReadKeys: [...verseReadKeys],
    totals: {
      ...readingData.totals,
      rukuRead: readingData.totals.rukuRead + 1,
      verseRead: verseReadKeys.size,
      readingDays: readingData.totals.readingDays + Number(isNewDailyReadingDay),
    },
    activityByDay,
    sessions: [...readingData.sessions, newSession].slice(-5000),
  };
}

function pruneActivity(activityByDay, currentDay) {
  const keys = Object.keys(activityByDay).sort();
  while (keys.length > 400) {
    const oldest = keys.shift();
    if (oldest !== currentDay) delete activityByDay[oldest];
  }
}

export function getRukuIndex(data, chapters) {
  const starts = data.Ruku.slice(1).filter(([chapter, verse]) => chapters[chapter - 1] && verse >= 1 && verse <= chapters[chapter - 1].verses);
  const positionAt = globalIndex => {
    const chapter = [...chapters].reverse().find(item => item.start <= globalIndex);
    return { chapter: chapter.id, verse: globalIndex - chapter.start + 1 };
  };
  return starts.map(([chapter, verse], index) => {
    const next = starts[index + 1];
    const chapterMeta = chapters[chapter - 1];
    const nextGlobal = next ? chapters[next[0] - 1].start + next[1] - 1 : null;
    const finalGlobal = chapters.at(-1).start + chapters.at(-1).verses - 1;
    const end = positionAt((nextGlobal ?? finalGlobal + 1) - 1);
    const localNumber = starts.slice(0, index + 1).filter(start => start[0] === chapter).length;
    return {
      id: index + 1,
      chapter,
      localNumber,
      start: { chapter, verse },
      end,
      chapterMeta,
      chapters,
    };
  });
}

export function findRuku(position, rukus) {
  let found = null;
  for (const ruku of rukus) {
    if (ruku.start.chapter < position.chapter || (ruku.start.chapter === position.chapter && ruku.start.verse <= position.verse)) found = ruku;
    else break;
  }
  return found;
}

export function isRukuEnd(position, ruku) {
  return Boolean(ruku && position.chapter === ruku.end.chapter && position.verse === ruku.end.verse);
}

export function resolveStartupPosition({ hashPosition, savedPosition }) {
  return hashPosition
    ? { position: hashPosition, source: "link" }
    : { position: savedPosition, source: "saved" };
}

export function getSurahRukuProgress(chapterId, readingData, rukus) {
  const surahRukus = rukus.filter(ruku => ruku.chapter === chapterId);
  const completed = surahRukus.filter(ruku => readingData.completedRukuIds.includes(ruku.id)).length;
  return { completed, total: surahRukus.length };
}
