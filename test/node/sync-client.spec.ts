import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PREFERENCES_KEY } from "../../public/preferences-store.js";
import {
	SYNC_STORAGE_KEY,
	DEFAULT_SYNC_ENDPOINT,
	clearSyncConfig,
	createSyncClient,
	createSyncSetupCode,
	generateSyncKey,
	loadSyncConfig,
	normalizeEndpoint,
	parseSyncSetupCode,
	saveSyncConfig,
} from "../../public/sync-client.js";

/**
 * The reader module is plain browser JavaScript, so its inferred option types
 * are looser than the real contract.
 */
function createClient(options: any) {
	return createSyncClient(options);
}

function encodeSetupPayload(payload: unknown): string {
	return `QRS1-${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

function createStorage(store = new Map<string, string>()) {
	return {
		store,
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key),
	};
}

describe("setup codes", () => {
	it("round-trips generated keys with exactly the trusted endpoint and key", () => {
		const syncKey = generateSyncKey();
		const code = createSyncSetupCode(DEFAULT_SYNC_ENDPOINT, syncKey);
		expect(code).toMatch(/^QRS1-[A-Za-z0-9_-]+$/);
		expect(parseSyncSetupCode(code)).toEqual({ endpoint: DEFAULT_SYNC_ENDPOINT, syncKey });
		expect(code.length <= 4096).toBe(true);
	});

	it("normalizes surrounding whitespace, trusted URLs, and valid UTF-8 keys", () => {
		const syncKey = "café-private-key";
		const code = createSyncSetupCode(`  ${DEFAULT_SYNC_ENDPOINT}/api/sync  `, `\u2003${syncKey}\u2003`);
		expect(parseSyncSetupCode(`\u2003${code}\n`)).toEqual({ endpoint: DEFAULT_SYNC_ENDPOINT, syncKey });
		expect(
			parseSyncSetupCode(
				encodeSetupPayload({
					version: 1,
					endpoint: "https://QURAN.FIROFAME.WORKERS.DEV:443/",
					key: ` ${syncKey} `,
				}),
			),
		).toEqual({ endpoint: DEFAULT_SYNC_ENDPOINT, syncKey });
		expect(parseSyncSetupCode(code.replace("QRS1-", "QRS1- "))).toBeNull();
	});

	it("rejects invalid prefixes, Base64url, JSON, payload shapes, and versions", () => {
		for (const code of [
			undefined,
			null,
			42,
			{},
			"",
			"   ",
			"QRS2-abc",
			"qrs1-abc",
			"QRS1-",
			"QRS1-a",
			"QRS1-%%%",
			"QRS1-YQ==",
			"QRS1-e30+",
		]) {
			expect(parseSyncSetupCode(code)).toBeNull();
		}
		expect(parseSyncSetupCode(`QRS1-${Buffer.from("{bad json").toString("base64url")}`)).toBeNull();
		for (const payload of [null, [], 1, "string", {}, { version: "1" }, { version: 2 }, { version: 1, key: {} }]) {
			expect(parseSyncSetupCode(encodeSetupPayload(payload))).toBeNull();
		}
	});

	it("rejects invalid UTF-8 even in an otherwise ignored payload field", () => {
		const bytes = Buffer.concat([
			Buffer.from(`{"version":1,"endpoint":"${DEFAULT_SYNC_ENDPOINT}","key":"private-key","extra":"`),
			Buffer.from([0xff]),
			Buffer.from('"}'),
		]);
		expect(parseSyncSetupCode(`QRS1-${bytes.toString("base64url")}`)).toBeNull();
	});

	it("rejects untrusted and invalid endpoints on creation and parsing", () => {
		for (const endpoint of [
			undefined,
			null,
			{},
			"",
			"not a valid url :::",
			"https://untrusted.example",
			"http://quran.firofame.workers.dev",
			"http://localhost:8787",
			"https://quran.firofame.workers.dev:8443",
			"https://quran.firofame.workers.dev.evil.example",
			"https://quran.firofame.workers.dev@evil.example",
			"https://evil-quran.firofame.workers.dev",
		]) {
			expect(() => createSyncSetupCode(endpoint, "private-key")).toThrow(/project's sync service/);
			expect(parseSyncSetupCode(encodeSetupPayload({ version: 1, endpoint, key: "private-key" }))).toBeNull();
		}
	});

	it("enforces nonempty header-safe keys and the exact 512-character boundary", () => {
		for (const key of [
			undefined,
			null,
			42,
			{},
			"",
			" \n ",
			"a".repeat(513),
			"private\nkey",
			"private\rkey",
			"private\u0000key",
			"private\u007fkey",
			"private\u0100key",
			"private\ud83d\udd11key",
		]) {
			expect(() => createSyncSetupCode(DEFAULT_SYNC_ENDPOINT, key)).toThrow(/valid private key/);
			expect(parseSyncSetupCode(encodeSetupPayload({ version: 1, endpoint: DEFAULT_SYNC_ENDPOINT, key }))).toBeNull();
		}
		for (const syncKey of ["a".repeat(512), "é".repeat(512)]) {
			const code = createSyncSetupCode(DEFAULT_SYNC_ENDPOINT, syncKey);
			expect(parseSyncSetupCode(code)).toEqual({ endpoint: DEFAULT_SYNC_ENDPOINT, syncKey });
			expect(code.length <= 4096).toBe(true);
		}
	});

	it("accepts 4096 input characters and rejects 4097 before trimming", () => {
		const payload = JSON.stringify({ version: 1, endpoint: DEFAULT_SYNC_ENDPOINT, key: "private-key" });
		const bytes = payload + " ".repeat(3068 - Buffer.byteLength(payload));
		const code = `QRS1-${Buffer.from(bytes).toString("base64url")}`;
		expect(code.length).toBe(4096);
		expect(parseSyncSetupCode(code)).toEqual({ endpoint: DEFAULT_SYNC_ENDPOINT, syncKey: "private-key" });
		expect(parseSyncSetupCode(`${code} `)).toBeNull();
		expect(parseSyncSetupCode(`QRS1-${Buffer.from(`${bytes} `).toString("base64url")}`)).toBeNull();
	});
});

describe("sync configuration", () => {
	it("clears unsupported settings before requests and preserves local reading data", async () => {
		const reading = JSON.stringify({ position: { chapter: 2, verse: 255 }, translation: "en.sahih" });
		for (const endpoint of ["https://custom.example", "http://localhost:8787", ""]) {
			const store = new Map<string, string>([
				[PREFERENCES_KEY, reading],
				[SYNC_STORAGE_KEY, JSON.stringify({ explicitlyConfigured: true, endpoint, syncKey: "old-key", autoSync: true })],
			]);
			const storage = createStorage(store);
			let fetchCalls = 0;
			const client = createClient({
				storage,
				fetch: async () => {
					fetchCalls++;
					throw new Error("Must not fetch");
				},
			});
			expect(store.has(SYNC_STORAGE_KEY)).toBe(false);
			expect(store.get(PREFERENCES_KEY)).toBe(reading);
			expect(client.isConfigured()).toBe(false);
			expect(client.getStatus().message).toMatch(/Start syncing or join again/);
			expect((await client.pull()).reason).toBe("unconfigured");
			expect((await client.push({ position: { chapter: 1, verse: 1 } })).reason).toBe("unconfigured");
			expect((await client.sync({ position: { chapter: 1, verse: 1 } })).reason).toBe("unconfigured");
			client.queuePush({ position: { chapter: 1, verse: 1 } });
			expect(fetchCalls).toBe(0);
			client.destroy();
		}
	});

	it("rejects invalid configuration explicitly without storing or sending it", async () => {
		const store = new Map<string, string>();
		const storage = createStorage(store);
		let fetchCalls = 0;
		const client = createClient({
			storage,
			fetch: async () => {
				fetchCalls++;
				throw new Error("Must not fetch");
			},
		});
		for (const config of [
			{ endpoint: "https://custom.example", syncKey: "private-key" },
			{ endpoint: DEFAULT_SYNC_ENDPOINT, syncKey: "private\nkey" },
		]) {
			expect(() => client.updateConfig(config)).toThrow(/valid private key/);
			expect(client.getStatus().status).toBe("error");
			expect(client.isConfigured()).toBe(false);
			expect(store.has(SYNC_STORAGE_KEY)).toBe(false);
			expect((await client.pull()).reason).toBe("unconfigured");
		}
		expect(fetchCalls).toBe(0);
		client.destroy();
	});

	it("loads defaults when storage is empty or corrupted", () => {
		const store = new Map<string, string>();
		const storage = createStorage(store);

		const emptyConfig = loadSyncConfig(storage);
		expect(emptyConfig.endpoint).toBe("");
		expect(emptyConfig.syncKey).toBe("");
		expect(emptyConfig.lastSyncedAt).toBe(0);
		expect(emptyConfig.lastUpdatedAt).toBe(0);
		expect(emptyConfig.autoSync).toBe(false);

		store.set(SYNC_STORAGE_KEY, "{corrupt-json");
		const corruptedConfig = loadSyncConfig(storage);
		expect(corruptedConfig.endpoint).toBe("");
		expect(corruptedConfig.syncKey).toBe("");

		store.set(SYNC_STORAGE_KEY, "null");
		expect(loadSyncConfig(storage).endpoint).toBe("");
	});

	it("saves, loads, and clears valid configuration", () => {
		const store = new Map<string, string>();
		const storage = createStorage(store);

		const config = {
			explicitlyConfigured: true,
			endpoint: DEFAULT_SYNC_ENDPOINT,
			syncKey: "secret-key-123",
			lastSyncedAt: 1000,
			lastUpdatedAt: 1000,
			autoSync: true,
		};

		saveSyncConfig(storage, config);
		expect(store.has(SYNC_STORAGE_KEY)).toBe(true);
		const loaded = loadSyncConfig(storage);
		expect(loaded).toEqual(config);

		clearSyncConfig(storage);
		expect(store.has(SYNC_STORAGE_KEY)).toBe(false);
	});

	it("clears legacy settings that did not record explicit consent", async () => {
		const store = new Map<string, string>([
			[
				SYNC_STORAGE_KEY,
				JSON.stringify({
					endpoint: DEFAULT_SYNC_ENDPOINT,
					syncKey: "legacy-shared-key",
					autoSync: true,
				}),
			],
		]);
		const storage = createStorage(store);

		let fetchCalled = false;
		const client = createClient({
			storage,
			fetch: async () => {
				fetchCalled = true;
				throw new Error("Legacy configuration must not sync.");
			},
		});

		expect(client.isConfigured()).toBe(false);
		expect(client.getConfig().syncKey).toBe("");
		expect(store.has(SYNC_STORAGE_KEY)).toBe(false);
		const syncResult = await client.sync({ position: { chapter: 1, verse: 1 } });
		expect(syncResult.reason).toBe("unconfigured");
		client.queuePush({ position: { chapter: 1, verse: 1 } });
		expect(fetchCalled).toBe(false);
	});
});

describe("endpoints and keys", () => {
	it("sanitizes worker URLs correctly and enforces HTTPS for remote hosts", () => {
		expect(normalizeEndpoint("")).toBe("");
		expect(normalizeEndpoint("   ")).toBe("");
		expect(normalizeEndpoint("sync.example.workers.dev")).toBe("https://sync.example.workers.dev");
		expect(normalizeEndpoint("https://sync.example.workers.dev/")).toBe("https://sync.example.workers.dev");
		expect(normalizeEndpoint("https://sync.example.workers.dev/api/sync")).toBe("https://sync.example.workers.dev");
		expect(normalizeEndpoint("http://localhost:8787/api/sync")).toBe("http://localhost:8787");
		expect(normalizeEndpoint("http://127.0.0.1:8787/api/sync")).toBe("http://127.0.0.1:8787");
		expect(normalizeEndpoint("http://[::1]:8787/api/sync")).toBe("http://[::1]:8787");
		expect(normalizeEndpoint("http://app.localhost:8787")).toBe("http://app.localhost:8787");
		expect(normalizeEndpoint("http://sync.example.workers.dev")).toBe("");
		expect(normalizeEndpoint("http://insecure.example.com/api/sync")).toBe("");
		expect(normalizeEndpoint("not a valid url :::")).toBe("");
	});

	it("generates distinct, formatted sync keys", () => {
		const key1 = generateSyncKey();
		const key2 = generateSyncKey();
		expect(key1).toMatch(/^quran-(?:[0-9a-f]{8}-){5}[0-9a-f]{8}$/);
		expect(key2).toMatch(/^quran-(?:[0-9a-f]{8}-){5}[0-9a-f]{8}$/);
		expect(key1).not.toBe(key2);
	});

	it("refuses to fall back when Web Crypto is unavailable", () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
		try {
			Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
			expect(() => generateSyncKey()).toThrow(/Secure random key generation is unavailable/);
		} finally {
			Object.defineProperty(globalThis, "crypto", descriptor!);
		}
	});
});

describe("sync client", () => {
	it("safely returns without making network requests when unconfigured", async () => {
		const storage = createStorage();
		let fetchCalled = false;
		const client = createClient({
			storage,
			fetch: async () => {
				fetchCalled = true;
				throw new Error("Should not fetch");
			},
		});

		expect(client.isConfigured()).toBe(false);
		expect(client.getConfig().endpoint).toBe("");
		expect(client.getConfig().syncKey).toBe("");
		expect(client.getConfig().autoSync).toBe(false);
		const pullRes = await client.pull();
		expect(pullRes.success).toBe(false);
		expect(pullRes.reason).toBe("unconfigured");

		const pushRes = await client.push({ position: { chapter: 1, verse: 1 } });
		expect(pushRes.success).toBe(false);
		expect(pushRes.reason).toBe("unconfigured");

		const syncRes = await client.sync({ position: { chapter: 1, verse: 1 } });
		expect(syncRes.success).toBe(false);
		expect(syncRes.reason).toBe("unconfigured");

		client.queuePush({ position: { chapter: 1, verse: 1 } });
		expect(fetchCalled).toBe(false);
	});

	it("pushes local state to the worker with correct authorization and payload", async () => {
		const storage = createStorage();

		let capturedUrl = "";
		let capturedHeaders: any = null;
		let capturedBody: any = null;

		const mockFetch = async (url: string, options: any) => {
			capturedUrl = url;
			capturedHeaders = options.headers;
			capturedBody = JSON.parse(options.body);
			return {
				ok: true,
				status: 200,
				json: async () => ({
					empty: false,
					chapter: capturedBody.chapter,
					verse: capturedBody.verse,
					translation: capturedBody.translation,
					updatedAt: capturedBody.updatedAt,
				}),
			};
		};

		const client = createClient({
			storage,
			fetch: mockFetch,
		});

		client.updateConfig({
			endpoint: DEFAULT_SYNC_ENDPOINT,
			syncKey: "test-secret-key",
		});
		expect(client.isConfigured()).toBe(true);

		const localState = {
			position: { chapter: 2, verse: 255 },
			translation: "en.sahih",
		};

		const res = await client.push(localState);
		expect(res.success).toBe(true);
		expect(capturedUrl).toBe(`${DEFAULT_SYNC_ENDPOINT}/api/sync`);
		expect(capturedHeaders.Authorization).toBe("Bearer test-secret-key");
		expect(capturedHeaders["X-Sync-Key"]).toBe("test-secret-key");
		expect(capturedBody.chapter).toBe(2);
		expect(capturedBody.verse).toBe(255);
		expect(capturedBody.translation).toBe("en.sahih");
		expect(capturedBody.updatedAt > 0).toBe(true);

		const status = client.getStatus();
		expect(status.status).toBe("synced");
		expect(status.lastSyncedAt > 0).toBe(true);
	});

	it("pulls newer remote state and triggers onRemoteUpdate", async () => {
		const storage = createStorage();

		const remotePayload = {
			empty: false,
			chapter: 3,
			verse: 18,
			translation: "ml.abdulhameed",
			updatedAt: 500000,
		};

		let remoteUpdateReceived: any = null;
		const client = createClient({
			storage,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => remotePayload,
			}),
			onRemoteUpdate: (data: any) => {
				remoteUpdateReceived = data;
			},
		});

		client.updateConfig({
			endpoint: DEFAULT_SYNC_ENDPOINT,
			syncKey: "test-secret-key",
			lastUpdatedAt: 1000, // Local is older than remote (1000 < 500000)
		});

		const res = await client.pull();
		expect(res.success).toBe(true);
		expect(res.updated).toBe(true);
		expect(remoteUpdateReceived).toEqual(remotePayload);
		expect(client.getConfig().lastSyncedAt).toBe(500000);
	});

	it("handles network failure gracefully without throwing", async () => {
		const storage = createStorage();

		let lastStatus: any = null;
		const client = createClient({
			storage,
			fetch: async () => {
				throw new TypeError("Failed to fetch");
			},
			onStatusChange: (status: any) => {
				lastStatus = status;
			},
		});

		client.updateConfig({
			endpoint: DEFAULT_SYNC_ENDPOINT,
			syncKey: "test-secret-key",
		});

		const res = await client.sync({ position: { chapter: 1, verse: 1 } });
		expect(res.success).toBe(false);
		expect(lastStatus.status).toBe("offline");
		expect(lastStatus.message).toMatch(/Failed to fetch/);
	});

	it("maps HTTP error codes to friendly messages", async () => {
		const storage = createStorage();

		let lastStatus: any = null;
		let mockStatus = 401;
		const client = createClient({
			storage,
			fetch: async () => ({
				ok: false,
				status: mockStatus,
				text: async () => JSON.stringify({ error: "Unauthorized: Invalid pairing key." }),
			}),
			onStatusChange: (status: any) => {
				lastStatus = status;
			},
		});

		client.updateConfig({
			endpoint: DEFAULT_SYNC_ENDPOINT,
			syncKey: "wrong-key",
		});

		await client.pull();
		expect(lastStatus.status).toBe("error");
		expect(lastStatus.message).toBe("This setup code was not accepted.");

		mockStatus = 404;
		await client.pull();
		expect(lastStatus.status).toBe("error");
		expect(lastStatus.message).toBe("The sync service could not be found. Try again later.");

		mockStatus = 500;
		await client.pull();
		expect(lastStatus.status).toBe("error");
		expect(lastStatus.message).toBe("Sync service error (500).");
	});

	it("debounces queuePush and coalesces rapid local updates", async () => {
		const storage = createStorage();

		let pushes = 0;
		let lastPushedVerse = 0;

		const client = createClient({
			storage,
			debounceMs: 50,
			fetch: async (url: string, options: any) => {
				pushes++;
				const body = JSON.parse(options.body);
				lastPushedVerse = body.verse;
				return {
					ok: true,
					status: 200,
					json: async () => ({ empty: false, chapter: 1, verse: body.verse, updatedAt: body.updatedAt }),
				};
			},
		});

		client.updateConfig({
			endpoint: DEFAULT_SYNC_ENDPOINT,
			syncKey: "test-secret",
		});

		// Rapidly queue 3 pushes
		client.queuePush({ position: { chapter: 1, verse: 1 } });
		client.queuePush({ position: { chapter: 1, verse: 2 } });
		client.queuePush({ position: { chapter: 1, verse: 3 } });

		expect(pushes).toBe(0); // Not pushed yet
		await new Promise(resolve => setTimeout(resolve, 80));

		expect(pushes).toBe(1);
		expect(lastPushedVerse).toBe(3);
		client.destroy();
	});

	it("does not update lastUpdatedAt in storage when queuePush is unconfigured", () => {
		const storage = createStorage();

		const client = createClient({ storage });
		expect(client.isConfigured()).toBe(false);
		client.queuePush({ position: { chapter: 2, verse: 1 } });

		const config = client.getConfig();
		expect(config.lastUpdatedAt).toBe(0);
	});

	it("pulls remote cloud progress when a fresh device pairs", async () => {
		const storage = createStorage();

		const remotePayload = {
			empty: false,
			chapter: 18,
			verse: 1,
			translation: "en.sahih",
			updatedAt: 1000,
		};

		let remoteUpdate: any = null;
		const client = createClient({
			storage,
			fetch: async () => ({
				ok: true,
				status: 200,
				json: async () => remotePayload,
			}),
			onRemoteUpdate: (data: any) => {
				remoteUpdate = data;
			},
		});

		client.updateConfig({
			endpoint: DEFAULT_SYNC_ENDPOINT,
			syncKey: "paired-device-key",
		});

		// Fresh device has lastSyncedAt === 0
		expect(client.getConfig().lastSyncedAt).toBe(0);

		const res = await client.sync({ position: { chapter: 1, verse: 1 } });
		expect(res.success).toBe(true);
		expect(res.direction).toBe("pulled");
		expect(remoteUpdate).toEqual(remotePayload);
		expect(client.getConfig().lastSyncedAt).toBe(1000);
	});

	it("maintains monotonic timestamps when the stored timestamp is ahead of the local clock", () => {
		const storage = createStorage();

		const client = createClient({ storage });
		const futureTimestamp = Date.now() + 100000;
		client.updateConfig({
			endpoint: DEFAULT_SYNC_ENDPOINT,
			syncKey: "paired-device-key",
			lastUpdatedAt: futureTimestamp,
			lastPosition: { chapter: 1, verse: 1 },
		});

		expect(client.getConfig().lastUpdatedAt).toBe(futureTimestamp);

		// User navigates to chapter 2, verse 1
		client.queuePush({
			position: { chapter: 2, verse: 1 },
			translation: "en.sahih",
		});

		const updatedConfig = client.getConfig();
		expect(
			updatedConfig.lastUpdatedAt,
			"lastUpdatedAt must monotonically advance beyond future timestamp instead of rewinding to local clock",
		).toBe(futureTimestamp + 1);
		expect(
			updatedConfig.lastUpdatedAt > futureTimestamp,
			"lastUpdatedAt must remain strictly greater than the stored remote timestamp",
		).toBe(true);
		client.destroy();
	});
});

describe("published sources", () => {
	it("contains no shared authentication credential", async () => {
		const source = await Promise.all(
			["../../public/app.js", "../../public/sync-client.js"].map(path => readFile(fileURLToPath(new URL(path, import.meta.url).href), "utf8")),
		);

		expect(source.join("\n")).not.toMatch(/firo-quran-sync|DEFAULT_SYNC_KEY/);
	});
});
