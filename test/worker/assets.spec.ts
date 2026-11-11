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
});
