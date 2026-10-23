import { TRANSLATIONS, createChapters, parseTranslation, parseHash, selectAyah, adjacentPosition, swipeDirection, matchesChapter, decodeState } from "./reader.js";

const icons = {
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  moon: '<path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="2" fill="var(--paper)"/><circle cx="16" cy="17" r="2" fill="var(--paper)"/>',
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
let ayahPointer = null;
let pageTurn = null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function cancelPageTurn() {
  const turn = pageTurn;
  pageTurn = null;
  turn?.animation?.cancel();
  turn?.sheet.remove();
  turn?.preview.remove();
  $("reading-content").classList.remove("is-turning");
  $("reading-content").style.removeProperty("min-height");
}

function releaseAyahPointer() {
  const pointer = ayahPointer;
  ayahPointer = null;
  const content = $("reading-content");
  content.classList.remove("is-dragging");
  if (pointer && content.hasPointerCapture(pointer.id)) content.releasePointerCapture(pointer.id);
  return pointer;
}

function cancelAyahDrag() {
  releaseAyahPointer();
  cancelPageTurn();
}

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
    $("chapter-heading").innerHTML = `<div><h1>Saved verses</h1><p>A collection to come back to.</p></div>`;
    document.title = "Saved verses — The Quran";
  } else {
    $("chapter-heading").innerHTML = `<div><h1>${chapter.id}. ${chapter.name}</h1><p>${chapter.meaning} · ${chapter.verses} ayahs<span class="sr-only"> · ${chapter.origin}</span></p></div><span class="chapter-arabic" lang="ar" dir="rtl">${chapter.arabic}</span>`;
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
  cancelAyahDrag();
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
  for (const verse of filtered) fragment.append(createVerse(verse));
  $("reading-content").replaceChildren(fragment);
  $("reading-content").setAttribute("aria-busy", "false");
  $("search-count").hidden = !query;
  $("search-count").textContent = view === "read" && selection.ayah
    ? `${selection.index + 1} of ${selection.matches.length} matches`
    : `${selection.matches.length} ${selection.matches.length === 1 ? "verse" : "verses"}`;
  $("active-search").hidden = !query;
  $("active-search-label").textContent = query ? `Search: “${query}” · ${$("search-count").textContent}` : "";
  $("jump-control").hidden = view !== "read" || Boolean(query);
  renderPagination(selection);
}

function createVerse(verse) {
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
  return article;
}

function renderPagination(selection) {
  const nav = $("ayah-navigation");
  const focusedDirection = document.activeElement?.getAttribute("data-direction");
  const searching = Boolean($("verse-search").value.trim());
  nav.hidden = view !== "read" || !selection.ayah;
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
  cancelAyahDrag();
  const request = ++requestId;
  loading = true;
  updateTabs();
  renderChapters();
  renderHeading();
  $("ayah-navigation").hidden = true;
  $("ayah-status").hidden = true;
  $("active-search").hidden = true;
  $("navigation-hint").hidden = true;
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

function ayahTarget(direction) {
  if (loading || view !== "read") return null;
  const data = cache.get(state.translation);
  if (!data) return null;
  const query = $("verse-search").value.trim();
  const selection = selectAyah(data[state.position.chapter - 1], state.position.verse, query);
  if (!selection.ayah) return null;
  return query
    ? selection.matches[selection.index + direction]
    : adjacentPosition(state.position, direction, chapters);
}

function beginPageTurn(direction, target) {
  cancelPageTurn();
  const content = $("reading-content");
  const previous = content.querySelector(".verse").cloneNode(true);
  previous.removeAttribute("id");
  const sheet = document.createElement("div");
  sheet.className = `page-turn ${direction === 1 ? "page-turn-forward" : "page-turn-backward"}`;
  const shade = document.createElement("div");
  shade.className = "page-turn-shade";
  sheet.append(previous, shade);
  const preview = document.createElement("div");
  preview.className = "page-preview";
  const next = createVerse(cache.get(state.translation)[target.chapter - 1][target.verse - 1]);
  next.removeAttribute("id");
  preview.append(next);
  for (const layer of [sheet, preview]) {
    layer.setAttribute("aria-hidden", "true");
    layer.inert = true;
  }
  const height = content.getBoundingClientRect().height;
  content.append(preview, sheet);
  // A longer preview must not resize the page underneath an active drag.
  content.style.minHeight = `${height}px`;
  content.classList.add("is-turning");
  pageTurn = { sheet, preview, shade, direction, target, progress: 0 };
  updatePageTurn(0);
}

function pageTurnFrame(progress, direction) {
  return {
    transform: `rotateY(${-direction * progress * 105}deg)`,
    boxShadow: `${direction * progress * 12}px 8px ${progress * 32}px rgb(0 0 0 / ${progress * 0.22})`,
  };
}

function updatePageTurn(progress) {
  pageTurn.progress = progress;
  Object.assign(pageTurn.sheet.style, pageTurnFrame(progress, pageTurn.direction));
  pageTurn.shade.style.opacity = progress * 0.65;
}

function finishPageTurn(commit) {
  const target = pageTurn?.target;
  cancelAyahDrag();
  if (commit && target) showAyah(target);
}

function interruptPageTurn() {
  if (pageTurn?.committing) finishPageTurn(true);
  else cancelAyahDrag();
}

function settlePageTurn(commit) {
  if (!pageTurn) return;
  if (reducedMotion.matches) {
    finishPageTurn(commit);
    return;
  }
  const turn = pageTurn;
  const end = commit ? 1 : 0;
  const options = {
    duration: Math.max(140, Math.abs(end - turn.progress) * 460),
    easing: "cubic-bezier(.2, .75, .25, 1)",
    fill: "forwards",
  };
  turn.committing = commit;
  turn.shade.animate([{ opacity: turn.progress * 0.65 }, { opacity: end * 0.65 }], options);
  turn.animation = turn.sheet.animate([
    pageTurnFrame(turn.progress, turn.direction), pageTurnFrame(end, turn.direction),
  ], options);
  turn.animation.finished.then(() => {
    if (pageTurn === turn) finishPageTurn(commit);
  }, error => {
    if (error.name !== "AbortError") {
      console.error("Unable to finish page turn:", error);
      notify("The page animation could not finish. You can keep reading normally.");
      if (pageTurn === turn) finishPageTurn(commit);
    }
  });
}

function moveAyah(direction) {
  if (pageTurn?.animation) finishPageTurn(pageTurn.committing);
  cancelAyahDrag();
  const target = ayahTarget(direction);
  if (!target) return;
  if (reducedMotion.matches) showAyah(target);
  else {
    beginPageTurn(direction, target);
    settlePageTurn(true);
  }
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
$("reading-content").addEventListener("pointerdown", event => {
  if (!event.isPrimary || event.button !== 0 || pageTurn?.animation || loading ||
    view !== "read" || $("ayah-navigation").hidden ||
    $("sidebar").classList.contains("is-open") || window.getSelection()?.isCollapsed === false ||
    event.target.closest("a, button, input, select, textarea, [contenteditable]")) return;
  // Mouse drags start outside the text so selecting a passage still works.
  if (event.pointerType === "mouse" && event.target.closest(".verse-body")) return;
  ayahPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
});
document.addEventListener("pointerdown", event => {
  if (event.pointerType === "touch" && !event.isPrimary) cancelAyahDrag();
});
document.addEventListener("pointermove", event => {
  const start = ayahPointer;
  if (!start || start.id !== event.pointerId) return;
  const deltaX = event.clientX - start.x;
  const deltaY = event.clientY - start.y;
  if (window.getSelection()?.isCollapsed === false || (!start.dragging &&
    Math.abs(deltaY) > 10 && Math.abs(deltaY) >= Math.abs(deltaX))) {
    cancelAyahDrag();
    return;
  }
  if (!start.dragging) {
    if (Math.abs(deltaX) < 10 || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return;
    start.dragging = true;
    $("reading-content").classList.add("is-dragging");
    $("reading-content").setPointerCapture(start.id);
  }
  event.preventDefault();
  const direction = deltaX < 0 ? 1 : -1;
  if (pageTurn?.direction !== direction) {
    cancelPageTurn();
    const target = ayahTarget(direction);
    if (target && !reducedMotion.matches) beginPageTurn(direction, target);
  }
  if (pageTurn) updatePageTurn(Math.min(0.95, Math.abs(deltaX) / ($("reading-content").clientWidth * 0.75)));
});
document.addEventListener("pointerup", event => {
  if (ayahPointer?.id !== event.pointerId) return;
  const start = releaseAyahPointer();
  const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y);
  const allowed = !$("sidebar").classList.contains("is-open") && window.getSelection()?.isCollapsed !== false;
  if (pageTurn) settlePageTurn(allowed && direction === pageTurn.direction);
  else if (allowed && direction && start.dragging) moveAyah(direction);
});
document.addEventListener("pointercancel", event => {
  if (ayahPointer?.id === event.pointerId) cancelAyahDrag();
});
$("reading-content").addEventListener("lostpointercapture", event => {
  if (event.target === event.currentTarget && ayahPointer?.id === event.pointerId &&
    !event.currentTarget.hasPointerCapture(event.pointerId)) cancelAyahDrag();
});
window.addEventListener("blur", interruptPageTurn);
window.addEventListener("resize", interruptPageTurn);
$("chapter-search").addEventListener("input", renderChapters);
$("verse-search").addEventListener("input", () => { if (!loading) renderVerses(); });
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
    $("reading-controls").open = false;
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
    cancelAyahDrag();
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
window.addEventListener("pagehide", () => {
  interruptPageTurn();
  persist();
});
matchMedia("(max-width: 760px)").addEventListener("change", closeMenu);
reducedMotion.addEventListener("change", interruptPageTurn);

applyPreferences();
closeMenu();
persist();
loadReading();
