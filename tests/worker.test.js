import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import workerDefault, {
  SyncDurableObject,
  extractAuthKey,
  getCorsHeaders,
  hashSyncKey,
  MAX_FUTURE_SKEW_MS,
} from "../worker/src/index.js";

function createMockSqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...params) {
      const trimmed = query.trim().toUpperCase();
      if (trimmed.startsWith("SELECT")) {
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
  const request = new Request("https://sync.example.com", {
    headers: { Origin: "https://my-github-pages.io" },
  });
  const headers = getCorsHeaders(request);
  assert.equal(headers["Access-Control-Allow-Origin"], "https://my-github-pages.io");
  assert.match(headers["Access-Control-Allow-Methods"], /GET, PUT, POST, OPTIONS/);
  assert.match(headers["Access-Control-Allow-Headers"], /Authorization/);
});

test("extractAuthKey: parses Bearer token (case-insensitively per RFC 6750) and X-Sync-Key headers", () => {
  const req1 = new Request("https://sync.example.com", {
    headers: { Authorization: "Bearer my-secret-token" },
  });
  assert.equal(extractAuthKey(req1), "my-secret-token");

  const reqCase = new Request("https://sync.example.com", {
    headers: { Authorization: "bearer lowercase-token" },
  });
  assert.equal(extractAuthKey(reqCase), "lowercase-token");

  const req2 = new Request("https://sync.example.com", {
    headers: { "X-Sync-Key": "custom-key-123" },
  });
  assert.equal(extractAuthKey(req2), "custom-key-123");

  const req3 = new Request("https://sync.example.com", {
    headers: { Authorization: "Basic dXNlcjpwYXNz" },
  });
  assert.equal(extractAuthKey(req3), null);

  const req4 = new Request("https://sync.example.com");
  assert.equal(extractAuthKey(req4), null);
});

test("hashSyncKey: creates deterministic 64-character SHA-256 hex string", async () => {
  const hash1 = await hashSyncKey("apple-banana-123");
  const hash2 = await hashSyncKey("apple-banana-123");
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
        bookmarks: [],
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
  const request = new Request("https://sync.example.com/api/sync", {
    method: "OPTIONS",
    headers: { Origin: "https://pages.github.io" },
  });
  const response = await workerDefault.fetch(request, {}, {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://pages.github.io");
});

test("Worker fetch: responds to health check", async () => {
  const request = new Request("https://sync.example.com/health");
  const response = await workerDefault.fetch(request, {}, {});
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, "ok");
  assert.equal(data.service, "quran-reader-sync");
});

test("Worker fetch: returns 404 for unknown endpoints", async () => {
  const request = new Request("https://sync.example.com/unknown");
  const response = await workerDefault.fetch(request, {}, {});
  assert.equal(response.status, 404);
});

test("Worker fetch: rejects unauthorized requests with 401", async () => {
  const request = new Request("https://sync.example.com/api/sync");
  const response = await workerDefault.fetch(request, {}, {});
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.match(body.error, /Unauthorized/);
});

test("Worker fetch: validates master secret when env.SYNC_SECRET is set", async () => {
  const env = { SYNC_SECRET: "master-password-xyz" };

  const invalidReq = new Request("https://sync.example.com/api/sync", {
    headers: { Authorization: "Bearer wrong-password" },
  });
  const res1 = await workerDefault.fetch(invalidReq, env, {});
  assert.equal(res1.status, 401);

  let stubFetched = false;
  const mockBinding = {
    idFromName: name => `id-${name}`,
    get: id => ({
      fetch: async () => {
        stubFetched = true;
        return new Response(JSON.stringify({ empty: true, updatedAt: 0 }), { status: 200 });
      },
    }),
  };

  const validReq = new Request("https://sync.example.com/api/sync", {
    headers: { Authorization: "Bearer master-password-xyz" },
  });
  const res2 = await workerDefault.fetch(validReq, { ...env, SYNC_DO: mockBinding }, {});
  assert.equal(res2.status, 200);
  assert.equal(stubFetched, true);
});

test("SyncDurableObject (SQLite): handles position LWW and bookmark merging", async () => {
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
      bookmarks: [{ chapter: 1, verse: 1 }, { chapter: 2, verse: 255 }, { chapter: 1, verse: 1 }], // Duplicate bookmark
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
  assert.equal(stored1.bookmarks.length, 2); // Correctly deduplicated
  assert.equal(stored1.updatedAt, 1000);

  // 4. PUT with an older timestamp does NOT overwrite newer state (atomic conflict resolution)
  const putReqOld = new Request("https://internal/sync", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chapter: 1,
      verse: 1,
      bookmarks: [],
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
      bookmarks: [{ chapter: 3, verse: 18 }],
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

test("SyncDurableObject: isolated instances keep separate SQLite state", async () => {
  const sqlA = createMockSqlStorage();
  const doA = new SyncDurableObject({ storage: { sql: sqlA } }, {});

  const sqlB = createMockSqlStorage();
  const doB = new SyncDurableObject({ storage: { sql: sqlB } }, {});

  // Update instance A to 2:255
  await doA.fetch(new Request("https://internal/sync", {
    method: "PUT",
    body: JSON.stringify({ chapter: 2, verse: 255, bookmarks: [], updatedAt: 100 }),
  }));

  // Update instance B to 36:1
  await doB.fetch(new Request("https://internal/sync", {
    method: "PUT",
    body: JSON.stringify({ chapter: 36, verse: 1, bookmarks: [], updatedAt: 200 }),
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
      bookmarks: [],
      updatedAt,
    }),
  }));

  const unsafeTimestamp = await put(Number.MAX_SAFE_INTEGER + 1);
  const futureTimestamp = await put(Date.now() + MAX_FUTURE_SKEW_MS + 1);
  assert.equal(unsafeTimestamp.status, 400);
  assert.equal(futureTimestamp.status, 400);

  const state = await (await doInstance.fetch(new Request("https://internal/sync"))).json();
  assert.equal(state.empty, true);
});

test("SyncDurableObject repairs an already-stored unreasonable timestamp", async () => {
  const sql = createMockSqlStorage();
  const doInstance = new SyncDurableObject({ storage: { sql } }, {});
  const poisonedTimestamp = Date.now() + MAX_FUTURE_SKEW_MS + 1000;
  sql.exec(
    "INSERT INTO sync_state (id, chapter, verse, bookmarks, translation, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
    2,
    1,
    JSON.stringify([{ chapter: 1, verse: 1 }]),
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
      bookmarks: [{ chapter: 1, verse: 1 }],
      bookmarkChanges: [],
      updatedAt: Date.now() + 1000,
    }),
  }))).json();
  assert.equal(updated.chapter, 3);
});

test("SyncDurableObject merges independent bookmark edits and retains removal tombstones", async () => {
  const doInstance = new SyncDurableObject({ storage: { sql: createMockSqlStorage() } }, {});
  const bookmarkA = { chapter: 1, verse: 1 };
  const bookmarkB = { chapter: 2, verse: 1 };
  const bookmarkC = { chapter: 3, verse: 1 };
  const bookmarkD = { chapter: 4, verse: 1 };
  const put = async (updatedAt, bookmarks, bookmarkChanges = [], chapter = 1) => {
    const response = await doInstance.fetch(new Request("https://internal/sync", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chapter,
        verse: 1,
        bookmarks,
        bookmarkChanges,
        updatedAt,
      }),
    }));
    assert.equal(response.status, 200);
    return response.json();
  };

  await put(1000, [bookmarkA, bookmarkB], [bookmarkA, bookmarkB].map(item => ({
    ...item,
    bookmarked: true,
    updatedAt: 1000,
  })));
  const bookmarkOnlyUpdate = await put(900, [bookmarkA, bookmarkB, bookmarkC], [{
    ...bookmarkC,
    bookmarked: true,
    updatedAt: 2000,
  }], 2);
  assert.equal(bookmarkOnlyUpdate.chapter, 1);
  assert.equal(bookmarkOnlyUpdate.updatedAt, 1000);

  const afterConcurrentAddition = await put(
    3000,
    [bookmarkA, bookmarkB, bookmarkD],
    [{ ...bookmarkD, bookmarked: true, updatedAt: 3000 }]
  );
  assert.deepEqual(afterConcurrentAddition.bookmarks, [bookmarkA, bookmarkB, bookmarkC, bookmarkD]);

  const afterRemoval = await put(4000, [bookmarkA, bookmarkB, bookmarkD], [{
    ...bookmarkC,
    bookmarked: false,
    updatedAt: 4000,
  }]);
  assert.deepEqual(afterRemoval.bookmarks, [bookmarkA, bookmarkB, bookmarkD]);

  const afterStaleDevice = await put(5000, [bookmarkA, bookmarkB, bookmarkC, bookmarkD]);
  assert.deepEqual(afterStaleDevice.bookmarks, [bookmarkA, bookmarkB, bookmarkD]);

  const afterIntentionalReAdd = await put(6000, [bookmarkA, bookmarkB, bookmarkC, bookmarkD], [{
    ...bookmarkC,
    bookmarked: true,
    updatedAt: 6000,
  }]);
  assert.deepEqual(afterIntentionalReAdd.bookmarks, [bookmarkA, bookmarkB, bookmarkC, bookmarkD]);
});
