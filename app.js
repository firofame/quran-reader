import { TRANSLATIONS, createChapters, parseTranslation, parseHash, selectAyah, adjacentPosition, matchesChapter, decodeState } from "./reader.js";

const icons = {
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  moon: '<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  left: '<path d="m14 6-6 6 6 6M8 12h12"/>',
  right: '<path d="m10 6 6 6-6 6M16 12H4"/>',
};
const $ = id => document.getElementById(id);
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
document.querySelectorAll("[data-icon]").forEach(element => { element.innerHTML = icon(element.dataset.icon); });

const chapters = createChapters(globalThis.QuranData.Sura);
const cache = new Map();
const storageKey = "quran-reader:v1";
let state;
let view = "read";
let requestId = 0;
let noticeTimer;
let storageFailed = false;
let loading = false;

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
  state = decodeState(localStorage.getItem(storageKey), chapters);
} catch (error) {
  console.error("Unable to read saved Quran reader preferences:", error);
  state = decodeState(null, chapters);
  notify("Your saved preferences could not be read. Default preferences have been restored.", true);
}

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch (error) {
    if (!storageFailed) {
      console.error("Unable to save Quran reader preferences:", error);
      notify("Browser storage is unavailable. Your reading progress and bookmarks won't be saved.", true);
      storageFailed = true;
    }
  }
}

const initialPosition = parseHash(location.hash, chapters);
if (initialPosition) state.position = initialPosition;
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

function updateTabs() {
  const reading = view === "read";
  $("read-tab").classList.toggle("active", reading);
  $("saved-tab").classList.toggle("active", !reading);
  $("read-tab").toggleAttribute("aria-current", reading);
  $("saved-tab").toggleAttribute("aria-current", !reading);
  if (reading) $("read-tab").setAttribute("aria-current", "page");
  else $("saved-tab").setAttribute("aria-current", "page");
  $("saved-count").textContent = state.bookmarks.length;
}

function renderHeading() {
  const chapter = chapters[state.position.chapter - 1];
  if (view === "saved") {
    $("chapter-heading").innerHTML = `<div><span class="eyebrow">KEEP THE WORDS CLOSE</span><h2>Saved verses</h2><p>A collection to come back to.</p></div><span class="heading-symbol">${icon("bookmark")}</span>`;
    document.title = "Saved verses — The Quran";
  } else {
    $("chapter-heading").innerHTML = `<div><span class="eyebrow">CHAPTER ${String(chapter.id).padStart(2, "0")} <span class="meta-dot">·</span> ${chapter.origin.toUpperCase()} <span class="meta-dot">·</span> ${chapter.verses} VERSES</span><h2>${chapter.name}</h2><p>${chapter.meaning}</p></div><span class="chapter-arabic" lang="ar" dir="rtl">${chapter.arabic}</span>`;
    document.title = `${chapter.name} — The Quran`;
  }
  const jumpOptions = Array.from({ length: chapter.verses }, (_, index) => new Option(index + 1, index + 1));
  $("verse-jump").replaceChildren(...jumpOptions);
  $("verse-jump").value = state.position.verse;
  $("jump-control").hidden = view !== "read";
  $("verse-search").placeholder = view === "read" ? "Search in this chapter…" : "Search saved verses…";
  $("verse-search").setAttribute("aria-label", view === "read" ? "Search verses in this chapter" : "Search saved verses");
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

function isBookmarked(chapter, verse) {
  return state.bookmarks.some(item => item.chapter === chapter && item.verse === verse);
}

function renderVerses() {
  const data = cache.get(state.translation);
  if (!data) return;
  const query = $("verse-search").value.trim();
  const verses = view === "read"
    ? data[state.position.chapter - 1]
    : state.bookmarks.map(item => data[item.chapter - 1][item.verse - 1]);
  const selection = selectAyah(verses, state.position.verse, query);
  const filtered = view === "read" ? (selection.ayah ? [selection.ayah] : []) : selection.matches;
  const chapter = chapters[state.position.chapter - 1];
  if (view === "read" && selection.ayah) {
    if (state.position.verse !== selection.ayah.verse) {
      savePosition({ chapter: chapter.id, verse: selection.ayah.verse });
    }
    $("verse-jump").value = state.position.verse;
    document.title = `${chapter.name} ${chapter.id}:${state.position.verse} — The Quran`;
  }
  $("reading-content").classList.toggle("focused", view === "read");
  $("reading-content").setAttribute("aria-live", view === "read" ? "polite" : "off");
  $("ayah-status").hidden = view !== "read" || !selection.ayah;
  $("ayah-status").textContent = `AYAH ${state.position.verse} OF ${chapter.verses}`;
  $("chapter-progress").hidden = view !== "read" || !selection.ayah;
  $("chapter-progress").max = chapter.verses;
  $("chapter-progress").value = state.position.verse;
  const fragment = document.createDocumentFragment();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `${icon(query ? "search" : "bookmark")}<h3>${query ? "No verses found" : "A place for meaningful words."}</h3><p>${query ? "Try a different word or clear your search." : "Tap the bookmark beside any verse to save it here."}</p>`;
    fragment.append(empty);
  }
  for (const verse of filtered) {
    const article = document.createElement("article");
    article.className = "verse";
    article.id = `verse-${verse.chapter}-${verse.verse}`;
    article.dataset.chapter = verse.chapter;
    article.dataset.verse = verse.verse;
    const saved = isBookmarked(verse.chapter, verse.verse);
    const number = document.createElement(view === "saved" ? "button" : "a");
    number.className = "verse-number";
    number.textContent = `${verse.chapter}:${verse.verse}`;
    if (view === "saved") {
      number.dataset.openChapter = verse.chapter;
      number.dataset.openVerse = verse.verse;
      number.setAttribute("aria-label", `Read ${chapters[verse.chapter - 1].name}, verse ${verse.verse}`);
    } else {
      number.href = `#${verse.chapter}:${verse.verse}`;
      number.setAttribute("aria-label", `Link to verse ${verse.chapter}:${verse.verse}`);
    }
    const textContainer = document.createElement("div");
    textContainer.className = "verse-body";
    if (view === "saved") {
      const label = document.createElement("span");
      label.className = "saved-chapter-name";
      label.textContent = chapters[verse.chapter - 1].name;
      textContainer.append(label);
    }
    const text = document.createElement("p");
    text.lang = TRANSLATIONS[state.translation].language;
    text.textContent = verse.text;
    textContainer.append(text);
    const bookmark = document.createElement("button");
    bookmark.className = `icon-button verse-bookmark${saved ? " is-saved" : ""}`;
    bookmark.dataset.bookmark = `${verse.chapter}:${verse.verse}`;
    bookmark.setAttribute("aria-label", `${saved ? "Remove bookmark for" : "Bookmark"} verse ${verse.chapter}:${verse.verse}`);
    bookmark.setAttribute("aria-pressed", String(saved));
    bookmark.innerHTML = icon("bookmark");
    article.append(number, textContainer, bookmark);
    fragment.append(article);
  }
  $("reading-content").replaceChildren(fragment);
  $("reading-content").setAttribute("aria-busy", "false");
  $("search-count").hidden = !query;
  $("search-count").textContent = view === "read" && selection.ayah
    ? `${selection.index + 1} of ${selection.matches.length} matches`
    : `${selection.matches.length} ${selection.matches.length === 1 ? "verse" : "verses"}`;
  $("jump-control").hidden = view !== "read" || Boolean(query);
  renderPagination(selection);
}

function renderPagination(selection) {
  const nav = $("ayah-navigation");
  const focusedDirection = document.activeElement?.getAttribute("data-direction");
  const searching = Boolean($("verse-search").value.trim());
  nav.hidden = view !== "read" || !selection.ayah;
  $("keyboard-hint").hidden = nav.hidden;
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
    const label = searching ? "MATCH" : target && target.chapter !== state.position.chapter ? "CHAPTER" : "AYAH";
    const title = target
      ? target.chapter !== state.position.chapter ? chapters[target.chapter - 1].name : direction === -1 ? "Back" : "Continue"
      : searching ? "No more matches" : direction === -1 ? "The beginning" : "The final ayah";
    button.innerHTML = `${icon(direction === -1 ? "left" : "right")}<span><span>${direction === -1 ? "PREVIOUS" : "NEXT"} ${label}</span><strong>${title}</strong></span>`;
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
  updateTabs();
  renderChapters();
  renderHeading();
  $("ayah-navigation").hidden = true;
  $("ayah-status").hidden = true;
  $("keyboard-hint").hidden = true;
  $("chapter-progress").hidden = true;
  $("reading-content").setAttribute("aria-busy", "true");
  $("reading-content").innerHTML = '<div class="loading-state"><span class="loading-dot"></span>Opening the words…</div>';
  if (scroll) window.scrollTo({ top: 0, behavior: "instant" });
  try {
    const translationId = state.translation;
    if (!cache.has(translationId)) {
      const response = await fetch(TRANSLATIONS[translationId].file);
      if (!response.ok) throw new Error(`Translation request failed (${response.status}).`);
      const data = parseTranslation(await response.text(), chapters);
      cache.set(translationId, data);
    }
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
  state.position = { chapter: position.chapter, verse: position.verse };
  history.replaceState(null, "", `#${position.chapter}:${position.verse}`);
  persist();
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

function moveAyah(direction) {
  if (loading || view !== "read") return;
  const data = cache.get(state.translation);
  if (!data) return;
  const query = $("verse-search").value.trim();
  const selection = selectAyah(data[state.position.chapter - 1], state.position.verse, query);
  const target = query
    ? selection.matches[selection.index + direction]
    : adjacentPosition(state.position, direction, chapters);
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
  view = "read";
  $("verse-search").value = "";
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
$("verse-search").addEventListener("input", () => { if (!loading) renderVerses(); });
$("verse-jump").addEventListener("change", () => {
  showAyah({ chapter: state.position.chapter, verse: Number($("verse-jump").value) });
});
$("translation").addEventListener("change", () => {
  state.translation = $("translation").value;
  persist();
  loadReading();
});
$("reading-content").addEventListener("click", event => {
  const open = event.target.closest("[data-open-chapter]");
  if (open) {
    navigate(Number(open.dataset.openChapter), Number(open.dataset.openVerse));
    return;
  }
  const button = event.target.closest("[data-bookmark]");
  if (!button) return;
  const [chapter, verse] = button.dataset.bookmark.split(":").map(Number);
  const saved = isBookmarked(chapter, verse);
  if (saved) state.bookmarks = state.bookmarks.filter(item => item.chapter !== chapter || item.verse !== verse);
  else state.bookmarks.push({ chapter, verse });
  persist();
  updateTabs();
  if (view === "saved") renderVerses();
  else {
    button.classList.toggle("is-saved", !saved);
    button.setAttribute("aria-pressed", String(!saved));
    button.setAttribute("aria-label", `${saved ? "Bookmark" : "Remove bookmark for"} verse ${chapter}:${verse}`);
  }
  notify(saved ? `Verse ${chapter}:${verse} removed from saved verses.` : `Verse ${chapter}:${verse} saved for later.`);
});

for (const [id, value] of [["read-tab", "read"], ["saved-tab", "saved"]]) {
  $(id).addEventListener("click", () => {
    if (view === value) return;
    view = value;
    $("verse-search").value = "";
    loadReading({ scroll: true });
  });
}
for (const [id, increment] of [["font-down", -2], ["font-up", 2]]) {
  $(id).addEventListener("click", () => {
    state.fontSize = Math.max(17, Math.min(29, state.fontSize + increment));
    applyPreferences();
    persist();
  });
}
$("theme-toggle").addEventListener("click", () => {
  state.theme = state.theme === "light" ? "dark" : "light";
  applyPreferences();
  persist();
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
    !$("sidebar").classList.contains("is-open") && view === "read") {
    event.preventDefault();
    moveAyah(event.key === "ArrowRight" ? 1 : -1);
  }
  if (event.key === "Escape") {
    if ($("sidebar").classList.contains("is-open")) { closeMenu(); $("open-menu").focus(); }
    if (event.target instanceof HTMLInputElement && event.target.value) {
      event.target.value = "";
      event.target.dispatchEvent(new Event("input"));
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

applyPreferences();
closeMenu();
persist();
loadReading();
