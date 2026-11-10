/**
 * Quran Reader — Cloudflare Worker.
 *
 * One Worker serves both halves of the project:
 *
 * - the reader itself, as static assets from `public/`
 * - the cross-device sync API at `/api/sync`, backed by a SQLite Durable Object
 *
 * Routing and CORS are handled by Hono, and request payloads are validated
 * with Zod, so the API stays declarative and easy to extend.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { extractAuthKey, hashSyncKey } from "./auth";
import { InvalidSyncStateError, SyncDurableObject } from "./durable-object";
import { parseSyncState } from "./sync-state";

export { SyncDurableObject };

type Bindings = {
	Bindings: Env;
	Variables: {
		syncStub: DurableObjectStub<SyncDurableObject>;
	};
};

const app = new Hono<Bindings>();

app.use(
	"*",
	cors({
		origin: origin => origin || "*",
		allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
		allowHeaders: ["Authorization", "Content-Type", "X-Sync-Key"],
		maxAge: 86400,
	}),
);

/** Answers a CORS preflight for every path. */
app.options("*", c => c.body(null, 204));

/** Health and service check. */
app.get("/health", c =>
	c.json({
		status: "ok",
		service: "quran",
		storage: "SQLite Durable Object",
	}),
);

/**
 * Authenticates the request and resolves the Durable Object that holds the
 * sync space for the request's pairing key.
 */
app.use("/api/sync", async (c, next) => {
	const authKey = extractAuthKey(c.req.raw);
	if (!authKey) {
		return c.json({ error: "Unauthorized: Sync password or Bearer token is required." }, 401);
	}

	if (c.env.SYNC_SECRET && c.env.SYNC_SECRET !== authKey) {
		return c.json({ error: "Unauthorized: Invalid pairing key." }, 401);
	}

	if (!c.env.SYNC_DO) {
		return c.json({ error: "Server error: SYNC_DO binding is not configured." }, 500);
	}

	const keyHash = await hashSyncKey(authKey);
	c.set("syncStub", c.env.SYNC_DO.get(c.env.SYNC_DO.idFromName(keyHash)));
	await next();
});

/** Reads the stored reading position for the pairing key. */
app.get("/api/sync", async c => {
	return c.json(await c.get("syncStub").getSnapshot());
});

/** Stores a reading position for the pairing key. */
app.on(["PUT", "POST"], "/api/sync", async c => {
	let payload: unknown;
	try {
		payload = await c.req.raw.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const state = parseSyncState(payload);
	if (!state) {
		return c.json({ error: "Invalid state payload." }, { status: 400 });
	}

	try {
		return c.json(await c.get("syncStub").putState(state));
	} catch (error) {
		if (error instanceof InvalidSyncStateError) {
			return c.json({ error: error.message }, { status: 400 });
		}
		throw error;
	}
});

/** Any other method is not part of the sync contract. */
app.all("/api/sync", c => c.json({ error: "Method not allowed" }, { status: 405 }));

app.notFound(c => c.json({ error: "Not found" }, 404));

app.onError((error, c) => {
	console.error("Unhandled error while serving a request:", error);
	return c.json({ error: "Internal server error" }, 500);
});

export default {
	fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
