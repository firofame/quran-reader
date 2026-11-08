import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSyncClient, createSyncSetupCode, DEFAULT_SYNC_ENDPOINT, parseSyncSetupCode } from "../sync-client.js";
import { SyncDurableObject } from "../worker/src/index.js";

function createMockSqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...params) {
      if (query.trim().toUpperCase().startsWith("SELECT")) {
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

function createStorage() {
  const entries = new Map();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
}

test("paired devices synchronize reading progress using timestamp-based LWW", async () => {
  const remote = new SyncDurableObject({ storage: { sql: createMockSqlStorage() } }, {});
  const fetchRemote = async (url, options) => {
    return remote.fetch(new Request(url, options));
  };

  let macRemoteState = null;
  const mac = createSyncClient({
    storage: createStorage(),
    fetch: fetchRemote,
    debounceMs: 5,
    onRemoteUpdate: data => { macRemoteState = data; },
  });
  let phoneRemoteState = null;
  const phone = createSyncClient({
    storage: createStorage(),
    fetch: fetchRemote,
    debounceMs: 5,
    onRemoteUpdate: data => { phoneRemoteState = data; },
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
  assert.equal(phonePushRes.success, true);
  assert.equal(phonePushRes.data.chapter, 2);
  assert.equal(phonePushRes.data.verse, 1);

  // Mac syncs and receives phone's newer position
  const macSyncRes = await mac.sync(initialMacState);
  assert.equal(macSyncRes.success, true);
  assert.equal(macSyncRes.data.chapter, 2);
  assert.equal(macSyncRes.data.verse, 1);
  assert.equal(macRemoteState.chapter, 2);
  assert.equal(macRemoteState.verse, 1);

  // Mac navigates to chapter 3, verse 1 with even newer timestamp
  const macNewState = { position: { chapter: 3, verse: 1 }, translation: "en.sahih" };
  const macPushRes = await mac.push(macNewState, { updatedAt: 3000 });
  assert.equal(macPushRes.success, true);
  assert.equal(macPushRes.data.chapter, 3);
  assert.equal(macPushRes.data.verse, 1);

  // Phone syncs and receives Mac's newer position
  await phone.sync(phoneState);
  assert.equal(phoneRemoteState.chapter, 3);
  assert.equal(phoneRemoteState.verse, 1);

  mac.destroy();
  phone.destroy();
});

test("regression: in-flight sync does not overwrite newer local reading progress", async () => {
  const remote = new SyncDurableObject({ storage: { sql: createMockSqlStorage() } }, {});
  let delayGatePromise = null;
  const fetchRemote = async (url, options = {}) => {
    if ((options.method === "GET" || !options.method) && delayGatePromise) {
      await delayGatePromise;
    }
    return remote.fetch(new Request(url, options));
  };

  const client = createSyncClient({
    storage: createStorage(),
    fetch: fetchRemote,
    debounceMs: 50,
  });

  const endpoint = DEFAULT_SYNC_ENDPOINT;
  const sharedKey = "shared-pairing-key";
  client.updateConfig({ endpoint, syncKey: sharedKey });

  // Cloud already has initial reading progress at chapter 1, verse 1
  await remote.fetch(new Request("https://sync.example.workers.dev/api/sync", {
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
  }));

  // Device initial state at chapter 1, verse 1
  const startState = {
    position: { chapter: 1, verse: 1 },
    translation: "en.sahih",
  };

  let releaseGet;
  delayGatePromise = new Promise(resolve => { releaseGet = resolve; });

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
  assert.equal(syncResult.success, true);
  assert.equal(syncResult.data.chapter, 2, "Returned reading position chapter must remain chapter 2");
  assert.equal(syncResult.data.verse, 1, "Returned reading position verse must remain verse 1");

  const remoteRes = await remote.fetch(new Request("https://sync.example.workers.dev/api/sync", {
    headers: { Authorization: `Bearer ${sharedKey}` },
  }));
  const remoteData = await remoteRes.json();
  assert.equal(remoteData.chapter, 2, "Worker reading position chapter must remain chapter 2");
  assert.equal(remoteData.verse, 1, "Worker reading position verse must remain verse 1");

  client.destroy();
});
