import { TRANSLATIONS, createChapters, getVerseMetadata, getRukuProgress, parseHash, selectAyah, adjacentPosition, matchesChapter, decodeState, validPosition } from "./reader.js";
import { reduceReaderState } from "./reader-state.js";
import { createPreferencesStore } from "./preferences-store.js";
import { createTranslationRepository } from "./translation-repository.js";
import { createSyncClient, generateSyncKey, normalizeEndpoint } from "./sync-client.js";

const icons = {
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  moon: '<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="2" fill="var(--paper)"/><circle cx="16" cy="17" r="2" fill="var(--paper)"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  left: '<path d="m14 6-6 6 6 6M8 12h12"/>',
  right: '<path d="m10 6 6 6-6 6M16 12H4"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m11.5 11.5 8.5-8.5M16 7l2 2M18 5l2 2"/>',
};
const $ = id => document.getElementById(id);
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ""}</svg>`;
document.querySelectorAll("[data-icon]").forEach(element => { element.innerHTML = icon(element.dataset.icon); });

const chapters = createChapters(globalThis.QuranData.Sura);
const preferences = createPreferencesStore({
  getItem: key => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
}, chapters);
const translations = createTranslationRepository();
let state;
let requestId = 0;
let noticeTimer;
let storageFailed = false;
let loading = false;

const syncClient = createSyncClient({
  storage: {
    getItem: key => {
      try { return globalThis.localStorage.getItem(key); } catch { return null; }
    },
    setItem: (key, value) => {
      try { globalThis.localStorage.setItem(key, value); } catch {}
    },
    removeItem: key => {
      try { globalThis.localStorage.removeItem(key); } catch {}
    },
  },
  onRemoteUpdate(data) {
    let stateChanged = false;
    let positionChanged = false;
    let translationChanged = false;

    if (data.chapter && data.verse && (data.chapter !== state.position.chapter || data.verse !== state.position.verse)) {
      if (validPosition({ chapter: data.chapter, verse: data.verse }, chapters)) {
        state = reduceReaderState(state, { type: "position/set", position: { chapter: data.chapter, verse: data.verse } }, chapters);
        stateChanged = true;
        positionChanged = true;
      }
    }
    if (data.translation && data.translation !== state.translation && Object.hasOwn(TRANSLATIONS, data.translation)) {
      state = reduceReaderState(state, { type: "translation/set", translation: data.translation }, chapters);
      stateChanged = true;
      translationChanged = true;
    }

    if (stateChanged) {
      persist();
      applyPreferences();
      history.replaceState(null, "", `#${state.position.chapter}:${state.position.verse}`);
      loadReading();
      if (positionChanged) {
        notify(`Synced with cloud: opened verse ${state.position.chapter}:${state.position.verse}.`);
      } else if (translationChanged) {
        notify("Synced with cloud: translation updated.");
      }
    }
  },
  onStatusChange(statusInfo) {
    renderSyncUI(statusInfo);
  },
});

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

function dispatch(action) {
  state = reduceReaderState(state, action, chapters);
  persist();
  syncClient.queuePush(state);
}

const initialPosition = parseHash(location.hash, chapters);
if (initialPosition) state = reduceReaderState(state, { type: "position/set", position: initialPosition }, chapters);
else if (location.hash && location.hash !== "#main") notify("That verse link isn't valid. Your last reading position has been opened.");

function applyPreferences() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.setProperty("--reading-size", `${state.fontSize}px`);
  $("translation").value = state.translation;
  $("theme-toggle").innerHTML = icon(state.theme === "dark" ? "sun" : "moon");
  $("theme-toggle").setAttribute("aria-label", `Switch to ${state.theme === "dark" ? "light" : "dark"} theme`);
  $("font-down").disabled = state.fontSize <= 17;
  $("font-up").disabled = state.fontSize >= 29;
  document.querySelector('meta[name="theme-color"]').content = state.theme === "dark" ? "#191e1b" : "#f8f7f2";
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
  $("reading-metadata").hidden = true;
  $("reading-metadata").replaceChildren();
  const chapter = chapters[state.position.chapter - 1];
  $("chapter-heading").innerHTML = `<div><h1>${chapter.id}. ${chapter.name}</h1><p>${chapter.meaning} · ${chapter.verses} ayahs<span class="sr-only"> · ${chapter.origin}</span></p></div><span class="chapter-arabic" lang="ar" dir="rtl">${chapter.arabic}</span>`;
  document.title = `${chapter.name} — The Quran`;
  const jumpOptions = Array.from({ length: chapter.verses }, (_, index) => new Option(index + 1, index + 1));
  $("verse-jump").replaceChildren(...jumpOptions);
  $("verse-jump").value = state.position.verse;
  $("jump-control").hidden = Boolean($("verse-search").value.trim());
  $("verse-search").placeholder = "Search in this chapter…";
  $("verse-search").setAttribute("aria-label", "Search verses in this chapter");
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
  const query = $("verse-search").value.trim();
  const verses = data[state.position.chapter - 1];
  const selection = selectAyah(verses, state.position.verse, query);
  const filtered = selection.ayah ? [selection.ayah] : [];
  const chapter = chapters[state.position.chapter - 1];
  renderReadingMetadata(selection.ayah);
  if (selection.ayah) {
    $("verse-jump").value = state.position.verse;
    document.title = `${chapter.name} ${chapter.id}:${state.position.verse} — The Quran`;
  }
  $("reading-content").classList.add("focused");
  $("reading-content").setAttribute("aria-live", "polite");
  $("ayah-status").hidden = !selection.ayah;
  $("ayah-status").textContent = `AYAH ${state.position.verse} OF ${chapter.verses}`;
  $("ruku-progress").hidden = !selection.ayah;
  if (selection.ayah) {
    const progress = getRukuProgress(selection.ayah, globalThis.QuranData, chapters);
    $("ruku-progress").max = progress.max;
    $("ruku-progress").value = progress.value;
    $("ruku-progress").setAttribute("aria-valuetext", `Ayah ${progress.value} of ${progress.max} in this ruku`);
  }
  const fragment = document.createDocumentFragment();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `${icon("search")}<h3>No verses found</h3><p>Try a different word or clear your search.</p>`;
    fragment.append(empty);
  }
  for (const verse of filtered) fragment.append(createVerse(verse));
  $("reading-content").replaceChildren(fragment);
  $("reading-content").setAttribute("aria-busy", "false");
  $("search-count").hidden = !query;
  $("search-count").textContent = selection.ayah
    ? `${selection.index + 1} of ${selection.matches.length} matches`
    : `${selection.matches.length} ${selection.matches.length === 1 ? "verse" : "verses"}`;
  $("active-search").hidden = !query;
  $("active-search-label").textContent = query ? `Search: “${query}” · ${$("search-count").textContent}` : "";
  $("jump-control").hidden = Boolean(query);
  renderPagination(selection);
}

function renderReadingMetadata(verse) {
  const container = $("reading-metadata");
  container.replaceChildren();
  if (!verse) {
    container.hidden = true;
    return;
  }

  const metadata = getVerseMetadata(verse, globalThis.QuranData);
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
    container.append(item);
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
    container.append(item);
  }
  container.hidden = false;
}

function createVerse(verse) {
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
  const text = document.createElement("p");
  text.lang = TRANSLATIONS[state.translation].language;
  text.textContent = verse.text;
  textContainer.append(text);
  article.append(number, textContainer);
  return article;
}

function renderPagination(selection) {
  const nav = $("ayah-navigation");
  const focusedDirection = document.activeElement?.getAttribute("data-direction");
  const searching = Boolean($("verse-search").value.trim());
  nav.hidden = !selection.ayah;
  $("navigation-hint").hidden = nav.hidden;
  nav.replaceChildren();
  if (nav.hidden) return;
  for (const direction of [-1, 1]) {
    const target = searching
      ? selection.matches[selection.index + direction]
      : adjacentPosition(state.position, direction, chapters);
    const button = document.createElement("button");
    button.className = direction === -1 ? "pagination-button previous" : "pagination-button next";
    button.disabled = !target;
    button.dataset.direction = direction;
    button.setAttribute("aria-label", direction === -1 ? "Previous ayah" : "Next ayah");
    const title = target
      ? target.chapter !== state.position.chapter ? chapters[target.chapter - 1].name : direction === -1 ? "Back" : "Continue"
      : searching ? "No more matches" : direction === -1 ? "The beginning" : "The final ayah";
    button.innerHTML = `${icon(direction === -1 ? "left" : "right")}<strong>${title}</strong>`;
    nav.append(button);
    if (direction === -1) {
      const position = document.createElement("span");
      position.className = "ayah-nav-position";
      position.textContent = searching
        ? `${selection.index + 1} / ${selection.matches.length}`
        : `${state.position.verse} / ${chapters[state.position.chapter - 1].verses}`;
      nav.append(position);
    }
  }
  if (focusedDirection) {
    nav.querySelector(`[data-direction="${focusedDirection}"]:not(:disabled)`)?.focus({ preventScroll: true });
  }
}

async function loadReading({ scroll = false } = {}) {
  const request = ++requestId;
  loading = true;
  renderChapters();
  renderHeading();
  $("ayah-navigation").hidden = true;
  $("ayah-status").hidden = true;
  $("active-search").hidden = true;
  $("navigation-hint").hidden = true;
  $("ruku-progress").hidden = true;
  $("reading-content").setAttribute("aria-busy", "true");
  $("reading-content").innerHTML = '<div class="loading-state"><span class="loading-dot"></span>Opening the words…</div>';
  if (scroll) window.scrollTo({ top: 0, behavior: "instant" });
  try {
    const translationId = state.translation;
    const data = await translations.load(translationId, chapters);
    if (request !== requestId) return;
    loading = false;
    synchronizeSearchPosition(data);
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
  state = reduceReaderState(state, { type: "position/set", position }, chapters);
  history.replaceState(null, "", `#${position.chapter}:${position.verse}`);
  persist();
  syncClient.queuePush(state);
}

function synchronizeSearchPosition(data) {
  const query = $("verse-search").value.trim();
  if (!query) return;
  const selection = selectAyah(data[state.position.chapter - 1], state.position.verse, query);
  if (selection.ayah && selection.ayah.verse !== state.position.verse) {
    savePosition({ chapter: state.position.chapter, verse: selection.ayah.verse });
  }
}

function showAyah(position) {
  if (position.chapter !== state.position.chapter) {
    navigate(position.chapter, position.verse);
    return;
  }
  savePosition(position);
  renderVerses();
  $("reading-content").scrollIntoView({ block: "nearest", behavior: "instant" });
}

function ayahTarget(direction) {
  if (loading) return null;
  const data = translations.getLoaded(state.translation);
  if (!data) return null;
  const query = $("verse-search").value.trim();
  const selection = selectAyah(data[state.position.chapter - 1], state.position.verse, query);
  if (!selection.ayah) return null;
  return query
    ? selection.matches[selection.index + direction]
    : adjacentPosition(state.position, direction, chapters);
}

function moveAyah(direction) {
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

function navigate(chapter, verse = 1) {
  savePosition({ chapter, verse });
  $("verse-search").value = "";
  $("reading-controls").open = false;
  closeMenu();
  loadReading({ scroll: true });
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
$("verse-search").addEventListener("input", () => {
  if (loading) return;
  const data = translations.getLoaded(state.translation);
  if (data) synchronizeSearchPosition(data);
  renderVerses();
});
$("clear-search").addEventListener("click", () => {
  $("verse-search").value = "";
  if (!loading) renderVerses();
  $("reading-controls").querySelector("summary").focus({ preventScroll: true });
});
$("verse-jump").addEventListener("change", () => {
  $("reading-controls").open = false;
  showAyah({ chapter: state.position.chapter, verse: Number($("verse-jump").value) });
  $("reading-controls").querySelector("summary").focus({ preventScroll: true });
});
$("translation").addEventListener("change", () => {
  dispatch({ type: "translation/set", translation: $("translation").value });
  loadReading();
});

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
  if (["ArrowLeft", "ArrowRight"].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) && !event.target.isContentEditable &&
    !$("sidebar").classList.contains("is-open")) {
    event.preventDefault();
    moveAyah(event.key === "ArrowRight" ? 1 : -1);
  }
  if (event.key === "Escape") {
    if ($("sidebar").classList.contains("is-open")) { closeMenu(); $("open-menu").focus(); }
    if (event.target instanceof HTMLInputElement && event.target.value) {
      event.target.value = "";
      event.target.dispatchEvent(new Event("input"));
    } else if ($("reading-controls").open) {
      $("reading-controls").open = false;
      $("reading-controls").querySelector("summary").focus({ preventScroll: true });
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
window.addEventListener("pagehide", persist);
matchMedia("(max-width: 760px)").addEventListener("change", closeMenu);

function renderSyncUI(statusInfo = syncClient.getStatus()) {
  const badge = $("sync-badge");
  const quickBtn = $("sync-quick-btn");
  const nowBtn = $("sync-now-btn");
  const disconnectBtn = $("sync-disconnect-btn");
  const message = $("sync-message");
  const endpointInput = $("sync-endpoint");
  const keyInput = $("sync-key");
  const copyBtn = $("copy-sync-key");
  const config = syncClient.getConfig();

  if (document.activeElement !== endpointInput) {
    endpointInput.value = config.endpoint || "";
  }
  if (document.activeElement !== keyInput) {
    keyInput.value = config.syncKey || "";
  }
  copyBtn.disabled = !keyInput.value.trim();

  const configured = syncClient.isConfigured();
  quickBtn.hidden = !configured;
  nowBtn.hidden = !configured;
  disconnectBtn.hidden = !configured;

  badge.className = "sync-badge";
  switch (statusInfo.status) {
    case "synced":
      badge.textContent = "Synced";
      badge.classList.add("is-synced");
      break;
    case "syncing":
      badge.textContent = "Syncing…";
      badge.classList.add("is-syncing");
      break;
    case "error":
      badge.textContent = "Error";
      badge.classList.add("is-error");
      break;
    case "offline":
      badge.textContent = "Offline";
      badge.classList.add("is-offline");
      break;
    default:
      badge.textContent = configured ? "Idle" : "Off";
      break;
  }

  message.className = `sync-message${statusInfo.status === "error" ? " is-error" : ""}`;
  if (statusInfo.message) {
    message.textContent = statusInfo.message;
  } else if (configured) {
    if (statusInfo.lastSyncedAt) {
      const date = new Date(statusInfo.lastSyncedAt);
      const timeStr = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      message.textContent = `Last synced at ${timeStr} · Chapter ${state.position.chapter}:${state.position.verse}`;
    } else {
      message.textContent = "Connected. Ready to sync with cloud.";
    }
  } else {
    message.textContent = "Sync is off. Enter a Worker URL and private pairing key, then choose Save & connect. No reading data is sent before then.";
  }
}

function initSyncUI() {
  const toggleBtn = $("sync-toggle-panel");
  const details = $("sync-details");
  const quickBtn = $("sync-quick-btn");
  const nowBtn = $("sync-now-btn");
  const generateBtn = $("generate-sync-key");
  const copyBtn = $("copy-sync-key");
  const toggleKeyBtn = $("toggle-sync-key");
  const keyInput = $("sync-key");
  const endpointInput = $("sync-endpoint");
  const form = $("sync-form");
  const disconnectBtn = $("sync-disconnect-btn");

  toggleBtn.addEventListener("click", () => {
    const isHidden = details.hidden;
    details.hidden = !isHidden;
    toggleBtn.setAttribute("aria-expanded", String(isHidden));
    toggleBtn.textContent = isHidden ? "Close" : "Configure";
    if (isHidden) {
      if (!endpointInput.value) endpointInput.focus();
      else if (!keyInput.value) keyInput.focus();
    }
  });

  const triggerSync = async () => {
    quickBtn.disabled = true;
    nowBtn.disabled = true;
    try {
      await syncClient.sync(state);
    } finally {
      quickBtn.disabled = false;
      nowBtn.disabled = false;
    }
  };

  quickBtn.addEventListener("click", triggerSync);
  nowBtn.addEventListener("click", triggerSync);

  generateBtn.addEventListener("click", () => {
    try {
      keyInput.value = generateSyncKey();
      keyInput.type = "text";
      copyBtn.disabled = false;
      keyInput.focus();
      $("sync-message").className = "sync-message";
      $("sync-message").textContent = "Key generated. Copy it and enter the same key on your other devices.";
    } catch (error) {
      $("sync-message").className = "sync-message is-error";
      $("sync-message").textContent = error.message || "Could not generate a secure pairing key.";
    }
  });

  copyBtn.addEventListener("click", async () => {
    const syncKey = keyInput.value.trim();
    if (!syncKey) return;
    if (!navigator.clipboard?.writeText) {
      $("sync-message").className = "sync-message is-error";
      $("sync-message").textContent = "Clipboard access is unavailable. Select and copy the key manually.";
      return;
    }
    try {
      await navigator.clipboard.writeText(syncKey);
      $("sync-message").className = "sync-message";
      $("sync-message").textContent = "Pairing key copied. Keep it private; anyone with it can access your synced data.";
    } catch {
      $("sync-message").className = "sync-message is-error";
      $("sync-message").textContent = "Could not copy the key. Select and copy it manually.";
    }
  });

  keyInput.addEventListener("input", () => {
    copyBtn.disabled = !keyInput.value.trim();
  });

  toggleKeyBtn.addEventListener("click", () => {
    const isPassword = keyInput.type === "password";
    keyInput.type = isPassword ? "text" : "password";
    toggleKeyBtn.setAttribute("aria-label", isPassword ? "Hide pairing key" : "Show pairing key");
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const endpoint = endpointInput.value.trim();
    const syncKey = keyInput.value.trim();

    if (!endpoint) {
      $("sync-message").textContent = "Please enter your Cloudflare Worker URL.";
      $("sync-message").className = "sync-message is-error";
      endpointInput.focus();
      return;
    }

    const normalizedEndpoint = normalizeEndpoint(endpoint);
    if (!normalizedEndpoint) {
      $("sync-message").textContent = "Please enter a valid HTTPS Worker URL (HTTP allowed only for localhost).";
      $("sync-message").className = "sync-message is-error";
      endpointInput.focus();
      return;
    }

    if (!syncKey) {
      $("sync-message").textContent = "Please generate or enter a private pairing key.";
      $("sync-message").className = "sync-message is-error";
      keyInput.focus();
      return;
    }

    syncClient.updateConfig({ endpoint: normalizedEndpoint, syncKey, autoSync: true });
    renderSyncUI();
    await triggerSync();
  });

  disconnectBtn.addEventListener("click", () => {
    syncClient.clearConfig();
    endpointInput.value = "";
    keyInput.value = "";
    renderSyncUI();
    notify("Cloud sync disconnected. Your progress is saved locally.");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && syncClient.isConfigured()) {
      syncClient.sync(state);
    }
  });

  window.addEventListener("online", () => {
    if (syncClient.isConfigured()) {
      syncClient.sync(state);
    }
  });

  renderSyncUI();
  if (syncClient.isConfigured()) {
    syncClient.sync(state);
  }
}

applyPreferences();
closeMenu();
persist();
loadReading();
initSyncUI();
