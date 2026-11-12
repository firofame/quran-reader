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
/** The longest translation the reader asks to be read in one request. */
const MAX_SPEECH_CHARACTERS = 2000;
/** How many readings are kept, so a second reading of the same ayah is free. */
const SPEECH_CACHE_SIZE = 16;

/** The readings this isolate has already made, oldest first. */
const speechCache = new Map<string, Uint8Array>();

/** Reads the text of a request body, or an empty string when it is unusable. */
function readRequestedText(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const text = (payload as { text?: unknown }).text;
	if (typeof text !== "string") return "";
	// The translation is read as one passage, so line breaks become pauses.
	return text.replace(/\s+/g, " ").trim();
}

/** Keeps the cache small, because every entry holds a whole ayah of audio. */
function rememberSpeech(text: string, audio: Uint8Array): void {
	speechCache.set(text, audio);
	while (speechCache.size > SPEECH_CACHE_SIZE) {
		const oldest = speechCache.keys().next();
		if (oldest.done) return;
		speechCache.delete(oldest.value);
	}
}

/** Sends the recorded reading back to the reader. */
function speechResponse(audio: Uint8Array): Response {
	return new Response(audio, {
		headers: {
			"content-type": "audio/mpeg",
			"content-length": String(audio.byteLength),
			"cache-control": "no-store",
		},
	});
}

/**
 * Reads text aloud with Eleven v4 Turbo and returns the audio.
 *
 * The key comes from the Worker binding, so it never reaches the browser.
 * The SDK is loaded on the first reading: it is a large package, and the
 * Worker has a small startup budget.
 */
export async function readAloud(text: string, apiKey: string): Promise<Uint8Array> {
	const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
	const client: ElevenLabsClientType = new ElevenLabsClient({ apiKey });
	const audio = await client.textToSpeech.convert(READER_VOICE_ID, {
		text,
		modelId: READER_MODEL_ID,
		outputFormat: "mp3_44100_128",
	});
	// The audio is read whole, so the next reading of the same ayah is free.
	return new Uint8Array(await new Response(audio).arrayBuffer());
}

/**
 * Reads an ayah translation aloud with Eleven v4 Turbo.
 *
 * The key never reaches the browser: it stays in the Worker binding, and the
 * reader only ever receives the audio.
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
	if (cached) return speechResponse(cached);
	let recorded: Uint8Array;
	try {
		recorded = await readAloud(text, env.ELEVENLABS_API_KEY);
	} catch (error) {
		console.error("Unable to read the translation aloud:", error);
		return Response.json({ error: "The translation could not be read aloud." }, { status: 502 });
	}
	rememberSpeech(text, recorded);
	return speechResponse(recorded);
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
