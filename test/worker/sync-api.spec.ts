import { describe, expect, it } from "vitest";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import worker from "../../src";
import { extractAuthKey, hashSyncKey } from "../../src/auth";
import { MAX_FUTURE_SKEW_MS } from "../../src/sync-state";

const SYNC_URL = "https://quran.example.com/api/sync";

function syncRequest(method: string, body?: unknown, key = "private-pairing-key"): Request {
	return new Request(SYNC_URL, {
		method,
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/** Reads a JSON response body. */
async function readJson<T = any>(response: Response): Promise<T> {
	return (await response.json()) as T;
}


describe("pairing keys", () => {
	it("reads the key from the Authorization and X-Sync-Key headers", () => {
		expect(extractAuthKey(new Request("https://sync.example.com", { headers: { Authorization: "Bearer my-secret-token" } }))).toBe(
			"my-secret-token",
		);
		expect(
			extractAuthKey(new Request("https://sync.example.com", { headers: { Authorization: "bearer lowercase-bearer-token" } })),
		).toBe("lowercase-bearer-token");
		expect(
			extractAuthKey(new Request("https://sync.example.com", { headers: { Authorization: "bEaReR mixed-case-token" } })),
		).toBe("mixed-case-token");
		expect(extractAuthKey(new Request("https://sync.example.com", { headers: { "X-Sync-Key": "custom-key-123" } }))).toBe(
			"custom-key-123",
		);
		expect(extractAuthKey(new Request("https://sync.example.com"))).toBeNull();
	});

	it("hashes a key into a deterministic 64-character SHA-256 hex string", async () => {
		const hash1 = await hashSyncKey("my-secret-pairing-key");
		const hash2 = await hashSyncKey("my-secret-pairing-key");
		const hash3 = await hashSyncKey("different-key");

		expect(hash1.length).toBe(64);
		expect(hash1).toBe(hash2);
		expect(hash1).not.toBe(hash3);
	});
});

describe("sync API", () => {
	it("isolates data for independent sync keys", async () => {
		const put = async (syncKey: string, chapter: number) =>
			SELF.fetch(
				new Request(SYNC_URL, {
					method: "PUT",
					headers: { Authorization: `Bearer ${syncKey}`, "Content-Type": "application/json" },
					body: JSON.stringify({ chapter, verse: 1, updatedAt: Date.now() }),
				}),
			);
		const get = async (syncKey: string) =>
			SELF.fetch(new Request(SYNC_URL, { headers: { Authorization: `Bearer ${syncKey}` } }));

		expect((await put("independent-key-a", 2)).status).toBe(200);
		expect((await put("independent-key-b", 36)).status).toBe(200);

		const stateA = await readJson(await get("independent-key-a"));
		const stateB = await readJson(await get("independent-key-b"));

		expect(stateA.chapter).toBe(2);
		expect(stateB.chapter).toBe(36);
	});

	it("answers a CORS preflight with 204", async () => {
		const response = await SELF.fetch(
			new Request(SYNC_URL, { method: "OPTIONS", headers: { Origin: "https://example.com" } }),
		);
		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
		expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Sync-Key");
	});

	it("responds to the health check", async () => {
		const response = await SELF.fetch(new Request("https://quran.example.com/health"));
		expect(response.status).toBe(200);
		const body = await readJson(response);
		expect(body.status).toBe("ok");
		expect(body.service).toBe("quran");
	});

	it("returns 404 for unknown endpoints", async () => {
		const response = await SELF.fetch(new Request("https://quran.example.com/unknown"));
		expect(response.status).toBe(404);
	});

	it("rejects unauthorized requests with 401", async () => {
		const response = await SELF.fetch(new Request(SYNC_URL, { method: "GET" }));
		expect(response.status).toBe(401);
		const body = await readJson(response);
		expect(body.error).toMatch(/Unauthorized/);
	});

	it("validates the master secret when env.SYNC_SECRET is set", async () => {
		const secretEnv = { SYNC_SECRET: "master-password", SYNC_DO: env.SYNC_DO };

		const invalid = await worker.fetch(
			new Request(SYNC_URL, { method: "GET", headers: { Authorization: "Bearer wrong-password" } }),
			secretEnv,
			{} as ExecutionContext,
		);
		expect(invalid.status).toBe(401);

		const valid = await worker.fetch(
			new Request(SYNC_URL, { method: "GET", headers: { Authorization: "Bearer master-password" } }),
			secretEnv,
			{} as ExecutionContext,
		);
		expect(valid.status).toBe(200);
	});

	it("rejects unsupported methods with 405", async () => {
		const response = await SELF.fetch(
			new Request(SYNC_URL, { method: "DELETE", headers: { Authorization: "Bearer private-pairing-key" } }),
		);
		expect(response.status).toBe(405);
		expect((await readJson(response)).error).toBe("Method not allowed");
	});

	it("accepts POST as an alias for PUT", async () => {
		const response = await SELF.fetch(
			new Request(SYNC_URL, {
				method: "POST",
				headers: { Authorization: "Bearer post-alias-key", "Content-Type": "application/json" },
				body: JSON.stringify({ chapter: 18, verse: 1, translation: "en.sahih", updatedAt: Date.now() }),
			}),
		);
		expect(response.status).toBe(200);
		expect((await readJson(response)).chapter).toBe(18);
	});

	it("rejects invalid JSON bodies and invalid state payloads with 400", async () => {
		const brokenJson = await SELF.fetch(
			new Request(SYNC_URL, {
				method: "PUT",
				headers: { Authorization: "Bearer private-pairing-key", "Content-Type": "application/json" },
				body: "{not json",
			}),
		);
		expect(brokenJson.status).toBe(400);
		expect((await readJson(brokenJson)).error).toBe("Invalid JSON body");

		for (const payload of [
			{ chapter: 999, verse: 1, updatedAt: Date.now() },
			{ chapter: 2, verse: 0, updatedAt: Date.now() },
			{ chapter: 2, verse: 1 },
			{ chapter: 2, verse: 1, updatedAt: Date.now() + MAX_FUTURE_SKEW_MS + 5000 },
			{ chapter: 2, verse: 1, updatedAt: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			const response = await SELF.fetch(syncRequest("PUT", payload));
			expect(response.status, JSON.stringify(payload)).toBe(400);
			expect((await readJson(response)).error).toBe("Invalid state payload.");
		}
	});
});

describe("sync Durable Object", () => {
	it("stores a reading position and applies timestamp-based last-write-wins", async () => {
		const id = env.SYNC_DO.idFromName("durable-object-lww");
		const stub = env.SYNC_DO.get(id);

		const empty = await readJson(await stub.fetch(new Request("https://internal/sync")));
		expect(empty.empty).toBe(true);
		expect(empty.updatedAt).toBe(0);

		const invalid = await stub.fetch(
			new Request("https://internal/sync", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chapter: 999, verse: 1, updatedAt: Date.now() }),
			}),
		);
		expect(invalid.status).toBe(400);

		const first = await readJson(await 
			await stub.fetch(
				new Request("https://internal/sync", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chapter: 2, verse: 255, translation: "en.sahih", updatedAt: 1000 }),
				}),
			)
		);
		expect(first.empty).toBe(false);
		expect(first.chapter).toBe(2);
		expect(first.verse).toBe(255);
		expect(first.updatedAt).toBe(1000);

		// An older timestamp never overwrites newer state.
		const older = await readJson(await 
			await stub.fetch(
				new Request("https://internal/sync", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chapter: 1, verse: 1, updatedAt: 500 }),
				}),
			)
		);
		expect(older.chapter).toBe(2);
		expect(older.verse).toBe(255);
		expect(older.updatedAt).toBe(1000);

		// The server stores the translation identifier it is given, so a device
		// running an older reader still syncs without losing its position.
		const newer = await readJson(await 
			await stub.fetch(
				new Request("https://internal/sync", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chapter: 3, verse: 18, translation: "ml.abdulhameed", updatedAt: 2000 }),
				}),
			)
		);
		expect(newer.chapter).toBe(3);
		expect(newer.verse).toBe(18);
		expect(newer.translation).toBe("ml.abdulhameed");
		expect(newer.updatedAt).toBe(2000);

		const stored = await readJson(await stub.fetch(new Request("https://internal/sync")));
		expect(stored).toEqual(newer);
	});

	it("keeps separate state for separate sync keys", async () => {
		const first = env.SYNC_DO.get(env.SYNC_DO.idFromName("isolated-key-a"));
		const second = env.SYNC_DO.get(env.SYNC_DO.idFromName("isolated-key-b"));

		await first.fetch(
			new Request("https://internal/sync", {
				method: "PUT",
				body: JSON.stringify({ chapter: 2, verse: 255, updatedAt: 100 }),
			}),
		);
		await second.fetch(
			new Request("https://internal/sync", {
				method: "PUT",
				body: JSON.stringify({ chapter: 36, verse: 1, updatedAt: 200 }),
			}),
		);

		const stateA = await readJson(await first.fetch(new Request("https://internal/sync")));
		const stateB = await readJson(await second.fetch(new Request("https://internal/sync")));

		expect(stateA.chapter).toBe(2);
		expect(stateB.chapter).toBe(36);
	});

	it("rejects unsafe and unreasonable future timestamps", async () => {
		const stub = env.SYNC_DO.get(env.SYNC_DO.idFromName("unsafe-timestamps"));
		const put = (updatedAt: number) =>
			stub.fetch(
				new Request("https://internal/sync", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chapter: 2, verse: 1, updatedAt }),
				}),
			);

		expect((await put(Number.MAX_SAFE_INTEGER + 1)).status).toBe(400);
		expect((await put(Date.now() + MAX_FUTURE_SKEW_MS + 5000)).status).toBe(400);

		const state = await readJson(await stub.fetch(new Request("https://internal/sync")));
		expect(state.empty).toBe(true);
	});

	it("repairs an already-stored unreasonable timestamp", async () => {
		const stub = env.SYNC_DO.get(env.SYNC_DO.idFromName("poisoned-timestamp"));
		const poisonedTimestamp = Date.now() + MAX_FUTURE_SKEW_MS + 5000000;

		await runInDurableObject(stub, async (instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO sync_state (id, chapter, verse, translation, updated_at) VALUES (1, ?, ?, ?, ?)",
				2,
				1,
				"en.sahih",
				poisonedTimestamp,
			);
		});

		const repaired = (await readJson(await stub.fetch(new Request("https://internal/sync")))) as any;
		expect(repaired.chapter).toBe(2);
		expect(repaired.updatedAt < poisonedTimestamp).toBe(true);

		const updated = await readJson(await 
			await stub.fetch(
				new Request("https://internal/sync", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chapter: 3, verse: 1, updatedAt: Date.now() + 1000 }),
				}),
			)
		);
		expect(updated.chapter).toBe(3);
	});

	it("adopts an existing SQLite state that still carries the retired bookmarks column", async () => {
		const stub = env.SYNC_DO.get(env.SYNC_DO.idFromName("legacy-bookmarks"));
		const updatedAt = Date.now() - 1000;

		await runInDurableObject(stub, async (instance, state) => {
			state.storage.sql.exec("DROP TABLE IF EXISTS sync_state;");
			state.storage.sql.exec(`
				CREATE TABLE sync_state (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					chapter INTEGER NOT NULL,
					verse INTEGER NOT NULL,
					bookmarks TEXT NOT NULL,
					translation TEXT,
					updated_at INTEGER NOT NULL
				);
			`);
			state.storage.sql.exec(
				"INSERT INTO sync_state (id, chapter, verse, bookmarks, translation, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
				18,
				10,
				"[]",
				"ml.abdulhameed",
				updatedAt,
			);
		});

		// The stored reading progress survives the migration.
		const state = await readJson(await stub.fetch(new Request("https://internal/sync")));
		expect(state).toEqual({
			empty: false,
			chapter: 18,
			verse: 10,
			translation: "ml.abdulhameed",
			updatedAt,
		});

		// Writing repairs the schema and keeps the migrated progress.
		await stub.fetch(
			new Request("https://internal/sync", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chapter: 18, verse: 11, updatedAt: Date.now() }),
			}),
		);

		const columns = await runInDurableObject(stub, async (instance, state) => {
			const cursor = state.storage.sql.exec("PRAGMA table_info(sync_state);");
			const rows = typeof cursor.toArray === "function" ? cursor.toArray() : [...cursor];
			return rows.map((row: any) => row.name);
		});
		expect(columns.some((column: string) => column === "bookmarks")).toBe(false);

		const repaired = (await readJson(await stub.fetch(new Request("https://internal/sync")))) as any;
		expect(repaired.chapter).toBe(18);
		expect(repaired.verse).toBe(11);
	});
});
