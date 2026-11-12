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

	it("no longer answers a request for a reading", async () => {
		const response = await SELF.fetch(new Request("https://quran.example.com/api/speech", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "In the name of Allah, the Entirely Merciful." }),
		}));
		expect(response.status).toBe(404);
		expect((await readJson(response)).error).toBe("Not found");
	});
});
