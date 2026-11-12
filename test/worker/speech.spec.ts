import { describe, expect, it } from "vitest";
import worker, { readAloud } from "../../src/index";

/** A short recording that stands in for the audio the API returns. */
const RECORDING = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

/** A reading request for the Worker. */
function speechRequest(body: unknown, method = "POST"): Request {
	return new Request("https://quran.example.com/api/speech", {
		method,
		headers: { "content-type": "application/json" },
		body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
	});
}

/**
 * Answers the ElevenLabs request with a recording, so the route is exercised
 * without calling the API.
 */
async function withRecordedAnswer(run: (calls: { url: string; body: string; headers: Headers }[]) => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	const calls: { url: string; body: string; headers: Headers }[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input as RequestInfo, init);
		calls.push({ url: request.url, body: await request.text(), headers: request.headers });
		return new Response(RECORDING, { headers: { "content-type": "audio/mpeg" } });
	}) as typeof fetch;
	try {
		await run(calls);
	} finally {
		globalThis.fetch = original;
	}
}

describe("reading aloud", () => {
	it("asks Eleven v4 Turbo for the narration", async () => {
		await withRecordedAnswer(async calls => {
			const audio = await readAloud("In the name of Allah, the Entirely Merciful.", "test-key");
			expect(audio).toEqual(RECORDING);
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toContain("/v1/text-to-speech/");
			expect(calls[0].url).toContain("output_format=mp3_44100_128");
			expect(calls[0].headers.get("xi-api-key")).toBe("test-key");
			expect(JSON.parse(calls[0].body)).toEqual({
				text: "In the name of Allah, the Entirely Merciful.",
				model_id: "eleven_v4_turbo",
			});
		});
	});

	it("answers the reader with the recording", async () => {
		await withRecordedAnswer(async () => {
			const response = await worker.fetch(
				speechRequest({ text: "In the name of Allah, the Entirely Merciful." }),
				{ ELEVENLABS_API_KEY: "test-key" },
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("audio/mpeg");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(RECORDING);
		});
	});

	it("reads an ayah again without a second request", async () => {
		await withRecordedAnswer(async calls => {
			const env = { ELEVENLABS_API_KEY: "test-key" };
			await worker.fetch(speechRequest({ text: "A reading that is asked for twice." }), env);
			await worker.fetch(speechRequest({ text: "A reading that is asked for twice." }), env);
			expect(calls).toHaveLength(1);
		});
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
