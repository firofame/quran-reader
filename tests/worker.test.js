import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import workerDefault, {
  MAX_FUTURE_SKEW_MS,
  SyncDurableObject,
  extractAuthKey,
  getCorsHeaders,
  hashSyncKey,
} from "../worker/src/index.js";

function createMockSqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...params) {
      const normalizedQuery = query.trim().toUpperCase();
      if (normalizedQuery.startsWith("SELECT") || normalizedQuery.startsWith("PRAGMA")) {
        const rows = db.prepare(query).all(...params);
        return {
          toArray: () => rows,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      }
      if (params.length === 0) {
        db.exec(query);
      } else {
        db.prepare(query).run(...params);
      }
      return { toArray: () => [] };
    },
  };
}

test("CORS headers: returns expected permissive headers", () => {
  const headers = getCorsHeaders(new Request("https://sync.example.com", {
    headers: { Origin: "https://example.com" },
  }));
  assert.equal(headers["Access-Control-Allow-Origin"], "https://example.com");
  assert.match(headers["Access-Control-Allow-Methods"], /GET/);
  assert.match(headers["Access-Control-Allow-Methods"], /PUT/);
  assert.match(headers["Access-Control-Allow-Headers"], /Authorization/);
  assert.match(headers["Access-Control-Allow-Headers"], /X-Sync-Key/);
});

test("extractAuthKey: parses Bearer token (case-insensitively per RFC 6750) and X-Sync-Key headers", () => {
  const bearerReq = new Request("https://sync.example.com", {
    headers: { Authorization: "Bearer my-secret-token" },
  });
  assert.equal(extractAuthKey(bearerReq), "my-secret-token");

  const caseInsensitiveBearer = new Request("https://sync.example.com", {
    headers: { Authorization: "bearer lowercase-bearer-token" },
  });
  assert.equal(extractAuthKey(caseInsensitiveBearer), "lowercase-bearer-token");

  const mixedCaseBearer = new Request("https://sync.example.com", {
    headers: { Authorization: "bEaReR mixed-case-token" },
  });
  assert.equal(extractAuthKey(mixedCaseBearer), "mixed-case-token");

  const customHeaderReq = new Request("https://sync.example.com", {
    headers: { "X-Sync-Key": "custom-key-123" },
  });
  assert.equal(extractAuthKey(customHeaderReq), "custom-key-123");

  const emptyReq = new Request("https://sync.example.com");
  assert.equal(extractAuthKey(emptyReq), null);
});

test("hashSyncKey: creates deterministic 64-character SHA-256 hex string", async () => {
  const hash1 = await hashSyncKey("my-secret-pairing-key");
  const hash2 = await hashSyncKey("my-secret-pairing-key");
  const hash3 = await hashSyncKey("different-key");

  assert.equal(hash1.length, 64);
  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
});

test("Worker fetch: isolates data for independent sync keys", async () => {
  const instances = new Map();
  const binding = {
    idFromName: name => name,
    get: id => {
      if (!instances.has(id)) {
        instances.set(id, new SyncDurableObject({ storage: { sql: createMockSqlStorage() } }, {}));
      }
      return { fetch: request => instances.get(id).fetch(request) };
    },
  };
  const env = { SYNC_DO: binding };
  const put = async (syncKey, chapter) => workerDefault.fetch(
    new Request("https://sync.example.com/api/sync", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${syncKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chapter,
        verse: 1,
        updatedAt: Date.now(),
      }),
    }),
    env,
    {}
  );
  const get = async syncKey => workerDefault.fetch(
    new Request("https://sync.example.com/api/sync", {
      headers: { Authorization: `Bearer ${syncKey}` },
    }),
    env,
    {}
  );

  assert.equal((await put("independent-key-a", 2)).status, 200);
  assert.equal((await put("independent-key-b", 36)).status, 200);
  const stateA = await (await get("independent-key-a")).json();
  const stateB = await (await get("independent-key-b")).json();

  assert.equal(instances.size, 2);
  assert.equal(stateA.chapter, 2);
  assert.equal(stateB.chapter, 36);
});

test("Worker fetch: handles OPTIONS preflight with 204", async () => {
  const req = new Request("https://sync.example.com/api/sync", {
    method: "OPTIONS",
    headers: { Origin: "https://example.com" },
  });
  const res = await workerDefault.fetch(req, {}, {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://example.com");
});

test("Worker fetch: responds to health check", async () => {
  const req = new Request("https://sync.example.com/health");
  const res = await workerDefault.fetch(req, {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "quran");
});

test("Worker fetch: returns 404 for unknown endpoints", async () => {
  const req = new Request("https://sync.example.com/unknown");
  const res = await workerDefault.fetch(req, {}, {});
  assert.equal(res.status, 404);
});

test("Worker fetch: rejects unauthorized requests with 401", async () => {
  const req = new Request("https://sync.example.com/api/sync", { method: "GET" });
  const res = await workerDefault.fetch(req, {}, {});
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error, /Unauthorized/);
});

test("Worker fetch: validates master secret when env.SYNC_SECRET is set", async () => {
  const env = { SYNC_SECRET: "master-password" };
  const invalidReq = new Request("https://sync.example.com/api/sync", {
    method: "GET",
    headers: { Authorization: "Bearer wrong-password" },
  });
  const res1 = await workerDefault.fetch(invalidReq, env, {});
  assert.equal(res1.status, 401);

  let stubFetched = false;
  const mockBinding = {
    idFromName: () => "mock-id",
    get: () => ({
      fetch: async () => {
        stubFetched = true;
        return new Response(JSON.stringify({ empty: true }));
      },
    }),
  };

  const validReq = new Request("https://sync.example.com/api/sync", {
    method: "GET",
    headers: { Authorization: "Bearer master-password" },
  });
  const res2 = await workerDefault.fetch(validReq, { ...env, SYNC_DO: mockBinding }, {});
  assert.equal(res2.status, 200);
  assert.equal(stubFetched, true);
});

test("SyncDurableObject (SQLite): handles position and translation LWW", async () => {
  const sql = createMockSqlStorage();
  const doInstance = new SyncDurableObject({ storage: { sql } }, {});

  // 1. Initial GET on fresh database returns empty state
  const getReq1 = new Request("https://internal/sync", { method: "GET" });
  const getRes1 = await doInstance.fetch(getReq1);
  assert.equal(getRes1.status, 200);
  const data1 = await getRes1.json();
  assert.equal(data1.empty, true);
  assert.equal(data1.updatedAt, 0);

  // 2. Reject invalid payload
  const badReq = new Request("https://internal/sync", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapter: 999, verse: 1 }), // invalid chapter
  });
  const badRes = await doInstance.fetch(badReq);
  assert.equal(badRes.status, 400);

  // 3. PUT valid initial state
  const putReq1 = new Request("https://internal/sync", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chapter: 2,
      verse: 255,
      translation: "en.sahih",
      updatedAt: 1000,
    }),
  });
  const putRes1 = await doInstance.fetch(putReq1);
  assert.equal(putRes1.status, 200);
  const stored1 = await putRes1.json();
  assert.equal(stored1.empty, false);
  assert.equal(stored1.chapter, 2);
  assert.equal(stored1.verse, 255);
  assert.equal(stored1.updatedAt, 1000);

  // 4. PUT with an older timestamp does NOT overwrite newer state (atomic conflict resolution)
  const putReqOld = new Request("https://internal/sync", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chapter: 1,
      verse: 1,
      updatedAt: 500, // Older than 1000
    }),
  });
  const putResOld = await doInstance.fetch(putReqOld);
  assert.equal(putResOld.status, 200);
  const storedOld = await putResOld.json();
  assert.equal(storedOld.chapter, 2); // Still 2:255!
  assert.equal(storedOld.verse, 255);
  assert.equal(storedOld.updatedAt, 1000);

  // 5. PUT with a newer timestamp updates state
  const putReqNew = new Request("https://internal/sync", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chapter: 3,
      verse: 18,
      translation: "ml.abdulhameed",
      updatedAt: 2000,
    }),
  });
  const putResNew = await doInstance.fetch(putReqNew);
  assert.equal(putResNew.status, 200);
  const storedNew = await putResNew.json();
  assert.equal(storedNew.chapter, 3);
  assert.equal(storedNew.verse, 18);
  assert.equal(storedNew.translation, "ml.abdulhameed");
  assert.equal(storedNew.updatedAt, 2000);

  // 6. GET retrieves updated state
  const getReq2 = new Request("https://internal/sync", { method: "GET" });
  const getRes2 = await doInstance.fetch(getReq2);
  const data2 = await getRes2.json();
  assert.deepEqual(data2, storedNew);
});

test("SyncDurableObject migrates existing SQLite state and preserves reading progress", async () => {
  const sql = createMockSqlStorage();
  const updatedAt = Date.now() - 1000;
  sql.exec(`
    CREATE TABLE sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      chapter INTEGER NOT NULL,
      verse INTEGER NOT NULL,
      bookmarks TEXT NOT NULL,
      translation TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  sql.exec(
    "INSERT INTO sync_state (id, chapter, verse, bookmarks, translation, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
    18,
    10,
    "[]",
    "ml.abdulhameed",
    updatedAt
  );

  const doInstance = new SyncDurableObject({ storage: { sql } }, {});
  const columns = sql.exec("PRAGMA table_info(sync_state);").toArray();
  assert.equal(columns.some(column => column.name === "bookmarks"), false);

  const state = await (await doInstance.fetch(new Request("https://internal/sync"))).json();
  assert.deepEqual(state, {
    empty: false,
    chapter: 18,
    verse: 10,
    translation: "ml.abdulhameed",
    updatedAt,
  });
});

test("SyncDurableObject: isolated instances keep separate SQLite state", async () => {
  const sqlA = createMockSqlStorage();
  const doA = new SyncDurableObject({ storage: { sql: sqlA } }, {});

  const sqlB = createMockSqlStorage();
  const doB = new SyncDurableObject({ storage: { sql: sqlB } }, {});

  // Update instance A to 2:255
  await doA.fetch(new Request("https://internal/sync", {
    method: "PUT",
    body: JSON.stringify({ chapter: 2, verse: 255, updatedAt: 100 }),
  }));

  // Update instance B to 36:1
  await doB.fetch(new Request("https://internal/sync", {
    method: "PUT",
    body: JSON.stringify({ chapter: 36, verse: 1, updatedAt: 200 }),
  }));

  const resA = await (await doA.fetch(new Request("https://internal/sync"))).json();
  const resB = await (await doB.fetch(new Request("https://internal/sync"))).json();

  assert.equal(resA.chapter, 2);
  assert.equal(resB.chapter, 36);
});

test("SyncDurableObject rejects unsafe and unreasonable future timestamps", async () => {
  const doInstance = new SyncDurableObject({ storage: { sql: createMockSqlStorage() } }, {});
  const put = updatedAt => doInstance.fetch(new Request("https://internal/sync", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chapter: 2,
      verse: 1,
      updatedAt,
    }),
  }));

  const unsafeTimestamp = await put(Number.MAX_SAFE_INTEGER + 1);
  const futureTimestamp = await put(Date.now() + MAX_FUTURE_SKEW_MS + 5000);
  assert.equal(unsafeTimestamp.status, 400);
  assert.equal(futureTimestamp.status, 400);

  const state = await (await doInstance.fetch(new Request("https://internal/sync"))).json();
  assert.equal(state.empty, true);
});

test("SyncDurableObject repairs an already-stored unreasonable timestamp", async () => {
  const sql = createMockSqlStorage();
  const doInstance = new SyncDurableObject({ storage: { sql } }, {});
  const poisonedTimestamp = Date.now() + MAX_FUTURE_SKEW_MS + 5000000;
  sql.exec(
    "INSERT INTO sync_state (id, chapter, verse, translation, updated_at) VALUES (1, ?, ?, ?, ?)",
    2,
    1,
    "en.sahih",
    poisonedTimestamp
  );

  const repaired = await (await doInstance.fetch(new Request("https://internal/sync"))).json();
  assert.equal(repaired.chapter, 2);
  assert.ok(repaired.updatedAt < poisonedTimestamp);

  const updated = await (await doInstance.fetch(new Request("https://internal/sync", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chapter: 3,
      verse: 1,
      updatedAt: Date.now() + 1000,
    }),
  }))).json();
  assert.equal(updated.chapter, 3);
});
