import { ChapterHeading } from "./ChapterHeading";
import { DailyPanel } from "./DailyPanel";
import { VerseCard } from "./VerseCard";
import { Icon } from "./Icon";
import { findRuku, isRukuEnd } from "../lib/reading-data";
import type { TodayStats } from "../lib/reading-data";
import { findAyah, getRukuProgress, adjacentPosition } from "../lib/reader";
import type { Position, Verse } from "../lib/reader";
import { chapters, rukus } from "../lib/quran";
import { QuranData } from "../lib/quran-data";
import type { VerseAudioStatus } from "../hooks/use-verse-audio";
import type { PrayerCountdown } from "./DailyPanel";

interface ReaderProps {
	position: Position;
	verses: Verse[] | null;
	loading: boolean;
	loadError: boolean;
	today: TodayStats;
	countdown: PrayerCountdown | null;
	shortcutsSeen: boolean;
	fontSize: number;
	onFontSizeAdjust: (delta: number) => void;
	onMove: (direction: number) => void;
	onRetry: () => void;
	audioStatus: VerseAudioStatus | null;
	onToggleAudio: (verse: Verse) => void;
}

export function Reader({ position, verses, loading, loadError, today, countdown, shortcutsSeen, fontSize, onFontSizeAdjust, onMove, onRetry, audioStatus, onToggleAudio }: ReaderProps) {
	const chapter = chapters[position.chapter - 1];
	const ayah = verses ? findAyah(verses, position.verse) : null;
	const currentRuku = findRuku(position, rukus);
	const rukuProgress = ayah && currentRuku ? getRukuProgress(position, QuranData, chapters) : null;
	const showNavigation = Boolean(ayah) && !loading;

	const renderPaginationButton = (direction: number) => {
		const target = !loading ? adjacentPosition(position, direction, chapters) : null;
		const disabled = !target;
		const title = target
			? direction === 1 && currentRuku && isRukuEnd(position, currentRuku)
				? "Finish ruku"
				: target.chapter !== position.chapter
					? chapters[target.chapter - 1].name
					: direction === -1 ? "Back" : "Continue"
			: direction === -1 ? "The beginning" : "The final ayah";
		return (
			<button
				key={direction}
				type="button"
				className={direction === -1 ? "pagination-button previous" : "pagination-button next"}
				disabled={disabled}
				data-direction={direction}
				onClick={() => onMove(direction)}
				aria-label={direction === -1 ? "Previous ayah" : "Next ayah"}
			>
				<Icon name={direction === -1 ? "left" : "right"} />
				<strong>{title}</strong>
			</button>
		);
	};

	return (
		<section className="reader" aria-label="Quran translation">
			<div className="reader-header">
				<ChapterHeading chapter={chapter} ayah={ayah} />
			</div>
			<DailyPanel today={today} countdown={countdown} rukuProgress={rukuProgress} />
			<div id="ayah-status" className="sr-only" role="status" hidden={!ayah}>
				AYAH {position.verse} OF {chapter.verses}
			</div>
			<div id="reading-content" className="focused" aria-busy={loading} aria-live="polite">
				{loading && <div className="loading-state"><span className="loading-dot"></span>Opening the words…</div>}
				{!loading && loadError && (
					<div className="empty-state" role="alert">
						<h3>The translation couldn’t be opened.</h3>
						<p>Check that the translation files are available, then try again.</p>
						<button type="button" className="primary-button" onClick={onRetry}>Try again</button>
					</div>
				)}
				{!loading && !loadError && (ayah
					? <VerseCard verse={ayah} totalVerses={chapter.verses} audioStatus={audioStatus} onToggleAudio={onToggleAudio} />
					: <div className="empty-state"><h3>No verses found</h3><p>This part of the chapter could not be loaded.</p></div>)}
			</div>
			<div className="reader-font-control">
				<span className="reading-option-label">Text size</span>
				<div className="font-controls" role="group" aria-label="Reading text size">
					<button id="font-down" type="button" aria-label="Decrease text size" disabled={fontSize <= 17} onClick={() => onFontSizeAdjust(-2)}>
						A<span>−</span>
					</button>
					<span className="control-divider" aria-hidden="true"></span>
					<button id="font-up" type="button" aria-label="Increase text size" disabled={fontSize >= 29} onClick={() => onFontSizeAdjust(2)}>
						A<span>+</span>
					</button>
				</div>
			</div>
			<nav id="ayah-navigation" className="chapter-pagination" aria-label="Ayah navigation" hidden={!showNavigation}>
				{showNavigation && [renderPaginationButton(-1), renderPaginationButton(1)]}
			</nav>
			<p id="navigation-hint" className="navigation-hint" hidden={!showNavigation}>
				Use <kbd>←</kbd> <kbd>→</kbd> to continue. <span id="shortcut-hint" hidden={shortcutsSeen}>Space next · <kbd>Esc</kbd> menu</span>
			</p>
		</section>
	);
}
