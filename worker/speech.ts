/**
 * Reads an ayah's English translation aloud with ElevenLabs Eleven v4.
 *
 * The reader asks for `GET /api/speech/<chapter>/<verse>` (the MP3) and
 * `GET /api/speech/<chapter>/<verse>/words` (when each word is spoken, so the
 * reader can highlight it). The Worker looks the
 * text up in its own copy of the translation, so it only ever reads the Quran
 * and never text a caller made up. The key stays in the ELEVENLABS_API_KEY
 * binding: the browser only ever receives the MP3.
 *
^ * Eleven v4 is read over the Text to Dialogue WebSocket, and v4
 * has no speed setting. The reading is slowed with longer pauses written into
 * the text here, and with a slower playback rate in the reader.
 */

import { QuranData } from "../src/lib/quran-data.ts";
import { READER_MODEL_ID, READER_VOICE_ID, pacedText, wordTimings } from "./pacing.ts";
import type { AlignmentChunk } from "./pacing.ts";

const OUTPUT_FORMAT = "mp3_44100_128";
/** Bump this when the voice, model or pacing changes, so old cached audio is not served. */
const SPEECH_VERSION = "3";
const TRANSLATION_FILE = "/en.hilali.txt";
const DIALOGUE_URL = `https://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=${READER_MODEL_ID}&output_format=${OUTPUT_FORMAT}&sync_alignment=true`;
/** Give up on a reading that takes longer than this. */
const SPEECH_TIMEOUT_MS = 60_000;

let translation: Promise<Map<string, string>> | null = null;

/** Loads the translation from the Worker's static assets once per isolate. */
function loadTranslation(env: Env, origin: string): Promise<Map<string, string>> {
	translation ??= (async () => {
		const response = await env.ASSETS.fetch(new URL(TRANSLATION_FILE, origin));
		if (!response.ok) throw new Error(`Translation asset failed (${response.status}).`);
		const verses = new Map<string, string>();
		for (const line of (await response.text()).split("\n")) {
			const [chapter, verse, ...rest] = line.split("|");
			if (chapter && verse && rest.length) verses.set(`${chapter}:${verse}`, rest.join("|"));
		}
		return verses;
	})().catch(error => {
		translation = null;
		throw error;
	});
	return translation;
}

interface Reading {
	audio: Uint8Array<ArrayBuffer>;
	words: [number, number][];
}

/** Readings being made right now, so the audio and its timings are paid for once. */
const pendingReadings = new Map<string, Promise<Reading>>();

/** Reads the text with Eleven v4 over the Text to Dialogue WebSocket. */
async function synthesize(text: string, apiKey: string): Promise<Reading> {
	const upgrade = await fetch(DIALOGUE_URL, { headers: { Upgrade: "websocket" } });
	const socket = upgrade.webSocket;
	if (!socket) throw new Error(`ElevenLabs refused the WebSocket (${upgrade.status}).`);
	socket.accept();

	return new Promise<Reading>((resolve, reject) => {
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		const alignment: AlignmentChunk[] = [];
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {
				// Already closed.
			}
			if (error) {
				reject(error);
				return;
			}
			if (!chunks.length) {
				reject(new Error("ElevenLabs returned no audio."));
				return;
			}
			const audio = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
			let offset = 0;
			for (const chunk of chunks) {
				audio.set(chunk, offset);
				offset += chunk.length;
			}
			resolve({ audio, words: wordTimings(alignment) });
		};
		const timer = setTimeout(() => finish(new Error("The reading timed out.")), SPEECH_TIMEOUT_MS);

		socket.addEventListener("message", event => {
			let message: { audio?: string; alignment?: AlignmentChunk; is_final?: boolean; error?: unknown };
			try {
				message = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
			} catch {
				return;
			}
			if (message.error) {
				finish(new Error(`ElevenLabs error: ${JSON.stringify(message.error)}`));
				return;
			}
			if (message.audio) chunks.push(Uint8Array.from(atob(message.audio), c => c.charCodeAt(0)));
			if (message.alignment?.chars?.length) alignment.push(message.alignment);
			if (message.is_final) finish();
		});
		socket.addEventListener("close", () => finish());
		socket.addEventListener("error", () => finish(new Error("The ElevenLabs WebSocket failed.")));

		// The first message registers the one voice and authenticates.
		socket.send(JSON.stringify({ voices: [READER_VOICE_ID], xi_api_key: apiKey }));
		socket.send(JSON.stringify({ inputs: [{ text, voice_id: READER_VOICE_ID, new_turn: false }] }));
		// Flush the rest of the text and close after the final audio frame.
		socket.send(JSON.stringify({ close_socket: true }));
	});
}

const CACHE_CONTROL = "public, max-age=31536000, immutable";

function audioResponse(audio: BodyInit): Response {
	return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": CACHE_CONTROL } });
}

function wordsResponse(words: [number, number][]): Response {
	return Response.json({ words }, { headers: { "cache-control": CACHE_CONTROL } });
}

/**
 * Answers `GET /api/speech/<chapter>/<verse>` with the reading as MP3, and
 * `GET /api/speech/<chapter>/<verse>/words` with when each word is spoken.
 */
export async function handleSpeech(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "GET") {
		return Response.json({ error: "Use GET to ask for a reading." }, { status: 405 });
	}
	const url = new URL(request.url);
	const match = /^\/api\/speech\/(\d{1,3})\/(\d{1,3})(\/words)?$/.exec(url.pathname);
	if (!match) return Response.json({ error: "Not found" }, { status: 404 });
	const chapter = Number(match[1]);
	const verse = Number(match[2]);
	const wantsWords = Boolean(match[3]);
	// Index 0 of the Tanzil table is empty, so chapters are one-based.
	const verseCount = chapter >= 1 && chapter <= 114 ? QuranData.Sura[chapter]?.[1] ?? 0 : 0;
	if (verse < 1 || verse > verseCount) return Response.json({ error: "Not found" }, { status: 404 });

	// Each ayah is only paid for once: the audio and its timings are kept in the edge cache.
	const base = `${url.origin}/api/speech/v${SPEECH_VERSION}/${chapter}/${verse}`;
	const audioKey = new Request(`${base}.mp3`);
	const wordsKey = new Request(`${base}.json`);
	const cache = caches.default;
	const cached = await cache.match(wantsWords ? wordsKey : audioKey);
	if (cached) return cached;

	const key = `${chapter}:${verse}`;
	let text: string | undefined;
	try {
		text = (await loadTranslation(env, url.origin)).get(key);
	} catch (error) {
		console.error("Unable to load the translation for reading aloud:", error);
	}
	if (!text) return Response.json({ error: "The translation could not be read aloud." }, { status: 503 });
	if (!env.ELEVENLABS_API_KEY) {
		return Response.json({ error: "Reading aloud is not configured." }, { status: 503 });
	}

	let pending = pendingReadings.get(key);
	if (!pending) {
		pending = synthesize(pacedText(text), env.ELEVENLABS_API_KEY);
		pendingReadings.set(key, pending);
		const reading = pending;
		ctx.waitUntil(reading.then(
			({ audio, words }) => Promise.all([
				cache.put(audioKey, audioResponse(audio)),
				cache.put(wordsKey, wordsResponse(words)),
			]),
			() => undefined,
		).finally(() => pendingReadings.delete(key)));
	}
	let reading: Reading;
	try {
		reading = await pending;
	} catch (error) {
		console.error("Unable to read the translation aloud:", error);
		return Response.json({ error: "The translation could not be read aloud." }, { status: 502 });
	}
	return wantsWords ? wordsResponse(reading.words) : audioResponse(reading.audio.slice());
}

/**
 * Answers `GET /api/speech/status`: whether the ElevenLabs account has run out
 * of credits, and when they come back. The reader asks only after a reading
 * failed, so it can say why instead of blaming the connection.
 */
export async function handleSpeechStatus(env: Env): Promise<Response> {
	const headers = { "cache-control": "no-store" };
	if (!env.ELEVENLABS_API_KEY) return Response.json({ configured: false }, { headers });
	try {
		const response = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
			headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
		});
		if (!response.ok) throw new Error(`Subscription request failed (${response.status}).`);
		const subscription = await response.json() as {
			character_count?: number;
			character_limit?: number;
			next_character_count_reset_unix?: number;
		};
		const used = subscription.character_count ?? 0;
		const limit = subscription.character_limit ?? Infinity;
		const reset = subscription.next_character_count_reset_unix;
		return Response.json({
			configured: true,
			// A reading needs room for a whole ayah, so a few characters left is as good as none.
			outOfCredits: limit - used < 200,
			resetsAt: reset ? new Date(reset * 1000).toISOString() : null,
		}, { headers });
	} catch (error) {
		console.error("Unable to check the ElevenLabs credits:", error);
		return Response.json({ configured: true, outOfCredits: null, resetsAt: null }, { headers });
	}
}
