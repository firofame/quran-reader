import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
	createSyncClient,
	createSyncSetupCode,
	DEFAULT_SYNC_ENDPOINT,
	parseSyncSetupCode,
} from "../../public/sync-client.js";

function createStorage() {
	const entries = new Map<string, string>();
	return {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => entries.set(key, value),
		removeItem: (key: string) => entries.delete(key),
	};
}

/**
 * Sends the client's requests straight to the Durable Object that owns the
 * sync space, the same way the Worker forwards them in production.
 */
function createRemoteFetch(name: string) {
	const stub = env.SYNC_DO.get(env.SYNC_DO.idFromName(name));
	return async (input: RequestInfo | URL, options: RequestInit = {}) => {
		const request = new Request("https://internal/sync", {
			method: options.method ?? "GET",
			headers: new Headers(options.headers),
			body: options.body ?? undefined,
		});
		return stub.fetch(request);
	};
}

/**
 * The reader module is plain browser JavaScript, so its inferred callback
 * types are looser than the real contract.
 */
function createClient(options: any) {
	return createSyncClient(options);
}

/** Reads a JSON response body. */
async function readJson<T = any>(response: Response): Promise<T> {
	return (await response.json()) as T;
}


describe("paired devices", () => {
	it("synchronize reading progress using timestamp-based last-write-wins", async () => {
		const remote = createRemoteFetch("paired-devices");

		let macRemoteState: any = null;
		const mac = createClient({
			storage: createStorage(),
			fetch: remote,
			debounceMs: 5,
			onRemoteUpdate: (data: any) => {
				macRemoteState = data;
			},
		});
		let phoneRemoteState: any = null;
		const phone = createClient({
			storage: createStorage(),
			fetch: remote,
			debounceMs: 5,
			onRemoteUpdate: (data: any) => {
				phoneRemoteState = data;
			},
		});
		const endpoint = DEFAULT_SYNC_ENDPOINT;
		const sharedKey = "private-paired-key";
		mac.updateConfig({ endpoint, syncKey: sharedKey });
		phone.updateConfig(parseSyncSetupCode(createSyncSetupCode(endpoint, sharedKey)));

		const initialMacState = {
			position: { chapter: 1, verse: 1 },
			translation: "en.sahih",
		};

		await mac.push(initialMacState, { updatedAt: 1000 });
		await phone.sync({ position: { chapter: 1, verse: 1 }, translation: "en.sahih" });

		// Phone advances to chapter 2, verse 1 with newer timestamp
		const phoneState = { position: { chapter: 2, verse: 1 }, translation: "en.sahih" };
		const phonePushRes = await phone.push(phoneState, { updatedAt: 2000 });
		expect(phonePushRes.success).toBe(true);
		expect(phonePushRes.data.chapter).toBe(2);
		expect(phonePushRes.data.verse).toBe(1);

		// Mac syncs and receives phone's newer position
		const macSyncRes = await mac.sync(initialMacState);
		expect(macSyncRes.success).toBe(true);
		expect(macSyncRes.data.chapter).toBe(2);
		expect(macSyncRes.data.verse).toBe(1);
		expect(macRemoteState.chapter).toBe(2);
		expect(macRemoteState.verse).toBe(1);

		// Mac navigates to chapter 3, verse 1 with even newer timestamp
		const macNewState = { position: { chapter: 3, verse: 1 }, translation: "en.sahih" };
		const macPushRes = await mac.push(macNewState, { updatedAt: 3000 });
		expect(macPushRes.success).toBe(true);
		expect(macPushRes.data.chapter).toBe(3);
		expect(macPushRes.data.verse).toBe(1);

		// Phone syncs and receives Mac's newer position
		await phone.sync(phoneState);
		expect(phoneRemoteState.chapter).toBe(3);
		expect(phoneRemoteState.verse).toBe(1);

		mac.destroy();
		phone.destroy();
	});

	it("keep newer local reading progress when an in-flight sync returns", async () => {
		const stub = env.SYNC_DO.get(env.SYNC_DO.idFromName("in-flight-sync"));
		let delayGatePromise: Promise<void> | null = null;
		const remote = async (input: RequestInfo | URL, options: RequestInit = {}) => {
			const method = options.method ?? "GET";
			if ((method === "GET" || !options.method) && delayGatePromise) {
				await delayGatePromise;
			}
			return stub.fetch(
				new Request("https://internal/sync", {
					method,
					headers: new Headers(options.headers),
					body: options.body ?? undefined,
				}),
			);
		};

		const client = createClient({
			storage: createStorage(),
			fetch: remote,
			debounceMs: 50,
		});

		const endpoint = DEFAULT_SYNC_ENDPOINT;
		const sharedKey = "shared-pairing-key";
		client.updateConfig({ endpoint, syncKey: sharedKey });

		// Cloud already has initial reading progress at chapter 1, verse 1
		await stub.fetch(
			new Request("https://internal/sync", {
				method: "PUT",
				headers: {
					"Authorization": `Bearer ${sharedKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					chapter: 1,
					verse: 1,
					translation: "en.sahih",
					updatedAt: 1000,
				}),
			}),
		);

		// Device initial state at chapter 1, verse 1
		const startState = {
			position: { chapter: 1, verse: 1 },
			translation: "en.sahih",
		};

		let releaseGet: () => void = () => {};
		delayGatePromise = new Promise<void>(resolve => {
			releaseGet = resolve;
		});

		// 1. Sync starts with chapter 1, verse 1 (GET request is delayed and in-flight)
		const syncPromise = client.sync(startState);

		// 2. User navigates to chapter 2, verse 1 while GET is pending
		const newState = {
			position: { chapter: 2, verse: 1 },
			translation: "en.sahih",
		};
		client.queuePush(newState);

		// 3. GET request completes
		releaseGet();
		const syncResult = await syncPromise;

		// 4. Assert that final reading position remains chapter 2, verse 1
		expect(syncResult.success).toBe(true);
		expect(syncResult.data.chapter, "Returned reading position chapter must remain chapter 2").toBe(2);
		expect(syncResult.data.verse, "Returned reading position verse must remain verse 1").toBe(1);

		const remoteRes = await stub.fetch(
			new Request("https://internal/sync", {
				headers: { Authorization: `Bearer ${sharedKey}` },
			}),
		);
		const remoteData = (await readJson(remoteRes)) as any;
		expect(remoteData.chapter, "Worker reading position chapter must remain chapter 2").toBe(2);
		expect(remoteData.verse, "Worker reading position verse must remain verse 1").toBe(1);

		client.destroy();
	});
});
