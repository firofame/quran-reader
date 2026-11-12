import { Icon } from "./Icon";
import { splitTranslationGlosses, splitTranslationParagraphs } from "../lib/reader";
import { TRANSLATIONS } from "../lib/reader";
import { verseAudioLabel } from "../hooks/use-verse-audio";
import type { VerseAudioStatus } from "../hooks/use-verse-audio";
import type { Verse } from "../lib/reader";

interface VerseCardProps {
	verse: Verse;
	totalVerses: number;
	audioStatus: VerseAudioStatus | null;
	onToggleAudio: (verse: Verse) => void;
}

export function VerseCard({ verse, totalVerses, audioStatus, onToggleAudio }: VerseCardProps) {
	const language = TRANSLATIONS["en.hilali"].language;
	const audio = audioStatus && audioStatus.position.chapter === verse.chapter && audioStatus.position.verse === verse.verse
		? verseAudioLabel(audioStatus)
		: { kind: "play" as const, text: `Play recitation for verse ${verse.chapter}:${verse.verse}` };
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
						onClick={() => onToggleAudio(verse)}
						aria-label={audio.text}
						title={audio.text}
						disabled={audio.kind === "loading"}
					>
						<Icon name={audio.kind === "pause" ? "pause" : "play"} />
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
