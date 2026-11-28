import { describe, expect, it } from "vitest";
import { translationErrorMessage } from "../../src/lib/audio";

const reply = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe("why a translation reading failed", () => {
	it("says the credits are used up, and when they come back", async () => {
		const message = await translationErrorMessage(reply({ configured: true, outOfCredits: true, resetsAt: "2026-12-12T17:03:31.000Z" }));
		expect(message).toMatch(/used up this month’s ElevenLabs credits/);
		expect(message).toMatch(/12/);
		expect(message).not.toMatch(/connection/);
	});

	it("says reading aloud is not set up when the site has no key", async () => {
		expect(await translationErrorMessage(reply({ configured: false }))).toMatch(/not set up/);
	});

	it("falls back to the connection message otherwise", async () => {
		expect(await translationErrorMessage(reply({ configured: true, outOfCredits: false }))).toMatch(/connection/);
		expect(await translationErrorMessage(reply({}, 500))).toMatch(/connection/);
		expect(await translationErrorMessage((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toMatch(/connection/);
	});
});
