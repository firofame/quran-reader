import { describe, expect, it } from "vitest";
import {
	authorizeProduction,
	createCloudflareApi,
	findWorker,
	readBindings,
	renameWorker,
	seedCanary,
	verifyWorker,
} from "../../scripts/deployment.js";

const sha = "a".repeat(40);
const repository = "firofame/quran-reader";
const worker = { id: "existing-worker-id", name: "quran" };
const binding = {
	type: "durable_object_namespace",
	name: "SYNC_DO",
	class_name: "SyncDurableObject",
	namespace_id: "existing-namespace",
};
const signature = [{ name: "SYNC_DO", className: "SyncDurableObject", namespaceId: "existing-namespace" }];

describe("production canary", () => {
	it("seeds legacy bookmark-requiring Workers without changing the reader payload", async () => {
		const state = { chapter: 2, verse: 255, translation: "en.sahih", updatedAt: Date.now() };
		let captured: any;
		await seedCanary({
			endpoint: "https://quran.firofame.workers.dev",
			key: "synthetic-private-key",
			state,
			fetch: (async (input: RequestInfo | URL, options: any = {}) => {
				if (options.method === "GET") return Response.json({ empty: true, updatedAt: 0 });
				captured = JSON.parse(options.body);
				if (!Array.isArray(captured.bookmarks)) return Response.json({ error: "Invalid state payload." }, { status: 400 });
				return Response.json({ empty: false, ...captured });
			}) as any,
		});
		expect(captured).toEqual({ ...state, bookmarks: [] });
		expect(Object.hasOwn(state, "bookmarks")).toBe(false);
	});

	it("rejects existing state and unsuccessful legacy writes", async () => {
		const options = {
			endpoint: "https://quran.firofame.workers.dev",
			key: "synthetic-private-key",
			state: { chapter: 2, verse: 255, translation: "en.sahih", updatedAt: Date.now() },
		};
		await expect(
			seedCanary({ ...options, fetch: async () => Response.json({ empty: false }) }),
		).rejects.toThrow(/existing state/);
		await expect(
			seedCanary({
				...options,
				fetch: (async (input: RequestInfo | URL, requestOptions: any = {}) =>
					requestOptions.method === "GET"
						? Response.json({ empty: true })
						: Response.json({ error: "Rejected" }, { status: 400 })) as any,
			}),
		).rejects.toThrow(/HTTP 400/);
	});
});

function authorizationOptions() {
	const roles = new Map<string, string>([
		["maintainer", "write"],
		["rerun-actor", "admin"],
	]);
	const state = { head: sha };
	return {
		roles,
		state,
		options: {
			eventName: "push",
			event: { sender: { login: "maintainer" } },
			ref: "refs/heads/main",
			sha,
			repository,
			actor: "rerun-actor",
			token: "test-github-token",
			fetch: async (url: string, options: any) => {
				expect(options.redirect).toBe("error");
				expect(options.signal).toBeTruthy();
				const path = new URL(url).pathname;
				if (path.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: state.head } });
				const login = path.match(/collaborators\/([^/]+)\/permission$/)?.[1];
				expect(login, `Unexpected GitHub request: ${path}`).toBeTruthy();
				return Response.json({ permission: roles.get(login!) });
			},
		},
	};
}

function cloudflareApi(fetch: any) {
	return createCloudflareApi({ accountId: "a".repeat(32), token: "test-cloudflare-token", fetch });
}

function mockApi({ existing = worker, bindings = [binding], renamed = worker }: { existing?: any; bindings?: any[]; renamed?: any } = {}) {
	const calls: any[] = [];
	const api = cloudflareApi(async (input: RequestInfo | URL, options: any = {}) => {
		const path = new URL(String(input)).pathname.split("/workers/")[1];
		calls.push({ path, ...options });
		expect(options.redirect).toBe("error");
		expect(options.signal).toBeTruthy();
		if (options.method === "PATCH") return Response.json({ success: true, result: renamed });
		if (path === "workers/quran" && existing.name !== "quran") return Response.json({ success: false }, { status: 404 });
		if (path === `workers/${existing.name}`) return Response.json({ success: true, result: existing });
		if (path.endsWith("/deployments")) {
			return Response.json({
				success: true,
				result: { deployments: [{ versions: [{ version_id: "active-version", percentage: 100 }] }] },
			});
		}
		if (path.endsWith("/versions/active-version")) {
			return Response.json({ success: true, result: { resources: { bindings } } });
		}
		throw new Error(`Unexpected Cloudflare request: ${path}`);
	});
	return { api, calls };
}

describe("production authorization", () => {
	it("accepts maintainers on the current main head", async () => {
		for (const role of ["write", "maintain", "admin"]) {
			const { options, roles } = authorizationOptions();
			roles.set("maintainer", role);
			await authorizeProduction(options as any);
		}
	});

	it("rejects actors without repository write access", async () => {
		for (const login of ["maintainer", "rerun-actor"]) {
			for (const role of ["read", "triage", "none"]) {
				const { options, roles } = authorizationOptions();
				roles.set(login, role);
				await expect(authorizeProduction(options as any)).rejects.toThrow(/repository write access/);
			}
		}
	});

	it("rejects events that are not a push or a manual run on main", async () => {
		const changes = [
			(options: any) => {
				options.eventName = "pull_request";
			},
			(options: any) => {
				options.eventName = "pull_request_target";
			},
			(options: any) => {
				options.eventName = "workflow_dispatch";
				options.ref = "refs/heads/topic";
			},
			(options: any) => {
				options.ref = "refs/heads/other";
			},
		];
		for (const change of changes) {
			const { options } = authorizationOptions();
			change(options);
			await expect(authorizeProduction(options as any)).rejects.toThrow(/not authorized/);
		}
	});

	it("permits manual runs on main but rejects stale main revisions", async () => {
		for (const eventName of ["push", "workflow_dispatch"]) {
			const { options, state } = authorizationOptions();
			options.eventName = eventName;
			options.ref = "refs/heads/main";
			await authorizeProduction(options as any);
			state.head = "b".repeat(40);
			await expect(authorizeProduction(options as any)).rejects.toThrow(/current main head/);
		}
	});

	it("surfaces unavailable GitHub permission checks and missing credentials", async () => {
		const { options } = authorizationOptions();
		await expect(authorizeProduction({ ...options, token: "" } as any)).rejects.toThrow(/credentials/);
		await expect(
			authorizeProduction({
				...options,
				fetch: async () => Response.json({ message: "Forbidden" }, { status: 403 }),
			} as any),
		).rejects.toThrow(/HTTP 403/);
	});
});

describe("Worker migration", () => {
	it("verifies same-name edit access without probing an inaccessible legacy resource", async () => {
		const { api, calls } = mockApi();
		expect(await findWorker(api)).toEqual(worker);
		expect(calls.length).toBe(1);
		await renameWorker(api, worker);
		const patch = calls.find(call => call.method === "PATCH");
		expect(patch.path).toBe(`workers/${worker.id}`);
		expect(JSON.parse(patch.body)).toEqual({ name: "quran" });
	});

	it("renames the legacy Worker by immutable identity", async () => {
		const existing = { ...worker, name: "quran-reader-sync" };
		const { api, calls } = mockApi({ existing });
		expect(await findWorker(api)).toEqual(existing);
		await renameWorker(api, existing);
		expect(calls.slice(0, 2).map(call => call.path)).toEqual(["workers/quran", "workers/quran-reader-sync"]);
		expect(calls.at(-1).path).toBe(`workers/${worker.id}`);
	});

	it("falls back only on 404, never on authorization or server failures", async () => {
		for (const status of [401, 403, 409, 500]) {
			let calls = 0;
			const api = cloudflareApi(async () => {
				calls++;
				return Response.json({ success: false }, { status });
			});
			await expect(findWorker(api)).rejects.toThrow(new RegExp(`HTTP ${status}`));
			expect(calls).toBe(1);
		}
		const absent = cloudflareApi(async () => Response.json({ success: false }, { status: 404 }));
		await expect(findWorker(absent)).rejects.toThrow(/refusing to create a replacement/);
	});

	it("rejects HTTP-success API failures, invalid JSON, and unexpected identities", async () => {
		for (const response of [
			Response.json({ success: false, result: worker }),
			Response.json({ success: true }),
			new Response("{invalid-json"),
			Response.json({ success: true, result: { name: "quran" } }),
		]) {
			await expect(findWorker(cloudflareApi(async () => response))).rejects.toThrow(
				/API success|invalid JSON|unexpected Worker identity/,
			);
		}
		const { api } = mockApi({ renamed: { ...worker, id: "replacement-id" } });
		await expect(renameWorker(api, worker)).rejects.toThrow(/preserve the expected identity/);
	});

	it("surfaces name conflicts and transport failures without mutation retries", async () => {
		const conflict = cloudflareApi(async () => Response.json({ success: false }, { status: 409 }));
		await expect(renameWorker(conflict, worker)).rejects.toThrow(/HTTP 409/);
		const offline = cloudflareApi(async () => {
			throw new Error("Network unavailable");
		});
		await expect(findWorker(offline)).rejects.toThrow(/Network unavailable/);
	});
});

describe("Worker deployment", () => {
	it("verifies the active Durable Object namespace, not just the class name", async () => {
		const { api } = mockApi();
		expect(await readBindings(api, "quran")).toEqual(signature);
		await verifyWorker(api, { workerId: worker.id, bindings: signature });
		await expect(verifyWorker(api, { workerId: "different-worker", bindings: signature })).rejects.toThrow(
			/Worker identity/,
		);
		const changed = mockApi({ bindings: [{ ...binding, namespace_id: "replacement-namespace" }] });
		await expect(verifyWorker(changed.api, { workerId: worker.id, bindings: signature })).rejects.toThrow(
			/namespace bindings/,
		);
	});

	it("rejects missing or unverifiable Durable Object bindings and inactive deployments", async () => {
		for (const bindings of [[], [{ ...binding, namespace_id: undefined }], [{ ...binding, class_name: "OtherClass" }]]) {
			await expect(readBindings(mockApi({ bindings }).api, "quran")).rejects.toThrow(/Cannot verify/);
		}
		const inactive = cloudflareApi(async () => Response.json({ success: true, result: { deployments: [] } }));
		await expect(readBindings(inactive, "quran")).rejects.toThrow(/no active deployment/);
	});

	it("rejects active versions with conflicting namespaces", async () => {
		const api = cloudflareApi(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/deployments")) {
				return Response.json({
					success: true,
					result: {
						deployments: [
							{
								versions: [
									{ version_id: "first", percentage: 50 },
									{ version_id: "second", percentage: 50 },
								],
							},
						],
					},
				});
			}
			const namespace_id = url.endsWith("/first") ? "first-namespace" : "second-namespace";
			return Response.json({ success: true, result: { resources: { bindings: [{ ...binding, namespace_id }] } } });
		});
		await expect(readBindings(api, "quran")).rejects.toThrow(/conflicting Durable Object namespaces/);
	});
});
