import { Icon } from "./Icon";
import { splitTranslationGlosses, splitTranslationParagraphs } from "../lib/reader";
import { TRANSLATIONS } from "../lib/reader";
import { verseAudioLabel } from "../hooks/use-verse-audio";
import type { VerseAudioSource, VerseAudioStatus } from "../hooks/use-verse-audio";
import type { Verse } from "../lib/reader";

interface VerseCardProps {
	verse: Verse;
	totalVerses: number;
	audioStatus: VerseAudioStatus | null;
	onToggleAudio: (verse: Verse, source: VerseAudioSource) => void;
}

export function VerseCard({ verse, totalVerses, audioStatus, onToggleAudio }: VerseCardProps) {
	const language = TRANSLATIONS["en.hilali"].language;
	const recitation = verseAudioLabel(audioStatus, verse, "recitation");
	const reading = verseAudioLabel(audioStatus, verse, "translation");
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
				{splitTranslationParagraphs(verse.text, language).map((paragraph, paragraphIndex) => (
					<p key={paragraphIndex} lang={language} dir="auto">
						{splitTranslationGlosses(paragraph).map((segment, segmentIndex) => (
							segment.gloss
								? <span key={segmentIndex} className="verse-gloss">{segment.text}</span>
								: segment.text
						))}
					</p>
				))}
			</div>
		</article>
	);
}
