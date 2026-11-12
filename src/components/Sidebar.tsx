import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import { chapters } from "../lib/quran";
import { matchesChapter } from "../lib/reader";
import type { Chapter } from "../lib/reader";

interface SidebarProps {
	open: boolean;
	/** The drawer collapses off-screen on phones, where it must stay inert while closed. */
	mobile: boolean;
	query: string;
	selectedChapter: number;
	onQueryChange: (query: string) => void;
	onSelectChapter: (chapter: number) => void;
	onClose: () => void;
}

export function Sidebar({ open, mobile, query, selectedChapter, onQueryChange, onSelectChapter, onClose }: SidebarProps) {
	const sidebarRef = useRef<HTMLElement | null>(null);
	const matches = chapters.filter(chapter => matchesChapter(chapter, query));

	// Keep focus cycling inside the open drawer.
	useEffect(() => {
		const sidebar = sidebarRef.current;
		if (!sidebar || !open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const focusable = [...sidebar.querySelectorAll<HTMLElement>("a, button, input")].filter(element => element.getClientRects().length);
			if (!focusable.length) return;
			const first = focusable[0];
			const last = focusable.at(-1)!;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		sidebar.addEventListener("keydown", onKeyDown);
		return () => sidebar.removeEventListener("keydown", onKeyDown);
	}, [open]);

	const renderChapter = (chapter: Chapter) => {
		const selected = chapter.id === selectedChapter;
		return (
			<button
				key={chapter.id}
				type="button"
				className={`chapter-link${selected ? " selected" : ""}`}
				data-chapter={chapter.id}
				onClick={() => onSelectChapter(chapter.id)}
				aria-current={selected ? "true" : undefined}
			>
				<span className="chapter-number">{String(chapter.id).padStart(2, "0")}</span>
				<span className="chapter-names"><span>{chapter.name}</span><span>{chapter.meaning}</span></span>
				<span className="chapter-verse-count">{chapter.verses}</span>
			</button>
		);
	};

	return (
		<aside id="sidebar" ref={sidebarRef} className={`sidebar${open ? " is-open" : ""}`} aria-label="Chapter navigation" inert={mobile && !open}>
			<a className="brand" href="./" aria-label="The Quran home">
				<span className="brand-icon"><Icon name="book" /></span>
				<span>The Quran<span className="brand-caption">READ &amp; REFLECT</span></span>
			</a>
			<button id="close-menu" type="button" className="icon-button close-menu" aria-label="Close chapters" onClick={onClose}>
				<Icon name="close" />
			</button>
			<div className="chapter-search input-wrap">
				<span><Icon name="search" /></span>
				<input
					id="chapter-search"
					type="search"
					placeholder="Find a chapter…"
					aria-label="Find a chapter"
					autoComplete="off"
					value={query}
					onChange={event => onQueryChange(event.target.value)}
				/>
				<kbd>/</kbd>
			</div>
			<div className="chapter-list-label"><span>CHAPTERS</span><span>114 SURAHS</span></div>
			<nav id="chapter-list" className="chapter-list" aria-label="Chapters">
				{matches.map(renderChapter)}
				{!matches.length && <p className="chapter-empty">No chapters found. Try a name or number.</p>}
			</nav>
		</aside>
	);
}
