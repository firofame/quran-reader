import { getVerseMetadata } from "../lib/reader";
import { QuranData } from "../lib/quran-data";
import type { Verse, VerseMetadata } from "../lib/reader";
import type { ReactNode } from "react";

function metadataItems(metadata: VerseMetadata): ReactNode[] {
	const items: ReactNode[] = [];
	const push = (key: string, node: ReactNode) => {
		if (items.length) {
			items.push(
				<span key={`sep-${key}`} className="reading-metadata-separator" aria-hidden="true">·</span>,
			);
		}
		items.push(node);
	};
	const entries: Array<[label: string, value: number | null]> = [
		["Page", metadata.page],
		["Ruku", metadata.ruku],
		["Manzil", metadata.manzil],
		["Hizb", metadata.hizb],
		["Juz", metadata.juz],
	];
	for (const [label, value] of entries) {
		if (value === null) continue;
		push(label, (
			<span key={label} className="reading-metadata-item">
				<span className="reading-metadata-label">{label}</span>
				<span className="reading-metadata-value">{value}</span>
			</span>
		));
	}
	if (metadata.sajda) {
		push("sajda", (
			<span key="sajda" className="sajda-indicator">
				<span className="sajda-symbol" aria-hidden="true">۩</span>
				<span>Sajda</span>
			</span>
		));
	}
	return items;
}

export function ChapterHeading({ chapter, ayah }: { chapter: { id: number; name: string; meaning: string; verses: number; origin: string }; ayah: Verse | null }) {
	const metadata = ayah ? getVerseMetadata({ chapter: ayah.chapter, verse: ayah.verse }, QuranData) : null;
	const items = metadata ? metadataItems(metadata) : [];
	return (
		<div id="chapter-heading" className="chapter-heading">
			<div className="chapter-heading-title">
				<h1>{chapter.id}. {chapter.name}</h1>
				<span className="sr-only">{chapter.meaning} · {chapter.verses} ayahs · {chapter.origin}</span>
			</div>
			<div className="chapter-heading-meta">
				<p className="chapter-meta-line">
					<span id="reading-metadata" className="reading-metadata" role="group" aria-label="Current ayah metadata" hidden={items.length === 0}>
						{items}
					</span>
				</p>
			</div>
		</div>
	);
}
