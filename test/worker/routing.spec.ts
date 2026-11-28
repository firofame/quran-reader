import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

/** Reads a JSON response body. */
async function readJson<T = any>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

describe("routing", () => {
	it("answers the health check", async () => {
		const response = await SELF.fetch(new Request("https://quran.example.com/health"));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toMatch(/application\/json/);
		expect(await readJson(response)).toEqual({ status: "ok", service: "quran" });
	});

	it("returns a JSON error for unknown paths", async () => {
		const response = await SELF.fetch(new Request("https://quran.example.com/unknown"));
		expect(response.status).toBe(404);
		expect((await readJson(response)).error).toBe("Not found");
	});

	it("does not read text a caller sends", async () => {
		const response = await SELF.fetch(new Request("https://quran.example.com/api/speech/1/1", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "Anything at all." }),
		}));
		expect(response.status).toBe(405);
	});

	it("answers an ayah that does not exist with not found", async () => {
		for (const path of ["/api/speech/1/8", "/api/speech/115/1", "/api/speech/one/1", "/api/speech"]) {
			const response = await SELF.fetch(new Request(`https://quran.example.com${path}`));
			expect(response.status, path).toBe(404);
			expect((await readJson(response)).error, path).toBe("Not found");
		}
	});
});
