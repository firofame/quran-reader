/**
 * Quran Reader — Cloudflare Worker.
 *
 * The reader itself is served from `public/` as Workers Static Assets. This
 * script answers the health check, the JSON fallback for unknown paths, and
 * the reading request that turns an ayah translation into speech.
 */

import type { ElevenLabsClient as ElevenLabsClientType } from "@elevenlabs/elevenlabs-js";

/** The premade voice that reads the translation: George, a warm narrator. */
const READER_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
/** Eleven v4 Turbo, the fast model of the v4 family. */
const READER_MODEL_ID = "eleven_v4_turbo";
/**
 * Raw audio, so the reader can play it as it arrives and follow the words.
 *
 * MP3 would be smaller, but the browser would need Media Source Extensions to
 * play it while it downloads, and iOS Safari does not support them.
 */
const READER_OUTPUT_FORMAT = "pcm_22050";
/** The longest translation the reader asks to be read in one request. */
const MAX_SPEECH_CHARACTERS = 2000;
/** How many readings are kept, so a second reading of the same ayah is free. */
const SPEECH_CACHE_SIZE = 16;
/** How much audio the cache may hold, so a long reading cannot fill the Worker. */
const SPEECH_CACHE_BYTES = 8 * 1024 * 1024;

/** One piece of a reading: the audio, and where every character falls in it. */
export interface SpeechChunk {
	/** The audio of this piece, as base64 encoded PCM samples. */
	audio: string;
	/** The characters this piece speaks. */
	characters: string;
	/** When each character starts, in seconds from the start of the reading. */
	starts: number[];
	/** When each character ends, in seconds from the start of the reading. */
	ends: number[];
}

/** The readings this isolate has already made, oldest first. */
const speechCache = new Map<string, { chunks: SpeechChunk[]; bytes: number }>();
/** The readings being made right now, so a repeat request waits for the first. */
const pendingReadings = new Map<string, Promise<SpeechChunk[]>>();

/** Reads the text of a request body, or an empty string when it is unusable. */
function readRequestedText(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const text = (payload as { text?: unknown }).text;
	if (typeof text !== "string") return "";
	// The translation is read as one passage, so line breaks become pauses.
	return text.replace(/\s+/g, " ").trim();
}

/** How much audio the cache is holding right now. */
function cachedBytes(): number {
	let total = 0;
	for (const entry of speechCache.values()) total += entry.bytes;
	return total;
}

/**
 * Keeps the cache small, because every entry holds a whole ayah of audio.
 *
 * The oldest reading is dropped first, so the ayahs read most recently are the
 * ones that stay.
 */
function rememberSpeech(text: string, chunks: SpeechChunk[]): void {
	const bytes = chunks.reduce((total, chunk) => total + chunk.audio.length, 0);
	speechCache.set(text, { chunks, bytes });
	while (speechCache.size > SPEECH_CACHE_SIZE || cachedBytes() > SPEECH_CACHE_BYTES) {
		const oldest = speechCache.keys().next();
		if (oldest.done) return;
		speechCache.delete(oldest.value);
	}
}

/**
 * Reads text aloud with Eleven v4 Turbo, a piece at a time.
 *
 * The key comes from the Worker binding, so it never reaches the browser.
 * The SDK is loaded on the first reading: it is a large package, and the
 * Worker has a small startup budget.
 */
export async function* readAloud(text: string, apiKey: string): AsyncGenerator<SpeechChunk> {
	const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
	const client: ElevenLabsClientType = new ElevenLabsClient({ apiKey });
	const stream = await client.textToSpeech.streamWithTimestamps(READER_VOICE_ID, {
		text,
		modelId: READER_MODEL_ID,
		outputFormat: READER_OUTPUT_FORMAT,
	});
	for await (const piece of stream) {
		const alignment = piece.alignment;
		yield {
			audio: piece.audioBase64,
			characters: alignment?.characters.join("") ?? "",
			starts: alignment?.characterStartTimesSeconds ?? [],
			ends: alignment?.characterEndTimesSeconds ?? [],
		};
	}
}

/** Sends one line of JSON to the reader. */
function encodeChunk(chunk: SpeechChunk | { error: string }): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(chunk)}\n`);
}

/** Sends the recorded reading back to the reader, a line of JSON at a time. */
function speechResponse(chunks: SpeechChunk[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encodeChunk(chunk));
			controller.close();
		},
	});
	return new Response(body, {
		headers: {
			"content-type": "application/x-ndjson",
			"cache-control": "no-store",
		},
	});
}

/**
 * Reads the translation aloud and sends each piece on as it lands, so the
 * reading starts before the whole ayah has been made.
 */
function streamingSpeechResponse(text: string, apiKey: string): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const reading = (async () => {
				const chunks: SpeechChunk[] = [];
				try {
					for await (const chunk of readAloud(text, apiKey)) {
						chunks.push(chunk);
						controller.enqueue(encodeChunk(chunk));
					}
					// The audio is read whole, so the next reading of the same ayah is free.
					rememberSpeech(text, chunks);
				} catch (error) {
					console.error("Unable to read the translation aloud:", error);
					try {
						controller.enqueue(encodeChunk({ error: "The translation could not be read aloud." }));
					} catch {
						// The reader has gone away, and there is nobody left to tell.
					}
				}
				return chunks;
			})();
			pendingReadings.set(text, reading);
			reading.then(
				() => pendingReadings.delete(text),
				() => pendingReadings.delete(text),
			);
			reading.then(
				() => {
					try {
						controller.close();
					} catch {
						// The reader has gone away, and there is nothing left to close.
					}
				},
				() => {
					try {
						controller.close();
					} catch {
						// The reader has gone away, and there is nothing left to close.
					}
				},
			);
		},
	});
	return new Response(body, {
		headers: {
			"content-type": "application/x-ndjson",
			"cache-control": "no-store",
		},
	});
}

/**
 * Reads an ayah translation aloud with Eleven v4 Turbo.
 *
 * The key never reaches the browser: it stays in the Worker binding, and the
 * reader only ever receives the audio and the timing of its words.
 */
async function handleSpeech(request: Request, env: Env): Promise<Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "The reading request must be JSON." }, { status: 400 });
	}
	const text = readRequestedText(payload);
	if (!text) {
		return Response.json({ error: "The reading request must carry the text to read." }, { status: 400 });
	}
	if (text.length > MAX_SPEECH_CHARACTERS) {
		return Response.json({ error: "That ayah is too long to read in one request." }, { status: 413 });
	}
	if (!env.ELEVENLABS_API_KEY) {
		return Response.json({ error: "Reading aloud is not configured." }, { status: 503 });
	}
	const cached = speechCache.get(text);
	if (cached) return speechResponse(cached.chunks);
	const pending = pendingReadings.get(text);
	if (pending) {
		// The same ayah is already being read, so wait for it rather than pay twice.
		return speechResponse(await pending);
	}
	return streamingSpeechResponse(text, env.ELEVENLABS_API_KEY);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/health") {
			return Response.json({ status: "ok", service: "quran" });
		}
		if (pathname === "/api/speech") {
			if (request.method !== "POST") {
				return Response.json({ error: "Use POST to ask for a reading." }, { status: 405 });
			}
			return handleSpeech(request, env);
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
