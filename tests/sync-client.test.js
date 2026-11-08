import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SYNC_STORAGE_KEY,
  loadSyncConfig,
  saveSyncConfig,
  clearSyncConfig,
  normalizeEndpoint,
  generateSyncKey,
  createSyncClient,
} from "../sync-client.js";

test("sync config: loads defaults when storage is empty or corrupted", () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  const emptyConfig = loadSyncConfig(storage);
  assert.equal(emptyConfig.endpoint, "");
  assert.equal(emptyConfig.syncKey, "");
  assert.equal(emptyConfig.lastSyncedAt, 0);
  assert.equal(emptyConfig.lastUpdatedAt, 0);
  assert.equal(emptyConfig.bookmarkBaseline, null);
  assert.equal(emptyConfig.autoSync, false);

  store.set(SYNC_STORAGE_KEY, "{corrupt-json");
  const corruptedConfig = loadSyncConfig(storage);
  assert.equal(corruptedConfig.endpoint, "");
  assert.equal(corruptedConfig.syncKey, "");

  store.set(SYNC_STORAGE_KEY, "null");
  assert.equal(loadSyncConfig(storage).endpoint, "");
});

test("sync config: saves, loads, and clears valid configuration", () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  const config = {
    explicitlyConfigured: true,
    endpoint: "https://sync.example.workers.dev",
    syncKey: "secret-key-123",
    lastSyncedAt: 1000,
    lastUpdatedAt: 1000,
    bookmarkBaseline: null,
    autoSync: true,
  };

  saveSyncConfig(storage, config);
  assert.equal(store.has(SYNC_STORAGE_KEY), true);
  const loaded = loadSyncConfig(storage);
  assert.deepEqual(loaded, config);

  clearSyncConfig(storage);
  assert.equal(store.has(SYNC_STORAGE_KEY), false);
});

test("sync config: clears legacy settings that did not record explicit consent", async () => {
  const store = new Map([[SYNC_STORAGE_KEY, JSON.stringify({
    endpoint: "https://sync.example.workers.dev",
    syncKey: "legacy-shared-key",
    autoSync: true,
  })]]);
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  let fetchCalled = false;
  const client = createSyncClient({
    storage,
    fetch: async () => { fetchCalled = true; throw new Error("Legacy configuration must not sync."); },
  });

  assert.equal(client.isConfigured(), false);
  assert.equal(client.getConfig().syncKey, "");
  assert.equal(store.has(SYNC_STORAGE_KEY), false);
  const syncResult = await client.sync({ position: { chapter: 1, verse: 1 }, bookmarks: [] });
  assert.equal(syncResult.reason, "unconfigured");
  client.queuePush({ position: { chapter: 1, verse: 1 }, bookmarks: [] });
  assert.equal(fetchCalled, false);
});

test("normalizeEndpoint: sanitizes worker URLs correctly and enforces HTTPS for remote hosts", () => {
  assert.equal(normalizeEndpoint(""), "");
  assert.equal(normalizeEndpoint("   "), "");
  assert.equal(normalizeEndpoint("sync.example.workers.dev"), "https://sync.example.workers.dev");
  assert.equal(normalizeEndpoint("https://sync.example.workers.dev/"), "https://sync.example.workers.dev");
  assert.equal(normalizeEndpoint("https://sync.example.workers.dev/api/sync"), "https://sync.example.workers.dev");
  assert.equal(normalizeEndpoint("http://localhost:8787/api/sync"), "http://localhost:8787");
  assert.equal(normalizeEndpoint("http://127.0.0.1:8787/api/sync"), "http://127.0.0.1:8787");
  assert.equal(normalizeEndpoint("http://[::1]:8787/api/sync"), "http://[::1]:8787");
  assert.equal(normalizeEndpoint("http://app.localhost:8787"), "http://app.localhost:8787");
  assert.equal(normalizeEndpoint("http://sync.example.workers.dev"), "");
  assert.equal(normalizeEndpoint("http://insecure.example.com/api/sync"), "");
  assert.equal(normalizeEndpoint("not a valid url :::"), "");
});

test("generateSyncKey: generates distinct, formatted sync keys", () => {
  const key1 = generateSyncKey();
  const key2 = generateSyncKey();
  assert.match(key1, /^quran-(?:[0-9a-f]{8}-){5}[0-9a-f]{8}$/);
  assert.match(key2, /^quran-(?:[0-9a-f]{8}-){5}[0-9a-f]{8}$/);
  assert.notEqual(key1, key2);
});

test("generateSyncKey: refuses to fall back when Web Crypto is unavailable", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    assert.throws(generateSyncKey, /Secure random key generation is unavailable/);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

test("sync client: unconfigured client safely returns without making network requests", async () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };
  let fetchCalled = false;
  const client = createSyncClient({
    storage,
    fetch: async () => { fetchCalled = true; throw new Error("Should not fetch"); },
  });

  assert.equal(client.isConfigured(), false);
  assert.equal(client.getConfig().endpoint, "");
  assert.equal(client.getConfig().syncKey, "");
  assert.equal(client.getConfig().autoSync, false);
  const pullRes = await client.pull();
  assert.equal(pullRes.success, false);
  assert.equal(pullRes.reason, "unconfigured");

  const pushRes = await client.push({ position: { chapter: 1, verse: 1 }, bookmarks: [] });
  assert.equal(pushRes.success, false);
  assert.equal(pushRes.reason, "unconfigured");

  const syncRes = await client.sync({ position: { chapter: 1, verse: 1 }, bookmarks: [] });
  assert.equal(syncRes.success, false);
  assert.equal(syncRes.reason, "unconfigured");

  client.queuePush({ position: { chapter: 1, verse: 1 }, bookmarks: [] });
  assert.equal(fetchCalled, false);
});

test("sync client: pushes local state to worker with correct authorization and payload", async () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  let capturedUrl = "";
  let capturedHeaders = null;
  let capturedBody = null;

  const mockFetch = async (url, options) => {
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
        bookmarks: capturedBody.bookmarks,
        translation: capturedBody.translation,
        updatedAt: capturedBody.updatedAt,
      }),
    };
  };

  const client = createSyncClient({
    storage,
    fetch: mockFetch,
  });

  client.updateConfig({
    endpoint: "https://sync.example.workers.dev",
    syncKey: "test-secret-key",
  });
  assert.equal(client.isConfigured(), true);

  const localState = {
    position: { chapter: 2, verse: 255 },
    bookmarks: [{ chapter: 1, verse: 1 }, { chapter: 2, verse: 255 }],
    translation: "en.sahih",
  };

  const res = await client.push(localState);
  assert.equal(res.success, true);
  assert.equal(capturedUrl, "https://sync.example.workers.dev/api/sync");
  assert.equal(capturedHeaders.Authorization, "Bearer test-secret-key");
  assert.equal(capturedHeaders["X-Sync-Key"], "test-secret-key");
  assert.equal(capturedBody.chapter, 2);
  assert.equal(capturedBody.verse, 255);
  assert.deepEqual(capturedBody.bookmarks, localState.bookmarks);
  assert.equal(capturedBody.translation, "en.sahih");
  assert.ok(capturedBody.updatedAt > 0);

  const status = client.getStatus();
  assert.equal(status.status, "synced");
  assert.ok(status.lastSyncedAt > 0);
});

test("sync client: pulls newer remote state and triggers onRemoteUpdate", async () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  const remotePayload = {
    empty: false,
    chapter: 3,
    verse: 18,
    bookmarks: [{ chapter: 3, verse: 18 }],
    translation: "ml.abdulhameed",
    updatedAt: 500000,
  };

  let remoteUpdateReceived = null;
  const client = createSyncClient({
    storage,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => remotePayload,
    }),
    onRemoteUpdate: data => { remoteUpdateReceived = data; },
  });

  client.updateConfig({
    endpoint: "https://sync.example.workers.dev",
    syncKey: "test-secret-key",
    lastUpdatedAt: 1000, // Local is older than remote (1000 < 500000)
  });

  const res = await client.pull();
  assert.equal(res.success, true);
  assert.equal(res.updated, true);
  assert.deepEqual(remoteUpdateReceived, remotePayload);
  assert.equal(client.getConfig().lastSyncedAt, 500000);
});

test("sync client: handles network failure gracefully without throwing", async () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  let lastStatus = null;
  const client = createSyncClient({
    storage,
    fetch: async () => {
      throw new TypeError("Failed to fetch");
    },
    onStatusChange: s => { lastStatus = s; },
  });

  client.updateConfig({
    endpoint: "https://sync.example.workers.dev",
    syncKey: "test-secret-key",
  });

  const res = await client.sync({ position: { chapter: 1, verse: 1 }, bookmarks: [] });
  assert.equal(res.success, false);
  assert.equal(lastStatus.status, "offline");
  assert.match(lastStatus.message, /Failed to fetch/);
});

test("sync client: maps HTTP error codes to friendly messages", async () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  let lastStatus = null;
  let mockStatus = 401;
  const client = createSyncClient({
    storage,
    fetch: async () => ({
      ok: false,
      status: mockStatus,
      text: async () => JSON.stringify({ error: "Unauthorized: Invalid pairing key." }),
    }),
    onStatusChange: s => { lastStatus = s; },
  });

  client.updateConfig({
    endpoint: "https://sync.example.workers.dev",
    syncKey: "wrong-key",
  });

  await client.pull();
  assert.equal(lastStatus.status, "error");
  assert.match(lastStatus.message, /Incorrect pairing key/);

  mockStatus = 404;
  await client.pull();
  assert.equal(lastStatus.status, "error");
  assert.match(lastStatus.message, /Worker endpoint not found/);

  mockStatus = 500;
  await client.pull();
  assert.equal(lastStatus.status, "error");
  assert.match(lastStatus.message, /Worker server error/);
});

test("sync client: debounced queuePush coalesces rapid local updates", async () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  let pushes = 0;
  let lastPushedVerse = 0;

  const client = createSyncClient({
    storage,
    debounceMs: 50,
    fetch: async (url, options) => {
      pushes++;
      const body = JSON.parse(options.body);
      lastPushedVerse = body.verse;
      return {
        ok: true,
        status: 200,
        json: async () => ({ empty: false, chapter: 1, verse: body.verse, bookmarks: [], updatedAt: body.updatedAt }),
      };
    },
  });

  client.updateConfig({
    endpoint: "https://sync.example.workers.dev",
    syncKey: "test-secret",
  });

  // Rapidly queue 3 pushes
  client.queuePush({ position: { chapter: 1, verse: 1 }, bookmarks: [] });
  client.queuePush({ position: { chapter: 1, verse: 2 }, bookmarks: [] });
  client.queuePush({ position: { chapter: 1, verse: 3 }, bookmarks: [] });

  assert.equal(pushes, 0); // Not pushed yet
  await new Promise(resolve => setTimeout(resolve, 80));

  assert.equal(pushes, 1);
  assert.equal(lastPushedVerse, 3);
  client.destroy();
});

test("sync client: unconfigured queuePush does not update lastUpdatedAt in storage", () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  const client = createSyncClient({ storage });
  assert.equal(client.isConfigured(), false);
  client.queuePush({ position: { chapter: 2, verse: 1 }, bookmarks: [] });

  const config = client.getConfig();
  assert.equal(config.lastUpdatedAt, 0);
});

test("sync client: fresh device pairing pulls remote cloud progress", async () => {
  const store = new Map();
  const storage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
    removeItem: key => store.delete(key),
  };

  const remotePayload = {
    empty: false,
    chapter: 18,
    verse: 1,
    bookmarks: [{ chapter: 18, verse: 1 }],
    translation: "en.sahih",
    updatedAt: 1000,
  };

  let remoteUpdate = null;
  const client = createSyncClient({
    storage,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => remotePayload,
    }),
    onRemoteUpdate: data => { remoteUpdate = data; },
  });

  client.updateConfig({
    endpoint: "https://sync.example.workers.dev",
    syncKey: "paired-device-key",
  });

  // Fresh device has lastSyncedAt === 0
  assert.equal(client.getConfig().lastSyncedAt, 0);

  const res = await client.sync({ position: { chapter: 1, verse: 1 }, bookmarks: [] });
  assert.equal(res.success, true);
  assert.equal(res.direction, "pulled");
  assert.deepEqual(remoteUpdate, remotePayload);
  assert.equal(client.getConfig().lastSyncedAt, 1000);
});

test("public sync JavaScript contains no shared authentication credential", async () => {
  const source = await Promise.all([
    "../app.js",
    "../sync-client.js",
  ].map(path => readFile(new URL(path, import.meta.url), "utf8")));

  assert.doesNotMatch(source.join("\n"), /firo-quran-sync|DEFAULT_SYNC_KEY/);
});

test("static server serves sync-client.js", async t => {
  const { createReaderServer } = await import("../server.js");
  const server = createReaderServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/sync-client.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.ok((await response.text()).includes("createSyncClient"));
});
