/**
 * Cloudflare Worker + SQLite-backed Durable Object for Quran Reader sync.
 *
 * Provides strongly consistent, zero-lag cross-device synchronization of:
 * - Current reading position (chapter & verse)
 * - Active translation preference
 * - Timestamp-based position and translation conflict resolution
 */

let BaseDurableObject = class {};
try {
  const cf = await import("cloudflare:workers");
  if (cf && cf.DurableObject) {
    BaseDurableObject = cf.DurableObject;
  }
} catch {
  // Running in Node.js test environment or non-Cloudflare runtime
}

export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function isValidTimestamp(value, now = Date.now()) {
  return Number.isSafeInteger(value) && value > 0 && value <= now + MAX_FUTURE_SKEW_MS;
}

export class SyncDurableObject extends BaseDurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.state = ctx;
    this.env = env;
    this.sql = ctx?.storage?.sql;

    if (this.sql) {
      if (typeof ctx?.blockConcurrencyWhile === "function") {
        ctx.blockConcurrencyWhile(async () => {
          this.initDatabase();
        });
      } else {
        this.initDatabase();
      }
    }
  }

  initDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        chapter INTEGER NOT NULL,
        verse INTEGER NOT NULL,
        translation TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    try {
      this.sql.exec("ALTER TABLE sync_state DROP COLUMN bookmarks;");
    } catch {}
  }

  async fetch(request) {
    const method = request.method.toUpperCase();

    if (method === "GET") {
      return this.getState();
    }

    if (method === "PUT" || method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      return this.putState(payload);
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  getState() {
    if (this.sql) {
      const cursor = this.sql.exec(
        "SELECT chapter, verse, translation, updated_at FROM sync_state WHERE id = 1"
      );
      const rows = typeof cursor.toArray === "function" ? cursor.toArray() : [...cursor];

      if (rows.length === 0) {
        return Response.json({ empty: true, updatedAt: 0 });
      }

      const row = rows[0];
      const now = Date.now();
      const storedUpdatedAt = Number(row.updated_at);
      const validStoredTimestamp = isValidTimestamp(storedUpdatedAt, now);
      const updatedAt = validStoredTimestamp ? storedUpdatedAt : now;

      if (!validStoredTimestamp) {
        this.sql.exec(
          "UPDATE sync_state SET updated_at = ? WHERE id = 1",
          updatedAt
        );
      }

      return Response.json({
        empty: false,
        chapter: row.chapter,
        verse: row.verse,
        translation: row.translation || null,
        updatedAt,
      });
    }

    return this.getStateFallback();
  }

  async getStateFallback() {
    const record = await this.state.storage?.get?.("sync_state");
    if (!record) {
      return Response.json({ empty: true, updatedAt: 0 });
    }
    const now = Date.now();
    const storedUpdatedAt = Number(record.updatedAt);
    const validStoredTimestamp = isValidTimestamp(storedUpdatedAt, now);
    const updatedAt = validStoredTimestamp ? storedUpdatedAt : now;
    return Response.json({
      empty: false,
      chapter: record.chapter,
      verse: record.verse,
      translation: record.translation || null,
      updatedAt,
    });
  }

  async putState(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return Response.json({ error: "Invalid state payload." }, { status: 400 });
    }

    const { chapter, verse, translation, updatedAt } = data;
    const now = Date.now();

    if (
      !Number.isSafeInteger(chapter) || chapter < 1 || chapter > 114 ||
      !Number.isSafeInteger(verse) || verse < 1 ||
      !isValidTimestamp(updatedAt, now)
    ) {
      return Response.json({ error: "Invalid state payload." }, { status: 400 });
    }

    const safeTranslation = typeof translation === "string" ? translation.slice(0, 50) : null;

    if (this.sql) {
      const cursor = this.sql.exec(
        "SELECT chapter, verse, translation, updated_at FROM sync_state WHERE id = 1"
      );
      const rows = typeof cursor.toArray === "function" ? cursor.toArray() : [...cursor];
      const existing = rows[0] || null;
      const existingUpdatedAt = existing ? Number(existing.updated_at) : 0;
      const validExistingTimestamp = Boolean(existing) && isValidTimestamp(existingUpdatedAt, now);
      const positionWins = !existing || !validExistingTimestamp || updatedAt >= existingUpdatedAt;
      const nextUpdatedAt = positionWins ? updatedAt : existingUpdatedAt;

      const nextState = {
        chapter: positionWins || !existing ? chapter : existing.chapter,
        verse: positionWins || !existing ? verse : existing.verse,
        translation: positionWins || !existing ? safeTranslation : existing.translation,
        updatedAt: !existing ? updatedAt : nextUpdatedAt,
      };
      this.sql.exec(
        `INSERT INTO sync_state (id, chapter, verse, translation, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           chapter = excluded.chapter,
           verse = excluded.verse,
           translation = excluded.translation,
           updated_at = excluded.updated_at;`,
        nextState.chapter,
        nextState.verse,
        nextState.translation,
        nextState.updatedAt
      );

      return this.getState();
    }

    return this.putStateFallback({
      chapter,
      verse,
      translation: safeTranslation,
      updatedAt,
    });
  }

  async putStateFallback(newState) {
    const existing = await this.state.storage?.get?.("sync_state");
    const now = Date.now();
    const existingUpdatedAt = existing ? Number(existing.updatedAt) : 0;
    const validExistingTimestamp = Boolean(existing) && isValidTimestamp(existingUpdatedAt, now);
    const positionWins = !existing || !validExistingTimestamp || newState.updatedAt >= existingUpdatedAt;
    const mergedUpdatedAt = positionWins ? newState.updatedAt : existingUpdatedAt;

    const record = {
      chapter: positionWins || !existing ? newState.chapter : existing.chapter,
      verse: positionWins || !existing ? newState.verse : existing.verse,
      translation: positionWins || !existing ? newState.translation : existing.translation,
      updatedAt: !existing ? newState.updatedAt : mergedUpdatedAt,
    };
    await this.state.storage?.put?.("sync_state", record);
    return Response.json({
      empty: false,
      chapter: record.chapter,
      verse: record.verse,
      translation: record.translation || null,
      updatedAt: record.updatedAt,
    });
  }
}

export function extractAuthKey(request) {
  const auth = request.headers.get("Authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }
  const custom = request.headers.get("X-Sync-Key");
  if (custom && custom.trim()) {
    return custom.trim();
  }
  return null;
}

export function getCorsHeaders(request) {
  const origin = request?.headers?.get?.("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Sync-Key",
    "Access-Control-Max-Age": "86400",
  };
}

export async function hashSyncKey(authKey) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authKey));
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Health / service check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "quran-reader-sync",
          storage: "SQLite Durable Object",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        }
      );
    }

    // Route only /api/sync
    if (url.pathname !== "/api/sync") {
      return new Response(
        JSON.stringify({ error: "Not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        }
      );
    }

    // Authentication check
    const authKey = extractAuthKey(request);
    if (!authKey) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Sync password or Bearer token is required." }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        }
      );
    }

    // If a master SYNC_SECRET environment variable is configured in Wrangler, enforce it
    if (env.SYNC_SECRET && env.SYNC_SECRET !== authKey) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Invalid pairing key." }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        }
      );
    }

    if (!env.SYNC_DO) {
      return new Response(
        JSON.stringify({ error: "Server error: SYNC_DO binding is not configured." }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        }
      );
    }

    // Derive deterministic Durable Object ID from the sync key hash
    // Each distinct sync key gets its own isolated SQLite-backed Durable Object instance
    const keyHash = await hashSyncKey(authKey);
    const doId = env.SYNC_DO.idFromName(keyHash);
    const stub = env.SYNC_DO.get(doId);

    // Forward the request to the Durable Object instance
    const doRequest = new Request(new URL("/sync", request.url).toString(), {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
      },
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
    });

    const doResponse = await stub.fetch(doRequest);
    const bodyText = await doResponse.text();

    return new Response(bodyText, {
      status: doResponse.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders,
      },
    });
  },
};
