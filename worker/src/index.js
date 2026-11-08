/**
 * Cloudflare Worker + SQLite-backed Durable Object for Quran Reader sync.
 *
 * Provides strongly consistent, zero-lag cross-device synchronization of:
 * - Current reading position (chapter & verse)
 * - Saved bookmarks
 * - Active translation preference
 * - Timestamp-based position and translation conflict resolution
 * - Per-bookmark add/remove versions with retained tombstones
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

function isValidBookmarkPosition(item) {
  return Boolean(
    item &&
    Number.isSafeInteger(item.chapter) &&
    item.chapter >= 1 &&
    item.chapter <= 114 &&
    Number.isSafeInteger(item.verse) &&
    item.verse >= 1
  );
}

function sanitizeBookmarks(bookmarks) {
  const seen = new Set();
  const result = [];
  for (const item of bookmarks) {
    if (!isValidBookmarkPosition(item)) continue;
    const key = `${item.chapter}:${item.verse}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ chapter: item.chapter, verse: item.verse });
    }
  }
  return result;
}

function parseBookmarkState(raw, legacyUpdatedAt = 0, now = Date.now()) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (Array.isArray(parsed)) {
    return sanitizeBookmarks(parsed).map(item => ({
      ...item,
      bookmarked: true,
      updatedAt: isValidTimestamp(legacyUpdatedAt, now) ? legacyUpdatedAt : 0,
    }));
  }

  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.items)) {
    return [];
  }

  const states = new Map();
  for (const item of parsed.items) {
    if (!isValidBookmarkPosition(item) || typeof item.bookmarked !== "boolean") continue;
    const key = `${item.chapter}:${item.verse}`;
    const updatedAt = Number.isSafeInteger(item.updatedAt) &&
      item.updatedAt >= 0 &&
      item.updatedAt <= now + MAX_FUTURE_SKEW_MS
      ? item.updatedAt
      : 0;
    const previous = states.get(key);
    if (!previous || updatedAt >= previous.updatedAt) {
      states.set(key, {
        chapter: item.chapter,
        verse: item.verse,
        bookmarked: item.bookmarked,
        updatedAt,
      });
    }
  }
  return [...states.values()].sort((first, second) =>
    first.chapter - second.chapter || first.verse - second.verse);
}

function isLegacyBookmarkState(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  return Array.isArray(parsed);
}

function serializeBookmarkState(items) {
  return JSON.stringify({ version: 1, items });
}

function activeBookmarks(items) {
  return items.filter(item => item.bookmarked).map(({ chapter, verse }) => ({ chapter, verse }));
}

function mergeBookmarkChanges(existing, changes) {
  const states = new Map(existing.map(item => [`${item.chapter}:${item.verse}`, item]));
  for (const change of changes) {
    const key = `${change.chapter}:${change.verse}`;
    const previous = states.get(key);
    if (!previous || change.updatedAt >= previous.updatedAt) {
      states.set(key, change);
    }
  }
  return [...states.values()].sort((first, second) =>
    first.chapter - second.chapter || first.verse - second.verse);
}

function legacyBookmarkChanges(bookmarks, existing, updatedAt) {
  const known = new Set(existing.map(item => `${item.chapter}:${item.verse}`));
  return bookmarks
    .filter(item => !known.has(`${item.chapter}:${item.verse}`))
    .map(item => ({ ...item, bookmarked: true, updatedAt }));
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
      const now = Date.now();
      const storedUpdatedAt = Number(row.updated_at);
      const validStoredTimestamp = isValidTimestamp(storedUpdatedAt, now);
      const updatedAt = validStoredTimestamp ? storedUpdatedAt : now;
      const bookmarkItems = parseBookmarkState(
        row.bookmarks,
        validStoredTimestamp ? storedUpdatedAt : 0,
        now
      );
      if (!validStoredTimestamp || isLegacyBookmarkState(row.bookmarks)) {
        this.sql.exec(
          "UPDATE sync_state SET bookmarks = ?, updated_at = ? WHERE id = 1",
          serializeBookmarkState(bookmarkItems),
          updatedAt
        );
      }

      return Response.json({
        empty: false,
        chapter: row.chapter,
        verse: row.verse,
        bookmarks: activeBookmarks(bookmarkItems),
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
    const rawBookmarkState = record.bookmarkState ?? record.bookmarks;
    const bookmarkItems = parseBookmarkState(
      rawBookmarkState,
      validStoredTimestamp ? storedUpdatedAt : 0,
      now
    );
    if (!validStoredTimestamp || isLegacyBookmarkState(rawBookmarkState)) {
      await this.state.storage?.put?.("sync_state", {
        ...record,
        bookmarkState: { version: 1, items: bookmarkItems },
        updatedAt,
      });
    }
    return Response.json({
      empty: false,
      chapter: record.chapter,
      verse: record.verse,
      bookmarks: activeBookmarks(bookmarkItems),
      translation: record.translation || null,
      updatedAt,
    });
  }

  async putState(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return Response.json({ error: "Invalid state payload." }, { status: 400 });
    }

    const { chapter, verse, bookmarks, translation, updatedAt } = data;
    const now = Date.now();

    if (
      !Number.isSafeInteger(chapter) || chapter < 1 || chapter > 114 ||
      !Number.isSafeInteger(verse) || verse < 1 ||
      !Array.isArray(bookmarks) ||
      !isValidTimestamp(updatedAt, now)
    ) {
      return Response.json({ error: "Invalid state payload." }, { status: 400 });
    }

    const sanitizedBookmarks = sanitizeBookmarks(bookmarks);
    const hasBookmarkChanges = Object.hasOwn(data, "bookmarkChanges");
    let bookmarkChanges = null;
    if (hasBookmarkChanges) {
      if (!Array.isArray(data.bookmarkChanges)) {
        return Response.json({ error: "Invalid bookmark changes." }, { status: 400 });
      }
      const changesByKey = new Map();
      for (const item of data.bookmarkChanges) {
        if (!isValidBookmarkPosition(item) || typeof item.bookmarked !== "boolean") {
          return Response.json({ error: "Invalid bookmark changes." }, { status: 400 });
        }
        const changeUpdatedAt = item.updatedAt === undefined ? updatedAt : item.updatedAt;
        if (!isValidTimestamp(changeUpdatedAt, now)) {
          return Response.json({ error: "Invalid bookmark change timestamp." }, { status: 400 });
        }
        changesByKey.set(`${item.chapter}:${item.verse}`, {
          chapter: item.chapter,
          verse: item.verse,
          bookmarked: item.bookmarked,
          updatedAt: changeUpdatedAt,
        });
      }
      bookmarkChanges = [...changesByKey.values()];
    }

    const safeTranslation = typeof translation === "string" ? translation.slice(0, 50) : null;

    if (this.sql) {
      const cursor = this.sql.exec(
        "SELECT chapter, verse, bookmarks, translation, updated_at FROM sync_state WHERE id = 1"
      );
      const rows = typeof cursor.toArray === "function" ? cursor.toArray() : [...cursor];
      const existing = rows[0] || null;
      const existingUpdatedAt = existing ? Number(existing.updated_at) : 0;
      const validExistingTimestamp = Boolean(existing) && isValidTimestamp(existingUpdatedAt, now);
      const existingBookmarks = existing
        ? parseBookmarkState(
          existing.bookmarks,
          validExistingTimestamp ? existingUpdatedAt : 0,
          now
        )
        : [];
      const changes = hasBookmarkChanges
        ? bookmarkChanges
        : legacyBookmarkChanges(sanitizedBookmarks, existingBookmarks, updatedAt);
      const mergedBookmarks = mergeBookmarkChanges(existingBookmarks, changes);
      const positionWins = !existing || !validExistingTimestamp || updatedAt >= existingUpdatedAt;
      const mergedUpdatedAt = positionWins ? updatedAt : existingUpdatedAt;

      const nextState = {
        chapter: positionWins ? chapter : existing.chapter,
        verse: positionWins ? verse : existing.verse,
        bookmarks: serializeBookmarkState(mergedBookmarks),
        translation: positionWins ? safeTranslation : existing.translation,
        updatedAt: mergedUpdatedAt,
      };
      this.sql.exec(
        `INSERT INTO sync_state (id, chapter, verse, bookmarks, translation, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           chapter = excluded.chapter,
           verse = excluded.verse,
           bookmarks = excluded.bookmarks,
           translation = excluded.translation,
           updated_at = excluded.updated_at;`,
        nextState.chapter,
        nextState.verse,
        nextState.bookmarks,
        nextState.translation,
        nextState.updatedAt
      );

      return this.getState();
    }

    return this.putStateFallback({
      chapter,
      verse,
      bookmarks: sanitizedBookmarks,
      bookmarkChanges,
      hasBookmarkChanges,
      translation: safeTranslation,
      updatedAt,
    });
  }

  async putStateFallback(newState) {
    const existing = await this.state.storage?.get?.("sync_state");
    const now = Date.now();
    const existingUpdatedAt = existing ? Number(existing.updatedAt) : 0;
    const validExistingTimestamp = Boolean(existing) && isValidTimestamp(existingUpdatedAt, now);
    const rawBookmarkState = existing?.bookmarkState ?? existing?.bookmarks;
    const existingBookmarks = existing
      ? parseBookmarkState(
        rawBookmarkState,
        validExistingTimestamp ? existingUpdatedAt : 0,
        now
      )
      : [];
    const changes = newState.hasBookmarkChanges
      ? newState.bookmarkChanges
      : legacyBookmarkChanges(newState.bookmarks, existingBookmarks, newState.updatedAt);
    const mergedBookmarks = mergeBookmarkChanges(existingBookmarks, changes);
    const positionWins = !existing || !validExistingTimestamp || newState.updatedAt >= existingUpdatedAt;
    const mergedUpdatedAt = positionWins ? newState.updatedAt : existingUpdatedAt;

    const record = {
      chapter: positionWins ? newState.chapter : existing.chapter,
      verse: positionWins ? newState.verse : existing.verse,
      bookmarkState: { version: 1, items: mergedBookmarks },
      translation: positionWins ? newState.translation : existing.translation,
      updatedAt: mergedUpdatedAt,
    };
    await this.state.storage?.put?.("sync_state", record);
    return Response.json({
      empty: false,
      chapter: record.chapter,
      verse: record.verse,
      bookmarks: activeBookmarks(mergedBookmarks),
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
