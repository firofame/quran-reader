import { TRANSLATIONS, createChapters, getVerseMetadata, getRukuProgress, parseHash, splitTranslationParagraphs, findAyah, adjacentPosition, matchesChapter, decodeState, validPosition } from "./reader.js";
import { reduceReaderState } from "./reader-state.js";
import { createPreferencesStore } from "./preferences-store.js";
import { createTranslationRepository } from "./translation-repository.js";
import { DEFAULT_RUKU_COUNT, findRuku, formatDateKey, getDayKey, getRecentDayKeys, getRukuIndex, getSurahRukuProgress, getTodayStats, getWeeklySummary, isRukuEnd, recordRukuCompletion, recordRukusAsRead, recordVerseVisit, resolveStartupPosition } from "./reading-data.js";

const icons = {
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  moon: '<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  left: '<path d="m14 6-6 6 6 6M8 12h12"/>',
  right: '<path d="m10 6 6 6-6 6M16 12H4"/>',
};
const $ = id => document.getElementById(id);
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ""}</svg>`;
document.querySelectorAll("[data-icon]").forEach(element => { element.innerHTML = icon(element.dataset.icon); });

const chapters = createChapters(globalThis.QuranData.Sura);
const rukus = getRukuIndex(globalThis.QuranData, chapters);
const preferences = createPreferencesStore({
  getItem: key => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
}, chapters);
// Drop configuration left by the former cross-device sync feature.
try { globalThis.localStorage.removeItem("quran-reader:sync:v1"); } catch {}
const translations = createTranslationRepository();
let state;
let requestId = 0;
let noticeTimer;
let storageFailed = false;
let loading = false;
let activePage = "reader";
let completedRuku = null;
let reminderTimer;
let activeAudioButton = null;
let audioRequestId = 0;
let currentAyah = null;

function notify(message, persistent = false) {
  if (storageFailed && !persistent) {
    message += " Changes will only last until this page is closed because browser storage is unavailable.";
    persistent = true;
  }
  clearTimeout(noticeTimer);
  $("notice").textContent = message;
  $("notice").hidden = false;
  if (!persistent) noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 5000);
}

try {
  state = preferences.load();
} catch (error) {
  console.error("Unable to read saved Quran reader preferences:", error);
  state = decodeState(null, chapters);
  notify("Your saved preferences could not be read. Default preferences have been restored.", true);
}

function persist() {
  try {
    preferences.save(state);
  } catch (error) {
    if (!storageFailed) {
      console.error("Unable to save Quran reader preferences:", error);
      notify("Browser storage is unavailable. Your reading progress won't be saved.", true);
      storageFailed = true;
    }
  }
}

function updateReadingData(update, { renderPages = true } = {}) {
  state = { ...state, readingData: update(state.readingData) };
  persist();
  if (renderPages) renderAllPages();
  else renderProgressSummary();
}

function recordCurrentVerse() {
  const currentRuku = findRuku(state.position, rukus);
  updateReadingData(readingData => recordVerseVisit(readingData, state.position, new Date()), { renderPages: false });
  if (currentRuku) renderRukuSummary(currentRuku);
}

/** Counts the rukus before the current one that are not recorded as read yet. */
function pendingEarlierRukus() {
  const currentRuku = findRuku(state.position, rukus);
  if (!currentRuku || currentRuku.id <= 1) return 0;
  const completed = new Set(state.readingData.completedRukuIds);
  let pending = 0;
  for (const ruku of rukus) {
    if (ruku.id >= currentRuku.id) break;
    if (!completed.has(ruku.id)) pending++;
  }
  return pending;
}

/** Shows the “mark earlier rukus as read” action on the Settings page. */
function renderMarkReadBlock() {
  const pendingEarlier = pendingEarlierRukus();
  $("mark-read-block").hidden = pendingEarlier === 0;
  $("mark-read-btn").textContent = `Mark ${pendingEarlier} earlier ruku${pendingEarlier === 1 ? "" : "s"} as read`;
}

function stopVerseAudio() {
  audioRequestId++;
  const audio = $("verse-audio");
  if (!audio) return;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (activeAudioButton?.isConnected) {
    activeAudioButton.disabled = false;
    activeAudioButton.textContent = "Hear one verse";
  }
  activeAudioButton = null;
}

function playVerseAudio(position, button) {
  const audio = $("verse-audio");
  const chapter = chapters[position.chapter - 1];
  const ayahNumber = chapter.start + position.verse - 1;
  const source = `https://cdn.islamic.network/quran/audio/128/ar.alafasy/${ayahNumber}.mp3`;
  stopVerseAudio();
  const request = ++audioRequestId;
  activeAudioButton = button;
  button.disabled = true;
  button.textContent = "Loading recitation…";
  audio.src = source;
  audio.currentTime = 0;
  audio.play().then(() => {
    if (request !== audioRequestId) return;
    if (activeAudioButton?.isConnected) {
      activeAudioButton.disabled = false;
      activeAudioButton.textContent = "Playing one verse…";
    }
  }).catch(error => {
    if (request !== audioRequestId) return;
    console.warn("Unable to play the selected recitation:", error);
    if (activeAudioButton?.isConnected) {
      activeAudioButton.disabled = false;
      activeAudioButton.textContent = "Hear one verse";
    }
    notify("The recitation could not be opened. Check your connection and try again.");
  });
  audio.onended = () => {
    if (request !== audioRequestId) return;
    if (activeAudioButton?.isConnected) {
      activeAudioButton.disabled = false;
      activeAudioButton.textContent = "Hear one verse";
    }
    activeAudioButton = null;
  };
  audio.onerror = () => {
    if (request !== audioRequestId) return;
    if (activeAudioButton?.isConnected) {
      activeAudioButton.disabled = false;
      activeAudioButton.textContent = "Hear one verse";
    }
    activeAudioButton = null;
  };
}

function updateDocumentChrome() {
  const currentRuku = findRuku(state.position, rukus);
  const today = getTodayStats(state.readingData);
  const progress = state.readingData.completedRukuIds.length;
  const percent = progress === 0 || progress === rukus.length
    ? Math.round(progress / rukus.length * 100)
    : Number((progress / rukus.length * 100).toFixed(1));
  const dayLabel = today.reached
    ? `${today.target}/${today.target}${today.bonus ? ` +${today.bonus}` : ""} today`
    : `${today.completed}/${today.target} today`;
  document.title = `${currentRuku ? `Ruku ${currentRuku.id}` : `Ayah ${state.position.chapter}:${state.position.verse}`} · ${dayLabel} — The Quran`;
  $("overall-progress-label").textContent = `${progress} / ${rukus.length} rukus · ${percent}%`;
  $("overall-progress-bar").max = rukus.length;
  $("overall-progress-bar").value = progress;
  renderMarkReadBlock();

  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) return;
    const center = 16;
    context.lineWidth = 3;
    context.strokeStyle = state.theme === "dark" ? "#343d33" : "#e5e6dc";
    context.beginPath();
    context.arc(center, center, 12, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = state.theme === "dark" ? "#c2ad83" : "#ac9468";
    context.lineCap = "round";
    context.beginPath();
    context.arc(center, center, 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, today.completed / today.target));
    context.stroke();
    const favicon = $("app-icon");
    favicon.href = canvas.toDataURL("image/png");
    favicon.type = "image/png";
  } catch {
    // The linked static SVG remains available if canvas or data URLs are unavailable.
  }
}

function dispatch(action) {
  state = reduceReaderState(state, action, chapters);
  persist();
}

const initialPosition = parseHash(location.hash, chapters);
const startup = resolveStartupPosition({
  hashPosition: initialPosition,
  savedPosition: state.position,
  readingData: state.readingData,
  chapters,
  rukus,
});
if (startup.source === "link") {
  state = reduceReaderState(state, { type: "position/set", position: startup.position }, chapters);
} else if (location.hash && location.hash !== "#main" && !initialPosition) {
  notify("That verse link isn't valid. Your last reading position has been opened.");
} else if (startup.source === "resume") {
  state = reduceReaderState(state, { type: "position/set", position: startup.position }, chapters);
  history.replaceState(null, "", `#${startup.position.chapter}:${startup.position.verse}`);
}

function applyPreferences() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.setProperty("--reading-size", `${state.fontSize}px`);
  document.documentElement.dataset.translationFont = state.readingData.settings.translationFont;
  $("theme-toggle").innerHTML = icon(state.theme === "dark" ? "sun" : "moon");
  $("theme-toggle").setAttribute("aria-label", `Switch to ${state.theme === "dark" ? "light" : "dark"} theme`);
  $("font-down").disabled = state.fontSize <= 17;
  $("font-up").disabled = state.fontSize >= 29;
  document.querySelector('meta[name="theme-color"]').content = state.theme === "dark" ? "#191e1b" : "#f8f7f2";
  $("shortcut-hint").hidden = state.readingData.settings.shortcutsSeen;
  updateDocumentChrome();
}

function renderChapters() {
  const query = $("chapter-search").value;
  const matches = chapters.filter(chapter => matchesChapter(chapter, query));
  const fragment = document.createDocumentFragment();
  for (const chapter of matches) {
    const button = document.createElement("button");
    button.className = `chapter-link${chapter.id === state.position.chapter ? " selected" : ""}`;
    button.dataset.chapter = chapter.id;
    if (chapter.id === state.position.chapter) button.setAttribute("aria-current", "true");
    button.innerHTML = `<span class="chapter-number">${String(chapter.id).padStart(2, "0")}</span><span class="chapter-names"><span>${chapter.name}</span><span>${chapter.meaning}</span></span><span class="chapter-verse-count">${chapter.verses}</span>`;
    fragment.append(button);
  }
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "chapter-empty";
    empty.textContent = "No chapters found. Try a name or number.";
    fragment.append(empty);
  }
  $("chapter-list").replaceChildren(fragment);
}

function renderHeading() {
  const chapter = chapters[state.position.chapter - 1];
  if (currentAyah && currentAyah.chapter !== chapter.id) currentAyah = null;
  const currentRuku = findRuku(state.position, rukus);
  const surahProgress = getSurahRukuProgress(chapter.id, state.readingData, rukus);
  const localRuku = currentRuku?.localNumber ?? 0;
  $("chapter-heading").innerHTML = `<div class="chapter-heading-title"><h1>${chapter.id}. ${chapter.name}</h1></div><div class="chapter-heading-meta"><p>${chapter.meaning} · ${chapter.verses} ayahs<span class="sr-only"> · ${chapter.origin}</span></p><p class="chapter-ruku-progress">${chapter.name}: ruku ${localRuku} of ${surahProgress.total} · ${surahProgress.completed} completed<span id="reading-metadata" class="reading-metadata" role="group" aria-label="Current ayah metadata" hidden></span></p></div>`;
  renderReadingMetadata(currentAyah);
  const translation = TRANSLATIONS[state.translation];
  const attribution = $("attribution");
  attribution.replaceChildren(document.createTextNode(`${translation.name} · `));
  const source = document.createElement("a");
  source.href = "https://tanzil.net/trans/";
  source.target = "_blank";
  source.rel = "noreferrer";
  source.textContent = "Translation source: Tanzil";
  attribution.append(source);
}

function renderVerses() {
  const data = translations.getLoaded(state.translation);
  if (!data) return;
  const verses = data[state.position.chapter - 1];
  const ayah = findAyah(verses, state.position.verse);
  const currentRuku = findRuku(state.position, rukus);
  const filtered = ayah ? [ayah] : [];
  const chapter = chapters[state.position.chapter - 1];
  currentAyah = ayah;
  renderReadingMetadata(currentAyah);
  $("reading-content").setAttribute("aria-live", "polite");
  $("ayah-status").hidden = !ayah;
  $("ayah-status").textContent = `AYAH ${state.position.verse} OF ${chapter.verses}`;
  $("ruku-progress-wrap").hidden = !ayah;
  if (ayah && currentRuku) {
    const progress = getRukuProgress(ayah, globalThis.QuranData, chapters);
    const percent = progress.max ? Math.min(100, Math.max(0, progress.value / progress.max * 100)) : 0;
    $("ruku-progress").setAttribute("aria-valuemax", String(progress.max));
    $("ruku-progress").setAttribute("aria-valuenow", String(progress.value));
    $("ruku-progress").setAttribute("aria-valuetext", `Ayah ${progress.value} of ${progress.max} in this ruku`);
    $("ruku-ring-value").style.strokeDashoffset = String(100 - percent);
    $("ruku-progress-label").textContent = `Verse ${progress.value} of ${progress.max} in this ruku`;
  }
  const fragment = document.createDocumentFragment();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<h3>No verses found</h3><p>This part of the chapter could not be loaded.</p>`;
    fragment.append(empty);
  }
  for (const verse of filtered) fragment.append(createVerse(verse));
  $("reading-content").replaceChildren(fragment);
  $("reading-content").setAttribute("aria-busy", "false");
  updateDocumentChrome();
  if (currentRuku) renderRukuSummary(currentRuku);
  renderPagination(ayah);
}

function renderReadingMetadata(verse) {
  const container = $("reading-metadata");
  if (!container) return;
  container.replaceChildren();
  if (!verse) {
    container.hidden = true;
    return;
  }

  const metadata = getVerseMetadata(verse, globalThis.QuranData);
  const parts = [];
  for (const [label, value] of [
    ["Page", metadata.page],
    ["Ruku", metadata.ruku],
    ["Manzil", metadata.manzil],
    ["Hizb", metadata.hizb],
    ["Juz", metadata.juz],
  ]) {
    if (value === null) continue;
    const item = document.createElement("span");
    item.className = "reading-metadata-item";
    const name = document.createElement("span");
    name.className = "reading-metadata-label";
    name.textContent = label;
    const number = document.createElement("span");
    number.className = "reading-metadata-value";
    number.textContent = value;
    item.append(name, number);
    parts.push(item);
  }
  if (metadata.sajda) {
    const item = document.createElement("span");
    item.className = "sajda-indicator";
    const symbol = document.createElement("span");
    symbol.className = "sajda-symbol";
    symbol.setAttribute("aria-hidden", "true");
    symbol.textContent = "۩";
    const label = document.createElement("span");
    label.textContent = "Sajda";
    item.append(symbol, label);
    parts.push(item);
  }
  for (const part of parts) {
    const separator = document.createElement("span");
    separator.className = "reading-metadata-separator";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = "·";
    container.append(separator, part);
  }
  container.hidden = parts.length === 0;
}

function createVerse(verse, showActions = true) {
  const article = document.createElement("article");
  article.className = "verse";
  article.id = `verse-${verse.chapter}-${verse.verse}`;
  article.dataset.chapter = verse.chapter;
  article.dataset.verse = verse.verse;
  const number = document.createElement("a");
  number.className = "verse-number";
  number.textContent = `${verse.chapter}:${verse.verse}`;
  number.href = `#${verse.chapter}:${verse.verse}`;
  number.setAttribute("aria-label", `Link to verse ${verse.chapter}:${verse.verse}`);
  const textContainer = document.createElement("div");
  textContainer.className = "verse-body";
  const language = TRANSLATIONS[state.translation].language;
  for (const paragraph of splitTranslationParagraphs(verse.text, language)) {
    const text = document.createElement("p");
    text.lang = language;
    text.dir = "auto";
    text.textContent = paragraph;
    textContainer.append(text);
  }
  article.append(number, textContainer);
  if (showActions && state.readingData.settings.listenEchoEnabled) {
    const actions = document.createElement("div");
    actions.className = "verse-actions";
    const listen = document.createElement("button");
    listen.type = "button";
    listen.dataset.listenVerse = `${verse.chapter}:${verse.verse}`;
    listen.textContent = "Hear one verse";
    listen.setAttribute("aria-label", `Hear verse ${verse.chapter}:${verse.verse} once, then read it aloud`);
    actions.append(listen);
    textContainer.append(actions);
  }
  return article;
}

function renderPagination(ayah) {
  const nav = $("ayah-navigation");
  const focusedDirection = document.activeElement?.getAttribute("data-direction");
  nav.hidden = !ayah;
  $("navigation-hint").hidden = nav.hidden;
  nav.replaceChildren();
  if (nav.hidden) return;
  const currentRuku = findRuku(state.position, rukus);
  for (const direction of [-1, 1]) {
    const target = adjacentPosition(state.position, direction, chapters);
    const button = document.createElement("button");
    button.className = direction === -1 ? "pagination-button previous" : "pagination-button next";
    button.disabled = !target;
    button.dataset.direction = direction;
    button.setAttribute("aria-label", direction === -1 ? "Previous ayah" : "Next ayah");
    const title = target
      ? direction === 1 && currentRuku && isRukuEnd(state.position, currentRuku) ? "Finish ruku"
        : target.chapter !== state.position.chapter ? chapters[target.chapter - 1].name : direction === -1 ? "Back" : "Continue"
      : direction === -1 ? "The beginning" : "The final ayah";
    button.innerHTML = `${icon(direction === -1 ? "left" : "right")}<strong>${title}</strong>`;
    nav.append(button);
    if (direction === -1) {
      const position = document.createElement("span");
      position.className = "ayah-nav-position";
      position.textContent = `${state.position.verse} / ${chapters[state.position.chapter - 1].verses}`;
      const progress = document.createElement("progress");
      progress.className = "surah-progress";
      progress.max = chapters[state.position.chapter - 1].verses;
      progress.value = state.position.verse;
      progress.setAttribute("aria-label", "Surah reading progress");
      progress.setAttribute("aria-valuetext", `Ayah ${state.position.verse} of ${progress.max} in this surah`);
      position.append(progress);
      nav.append(position);
    }
  }
  if (focusedDirection) {
    nav.querySelector(`[data-direction="${focusedDirection}"]:not(:disabled)`)?.focus({ preventScroll: true });
  }
}

function renderProgressSummary() {
  const readingData = state.readingData;
  const today = getTodayStats(readingData);
  $("today-progress").textContent = `Today: ${today.completed} / ${today.target}${today.bonus ? ` · +${today.bonus} bonus` : ""}`;
  $("target-reached-label").hidden = !today.reached;
  $("target-reached-label").textContent = today.bonus ? `Target reached · +${today.bonus} bonus` : "Target reached";
  updateDocumentChrome();

  const chips = $("anchor-chips");
  chips.replaceChildren();
  const anchors = [...readingData.settings.anchors].sort((a, b) => a.time.localeCompare(b.time));
  for (const anchor of anchors) {
    const button = document.createElement("button");
    const done = anchorWasUsedToday(anchor, anchors, readingData);
    button.type = "button";
    button.className = `anchor-chip${done ? " is-done" : ""}`;
    button.textContent = `${anchor.name} · ${done ? "done" : anchor.time}`;
    button.title = done ? `A reading session happened during ${anchor.name}` : `Reading anchor at ${anchor.time}`;
    button.addEventListener("click", () => {
      if (activePage !== "reader") showPage("reader");
      $("reading-content").scrollIntoView({ block: "center", behavior: "smooth" });
    });
    chips.append(button);
  }
  chips.hidden = !anchors.length;
}

function anchorWasUsedToday(anchor, anchors, readingData) {
  const now = new Date();
  const boundary = readingData.settings.dayBoundaryHour;
  const today = getDayKey(now, boundary);
  const current = anchors.findIndex(item => item.id === anchor.id);
  if (current < 0 || !anchors.length) return false;
  const next = anchors[(current + 1) % anchors.length];
  const [year, month, day] = today.split("-").map(Number);
  const dayStart = new Date(year, month - 1, day, boundary).getTime();
  const dayEndDate = new Date(year, month - 1, day + 1, boundary);
  const dayEnd = dayEndDate.getTime();
  const occurrenceInLogicalDay = time => {
    const [hour, minute] = time.split(":").map(Number);
    const date = new Date(year, month - 1, day, hour, minute);
    if (hour < boundary) date.setDate(date.getDate() + 1);
    return date.getTime();
  };
  const start = occurrenceInLogicalDay(anchor.time);
  let end = occurrenceInLogicalDay(next.time);
  if (end <= start) end += 24 * 60 * 60 * 1000;
  end = Math.min(end, dayEnd);
  const starts = readingData.activityByDay[today]?.sessionStarts ?? [];
  return start >= dayStart && starts.some(timestamp => timestamp >= start && timestamp < end);
}

function renderRukuSummary() {
  // No suitable sourced ruku summaries are bundled, so this card stays hidden.
  $("ruku-summary").hidden = true;
}

function showPage(page) {
  activePage = page;
  $("reader-page").hidden = page !== "reader";
  for (const id of ["weekly", "settings"]) $(`${id}-page`).hidden = page !== id;
  document.querySelectorAll("[data-page]").forEach(button => {
    if (button.closest("#app-navigation")) {
      if (button.dataset.page === page) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
  $("minimal-menu").hidden = true;
  if (page === "weekly") renderWeekly();
  if (page === "settings") renderSettings();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderAllPages() {
  renderProgressSummary();
  if (activePage === "weekly") renderWeekly();
  if (activePage === "settings") renderSettings();
}

function renderWeekly() {
  const summary = getWeeklySummary(state.readingData);
  $("weekly-days-read").textContent = `Days read this week: ${summary.readDays} / 7 · ${summary.thisWeekRukus} rukus completed`;
  const max = Math.max(1, ...summary.days.map(day => day.activity?.rukuCompletions ?? 0));
  const bars = $("week-bars");
  bars.replaceChildren();
  for (const day of summary.days) {
    const count = day.activity?.rukuCompletions ?? 0;
    const row = document.createElement("div");
    row.className = "week-bar-row";
    const label = document.createElement("span");
    label.textContent = formatDateKey(day.date, { weekday: "short" });
    const track = document.createElement("span");
    track.className = "week-bar-track";
    const fill = document.createElement("span");
    fill.className = "week-bar-fill";
    fill.style.width = `${count / max * 100}%`;
    track.append(fill);
    const value = document.createElement("span");
    value.textContent = String(count);
    row.append(label, track, value);
    bars.append(row);
  }
  $("week-comparison").textContent = `This week: ${summary.thisWeekRukus} rukus · Previous week: ${summary.previousWeekRukus} rukus.`;
  const suggestedTarget = summary.readDays
    ? Math.max(1, Math.min(10, Math.round(summary.thisWeekRukus / summary.readDays)))
    : state.readingData.settings.dailyTarget;
  $("weekly-target-suggestion").textContent = `For next week, you could try ${suggestedTarget} rukus per day, or keep the target that feels right in Settings.`;
  const days = getRecentDayKeys(new Date(), state.readingData.settings.dayBoundaryHour, 84);
  const heatmap = $("heatmap");
  heatmap.replaceChildren();
  for (const day of days) {
    const count = state.readingData.activityByDay[day]?.rukuCompletions ?? 0;
    const dot = document.createElement("span");
    dot.className = `heatmap-day heat-${Math.min(4, count)}`;
    dot.title = `${formatDateKey(day)} · ${count} rukus`;
    dot.setAttribute("aria-label", dot.title);
    heatmap.append(dot);
  }
  const totals = state.readingData.totals;
  $("lifetime-totals").innerHTML = `<span><strong>${totals.rukuRead}</strong> rukus read</span><span><strong>${totals.verseRead}</strong> verses read</span><span><strong>${totals.readingDays}</strong> reading days</span>`;
}

function completeCurrentRuku(ruku) {
  const completionTime = new Date();
  const updated = recordRukuCompletion(state.readingData, ruku, completionTime);
  updateReadingData(() => updated);
  completedRuku = ruku;
  const today = getTodayStats(state.readingData, completionTime);
  const completedCount = state.readingData.completedRukuIds.length;
  const percent = completedCount === 0 || completedCount === rukus.length
    ? Math.round(completedCount / rukus.length * 100)
    : Number((completedCount / rukus.length * 100).toFixed(1));
  $("completion-title").textContent = `${chapters[ruku.chapter - 1].name} · ruku ${ruku.localNumber} complete`;
  $("completion-progress").textContent = `Overall: ${state.readingData.completedRukuIds.length} / ${rukus.length} rukus (${percent}%) · Today: ${today.completed} / ${today.target}${today.reached ? " · Target reached" : ""}${today.bonus ? ` · +${today.bonus} bonus` : ""}`;
  $("next-ruku").disabled = !rukus[ruku.id];
  $("ruku-completion").hidden = false;
  $("reading-content").hidden = true;
  $("ayah-navigation").hidden = true;
  $("navigation-hint").hidden = true;
  $("ruku-progress-wrap").hidden = true;
  $("ruku-completion").scrollIntoView({ block: "center", behavior: "smooth" });
}

function renderSettings() {
  const settings = state.readingData.settings;
  $("daily-target").value = settings.dailyTarget;
  $("day-boundary").value = String(settings.dayBoundaryHour);
  $("translation-font").value = settings.translationFont;
  $("ruku-summary-setting").value = settings.rukuSummary;
  $("resume-setting").checked = settings.resumeAtNextUnread;
  $("reminders-setting").checked = settings.remindersEnabled;
  $("listen-echo-setting").checked = settings.listenEchoEnabled;
  renderAnchorEditor();
  renderMarkReadBlock();
}

function renderAnchorEditor() {
  const container = $("anchor-editor");
  if (!container) return;
  const anchors = state.readingData.settings.anchors;
  const addButton = $("add-anchor");
  if (addButton) addButton.disabled = anchors.length >= 4;
  container.replaceChildren();
  if (!anchors.length) {
    container.textContent = "No anchors set yet. Add up to four routines that fit your day.";
    return;
  }
  for (const anchor of anchors) {
    const row = document.createElement("div");
    row.className = "anchor-editor-row";
    row.dataset.anchorId = anchor.id;
    const name = document.createElement("input");
    name.type = "text";
    name.maxLength = 40;
    name.value = anchor.name;
    name.setAttribute("aria-label", "Anchor name");
    name.dataset.anchorName = "";
    const time = document.createElement("input");
    time.type = "time";
    time.value = anchor.time;
    time.setAttribute("aria-label", `${anchor.name} time`);
    time.dataset.anchorTime = "";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet-link";
    remove.dataset.removeAnchor = anchor.id;
    remove.textContent = "Remove";
    row.append(name, time, remove);
    container.append(row);
  }
}

function updateSetting(name, value, renderPages = false) {
  updateReadingData(readingData => ({
    ...readingData,
    settings: { ...readingData.settings, [name]: value },
  }), { renderPages });
}

function initializeSettingsControls() {
  const boundary = $("day-boundary");
  boundary.replaceChildren(new Option("Midnight", 0));
  for (let hour = 1; hour < 24; hour++) {
    const label = new Date(2020, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    boundary.add(new Option(label, hour));
  }

  $("daily-target").addEventListener("change", () => {
    const value = Math.max(1, Math.min(10, Number($("daily-target").value) || 3));
    updateSetting("dailyTarget", value);
    $("daily-target").value = value;
  });
  boundary.addEventListener("change", () => updateSetting("dayBoundaryHour", Number(boundary.value)));
  $("translation-font").addEventListener("change", () => {
    updateSetting("translationFont", $("translation-font").value);
    applyPreferences();
  });
  $("ruku-summary-setting").addEventListener("change", () => updateSetting("rukuSummary", $("ruku-summary-setting").value));
  $("listen-echo-setting").addEventListener("change", () => {
    updateSetting("listenEchoEnabled", $("listen-echo-setting").checked);
    if (!$("listen-echo-setting").checked) stopVerseAudio();
    renderVerses();
  });
  $("resume-setting").addEventListener("change", () => updateSetting("resumeAtNextUnread", $("resume-setting").checked));
  $("reminders-setting").addEventListener("change", async () => {
    if (!$("reminders-setting").checked) {
      updateSetting("remindersEnabled", false);
      scheduleAnchorReminder();
      return;
    }
    if (!("Notification" in window)) {
      $("reminders-setting").checked = false;
      notify("This browser does not support notifications.");
      return;
    }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") {
      $("reminders-setting").checked = false;
      notify("Notifications were not enabled. You can still use your anchor chips.");
      return;
    }
    updateSetting("remindersEnabled", true);
    scheduleAnchorReminder();
    notify("Browser reminders are on while this tab is open.");
  });
  $("add-anchor").addEventListener("click", () => {
    const anchors = state.readingData.settings.anchors;
    if (anchors.length >= 4) return;
    const next = [...anchors, { id: `anchor-${Date.now()}`, name: `Anchor ${anchors.length + 1}`, time: "06:00" }];
    updateSetting("anchors", next);
    renderAnchorEditor();
    scheduleAnchorReminder();
  });
  $("anchor-editor").addEventListener("change", event => {
    const row = event.target.closest("[data-anchor-id]");
    if (!row) return;
    const anchors = state.readingData.settings.anchors.map(anchor => {
      if (anchor.id !== row.dataset.anchorId) return anchor;
      const name = row.querySelector("[data-anchor-name]").value.trim().slice(0, 40) || anchor.name;
      const time = row.querySelector("[data-anchor-time]").value || anchor.time;
      return { ...anchor, name, time };
    });
    updateSetting("anchors", anchors);
    renderProgressSummary();
    scheduleAnchorReminder();
  });
  $("anchor-editor").addEventListener("click", event => {
    const button = event.target.closest("[data-remove-anchor]");
    if (!button) return;
    updateSetting("anchors", state.readingData.settings.anchors.filter(anchor => anchor.id !== button.dataset.removeAnchor));
    renderAnchorEditor();
    scheduleAnchorReminder();
  });
}

function scheduleAnchorReminder() {
  clearTimeout(reminderTimer);
  const settings = state.readingData.settings;
  if (!settings.remindersEnabled || !settings.anchors.length || !("Notification" in window) || Notification.permission !== "granted") return;
  const anchors = [...settings.anchors].sort((a, b) => a.time.localeCompare(b.time));
  const now = new Date();
  const next = anchors.map(anchor => {
    const [hour, minute] = anchor.time.split(":").map(Number);
    const time = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    if (time <= now) time.setDate(time.getDate() + 1);
    return { ...anchor, fireAt: time.getTime() };
  }).sort((a, b) => a.fireAt - b.fireAt)[0];
  reminderTimer = setTimeout(() => {
    const currentAnchors = [...state.readingData.settings.anchors].sort((a, b) => a.time.localeCompare(b.time));
    if (!anchorWasUsedToday(next, currentAnchors, state.readingData)) {
      const currentRuku = findRuku(state.position, rukus);
      const chapter = chapters[state.position.chapter - 1];
      const notification = new Notification(`Next up: ${chapter.name}, ruku ${currentRuku?.localNumber ?? 1}. One ruku, whenever you’re ready.`);
      notification.onclick = () => { window.focus(); notification.close(); };
    }
    scheduleAnchorReminder();
  }, Math.min(2147483647, Math.max(0, next.fireAt - now.getTime())));
}

async function loadReading({ scroll = false } = {}) {
  const request = ++requestId;
  loading = true;
  renderChapters();
  renderHeading();
  $("ayah-navigation").hidden = true;
  $("ayah-status").hidden = true;
  $("navigation-hint").hidden = true;
  $("ruku-progress-wrap").hidden = true;
  $("ruku-completion").hidden = true;
  $("reading-content").setAttribute("aria-busy", "true");
  $("reading-content").hidden = false;
  $("reading-content").innerHTML = '<div class="loading-state"><span class="loading-dot"></span>Opening the words…</div>';
  if (scroll) window.scrollTo({ top: 0, behavior: "instant" });
  try {
    const translationId = state.translation;
    const data = await translations.load(translationId, chapters);
    if (request !== requestId) return;
    loading = false;
    renderVerses();
  } catch (error) {
    if (request !== requestId) return;
    loading = false;
    console.error("Unable to load Quran translation:", error);
    $("reading-content").setAttribute("aria-busy", "false");
    $("reading-content").innerHTML = '<div class="empty-state" role="alert"><h3>The translation couldn’t be opened.</h3><p>Check that the translation files are available, then try again.</p><button id="retry" class="primary-button">Try again</button></div>';
    $("retry").addEventListener("click", () => loadReading());
  }
}

function savePosition(position) {
  if (position.chapter !== state.position.chapter || position.verse !== state.position.verse) stopVerseAudio();
  state = reduceReaderState(state, { type: "position/set", position }, chapters);
  history.replaceState(null, "", `#${position.chapter}:${position.verse}`);
  persist();
  updateDocumentChrome();
}

function showAyah(position) {
  if (position.chapter !== state.position.chapter) {
    navigate(position.chapter, position.verse, { record: true });
    return;
  }
  savePosition(position);
  recordCurrentVerse();
  renderVerses();
  $("reading-content").scrollIntoView({ block: "nearest", behavior: "instant" });
}

function ayahTarget(direction) {
  if (loading) return null;
  return adjacentPosition(state.position, direction, chapters);
}

function moveAyah(direction) {
  const currentRuku = findRuku(state.position, rukus);
  if (direction === 1 && currentRuku && isRukuEnd(state.position, currentRuku)) {
    recordCurrentVerse();
    completeCurrentRuku(currentRuku);
    return;
  }
  const target = ayahTarget(direction);
  if (target) showAyah(target);
}

function closeMenu() {
  $("sidebar").classList.remove("is-open");
  $("sidebar").inert = matchMedia("(max-width: 760px)").matches;
  document.querySelector(".workspace").inert = false;
  $("sidebar-backdrop").hidden = true;
  $("open-menu").setAttribute("aria-expanded", "false");
  document.body.classList.remove("menu-open");
}

function navigate(chapter, verse = 1, { record = false } = {}) {
  if (activePage !== "reader") showPage("reader");
  completedRuku = null;
  savePosition({ chapter, verse });
  if (record) recordCurrentVerse();
  closeMenu();
  loadReading({ scroll: true });
}

function initializeFeatureInteractions() {
  document.addEventListener("click", event => {
    const pageButton = event.target.closest("[data-page]");
    if (pageButton) showPage(pageButton.dataset.page);
    const jump = event.target.closest("[data-jump]");
    if (jump) {
      const [chapter, verse] = jump.dataset.jump.split(":").map(Number);
      navigate(chapter, verse);
    }
    const listen = event.target.closest("[data-listen-verse]");
    if (listen) {
      const [chapter, verse] = listen.dataset.listenVerse.split(":").map(Number);
      playVerseAudio({ chapter, verse }, listen);
    }
  });

  $("next-ruku").addEventListener("click", () => {
    const next = completedRuku && rukus[completedRuku.id];
    $("ruku-completion").hidden = true;
    if (next) navigate(next.start.chapter, next.start.verse);
  });
  $("done-for-now").addEventListener("click", () => {
    $("ruku-completion").hidden = true;
    $("reading-content").hidden = false;
    completedRuku = null;
    renderVerses();
  });
  $("mark-read-btn").addEventListener("click", () => {
    const currentRuku = findRuku(state.position, rukus);
    const pending = pendingEarlierRukus();
    if (!currentRuku || pending === 0) return;
    const plural = pending === 1 ? "ruku" : "rukus";
    if (!confirm(`Mark ${pending} earlier ${plural} as read? The overall progress and the lifetime totals catch up. The daily and weekly history stays unchanged.`)) return;
    const updated = recordRukusAsRead(state.readingData, currentRuku.id, rukus);
    updateReadingData(() => updated);
    renderHeading();
    notify(`Marked ${pending} earlier ${plural} as read.`);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleAnchorReminder();
  });
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("service-worker.js", { updateViaCache: "none" })
      .then(registration => registration.update())
      .catch(error => console.warn("Offline install is unavailable:", error));
  }
}

$("chapter-list").addEventListener("click", event => {
  const button = event.target.closest("[data-chapter]");
  if (button) navigate(Number(button.dataset.chapter));
});
$("ayah-navigation").addEventListener("click", event => {
  const button = event.target.closest("[data-direction]");
  if (button) moveAyah(Number(button.dataset.direction));
});
$("chapter-search").addEventListener("input", renderChapters);

for (const [id, increment] of [["font-down", -2], ["font-up", 2]]) {
  $(id).addEventListener("click", () => {
    dispatch({ type: "font-size/adjust", delta: increment });
    applyPreferences();
  });
}
$("theme-toggle").addEventListener("click", () => {
  dispatch({ type: "theme/toggle" });
  applyPreferences();
});
$("open-menu").addEventListener("click", () => {
  $("sidebar").classList.add("is-open");
  $("sidebar").inert = false;
  document.querySelector(".workspace").inert = true;
  $("sidebar-backdrop").hidden = false;
  $("open-menu").setAttribute("aria-expanded", "true");
  document.body.classList.add("menu-open");
  $("chapter-search").focus();
});
$("close-menu").addEventListener("click", () => { closeMenu(); $("open-menu").focus(); });
$("sidebar-backdrop").addEventListener("click", closeMenu);
document.addEventListener("keydown", event => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.target.isContentEditable;
  const sidebarOpen = $("sidebar").classList.contains("is-open");
  const markShortcutsSeen = () => {
    if (!state.readingData.settings.shortcutsSeen) updateSetting("shortcutsSeen", true);
  };
  if (activePage === "reader" && ["ArrowLeft", "ArrowRight"].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !typing && !sidebarOpen) {
    event.preventDefault();
    markShortcutsSeen();
    moveAyah(event.key === "ArrowRight" ? 1 : -1);
  }
  if (activePage === "reader" && (event.key === " " || event.code === "Space") && !event.ctrlKey && !event.metaKey && !event.altKey && !typing && !["BUTTON", "A"].includes(event.target.tagName) && !sidebarOpen) {
    event.preventDefault();
    markShortcutsSeen();
    moveAyah(1);
  }
  if (event.key === "Escape") {
    if (sidebarOpen) { closeMenu(); $("open-menu").focus(); return; }
    if (event.target instanceof HTMLInputElement && event.target.value) {
      event.target.value = "";
      event.target.dispatchEvent(new Event("input"));
    } else if ($("minimal-menu").hidden) {
      $("minimal-menu").hidden = false;
      $("minimal-menu").querySelector("button:not([hidden])")?.focus();
    } else {
      $("minimal-menu").hidden = true;
    }
  }
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
    event.preventDefault();
    if (matchMedia("(max-width: 760px)").matches) $("open-menu").click();
    else $("chapter-search").focus();
  }
  if (event.key === "Tab" && $("sidebar").classList.contains("is-open")) {
    const focusable = [...$("sidebar").querySelectorAll("a, button, input")].filter(element => element.getClientRects().length);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
window.addEventListener("hashchange", () => {
  if (location.hash === "#main") return;
  const position = parseHash(location.hash, chapters);
  if (position) navigate(position.chapter, position.verse);
  else notify("That verse link isn't valid. Choose a chapter or verse to continue.");
});
window.addEventListener("pagehide", () => {
  persist();
});
matchMedia("(max-width: 760px)").addEventListener("change", closeMenu);

if (rukus.length !== DEFAULT_RUKU_COUNT) console.warn(`Expected ${DEFAULT_RUKU_COUNT} Tanzil rukus; found ${rukus.length}.`);
initializeSettingsControls();
initializeFeatureInteractions();
applyPreferences();
closeMenu();
persist();
renderProgressSummary();
renderAllPages();
loadReading();
scheduleAnchorReminder();
