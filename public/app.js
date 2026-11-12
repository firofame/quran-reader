import { TRANSLATIONS, createChapters, getVerseMetadata, getRukuProgress, parseHash, splitTranslationParagraphs, findAyah, adjacentPosition, matchesChapter, decodeState, validPosition } from "./reader.js";
import { reduceReaderState } from "./reader-state.js";
import { createPreferencesStore } from "./preferences-store.js";
import { createTranslationRepository } from "./translation-repository.js";
import { DAY_BOUNDARY_HOUR, DEFAULT_PRAYER_TIMES, DEFAULT_RUKU_COUNT, PRAYERS, findRuku, formatCountdown, getDayKey, getNextPrayerMoment, getPrayerSchedule, getRukuIndex, getTodayStats, isRukuEnd, recordRukuCompletion, recordRukusAsRead, recordVerseVisit, resolveStartupPosition } from "./reading-data.js";

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
let reminderTimer;
let countdownTimer;
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
  updateReadingData(readingData => recordVerseVisit(readingData, state.position, new Date()), { renderPages: false });
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
  $("reading-history-card").hidden = pendingEarlier === 0;
  $("mark-read-btn").textContent = `Mark ${pendingEarlier} earlier ruku${pendingEarlier === 1 ? "" : "s"} as read`;
}

function setAudioButtonState(button, status) {
  const [chapter, verse] = button.dataset.listenVerse.split(":");
  const labels = {
    play: `Play recitation for verse ${chapter}:${verse}`,
    pause: `Pause recitation for verse ${chapter}:${verse}`,
    loading: `Loading recitation for verse ${chapter}:${verse}`,
  };
  const iconPath = status === "pause"
    ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${iconPath}</svg>`;
  button.setAttribute("aria-label", labels[status]);
  button.title = labels[status];
  button.disabled = status === "loading";
}

function stopVerseAudio() {
  audioRequestId++;
  const audio = $("verse-audio");
  if (!audio) return;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (activeAudioButton?.isConnected) {
    setAudioButtonState(activeAudioButton, "play");
  }
  activeAudioButton = null;
}

function finishVersePlayback(request) {
  if (request !== audioRequestId) return;
  if (activeAudioButton?.isConnected) setAudioButtonState(activeAudioButton, "play");
  activeAudioButton = null;
}

function playVerseAudio(position, button) {
  const audio = $("verse-audio");
  const chapter = chapters[position.chapter - 1];
  // Tanzil's chapter start is zero-based, while the audio CDN expects a
  // one-based global ayah number (for example, 2:254 is ayah 261).
  const ayahNumber = chapter.start + position.verse;
  const source = `https://cdn.islamic.network/quran/audio/128/ar.alafasy/${ayahNumber}.mp3`;
  stopVerseAudio();
  const request = ++audioRequestId;
  activeAudioButton = button;
  setAudioButtonState(button, "loading");
  audio.src = source;
  audio.currentTime = 0;
  audio.onended = () => {
    if (request !== audioRequestId) return;
    finishVersePlayback(request);
  };
  audio.onerror = () => {
    if (request !== audioRequestId) return;
    finishVersePlayback(request);
  };
  audio.play().then(() => {
    if (request !== audioRequestId) return;
    if (activeAudioButton?.isConnected) {
      setAudioButtonState(activeAudioButton, "pause");
    }
  }).catch(error => {
    if (request !== audioRequestId) return;
    console.warn("Unable to play the selected recitation:", error);
    finishVersePlayback(request);
    notify("The recitation could not be opened. Check your connection and try again.");
  });
}

function toggleVerseAudio(position, button) {
  const audio = $("verse-audio");
  if (activeAudioButton !== button) {
    playVerseAudio(position, button);
    return;
  }
  if (!audio.paused) {
    audio.pause();
    setAudioButtonState(button, "play");
    return;
  }
  const request = audioRequestId;
  setAudioButtonState(button, "loading");
  audio.play().then(() => {
    if (request === audioRequestId && activeAudioButton === button) setAudioButtonState(button, "pause");
  }).catch(error => {
    if (request !== audioRequestId || activeAudioButton !== button) return;
    console.warn("Unable to resume the selected recitation:", error);
    finishVersePlayback(request);
    notify("The recitation could not be opened. Check your connection and try again.");
  });
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
// A browser reload or explicit verse link should keep the visible ayah.
const startup = resolveStartupPosition({
  hashPosition: initialPosition,
  savedPosition: state.position,
});
if (startup.source === "link") {
  state = reduceReaderState(state, { type: "position/set", position: startup.position }, chapters);
} else if (location.hash && location.hash !== "#main" && !initialPosition) {
  notify("That verse link isn't valid. Your last reading position has been opened.");
}

function applyPreferences() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.setProperty("--reading-size", `${state.fontSize}px`);
  $("theme-toggle").innerHTML = icon(state.theme === "dark" ? "sun" : "moon");
  $("theme-toggle").setAttribute("aria-label", `Switch to ${state.theme === "dark" ? "light" : "dark"} theme`);
  $("font-down").disabled = state.fontSize <= 17;
  $("font-up").disabled = state.fontSize >= 29;
  document.querySelector('meta[name="theme-color"]').content = state.theme === "dark" ? "#191e1b" : "#f8f6ef";
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
  $("chapter-heading").innerHTML = `<div class="chapter-heading-title"><h1>${chapter.id}. ${chapter.name}</h1><span class="sr-only">${chapter.meaning} · ${chapter.verses} ayahs · ${chapter.origin}</span></div><div class="chapter-heading-meta"><p class="chapter-meta-line"><span id="reading-metadata" class="reading-metadata" role="group" aria-label="Current ayah metadata" hidden></span></p></div>`;
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
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "reading-metadata-separator";
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "·";
      container.append(separator);
    }
    container.append(part);
  }
  container.hidden = parts.length === 0;
}

function createVerse(verse) {
  const article = document.createElement("article");
  article.className = "verse";
  article.id = `verse-${verse.chapter}-${verse.verse}`;
  article.dataset.chapter = verse.chapter;
  article.dataset.verse = verse.verse;
  const reference = document.createElement("div");
  reference.className = "verse-reference";
  const number = document.createElement("a");
  number.className = "verse-number";
  number.textContent = `${verse.chapter}:${verse.verse}`;
  number.href = `#${verse.chapter}:${verse.verse}`;
  number.setAttribute("aria-label", `Link to verse ${verse.chapter}:${verse.verse}`);
  const actions = document.createElement("div");
  actions.className = "verse-audio-action";
  const listen = document.createElement("button");
  listen.type = "button";
  listen.dataset.listenVerse = `${verse.chapter}:${verse.verse}`;
  setAudioButtonState(listen, "play");
  actions.append(listen);
  reference.append(number, actions);
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
  article.append(reference, textContainer);
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
  $("today-completed").textContent = today.completed;
  $("today-target").textContent = today.target;
  $("today-bonus").textContent = today.bonus ? ` · +${today.bonus} bonus` : "";
  $("target-reached-label").hidden = !today.reached;
  $("target-reached-label").textContent = today.bonus ? `Target reached · +${today.bonus} bonus` : "Target reached";
  updateDocumentChrome();
}

/**
 * Places every prayer of the current reading day on the clock, from its adhan
 * to the adhan of the next prayer, and records whether the reader read during
 * it.
 */
function prayerWindows(prayers, readingData, date = new Date()) {
  const boundary = DAY_BOUNDARY_HOUR;
  const today = getDayKey(date);
  const [year, month, day] = today.split("-").map(Number);
  const dayStart = new Date(year, month - 1, day, boundary).getTime();
  const dayEnd = new Date(year, month - 1, day + 1, boundary).getTime();
  const occurrence = time => {
    const [hour, minute] = time.split(":").map(Number);
    const value = new Date(year, month - 1, day, hour, minute);
    if (hour < boundary) value.setDate(value.getDate() + 1);
    return value.getTime();
  };
  const sessions = readingData.activityByDay[today]?.sessionStarts ?? [];
  return prayers.map((prayer, index) => {
    const next = prayers[(index + 1) % prayers.length];
    const start = occurrence(prayer.adhan);
    let end = occurrence(next.adhan);
    if (end <= start) end += 24 * 60 * 60 * 1000;
    return {
      ...prayer,
      start,
      end: Math.min(end, dayEnd),
      read: start >= dayStart && sessions.some(timestamp => timestamp >= start && timestamp < end),
    };
  });
}

function showPage(page) {
  activePage = page;
  $("reader-page").hidden = page !== "reader";
  $("settings-page").hidden = page !== "settings";
  document.querySelectorAll("[data-page]").forEach(button => {
    if (button.closest("#app-navigation")) {
      if (button.dataset.page === page) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
  $("minimal-menu").hidden = true;
  if (page === "settings") renderSettings();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderAllPages() {
  renderProgressSummary();
  if (activePage === "settings") renderSettings();
}

function completeCurrentRuku(ruku) {
  const updated = recordRukuCompletion(state.readingData, ruku, new Date());
  updateReadingData(() => updated);
  const next = rukus[ruku.id];
  if (next) navigate(next.start.chapter, next.start.verse);
}

function renderSettings() {
  const settings = state.readingData.settings;
  $("reminders-setting").checked = settings.remindersEnabled;
  renderPrayerEditor();
  renderMarkReadBlock();
}

/**
 * Lists the five daily prayers with their adhan and iqama times. The prayers
 * are fixed, so only the times of each one can be changed.
 */
function renderPrayerEditor() {
  const container = $("prayer-editor");
  if (!container) return;
  const times = state.readingData.settings.prayerTimes;
  container.replaceChildren();
  const head = document.createElement("div");
  head.className = "prayer-editor-head";
  for (const label of ["Prayer", "Adhan", "Iqama"]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    head.append(cell);
  }
  container.append(head);
  for (const prayer of PRAYERS) {
    const saved = times[prayer.id] ?? DEFAULT_PRAYER_TIMES[prayer.id];
    const row = document.createElement("div");
    row.className = "prayer-editor-row";
    row.dataset.prayerId = prayer.id;
    const name = document.createElement("span");
    name.className = "prayer-editor-name";
    name.textContent = prayer.name;
    row.append(name);
    for (const [field, attribute] of [["adhan", "prayerAdhan"], ["iqama", "prayerIqama"]]) {
      const time = document.createElement("input");
      time.type = "time";
      time.value = saved[field] ?? "";
      time.setAttribute("aria-label", `${prayer.name} ${field} time`);
      time.dataset[attribute] = "";
      row.append(time);
    }
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
  $("reminders-setting").addEventListener("change", async () => {
    if (!$("reminders-setting").checked) {
      updateSetting("remindersEnabled", false);
      schedulePrayerReminder();
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
      notify("Notifications were not enabled. You can still use your prayer chips.");
      return;
    }
    updateSetting("remindersEnabled", true);
    schedulePrayerReminder();
    notify("Browser reminders are on while this tab is open.");
  });
  $("prayer-editor").addEventListener("change", event => {
    const row = event.target.closest("[data-prayer-id]");
    if (!row) return;
    const prayerId = row.dataset.prayerId;
    const field = event.target.matches("[data-prayer-adhan]") ? "adhan" : "iqama";
    const time = event.target.value;
    if (!time) return;
    const current = state.readingData.settings.prayerTimes[prayerId] ?? DEFAULT_PRAYER_TIMES[prayerId];
    updateSetting("prayerTimes", {
      ...state.readingData.settings.prayerTimes,
      [prayerId]: { ...current, [field]: time },
    });
    schedulePrayerReminder();
  });
}

/** Keeps the countdown to the next prayer moment up to date. */
function startPrayerCountdown() {
  clearInterval(countdownTimer);
  renderPrayerCountdown();
  countdownTimer = setInterval(renderPrayerCountdown, 1000);
}

/**
 * Counts down to the next adhan or iqama, so the time left until the iqama
 * is always in sight.
 */
function renderPrayerCountdown() {
  const container = $("prayer-countdown");
  if (!container) return;
  const next = getNextPrayerMoment(getPrayerSchedule(state.readingData), new Date());
  if (!next) {
    container.hidden = true;
    return;
  }
  const name = container.querySelector(".prayer-countdown-name");
  const detail = container.querySelector(".prayer-countdown-detail");
  const time = container.querySelector(".prayer-countdown-time");
  const remaining = formatCountdown(next.at - Date.now());
  if (name.textContent !== next.name) name.textContent = next.name;
  if (detail.textContent !== `${next.kind} in`) detail.textContent = `${next.kind} in`;
  if (time.textContent !== remaining) time.textContent = remaining;
  container.hidden = false;
}

function schedulePrayerReminder() {
  clearTimeout(reminderTimer);
  const settings = state.readingData.settings;
  if (!settings.remindersEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
  const prayers = getPrayerSchedule(state.readingData);
  const now = new Date();
  const next = getNextPrayerMoment(prayers, now);
  if (!next) return;
  reminderTimer = setTimeout(() => {
    const currentPrayers = getPrayerSchedule(state.readingData);
    const slot = prayerWindows(currentPrayers, state.readingData).find(item => item.id === next.id);
    const currentRuku = findRuku(state.position, rukus);
    const chapter = chapters[state.position.chapter - 1];
    const message = next.kind === "adhan"
      ? `${next.name} adhan at ${next.adhan}. Next up: ${chapter.name}, ruku ${currentRuku?.localNumber ?? 1}. One ruku, whenever you’re ready.`
      : `${next.name} iqama at ${next.iqama}. Time to head to the masjid.`;
    // The iqama nudge is about reaching the masjid, so it always fires. The
    // adhan nudge waits for the prayer window when the reader already read.
    if (next.kind === "iqama" || !(slot?.read ?? false)) {
      const notification = new Notification(message);
      notification.onclick = () => { window.focus(); notification.close(); };
    }
    schedulePrayerReminder();
  }, Math.min(2147483647, Math.max(0, next.at - now.getTime())));
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
  if (position.chapter !== state.position.chapter || position.verse !== state.position.verse) {
    stopVerseAudio();
  }
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
      toggleVerseAudio({ chapter, verse }, listen);
    }
  });

  $("mark-read-btn").addEventListener("click", () => {
    const currentRuku = findRuku(state.position, rukus);
    const pending = pendingEarlierRukus();
    if (!currentRuku || pending === 0) return;
    const plural = pending === 1 ? "ruku" : "rukus";
    if (!confirm(`Mark ${pending} earlier ${plural} as read? The overall progress and the lifetime totals catch up. Daily activity stays unchanged.`)) return;
    const updated = recordRukusAsRead(state.readingData, currentRuku.id, rukus);
    updateReadingData(() => updated);
    renderHeading();
    notify(`Marked ${pending} earlier ${plural} as read.`);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      schedulePrayerReminder();
      renderPrayerCountdown();
    }
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
schedulePrayerReminder();
startPrayerCountdown();
