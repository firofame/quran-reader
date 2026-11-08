/**
 * Cloudflare Worker + SQLite-backed Durable Object for Quran Reader sync.
 *
 * Provides strongly consistent, zero-lag cross-device synchronization of:
 * - Current reading position (chapter & verse)
 * - Saved bookmarks
 * - Active translation preference
 * - Timestamp of last update (LWW conflict resolution)
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
        bookmarks TEXT NOT NULL,
        translation TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
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
        "SELECT chapter, verse, bookmarks, translation, updated_at FROM sync_state WHERE id = 1"
      );
      const rows = typeof cursor.toArray === "function" ? cursor.toArray() : [...cursor];

      if (rows.length === 0) {
        return Response.json({ empty: true, updatedAt: 0 });
      }

      const row = rows[0];
      let bookmarks = [];
      try {
        bookmarks = JSON.parse(row.bookmarks);
      } catch {
        bookmarks = [];
      }

      return Response.json({
        empty: false,
        chapter: row.chapter,
        verse: row.verse,
        bookmarks,
        translation: row.translation || null,
        updatedAt: row.updated_at,
      });
    }

    return this.getStateFallback();
  }

  async getStateFallback() {
    const record = await this.state.storage?.get?.("sync_state");
    if (!record) {
      return Response.json({ empty: true, updatedAt: 0 });
    }
    return Response.json(record);
  }

  async putState(data) {
    const { chapter, verse, bookmarks, translation, updatedAt } = data;

    if (
      !Number.isInteger(chapter) || chapter < 1 || chapter > 114 ||
      !Number.isInteger(verse) || verse < 1 ||
      !Array.isArray(bookmarks) ||
      typeof updatedAt !== "number" || updatedAt <= 0
    ) {
      return Response.json({ error: "Invalid state payload." }, { status: 400 });
    }

    const seen = new Set();
    const sanitizedBookmarks = [];
    for (const item of bookmarks) {
      if (
        item &&
        Number.isInteger(item.chapter) &&
        item.chapter >= 1 &&
        item.chapter <= 114 &&
        Number.isInteger(item.verse) &&
        item.verse >= 1
      ) {
        const key = `${item.chapter}:${item.verse}`;
        if (!seen.has(key)) {
          seen.add(key);
          sanitizedBookmarks.push({ chapter: item.chapter, verse: item.verse });
        }
      }
    }

    const safeTranslation = typeof translation === "string" ? translation.slice(0, 50) : null;

    if (this.sql) {
      this.sql.exec(
        `INSERT INTO sync_state (id, chapter, verse, bookmarks, translation, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           chapter = excluded.chapter,
           verse = excluded.verse,
           bookmarks = excluded.bookmarks,
           translation = excluded.translation,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= sync_state.updated_at;`,
        chapter,
        verse,
        JSON.stringify(sanitizedBookmarks),
        safeTranslation,
        updatedAt
      );

      return this.getState();
    }

    return this.putStateFallback({
      empty: false,
      chapter,
      verse,
      bookmarks: sanitizedBookmarks,
      translation: safeTranslation,
      updatedAt,
    });
  }

  async putStateFallback(newRecord) {
    const existing = await this.state.storage?.get?.("sync_state");
    if (existing && existing.updatedAt > newRecord.updatedAt) {
      return Response.json(existing);
    }
    await this.state.storage?.put?.("sync_state", newRecord);
    return Response.json(newRecord);
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
        JSON.stringify({ error: "Unauthorized: Invalid sync password." }),
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
