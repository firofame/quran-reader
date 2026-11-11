export const READER_SCHEMA_VERSION = 8;
export const DEFAULT_RUKU_COUNT = 556;

/**
 * Sessions recorded under the retired light day, deep, and flow names still
 * count as regular reading, so saved history keeps its totals.
 */
const RETIRED_MODES = new Set(["full", "flow", "deep", "light"]);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const VERSE_KEY = /^(\d{1,3}):(\d{1,3})$/;

export function createDefaultReadingData() {
  return {
    version: READER_SCHEMA_VERSION,
    completedRukuIds: [],
    verseReadKeys: [],
    totals: { rukuRead: 0, verseRead: 0, readingDays: 0 },
    activityByDay: {},
    sessions: [],
    settings: {
      dailyTarget: 3,
      dayBoundaryHour: 0,
      anchors: [],
      remindersEnabled: false,
      translationFont: "serif",
      rukuSummary: "auto",
      listenEchoEnabled: false,
      shortcutsSeen: false,
      resumeAtNextUnread: true,
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

function cleanAnchor(anchor) {
  if (!isObject(anchor)) return null;
  const name = typeof anchor.name === "string" ? anchor.name.trim().slice(0, 40) : "";
  const time = typeof anchor.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(anchor.time) ? anchor.time : "";
  if (!name || !time) return null;
  return { id: typeof anchor.id === "string" ? anchor.id.slice(0, 80) : `${name}-${time}`, name, time };
}

export function normalizeReadingData(raw, chapters, rukuCount = DEFAULT_RUKU_COUNT) {
  const defaults = createDefaultReadingData();
  if (!isObject(raw)) return defaults;
  const settings = isObject(raw.settings) ? raw.settings : {};
  const anchors = (Array.isArray(settings.anchors) ? settings.anchors : []).map(cleanAnchor).filter(Boolean).slice(0, 4);
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
      dailyTarget: boundedInteger(settings.dailyTarget, defaults.settings.dailyTarget, 1, 10),
      dayBoundaryHour: boundedInteger(settings.dayBoundaryHour, 0, 0, 23),
      anchors,
      remindersEnabled: Boolean(settings.remindersEnabled),
      translationFont: ["serif", "sans"].includes(settings.translationFont) ? settings.translationFont : defaults.settings.translationFont,
      rukuSummary: ["auto", "always", "never"].includes(settings.rukuSummary) ? settings.rukuSummary : defaults.settings.rukuSummary,
      listenEchoEnabled: Boolean(settings.listenEchoEnabled),
      shortcutsSeen: Boolean(settings.shortcutsSeen),
      resumeAtNextUnread: settings.resumeAtNextUnread !== false,
    },
  };
}

export function getDayKey(date = new Date(), boundaryHour = 0) {
  const adjusted = new Date(date.getTime() - Math.max(0, Math.min(23, boundaryHour)) * 60 * 60 * 1000);
  return `${adjusted.getFullYear()}-${String(adjusted.getMonth() + 1).padStart(2, "0")}-${String(adjusted.getDate()).padStart(2, "0")}`;
}

function shiftDayKey(key, amount) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + amount);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function getRecentDayKeys(date = new Date(), boundaryHour = 0, count = 7) {
  const today = getDayKey(date, boundaryHour);
  return Array.from({ length: count }, (_, index) => shiftDayKey(today, index - count + 1));
}

export function getTodayStats(readingData, date = new Date()) {
  const { settings } = readingData;
  const key = getDayKey(date, settings.dayBoundaryHour);
  const activity = readingData.activityByDay[key];
  const target = settings.dailyTarget;
  const completed = activity?.rukuIds.length ?? 0;
  return { date: key, target, completed, bonus: Math.max(0, completed - target), reached: completed >= target };
}

export function recordVerseVisit(readingData, position, date = new Date()) {
  const key = `${position.chapter}:${position.verse}`;
  const boundaryHour = readingData.settings.dayBoundaryHour;
  const day = getDayKey(date, boundaryHour);
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
 * The daily and weekly activity is left untouched rather than inventing a
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
  const day = getDayKey(date, readingData.settings.dayBoundaryHour);
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

export function resolveStartupPosition({ hashPosition, savedPosition, readingData, chapters, rukus }) {
  if (hashPosition && (hashPosition.chapter !== savedPosition.chapter || hashPosition.verse !== savedPosition.verse)) {
    return { position: hashPosition, source: "link" };
  }
  if (!readingData.settings.resumeAtNextUnread) {
    return { position: savedPosition, source: "saved" };
  }
  const resumePosition = getResumePosition(savedPosition, readingData, chapters, rukus);
  const changed = resumePosition.chapter !== savedPosition.chapter || resumePosition.verse !== savedPosition.verse;
  return { position: resumePosition, source: changed ? "resume" : "saved" };
}

export function getResumePosition(position, readingData, chapters, rukus) {
  const key = `${position.chapter}:${position.verse}`;
  if (!readingData.verseReadKeys.includes(key)) return position;
  const currentRuku = findRuku(position, rukus);
  if (!currentRuku) return position;
  const isRead = (chapter, verse) => readingData.verseReadKeys.includes(`${chapter}:${verse}`);
  const versesOf = ruku => {
    const verses = [];
    for (let chapter = ruku.start.chapter; chapter <= ruku.end.chapter; chapter++) {
      const first = chapter === ruku.start.chapter ? ruku.start.verse : 1;
      const last = chapter === ruku.end.chapter ? ruku.end.verse : chapters[chapter - 1].verses;
      for (let verse = first; verse <= last; verse++) verses.push({ chapter, verse });
    }
    return verses;
  };
  const remaining = versesOf(currentRuku).filter(candidate => candidate.chapter !== position.chapter || candidate.verse > position.verse);
  for (const candidate of remaining) {
    if (!isRead(candidate.chapter, candidate.verse)) return candidate;
  }
  for (const ruku of rukus.slice(currentRuku.id)) {
    for (const candidate of versesOf(ruku)) {
      if (!isRead(candidate.chapter, candidate.verse)) return candidate;
    }
  }
  return position;
}

export function getSurahRukuProgress(chapterId, readingData, rukus) {
  const surahRukus = rukus.filter(ruku => ruku.chapter === chapterId);
  const completed = surahRukus.filter(ruku => readingData.completedRukuIds.includes(ruku.id)).length;
  return { completed, total: surahRukus.length };
}

export function getRecentPace(readingData, date = new Date(), windowDays = 14) {
  const days = getRecentDayKeys(date, readingData.settings.dayBoundaryHour, windowDays);
  const counts = days.map(day => readingData.activityByDay[day]?.rukuCompletions ?? 0);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const activeDays = counts.filter(count => count > 0).length;
  return {
    total,
    activeDays,
    activeDayAverage: activeDays ? total / activeDays : 0,
    calendarDayAverage: total / windowDays,
  };
}

export function getWeekKeys(date = new Date(), boundaryHour = 0) {
  const today = getDayKey(date, boundaryHour);
  const [year, month, day] = today.split("-").map(Number);
  const localDate = new Date(year, month - 1, day, 12);
  const daysSinceMonday = (localDate.getDay() + 6) % 7;
  const monday = shiftDayKey(today, -daysSinceMonday);
  return Array.from({ length: 7 }, (_, index) => shiftDayKey(monday, index));
}

export function getWeeklySummary(readingData, date = new Date()) {
  const thisWeek = getWeekKeys(date, readingData.settings.dayBoundaryHour);
  const previousWeek = thisWeek.map(day => shiftDayKey(day, -7));
  const sumWeek = days => days.reduce((total, day) => total + (readingData.activityByDay[day]?.rukuCompletions ?? 0), 0);
  const readDays = thisWeek.filter(day => readingData.activityByDay[day]?.active).length;
  return {
    days: thisWeek.map(day => ({ date: day, activity: readingData.activityByDay[day] ?? null })),
    readDays,
    thisWeekRukus: sumWeek(thisWeek),
    previousWeekRukus: sumWeek(previousWeek),
  };
}

export function getSectionRukus(type, number, data, chapters, rukus) {
  const markers = data[type === "juz" ? "Juz" : "Manzil"];
  if (!Array.isArray(markers) || !markers[number]) return [];
  const [startChapter, startVerse] = markers[number];
  const next = markers[number + 1];
  const start = chapters[startChapter - 1].start + startVerse - 1;
  const end = next && chapters[next[0] - 1]
    ? chapters[next[0] - 1].start + next[1] - 2
    : chapters.at(-1).start + chapters.at(-1).verses - 1;
  return rukus.filter(ruku => {
    const global = chapters[ruku.chapter - 1].start + ruku.start.verse - 1;
    return global >= start && global <= end;
  });
}

export function formatDateKey(key, options = { month: "short", day: "numeric" }) {
  if (!validDateKey(key)) return "";
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12).toLocaleDateString(undefined, options);
}
