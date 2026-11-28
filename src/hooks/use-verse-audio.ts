import { useCallback, useRef, useState } from "react";
import { TRANSLATION_PLAYBACK_RATE, recitationUrl, translationErrorMessage, translationSpeechUrl } from "../lib/audio";
import { chapters } from "../lib/quran";
import type { Position } from "../lib/reader";

export type VerseAudioState = "loading" | "playing" | "paused";
/** The Arabic recitation, or the English translation read aloud. */
export type VerseAudioSource = "recitation" | "translation";

export interface VerseAudioStatus {
	position: Position;
	source: VerseAudioSource;
	state: VerseAudioState;
}

function sameAudio(status: VerseAudioStatus | null, position: Position, source: VerseAudioSource): status is VerseAudioStatus {
	return !!status && status.source === source && status.position.chapter === position.chapter && status.position.verse === position.verse;
}

type RecitationLabel = "play" | "pause" | "loading";

/**
 * Plays one ayah: the recitation from the Al Quran Cloud CDN, or the English
 * translation read aloud by the Worker. Both share one audio element, so they
 * never talk over each other. Playback starts only after the direct user
 * action that called `toggle`.
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

	const play = useCallback((position: Position, source: VerseAudioSource) => {
		const audio = audioRef.current;
		if (!audio) return;
		stop();
		const request = ++requestRef.current;
		applyStatus({ position, source, state: "loading" });
		audio.src = source === "translation" ? translationSpeechUrl(position) : recitationUrl(position, chapters);
		// The translation is played slower, so each phrase has time to settle.
		const rate = source === "translation" ? TRANSLATION_PLAYBACK_RATE : 1;
		audio.defaultPlaybackRate = rate;
		audio.playbackRate = rate;
		audio.preservesPitch = true;
		audio.currentTime = 0;
		audio.onended = () => finish(request);
		audio.onerror = () => finish(request);
		audio.play().then(() => {
			if (request !== requestRef.current) return;
			const active = statusRef.current;
			if (sameAudio(active, position, source)) {
				applyStatus({ ...active, state: "playing" });
			}
		}).catch(error => {
			if (request !== requestRef.current) return;
			console.warn(`Unable to play the selected ${source}:`, error);
			finish(request);
			reportError(source, onError);
		});
	}, [applyStatus, finish, onError, stop]);

	const toggle = useCallback((position: Position, source: VerseAudioSource = "recitation") => {
		const audio = audioRef.current;
		if (!audio) return;
		const current = statusRef.current;
		if (!sameAudio(current, position, source)) {
			play(position, source);
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
			if (sameAudio(active, position, source)) {
				applyStatus({ ...active, state: "playing" });
			}
		}).catch(error => {
			if (request !== requestRef.current) return;
			console.warn(`Unable to resume the selected ${source}:`, error);
			finish(request);
			reportError(source, onError);
		});
	}, [applyStatus, finish, onError, play]);

	return { audioRef, status, toggle, stop };
}

function reportError(source: VerseAudioSource, onError: (message: string) => void): void {
	if (source === "translation") {
		void translationErrorMessage().then(onError);
		return;
	}
	onError("The recitation could not be opened. Check your connection and try again.");
}

/** The button state for one ayah's recitation or translation reading. */
export function verseAudioLabel(status: VerseAudioStatus | null, position: Position, source: VerseAudioSource): { kind: RecitationLabel; text: string } {
	const verse = `${position.chapter}:${position.verse}`;
	const what = source === "translation" ? "translation reading" : "recitation";
	if (sameAudio(status, position, source)) {
		if (status.state === "loading") return { kind: "loading", text: `Loading ${what} for verse ${verse}` };
		if (status.state === "playing") return { kind: "pause", text: `Pause ${what} for verse ${verse}` };
	}
	return { kind: "play", text: `Play ${what} for verse ${verse}` };
}
