import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSyncClient } from "../sync-client.js";
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

test("paired devices merge offline bookmark additions and preserve concurrent removals", async () => {
  const remote = new SyncDurableObject({ storage: { sql: createMockSqlStorage() } }, {});
  let firstDeviceOffline = false;
  const fetchRemote = async (url, options) => {
    if (firstDeviceOffline) throw new TypeError("offline");
    return remote.fetch(new Request(url, options));
  };

  let firstDeviceRemoteState = null;
  const mac = createSyncClient({
    storage: createStorage(),
    fetch: fetchRemote,
    debounceMs: 5,
    onRemoteUpdate: data => { firstDeviceRemoteState = data; },
  });
  let phoneRemoteState = null;
  const phone = createSyncClient({
    storage: createStorage(),
    fetch: fetchRemote,
    onRemoteUpdate: data => { phoneRemoteState = data; },
  });
  const endpoint = "https://sync.example.workers.dev";
  const sharedKey = "private-paired-key";
  mac.updateConfig({ endpoint, syncKey: sharedKey });
  phone.updateConfig({ endpoint, syncKey: sharedKey });

  const bookmarkA = { chapter: 1, verse: 1 };
  const bookmarkB = { chapter: 2, verse: 1 };
  const bookmarkC = { chapter: 3, verse: 1 };
  const bookmarkD = { chapter: 4, verse: 1 };
  const initialState = {
    position: { chapter: 1, verse: 1 },
    bookmarks: [bookmarkA, bookmarkB],
    translation: "en.sahih",
  };

  await mac.sync(initialState);
  await phone.sync({ ...initialState, bookmarks: [] });

  firstDeviceOffline = true;
  const offlineMacState = { ...initialState, bookmarks: [...initialState.bookmarks, bookmarkC] };
  mac.queuePush(offlineMacState);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(mac.getConfig().bookmarkBaseline, [bookmarkA, bookmarkB]);

  const phoneState = { ...initialState, position: { chapter: 2, verse: 1 }, bookmarks: [bookmarkA, bookmarkB, bookmarkD] };
  firstDeviceOffline = false;
  await phone.push(phoneState);
  await mac.sync(offlineMacState);

  assert.deepEqual(firstDeviceRemoteState.bookmarks, [bookmarkA, bookmarkB, bookmarkC, bookmarkD]);
  assert.deepEqual(mac.getConfig().bookmarkBaseline, [bookmarkA, bookmarkB, bookmarkC, bookmarkD]);
  assert.equal(firstDeviceRemoteState.chapter, 2);
  assert.equal(firstDeviceRemoteState.verse, 1);

  const macRemovedC = {
    ...offlineMacState,
    position: { chapter: firstDeviceRemoteState.chapter, verse: firstDeviceRemoteState.verse },
    bookmarks: firstDeviceRemoteState.bookmarks.filter(item =>
      item.chapter !== bookmarkC.chapter || item.verse !== bookmarkC.verse),
  };
  await mac.push(macRemovedC);
  await phone.push(phoneState);

  assert.deepEqual(firstDeviceRemoteState.bookmarks, [bookmarkA, bookmarkB, bookmarkD]);
  assert.deepEqual(phoneRemoteState.bookmarks, [bookmarkA, bookmarkB, bookmarkD]);
  assert.equal(firstDeviceRemoteState.chapter, 2);
  assert.equal(firstDeviceRemoteState.verse, 1);
  assert.equal(phoneRemoteState.chapter, 2);
  assert.equal(phoneRemoteState.verse, 1);
  mac.destroy();
  phone.destroy();
});

test("regression: bookmark-only sync does not overwrite newer reading progress (4-step scenario)", async () => {
  const remote = new SyncDurableObject({ storage: { sql: createMockSqlStorage() } }, {});
  let macOffline = false;
  const fetchRemote = async (url, options = {}) => {
    if (macOffline && options.headers?.["X-Device"] === "mac") throw new TypeError("offline");
    return remote.fetch(new Request(url, options));
  };

  let macRemoteState = null;
  const mac = createSyncClient({
    storage: createStorage(),
    fetch: (url, opts = {}) => fetchRemote(url, { ...opts, headers: { ...opts.headers, "X-Device": "mac" } }),
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

  const endpoint = "https://sync.example.workers.dev";
  const sharedKey = "shared-pairing-key";
  mac.updateConfig({ endpoint, syncKey: sharedKey });
  phone.updateConfig({ endpoint, syncKey: sharedKey });

  // Step 1. Mac is reading chapter 1, verse 1.
  const macInitial = {
    position: { chapter: 1, verse: 1 },
    bookmarks: [],
    translation: "en.sahih",
  };
  await mac.sync(macInitial);
  await phone.sync(macInitial);

  // Step 2. Mac goes offline and adds a bookmark.
  macOffline = true;
  const newBookmark = { chapter: 3, verse: 16 };
  const macOfflineState = {
    position: { chapter: 1, verse: 1 },
    bookmarks: [newBookmark],
    translation: "en.sahih",
  };
  mac.queuePush(macOfflineState);
  await new Promise(resolve => setTimeout(resolve, 30));

  // Step 3. You read chapter 2, verse 1 on your phone. It synchronizes successfully.
  const phoneProgress = {
    position: { chapter: 2, verse: 1 },
    bookmarks: [],
    translation: "en.sahih",
  };
  const phonePushResult = await phone.push(phoneProgress);
  assert.equal(phonePushResult.success, true);
  assert.equal(phonePushResult.data.chapter, 2);
  assert.equal(phonePushResult.data.verse, 1);

  // Step 4. Mac reconnects and synchronizes its bookmark addition.
  macOffline = false;
  const macSyncResult = await mac.sync(macOfflineState);
  assert.equal(macSyncResult.success, true);

  // Assert that the final reading position remains chapter 2, verse 1.
  assert.equal(macSyncResult.data.chapter, 2, "Mac sync result chapter must remain chapter 2");
  assert.equal(macSyncResult.data.verse, 1, "Mac sync result verse must remain verse 1");
  assert.equal(macRemoteState.chapter, 2, "Mac remote state chapter must remain chapter 2");
  assert.equal(macRemoteState.verse, 1, "Mac remote state verse must remain verse 1");
  assert.deepEqual(macRemoteState.bookmarks, [newBookmark], "Mac bookmark addition must be preserved");

  const finalRemoteRes = await remote.fetch(new Request("https://sync.example.workers.dev/api/sync", {
    headers: { Authorization: `Bearer ${sharedKey}` },
  }));
  const finalRemoteData = await finalRemoteRes.json();
  assert.equal(finalRemoteData.chapter, 2, "Final remote reading position chapter must remain 2");
  assert.equal(finalRemoteData.verse, 1, "Final remote reading position verse must remain 1");
  assert.deepEqual(finalRemoteData.bookmarks, [newBookmark], "Final remote bookmarks must contain added bookmark");

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

  let clientRemoteState = null;
  const client = createSyncClient({
    storage: createStorage(),
    fetch: fetchRemote,
    debounceMs: 50,
    onRemoteUpdate: data => { clientRemoteState = data; },
  });

  const endpoint = "https://sync.example.workers.dev";
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
      bookmarks: [],
      translation: "en.sahih",
      updatedAt: 1000,
    }),
  }));

  // Device initial state at chapter 1, verse 1
  const startState = {
    position: { chapter: 1, verse: 1 },
    bookmarks: [],
    translation: "en.sahih",
  };

  let releaseGet;
  delayGatePromise = new Promise(resolve => { releaseGet = resolve; });

  // 1. Sync starts with chapter 1, verse 1 (GET request is delayed and in-flight)
  const syncPromise = client.sync(startState);

  // 2. User navigates to chapter 2, verse 1 while GET is pending
  const newState = {
    position: { chapter: 2, verse: 1 },
    bookmarks: [],
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

test("regression: bookmark-only sync with equal timestamps does not overwrite different reading position", async () => {
  const remote = new SyncDurableObject({ storage: { sql: createMockSqlStorage() } }, {});
  const fetchRemote = async (url, options = {}) => {
    return remote.fetch(new Request(url, options));
  };

  const endpoint = "https://sync.example.workers.dev";
  const sharedKey = "shared-pairing-key";

  let devARemoteState = null;
  const devA = createSyncClient({
    storage: createStorage(),
    fetch: fetchRemote,
    onRemoteUpdate: data => { devARemoteState = data; },
  });

  let devBRemoteState = null;
  const devB = createSyncClient({
    storage: createStorage(),
    fetch: fetchRemote,
    onRemoteUpdate: data => { devBRemoteState = data; },
  });

  const positionTimestamp = 5000;
  devA.updateConfig({
    endpoint,
    syncKey: sharedKey,
    lastUpdatedAt: positionTimestamp,
    lastSyncedAt: positionTimestamp,
    lastPosition: { chapter: 1, verse: 1 },
  });

  devB.updateConfig({
    endpoint,
    syncKey: sharedKey,
    lastUpdatedAt: positionTimestamp,
    lastSyncedAt: positionTimestamp,
    lastPosition: { chapter: 2, verse: 1 },
  });

  // Device B pushes reading position chapter 2, verse 1 at timestamp 5000
  const devBPush = await devB.push({
    position: { chapter: 2, verse: 1 },
    bookmarks: [],
    translation: "en.sahih",
  }, { updatedAt: positionTimestamp, isBookmarkOnly: false });
  assert.equal(devBPush.success, true);
  assert.equal(devBPush.data.chapter, 2);
  assert.equal(devBPush.data.verse, 1);

  // Device A is at chapter 1, verse 1 at identical position timestamp 5000
  // Device A adds a bookmark and synchronizes (bookmark-only sync)
  const bookmark = { chapter: 3, verse: 16 };
  const devAPush = await devA.push({
    position: { chapter: 1, verse: 1 },
    bookmarks: [bookmark],
    translation: "en.sahih",
  }, { updatedAt: positionTimestamp, isBookmarkOnly: true });

  assert.equal(devAPush.success, true);

  // Assert that Worker reading position remains chapter 2, verse 1 (not overwritten by Device A chapter 1, verse 1)
  const remoteRes = await remote.fetch(new Request("https://sync.example.workers.dev/api/sync", {
    headers: { Authorization: `Bearer ${sharedKey}` },
  }));
  const remoteData = await remoteRes.json();
  assert.equal(remoteData.chapter, 2, "Remote chapter must remain chapter 2");
  assert.equal(remoteData.verse, 1, "Remote verse must remain verse 1");
  assert.deepEqual(remoteData.bookmarks, [bookmark], "Remote bookmarks must contain Device A added bookmark");

  // Device A should preserve its own reading position and not adopt Device B position on bookmark-only push
  assert.equal(devARemoteState, null, "Device A should not receive position change update");

  devA.destroy();
  devB.destroy();
});
