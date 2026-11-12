import { useCallback, useRef, useState } from "react";
import { recitationUrl } from "../lib/audio";
import { chapters } from "../lib/quran";
import type { Position } from "../lib/reader";

export type VerseAudioState = "loading" | "playing" | "paused";

export interface VerseAudioStatus {
	position: Position;
	state: VerseAudioState;
}

type RecitationLabel = "play" | "pause" | "loading";

/**
 * Plays the one-ayah recitation from the Al Quran Cloud CDN. Playback starts
 * only after the direct user action that called `toggle`.
 */
export function useVerseAudio(onError: (message: string) => void) {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const requestRef = useRef(0);
	const statusRef = useRef<VerseAudioStatus | null>(null);
	const [status, setStatus] = useState<VerseAudioStatus | null>(null);

	const applyStatus = useCallback((next: VerseAudioStatus | null) => {
		statusRef.current = next;
		setStatus(next);
	}, []);

	const finish = useCallback((request: number) => {
		if (request !== requestRef.current) return;
		applyStatus(null);
	}, [applyStatus]);

	const stop = useCallback(() => {
		requestRef.current++;
		const audio = audioRef.current;
		if (!audio) return;
		audio.pause();
		audio.removeAttribute("src");
		audio.load();
		applyStatus(null);
	}, [applyStatus]);

	const play = useCallback((position: Position) => {
		const audio = audioRef.current;
		if (!audio) return;
		stop();
		const request = ++requestRef.current;
		applyStatus({ position, state: "loading" });
		audio.src = recitationUrl(position, chapters);
		audio.currentTime = 0;
		audio.onended = () => finish(request);
		audio.onerror = () => finish(request);
		audio.play().then(() => {
			if (request !== requestRef.current) return;
			const active = statusRef.current;
			if (active && active.position.chapter === position.chapter && active.position.verse === position.verse) {
				applyStatus({ ...active, state: "playing" });
			}
		}).catch(error => {
			if (request !== requestRef.current) return;
			console.warn("Unable to play the selected recitation:", error);
			finish(request);
			onError("The recitation could not be opened. Check your connection and try again.");
		});
	}, [applyStatus, finish, onError, stop]);

	const toggle = useCallback((position: Position) => {
		const audio = audioRef.current;
		if (!audio) return;
		const current = statusRef.current;
		if (!current || current.position.chapter !== position.chapter || current.position.verse !== position.verse) {
			play(position);
			return;
		}
		if (current.state !== "paused") {
			audio.pause();
			applyStatus({ ...current, state: "paused" });
			return;
		}
		const request = requestRef.current;
		applyStatus({ ...current, state: "loading" });
		audio.play().then(() => {
			if (request !== requestRef.current) return;
			const active = statusRef.current;
			if (active && active.position.chapter === position.chapter && active.position.verse === position.verse) {
				applyStatus({ ...active, state: "playing" });
			}
		}).catch(error => {
			if (request !== requestRef.current) return;
			console.warn("Unable to resume the selected recitation:", error);
			finish(request);
			onError("The recitation could not be opened. Check your connection and try again.");
		});
	}, [applyStatus, finish, onError, play]);

	return { audioRef, status, toggle, stop };
}

export function verseAudioLabel(status: VerseAudioStatus): { kind: RecitationLabel; text: string } {
	const verse = `${status.position.chapter}:${status.position.verse}`;
	if (status.state === "loading") return { kind: "loading", text: `Loading recitation for verse ${verse}` };
	if (status.state === "playing") return { kind: "pause", text: `Pause recitation for verse ${verse}` };
	return { kind: "play", text: `Play recitation for verse ${verse}` };
}
