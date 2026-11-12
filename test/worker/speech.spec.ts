import { describe, expect, it } from "vitest";
import worker, { readAloud, type SpeechChunk } from "../../src/index";

/** A piece of a reading, with the time of every character it speaks. */
const PIECE = {
	audio_base64: "AAEC",
	alignment: {
		characters: ["I", "n", " "],
		character_start_times_seconds: [0, 0.1, 0.2],
		character_end_times_seconds: [0.1, 0.2, 0.3],
	},
};

/** The same piece, as the Worker sends it to the reader. */
const SENT_PIECE = {
	audio: "AAEC",
	characters: "In ",
	starts: [0, 0.1, 0.2],
	ends: [0.1, 0.2, 0.3],
};

/** The calls the ElevenLabs request made. */
const calls: { url: string; body: string; headers: Headers }[] = [];

/** The answer the ElevenLabs request is given. */
let answer: () => Response = () => new Response("", { status: 500 });

// The SDK keeps the fetch it is first given, so it is set up once, and the
// answer it gives is changed from test to test.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const request = new Request(input as RequestInfo, init);
	calls.push({ url: request.url, body: await request.text(), headers: request.headers });
	return answer();
}) as typeof fetch;

/** A reading request for the Worker. */
function speechRequest(body: unknown, method = "POST"): Request {
	return new Request("https://quran.example.com/api/speech", {
		method,
		headers: { "content-type": "application/json" },
		body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
	});
}

/**
 * Answers the ElevenLabs request with a reading, so the route is exercised
 * without calling the API.
 */
async function withRecordedAnswer(run: () => Promise<void>): Promise<void> {
	calls.length = 0;
	answer = () => new Response(`${JSON.stringify(PIECE)}\n`, { headers: { "content-type": "application/json" } });
	try {
		await run();
	} finally {
		answer = () => new Response("", { status: 500 });
	}
}

/**
 * A reading that stays open, so a second request can arrive while the first
 * is still being made.
 */
function openReading() {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(stream) {
			controller = stream;
		},
	});
	return {
		body,
		deliver() {
			controller.enqueue(encoder.encode(`${JSON.stringify(PIECE)}\n`));
		},
		finish() {
			controller.close();
		},
	};
}

/** Waits until the ElevenLabs request has been made. */
async function waitForTheReading(): Promise<void> {
	for (let attempt = 0; attempt < 100 && !calls.length; attempt += 1) {
		await new Promise(resolve => setTimeout(resolve, 1));
	}
}

/** The lines of JSON the Worker sends to the reader. */
async function readLines(response: Response): Promise<unknown[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	return text
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line));
}

describe("reading aloud", () => {
	it("asks Eleven v4 Turbo for the narration", async () => {
		await withRecordedAnswer(async () => {
			const chunks: SpeechChunk[] = [];
			for await (const chunk of readAloud("In the name of Allah, the Entirely Merciful.", "test-key")) {
				chunks.push(chunk);
			}
			expect(chunks).toEqual([SENT_PIECE]);
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toContain("/v1/text-to-speech/");
			expect(calls[0].url).toContain("/stream/with-timestamps");
			expect(calls[0].url).toContain("output_format=pcm_22050");
			expect(calls[0].headers.get("xi-api-key")).toBe("test-key");
			expect(JSON.parse(calls[0].body)).toEqual({
				text: "In the name of Allah, the Entirely Merciful.",
				model_id: "eleven_v4_turbo",
			});
		});
	});

	it("sends the audio and the timing of its words to the reader", async () => {
		await withRecordedAnswer(async () => {
			const response = await worker.fetch(
				speechRequest({ text: "In the name of Allah, the Entirely Merciful." }),
				{ ELEVENLABS_API_KEY: "test-key" },
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("application/x-ndjson");
			expect(await readLines(response)).toEqual([SENT_PIECE]);
		});
	});

	it("reads an ayah again without a second request", async () => {
		await withRecordedAnswer(async () => {
			const env = { ELEVENLABS_API_KEY: "test-key" };
			await worker.fetch(speechRequest({ text: "A reading that is asked for twice." }), env);
			await worker.fetch(speechRequest({ text: "A reading that is asked for twice." }), env);
			expect(calls).toHaveLength(1);
		});
	});

	it("waits for a reading that is already being made", async () => {
		calls.length = 0;
		const reading = openReading();
		answer = () => new Response(reading.body, { headers: { "content-type": "application/json" } });
		try {
			const env = { ELEVENLABS_API_KEY: "test-key" };
			const first = worker.fetch(speechRequest({ text: "A reading that is already under way." }), env);
			await waitForTheReading();
			const second = worker.fetch(speechRequest({ text: "A reading that is already under way." }), env);
			reading.deliver();
			reading.finish();
			const [firstResponse, secondResponse] = await Promise.all([first, second]);
			expect(firstResponse.status).toBe(200);
			expect(secondResponse.status).toBe(200);
			expect(await readLines(secondResponse)).toEqual([SENT_PIECE]);
			expect(calls).toHaveLength(1);
		} finally {
			answer = () => new Response("", { status: 500 });
		}
	});

	it("refuses a request without any text", async () => {
		const response = await worker.fetch(speechRequest({ text: "   " }), { ELEVENLABS_API_KEY: "test-key" });
		expect(response.status).toBe(400);
	});

	it("refuses a request that is not JSON", async () => {
		const response = await worker.fetch(speechRequest("not json"), { ELEVENLABS_API_KEY: "test-key" });
		expect(response.status).toBe(400);
	});

	it("refuses a reading that is too long", async () => {
		const response = await worker.fetch(speechRequest({ text: "a".repeat(2001) }), { ELEVENLABS_API_KEY: "test-key" });
		expect(response.status).toBe(413);
	});

	it("asks for a POST", async () => {
		const response = await worker.fetch(speechRequest({ text: "A reading." }, "GET"), { ELEVENLABS_API_KEY: "test-key" });
		expect(response.status).toBe(405);
	});

	it("reports that reading aloud is not configured without a key", async () => {
		const response = await worker.fetch(speechRequest({ text: "A reading." }), { ELEVENLABS_API_KEY: "" });
		expect(response.status).toBe(503);
	});
});
