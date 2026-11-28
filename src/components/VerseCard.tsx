import { Icon } from "./Icon";
import { useMemo } from "react";
import { splitTranslationGlosses, splitTranslationParagraphs } from "../lib/reader";
import { wordIndexes, wordPieces } from "../lib/words";
import type { WordPiece } from "../lib/words";
import { TRANSLATIONS } from "../lib/reader";
import { verseAudioLabel } from "../hooks/use-verse-audio";
import type { VerseAudioSource, VerseAudioStatus } from "../hooks/use-verse-audio";
import type { Verse } from "../lib/reader";

interface VerseCardProps {
	verse: Verse;
	totalVerses: number;
	audioStatus: VerseAudioStatus | null;
	onToggleAudio: (verse: Verse, source: VerseAudioSource) => void;
	/** The word of this ayah being read aloud, or null. */
	spokenWord: number | null;
}

export function VerseCard({ verse, totalVerses, audioStatus, onToggleAudio, spokenWord }: VerseCardProps) {
	const language = TRANSLATIONS["en.hilali"].language;
	const recitation = verseAudioLabel(audioStatus, verse, "recitation");
	const reading = verseAudioLabel(audioStatus, verse, "translation");
	const indexes = useMemo(() => wordIndexes(verse.text), [verse.text]);
	const paragraphs = useMemo(() => {
		const result: { gloss: boolean; pieces: WordPiece[] }[][] = [];
		let offset = 0;
		for (const paragraph of splitTranslationParagraphs(verse.text, language)) {
			const segments: { gloss: boolean; pieces: WordPiece[] }[] = [];
			for (const segment of splitTranslationGlosses(paragraph)) {
				segments.push({ gloss: segment.gloss, pieces: wordPieces(segment.text, offset, indexes) });
				offset += segment.text.length;
			}
			result.push(segments);
		}
		return result;
	}, [verse.text, language, indexes]);
	const renderPieces = (pieces: WordPiece[]) => pieces.map((piece, index) => (
		piece.word < 0
			? piece.text
			: <span key={index} className={piece.word === spokenWord ? "word speaking" : "word"}>{piece.text}</span>
	));
	return (
		<article className="verse" id={`verse-${verse.chapter}-${verse.verse}`} data-chapter={verse.chapter} data-verse={verse.verse}>
			<div className="verse-reference">
				<a
					className="verse-number"
					href={`#${verse.chapter}:${verse.verse}`}
					aria-label={`Link to ayah ${verse.verse} of ${totalVerses} in chapter ${verse.chapter}`}
				>
					Ayah: {verse.verse} / {totalVerses}
				</a>
				<div className="verse-audio-action">
					<button
						type="button"
						onClick={() => onToggleAudio(verse, "recitation")}
						aria-label={recitation.text}
						title={recitation.text}
						disabled={recitation.kind === "loading"}
					>
						<Icon name={recitation.kind === "pause" ? "pause" : "play"} />
					</button>
					<button
						type="button"
						onClick={() => onToggleAudio(verse, "translation")}
						aria-label={reading.text}
						title={reading.text}
						disabled={reading.kind === "loading"}
					>
						<Icon name={reading.kind === "pause" ? "pause" : "speaker"} />
					</button>
				</div>
			</div>
			<div className="verse-body">
				{paragraphs.map((segments, paragraphIndex) => (
					<p key={paragraphIndex} lang={language} dir="auto">
						{segments.map((segment, segmentIndex) => (
							segment.gloss
								? <span key={segmentIndex} className="verse-gloss">{renderPieces(segment.pieces)}</span>
								: <span key={segmentIndex}>{renderPieces(segment.pieces)}</span>
						))}
					</p>
				))}
			</div>
		</article>
	);
}
