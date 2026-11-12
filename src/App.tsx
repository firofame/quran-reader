import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Notice } from "./components/Notice";
import type { NoticeState } from "./components/Notice";
import { Reader } from "./components/Reader";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { Icon } from "./components/Icon";
import { useNow } from "./hooks/use-now";
import { useVerseAudio } from "./hooks/use-verse-audio";
import {
	DEFAULT_PRAYER_TIMES,
	findRuku,
	formatCountdown,
	getNextPrayerMoment,
	getNextPrayerReminder,
	getPrayerSchedule,
	getTodayStats,
	isRukuEnd,
	pendingEarlierRukus,
	recordRukuCompletion,
	recordRukusAsRead,
	recordVerseVisit,
	resolveStartupPosition,
} from "./lib/reading-data";
import type { PrayerId, ReadingSettings, Ruku } from "./lib/reading-data";
import { adjacentPosition, decodeState, parseHash } from "./lib/reader";
import type { Position, ReaderState } from "./lib/reader";
import { createReaderReducer } from "./lib/reader-state";
import { createPreferencesStore } from "./lib/preferences-store";
import { prayerWindows } from "./lib/prayer-windows";
import { createTranslationRepository } from "./lib/translation-repository";
import { chapters, rukus } from "./lib/quran";

type Page = "reader" | "settings";
type ScrollMode = "top" | "nearest" | "none";

const preferences = createPreferencesStore(globalThis.localStorage, chapters);
const translationRepository = createTranslationRepository();

interface Initialization {
	state: ReaderState;
	notice: NoticeState | null;
}

function initializeReader(): Initialization {
	// Drop configuration left by the former cross-device sync feature.
	try {
		globalThis.localStorage.removeItem("quran-reader:sync:v1");
	} catch {
		// Storage may be unavailable; there is nothing to clean up then.
	}
	let state: ReaderState;
	let notice: NoticeState | null = null;
	try {
		state = preferences.load();
	} catch (error) {
		console.error("Unable to read saved Quran reader preferences:", error);
		state = decodeState(null, chapters);
		notice = { message: "Your saved preferences could not be read. Default preferences have been restored.", persistent: true };
	}
	const hashPosition = parseHash(globalThis.location.hash, chapters);
	// A browser reload or explicit verse link should keep the visible ayah.
	const startup = resolveStartupPosition({ hashPosition, savedPosition: state.position });
	if (startup.source === "link") {
		state = createReaderReducer(chapters)(state, { type: "position/set", position: startup.position });
	} else if (globalThis.location.hash && globalThis.location.hash !== "#main" && !hashPosition) {
		notice = { message: "That verse link isn't valid. Your last reading position has been opened.", persistent: false };
	}
	return { state, notice };
}

export function App() {
	const [initial] = useState(initializeReader);
	const [state, dispatch] = useReducer(createReaderReducer(chapters), initial.state);
	const [notice, setNotice] = useState<NoticeState | null>(initial.notice);
	const [activePage, setActivePage] = useState<Page>("reader");
	const [menuOpen, setMenuOpen] = useState(false);
	const [minimalOpen, setMinimalOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [mobile, setMobile] = useState(() => matchMedia("(max-width: 760px)").matches);
	const [translationStatus, setTranslationStatus] = useState<"loading" | "ready" | "error">("loading");
	const [loadAttempt, setLoadAttempt] = useState(0);

	const storageFailedRef = useRef(false);
	const noticeTimerRef = useRef<number | undefined>(undefined);
	const reminderTimerRef = useRef<number | undefined>(undefined);
	const scheduleRef = useRef<(() => void) | undefined>(undefined);
	const latestRef = useRef({
		state: initial.state,
		loading: true,
		menuOpen: false,
		minimalOpen: false,
		activePage: "reader" as Page,
	});
	// Render-time mirror so event handlers and timers always act on the
	// latest committed values.
	latestRef.current = {
		state,
		loading: translationStatus === "loading",
		menuOpen,
		minimalOpen,
		activePage,
	};

	const notify = useCallback((message: string, persistent = false) => {
		let text = message;
		let shownPersistent = persistent;
		if (storageFailedRef.current && !persistent) {
			text += " Changes will only last until this page is closed because browser storage is unavailable.";
			shownPersistent = true;
		}
		window.clearTimeout(noticeTimerRef.current);
		setNotice({ message: text, persistent: shownPersistent });
		if (!shownPersistent) {
			noticeTimerRef.current = window.setTimeout(() => setNotice(null), 5000);
		}
	}, []);

	const { audioRef, status: audioStatus, toggle: toggleAudio, stop: stopAudio } = useVerseAudio(notify);

	// Every committed state change is written back to browser storage.
	useEffect(() => {
		try {
			preferences.save(state);
		} catch (error) {
			if (!storageFailedRef.current) {
				console.error("Unable to save Quran reader preferences:", error);
				storageFailedRef.current = true;
				notify("Browser storage is unavailable. Your reading progress won't be saved.", true);
			}
		}
	}, [state, notify]);

	useEffect(() => {
		const onPageHide = () => {
			try {
				preferences.save(latestRef.current.state);
			} catch {
				// The persist effect has already reported storage problems.
			}
		};
		window.addEventListener("pagehide", onPageHide);
		return () => window.removeEventListener("pagehide", onPageHide);
	}, []);

	// Document chrome: theme, reading size, and the reading progress title.
	useEffect(() => {
		document.documentElement.dataset.theme = state.theme;
		document.documentElement.style.setProperty("--reading-size", `${state.fontSize}px`);
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.theme === "dark" ? "#191e1b" : "#f8f6ef");
	}, [state.theme, state.fontSize]);

	useEffect(() => {
		const currentRuku = findRuku(state.position, rukus);
		const today = getTodayStats(state.readingData);
		const dayLabel = today.reached
			? `${today.target}/${today.target}${today.bonus ? ` +${today.bonus}` : ""} today`
			: `${today.completed}/${today.target} today`;
		document.title = `${currentRuku ? `Ruku ${currentRuku.id}` : `Ayah ${state.position.chapter}:${state.position.verse}`} · ${dayLabel} — The Quran`;
	}, [state.position, state.readingData]);

	// The translation file loads once per translation id and is cached.
	useEffect(() => {
		let cancelled = false;
		setTranslationStatus("loading");
		translationRepository.load(state.translation, chapters)
			.then(() => {
				if (!cancelled) setTranslationStatus("ready");
			})
			.catch(error => {
				if (cancelled) return;
				console.error("Unable to load Quran translation:", error);
				setTranslationStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [state.translation, loadAttempt]);

	const goTo = useCallback((position: Position, record: boolean, scroll: ScrollMode = "none") => {
		const previous = latestRef.current.state.position;
		if (previous.chapter !== position.chapter || previous.verse !== position.verse) {
			stopAudio();
		}
		dispatch({ type: "position/set", position });
		history.replaceState(null, "", `#${position.chapter}:${position.verse}`);
		if (record) {
			dispatch({ type: "reading-data/update", update: readingData => recordVerseVisit(readingData, position, new Date()) });
		}
		if (scroll === "top") {
			window.scrollTo({ top: 0, behavior: "instant" });
		}
		if (scroll === "nearest") {
			requestAnimationFrame(() => document.getElementById("reading-content")?.scrollIntoView({ block: "nearest", behavior: "instant" }));
		}
	}, [stopAudio]);

	const completeRuku = useCallback((ruku: Ruku) => {
		dispatch({ type: "reading-data/update", update: readingData => recordRukuCompletion(readingData, ruku, new Date()) });
		const next = rukus[ruku.id];
		if (next) goTo(next.start, false, "top");
	}, [goTo]);

	const moveAyah = useCallback((direction: number) => {
		const current = latestRef.current;
		if (current.loading) return;
		const currentRuku = findRuku(current.state.position, rukus);
		if (direction === 1 && currentRuku && isRukuEnd(current.state.position, currentRuku)) {
			dispatch({ type: "reading-data/update", update: readingData => recordVerseVisit(readingData, current.state.position, new Date()) });
			completeRuku(currentRuku);
			return;
		}
		const target = adjacentPosition(current.state.position, direction, chapters);
		if (target) {
			goTo(target, true, target.chapter !== current.state.position.chapter ? "top" : "nearest");
		}
	}, [completeRuku, goTo]);

	// Verse links, such as #2:255, open their ayah wherever they appear.
	useEffect(() => {
		const onHashChange = () => {
			if (globalThis.location.hash === "#main") return;
			const position = parseHash(globalThis.location.hash, chapters);
			if (position) {
				setActivePage("reader");
				setMenuOpen(false);
				goTo(position, false, "top");
			} else {
				notify("That verse link isn't valid. Choose a chapter or verse to continue.");
			}
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, [goTo, notify]);

	const updateSetting = useCallback(<K extends keyof ReadingSettings>(name: K, value: ReadingSettings[K]) => {
		dispatch({
			type: "reading-data/update",
			update: readingData => {
				const settings: ReadingSettings = { ...readingData.settings, [name]: value };
				return { ...readingData, settings };
			},
		});
	}, []);

	const markShortcutsSeen = useCallback(() => {
		if (!latestRef.current.state.readingData.settings.shortcutsSeen) updateSetting("shortcutsSeen", true);
	}, [updateSetting]);

	const closeMenu = useCallback(() => setMenuOpen(false), []);

	const openMenu = useCallback(() => {
		setMenuOpen(true);
		document.getElementById("chapter-search")?.focus();
	}, []);

	const showPage = useCallback((page: Page) => {
		setActivePage(page);
		setMinimalOpen(false);
	}, []);

	useEffect(() => {
		window.scrollTo({ top: 0, behavior: "instant" });
	}, [activePage]);

	// Keyboard shortcuts for reading: arrows and space move between ayahs,
	// escape opens the reading menu, and "/" focuses the chapter search.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement;
			const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
			const current = latestRef.current;
			const sidebarOpen = current.menuOpen;
			if (current.activePage === "reader" && (event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.ctrlKey && !event.metaKey && !event.altKey && !typing && !sidebarOpen) {
				event.preventDefault();
				markShortcutsSeen();
				moveAyah(event.key === "ArrowRight" ? 1 : -1);
			}
			if (current.activePage === "reader" && (event.key === " " || event.code === "Space") && !event.ctrlKey && !event.metaKey && !event.altKey && !typing && !["BUTTON", "A"].includes(target.tagName) && !sidebarOpen) {
				event.preventDefault();
				markShortcutsSeen();
				moveAyah(1);
			}
			if (event.key === "Escape") {
				if (sidebarOpen) {
					closeMenu();
					document.getElementById("open-menu")?.focus();
					return;
				}
				if (event.target instanceof HTMLInputElement && event.target.value) {
					setQuery("");
					return;
				}
				if (!current.minimalOpen) {
					setMinimalOpen(true);
					window.setTimeout(() => document.querySelector<HTMLButtonElement>("#minimal-menu button:not([hidden])")?.focus());
				} else {
					setMinimalOpen(false);
				}
			}
			if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
				event.preventDefault();
				if (matchMedia("(max-width: 760px)").matches) document.getElementById("open-menu")?.click();
				else document.getElementById("chapter-search")?.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [closeMenu, markShortcutsSeen, moveAyah]);

	// The drawer collapses on phones; closing it returns the page to normal.
	useEffect(() => {
		const mediaQuery = matchMedia("(max-width: 760px)");
		const onChange = () => {
			setMobile(mediaQuery.matches);
			setMenuOpen(false);
		};
		mediaQuery.addEventListener("change", onChange);
		return () => mediaQuery.removeEventListener("change", onChange);
	}, []);

	/**
	 * Keeps the countdown to the next prayer moment up to date.
	 */
	const now = useNow();
	const schedule = getPrayerSchedule(state.readingData);
	const nextMoment = getNextPrayerMoment(schedule, now);
	const countdown = nextMoment
		? { name: nextMoment.name, kind: nextMoment.kind, remaining: formatCountdown(nextMoment.at - now.getTime()) }
		: null;

	/**
	 * Schedules the next browser reminder: at the adhan, and five minutes
	 * before the iqama. Reminders fire while the tab is open.
	 */
	const schedulePrayerReminder = useCallback(() => {
		window.clearTimeout(reminderTimerRef.current);
		const settings = latestRef.current.state.readingData.settings;
		if (!settings.remindersEnabled || !("Notification" in window) || Notification.permission !== "granted") return;
		const prayers = getPrayerSchedule(latestRef.current.state.readingData);
		const reminderNow = new Date();
		const next = getNextPrayerReminder(prayers, reminderNow);
		if (!next) return;
		reminderTimerRef.current = window.setTimeout(() => {
			const latest = latestRef.current.state;
			const slot = prayerWindows(getPrayerSchedule(latest.readingData), latest.readingData).find(item => item.id === next.id);
			const currentRuku = findRuku(latest.position, rukus);
			const chapter = chapters[latest.position.chapter - 1];
			const message = next.kind === "adhan"
				? `${next.name} adhan at ${next.adhan}. Next up: ${chapter.name}, ruku ${currentRuku?.localNumber ?? 1}. One ruku, whenever you’re ready.`
				: `${next.name} iqama at ${next.iqama}. Time to head to the masjid.`;
			// The iqama nudge is about reaching the masjid, so it fires 5 minutes
			// before the iqama to give time for wudu and travel. The adhan nudge
			// waits for the prayer window when the reader already read.
			if (next.kind === "iqama" || !(slot?.read ?? false)) {
				const notification = new Notification(message);
				notification.onclick = () => {
					window.focus();
					notification.close();
				};
			}
			scheduleRef.current?.();
		}, Math.min(2147483647, Math.max(0, next.at - reminderNow.getTime())));
	}, []);
	useEffect(() => {
		scheduleRef.current = schedulePrayerReminder;
	});

	useEffect(() => {
		schedulePrayerReminder();
		return () => window.clearTimeout(reminderTimerRef.current);
	}, [schedulePrayerReminder, state.readingData.settings.remindersEnabled, state.readingData.settings.prayerTimes]);

	useEffect(() => {
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible") schedulePrayerReminder();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [schedulePrayerReminder]);

	const onMarkEarlierRukus = useCallback(() => {
		const current = latestRef.current.state;
		const currentRuku = findRuku(current.position, rukus);
		const pending = pendingEarlierRukus(current.readingData, currentRuku?.id ?? null, rukus);
		if (!currentRuku || pending === 0) return;
		const plural = pending === 1 ? "ruku" : "rukus";
		if (!window.confirm(`Mark ${pending} earlier ${plural} as read? The overall progress and the lifetime totals catch up. Daily activity stays unchanged.`)) return;
		dispatch({ type: "reading-data/update", update: readingData => recordRukusAsRead(readingData, currentRuku.id, rukus) });
		notify(`Marked ${pending} earlier ${plural} as read.`);
	}, [notify]);

	const onRemindersChange = useCallback((enabled: boolean) => {
		if (!enabled) {
			updateSetting("remindersEnabled", false);
			schedulePrayerReminder();
			return;
		}
		if (!("Notification" in window)) {
			notify("This browser does not support notifications.");
			return;
		}
		void Promise.resolve(Notification.permission === "granted" ? "granted" : Notification.requestPermission()).then(permission => {
			if (permission !== "granted") {
				notify("Notifications were not enabled. You can still use your prayer chips.");
				return;
			}
			updateSetting("remindersEnabled", true);
			schedulePrayerReminder();
			notify("Browser reminders are on while this tab is open.");
		});
	}, [notify, schedulePrayerReminder, updateSetting]);

	const onPrayerTimeChange = useCallback((prayerId: PrayerId, field: "adhan" | "iqama", time: string) => {
		if (!time) return;
		const times = latestRef.current.state.readingData.settings.prayerTimes;
		const current = times[prayerId] ?? DEFAULT_PRAYER_TIMES[prayerId];
		updateSetting("prayerTimes", {
			...times,
			[prayerId]: { ...current, [field]: time },
		});
		schedulePrayerReminder();
	}, [schedulePrayerReminder, updateSetting]);

	const onSelectChapter = useCallback((chapterId: number) => {
		setActivePage("reader");
		goTo({ chapter: chapterId, verse: 1 }, false, "top");
		closeMenu();
	}, [closeMenu, goTo]);

	const today = getTodayStats(state.readingData);
	const verses = translationStatus === "ready"
		? translationRepository.getLoaded(state.translation)?.[state.position.chapter - 1] ?? null
		: null;

	return (
		<>
			<a className="skip-link" href="#main">Skip to reading</a>
			<Notice notice={notice} />
			<div id="sidebar-backdrop" className="sidebar-backdrop" hidden={!menuOpen} onClick={closeMenu} />
			<Sidebar
				open={menuOpen}
				mobile={mobile}
				query={query}
				selectedChapter={state.position.chapter}
				onQueryChange={setQuery}
				onSelectChapter={onSelectChapter}
				onClose={() => {
					closeMenu();
					document.getElementById("open-menu")?.focus();
				}}
			/>
			<div className="workspace" inert={mobile && menuOpen}>
				<header className="topbar">
					<div className="topbar-left">
						<button
							id="open-menu"
							type="button"
							className="icon-button open-menu"
							aria-label="Open chapters"
							aria-controls="sidebar"
							aria-expanded={menuOpen}
							onClick={openMenu}
						>
							<Icon name="menu" />
						</button>
						<span className="topbar-label">A SPACE FOR REFLECTION</span>
					</div>
					<nav id="app-navigation" className="app-navigation" aria-label="Reader pages">
						<button type="button" onClick={() => showPage("reader")} aria-current={activePage === "reader" ? "page" : undefined}>Read</button>
						<button type="button" onClick={() => showPage("settings")} aria-current={activePage === "settings" ? "page" : undefined}>Settings</button>
					</nav>
					<div className="topbar-right">
						<button
							id="theme-toggle"
							type="button"
							className="icon-button theme-toggle"
							aria-label={state.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
							onClick={() => dispatch({ type: "theme/toggle" })}
						>
							<Icon name={state.theme === "dark" ? "sun" : "moon"} />
						</button>
					</div>
				</header>
				<main id="main" tabIndex={-1}>
					<div id="reader-page" className="app-page" hidden={activePage !== "reader"}>
						<Reader
							position={state.position}
							verses={verses}
							loading={translationStatus === "loading"}
							loadError={translationStatus === "error"}
							today={today}
							countdown={countdown}
							shortcutsSeen={state.readingData.settings.shortcutsSeen}
							fontSize={state.fontSize}
							onFontSizeAdjust={delta => dispatch({ type: "font-size/adjust", delta })}
							onMove={moveAyah}
							onRetry={() => setLoadAttempt(attempt => attempt + 1)}
							audioStatus={audioStatus}
							onToggleAudio={verse => toggleAudio({ chapter: verse.chapter, verse: verse.verse })}
						/>
					</div>
					<div hidden={activePage !== "settings"}>
						<SettingsPage
							readingData={state.readingData}
							position={state.position}
							onMarkEarlierRukus={onMarkEarlierRukus}
							onPrayerTimeChange={onPrayerTimeChange}
							onRemindersChange={onRemindersChange}
						/>
					</div>
				</main>
				<div id="minimal-menu" className="minimal-menu" hidden={!minimalOpen} role="dialog" aria-label="Reading menu">
					<button type="button" onClick={() => showPage("reader")}>Return to reading</button>
					<button type="button" onClick={() => showPage("settings")}>Settings</button>
				</div>
				<audio id="verse-audio" preload="none" hidden ref={audioRef} />
			</div>
		</>
	);
}
