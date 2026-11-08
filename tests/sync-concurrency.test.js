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

  const macRemovedC = {
    ...offlineMacState,
    bookmarks: firstDeviceRemoteState.bookmarks.filter(item =>
      item.chapter !== bookmarkC.chapter || item.verse !== bookmarkC.verse),
  };
  await mac.push(macRemovedC);
  await phone.push(phoneState);

  assert.deepEqual(firstDeviceRemoteState.bookmarks, [bookmarkA, bookmarkB, bookmarkD]);
  assert.deepEqual(phoneRemoteState.bookmarks, [bookmarkA, bookmarkB, bookmarkD]);
  mac.destroy();
  phone.destroy();
});
