import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { translationWordsUrl } from "../lib/audio";
import { wordAt } from "../lib/words";
import type { VerseAudioStatus } from "./use-verse-audio";

type WordTimes = [number, number][];

/**
 * Follows the translation reading word by word: fetches when each word is
 * spoken, then reads the audio's position every frame while it plays.
 * Returns the index of the word being spoken, or null.
 */
export function useSpokenWord(audioRef: RefObject<HTMLAudioElement | null>, status: VerseAudioStatus | null): number | null {
	const [words, setWords] = useState<{ key: string; times: WordTimes } | null>(null);
	const [spoken, setSpoken] = useState<number | null>(null);
	const key = status?.source === "translation" ? `${status.position.chapter}:${status.position.verse}` : null;
	const playing = key !== null && status?.state === "playing";

	useEffect(() => {
		// Asked once the audio plays, so the reading has been made and the
		// timings come from the same reading rather than paying for a second one.
		if (!key || !status || !playing) return;
		if (words?.key === key) return;
		const controller = new AbortController();
		fetch(translationWordsUrl(status.position), { signal: controller.signal })
			.then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
			.then((body: { words?: WordTimes }) => {
				if (Array.isArray(body.words)) setWords({ key, times: body.words });
			})
			.catch(error => {
				if (!controller.signal.aborted) console.warn("Unable to follow the translation reading:", error);
			});
		return () => controller.abort();
		// The position is read through `key`, which changes whenever it does.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, playing]);

	const times = words && words.key === key ? words.times : null;

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio || !times || !key) return;
		let frame = 0;
		const update = () => setSpoken(wordAt(times, audio.currentTime));
		update();
		if (!playing) return;
		const tick = () => {
			update();
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [audioRef, times, key, playing]);

	return key && times ? spoken : null;
}
