export const SYNC_STORAGE_KEY = "quran-reader:sync:v1";

const DEFAULT_CONFIG = {
  explicitlyConfigured: false,
  endpoint: "",
  syncKey: "",
  lastSyncedAt: 0,
  lastUpdatedAt: 0,
  bookmarkBaseline: null,
  autoSync: false,
};

function normalizeBookmarks(bookmarks) {
  if (!Array.isArray(bookmarks)) return [];
  const seen = new Set();
  const result = [];
  for (const bookmark of bookmarks) {
    if (
      !bookmark ||
      !Number.isSafeInteger(bookmark.chapter) ||
      bookmark.chapter < 1 ||
      bookmark.chapter > 114 ||
      !Number.isSafeInteger(bookmark.verse) ||
      bookmark.verse < 1
    ) {
      continue;
    }
    const key = `${bookmark.chapter}:${bookmark.verse}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ chapter: bookmark.chapter, verse: bookmark.verse });
    }
  }
  return result;
}

function getBookmarkChanges(bookmarks, baseline, updatedAt) {
  const currentBookmarks = normalizeBookmarks(bookmarks);
  const previousBookmarks = normalizeBookmarks(baseline);
  const currentKeys = new Set(currentBookmarks.map(item => `${item.chapter}:${item.verse}`));
  const previousKeys = new Set(previousBookmarks.map(item => `${item.chapter}:${item.verse}`));
  const changes = [];

  for (const bookmark of currentBookmarks) {
    if (!previousKeys.has(`${bookmark.chapter}:${bookmark.verse}`)) {
      changes.push({ ...bookmark, bookmarked: true, updatedAt });
    }
  }
  for (const bookmark of previousBookmarks) {
    if (!currentKeys.has(`${bookmark.chapter}:${bookmark.verse}`)) {
      changes.push({ ...bookmark, bookmarked: false, updatedAt });
    }
  }
  return changes;
}

export function loadSyncConfig(storage) {
  try {
    const raw = storage.getItem(SYNC_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
    if (parsed.explicitlyConfigured !== true) {
      clearSyncConfig(storage);
      return { ...DEFAULT_CONFIG };
    }
    const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint.trim() : "";
    const syncKey = typeof parsed.syncKey === "string" ? parsed.syncKey.trim() : "";
    const config = {
      explicitlyConfigured: true,
      endpoint,
      syncKey,
      lastSyncedAt: Number.isSafeInteger(parsed.lastSyncedAt) && parsed.lastSyncedAt >= 0 ? parsed.lastSyncedAt : 0,
      lastUpdatedAt: Number.isSafeInteger(parsed.lastUpdatedAt) && parsed.lastUpdatedAt >= 0 ? parsed.lastUpdatedAt : 0,
      bookmarkBaseline: Array.isArray(parsed.bookmarkBaseline) ? normalizeBookmarks(parsed.bookmarkBaseline) : null,
      autoSync: typeof parsed.autoSync === "boolean" ? parsed.autoSync : Boolean(endpoint && syncKey),
    };
    if (parsed.disabled !== undefined) {
      config.disabled = Boolean(parsed.disabled);
    }
    return config;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveSyncConfig(storage, config) {
  try {
    storage.setItem(SYNC_STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.error("Unable to save sync configuration:", error);
  }
}

export function clearSyncConfig(storage) {
  try {
    storage.removeItem(SYNC_STORAGE_KEY);
  } catch (error) {
    console.error("Unable to clear sync configuration:", error);
  }
}

export function normalizeEndpoint(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let url = rawUrl.trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

export function generateSyncKey() {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("Secure random key generation is unavailable in this browser.");
  }
  const randomValues = globalThis.crypto.getRandomValues(new Uint8Array(24));
  const hex = Array.from(randomValues, value => value.toString(16).padStart(2, "0")).join("");
  return `quran-${hex.match(/.{8}/g).join("-")}`;
}

export function createSyncClient({
  storage = globalThis.localStorage,
  fetch = globalThis.fetch?.bind(globalThis),
  onRemoteUpdate = () => {},
  onStatusChange = () => {},
  debounceMs = 1500,
} = {}) {
  let config = loadSyncConfig(storage);

  function isConfigured() {
    return Boolean(config.explicitlyConfigured && !config.disabled && config.endpoint && config.syncKey);
  }

  let status = isConfigured() ? "idle" : "unconfigured";
  let statusMessage = "";
  let debounceTimer = null;
  let activePromise = null;
  let latestLocalState = null;
  let destroyed = false;

  function notifyStatus(newStatus, message = "") {
    status = newStatus;
    statusMessage = message;
    onStatusChange({
      status,
      message,
      lastSyncedAt: config.lastSyncedAt,
      isConfigured: isConfigured(),
    });
  }

  function updateConfig(newFields) {
    const endpoint = newFields.endpoint !== undefined ? normalizeEndpoint(newFields.endpoint) : config.endpoint;
    const syncKey = newFields.syncKey !== undefined ? newFields.syncKey.trim() : config.syncKey;
    const pairingChanged = endpoint !== config.endpoint || syncKey !== config.syncKey;
    config = {
      ...config,
      ...newFields,
      explicitlyConfigured: true,
      disabled: false,
      endpoint,
      syncKey,
      autoSync: typeof newFields.autoSync === "boolean" ? newFields.autoSync : true,
    };
    if (pairingChanged) {
      config.lastSyncedAt = Number.isSafeInteger(newFields.lastSyncedAt) ? newFields.lastSyncedAt : 0;
      config.lastUpdatedAt = Number.isSafeInteger(newFields.lastUpdatedAt) ? newFields.lastUpdatedAt : 0;
      config.bookmarkBaseline = normalizeBookmarks(newFields.bookmarkBaseline);
    }
    saveSyncConfig(storage, config);
    notifyStatus(isConfigured() ? "idle" : "unconfigured", "");
  }

  function clearConfig() {
    config = { ...DEFAULT_CONFIG, disabled: true };
    saveSyncConfig(storage, config);
    clearTimeout(debounceTimer);
    notifyStatus("unconfigured", "");
  }

  function ensureBookmarkBaseline(localState) {
    if (config.bookmarkBaseline === null) {
      config.bookmarkBaseline = config.lastSyncedAt > 0
        ? normalizeBookmarks(localState.bookmarks)
        : [];
      saveSyncConfig(storage, config);
    }
  }

  function hasBookmarkChanges(bookmarks) {
    return getBookmarkChanges(bookmarks, config.bookmarkBaseline || [], 0).length > 0;
  }

  function bookmarkListsDiffer(first, second) {
    return getBookmarkChanges(first, second, 0).length > 0;
  }

  function recordRemoteState(remoteData) {
    const updatedAt = Number.isSafeInteger(remoteData.updatedAt) && remoteData.updatedAt >= 0
      ? remoteData.updatedAt
      : 0;
    config.lastSyncedAt = updatedAt;
    config.lastUpdatedAt = updatedAt;
    if (Array.isArray(remoteData.bookmarks)) {
      config.bookmarkBaseline = normalizeBookmarks(remoteData.bookmarks);
    }
    saveSyncConfig(storage, config);
  }

  function recordRemoteBookmarks(remoteData) {
    if (Array.isArray(remoteData.bookmarks)) {
      config.bookmarkBaseline = normalizeBookmarks(remoteData.bookmarks);
      saveSyncConfig(storage, config);
    }
  }

  function nextUpdatedAt() {
    return Math.max(Date.now(), (config.lastUpdatedAt || 0) + 1);
  }

  function formatSyncError(statusCode, errText) {
    if (statusCode === 401) {
      return "Incorrect pairing key or unauthorized.";
    }
    if (statusCode === 404) {
      return "Worker endpoint not found. Check the URL.";
    }
    if (statusCode >= 500) {
      return `Worker server error (${statusCode}).`;
    }
    try {
      const parsed = JSON.parse(errText);
      if (parsed.error) return parsed.error;
    } catch {}
    return `Sync error (${statusCode}).`;
  }

  async function pull() {
    if (!isConfigured() || destroyed) {
      return { success: false, reason: "unconfigured" };
    }
    if (latestLocalState) {
      return sync(latestLocalState);
    }

    notifyStatus("syncing", "Checking for updates…");
    try {
      const url = `${normalizeEndpoint(config.endpoint)}/api/sync`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${config.syncKey}`,
          "X-Sync-Key": config.syncKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        const message = formatSyncError(response.status, errorText);
        notifyStatus("error", message);
        return { success: false, error: message };
      }

      const remoteData = await response.json();

      if (remoteData.empty || !remoteData.updatedAt) {
        config.bookmarkBaseline = [];
        saveSyncConfig(storage, config);
        notifyStatus("synced", "Ready (no remote data yet)");
        return { success: true, empty: true };
      }

      const localUpdatedAt = config.lastUpdatedAt || 0;
      if (remoteData.updatedAt > localUpdatedAt) {
        recordRemoteState(remoteData);
        onRemoteUpdate(remoteData);
        notifyStatus("synced", `Synced with cloud (Ayah ${remoteData.chapter}:${remoteData.verse})`);
        return { success: true, updated: true, data: remoteData };
      }

      const bookmarksChanged = bookmarkListsDiffer(remoteData.bookmarks, config.bookmarkBaseline || []);
      if (bookmarksChanged) {
        recordRemoteBookmarks(remoteData);
        config.lastSyncedAt = Math.max(config.lastSyncedAt, remoteData.updatedAt);
        saveSyncConfig(storage, config);
        onRemoteUpdate({ bookmarks: remoteData.bookmarks });
      }
      saveSyncConfig(storage, config);
      notifyStatus("synced", bookmarksChanged ? "Merged bookmarks from cloud." : "Already up to date.");
      return { success: true, updated: bookmarksChanged, data: remoteData };
    } catch (err) {
      const message = err?.message || "Network request failed.";
      notifyStatus("offline", `Sync unreachable: ${message}`);
      return { success: false, error: message };
    }
  }

  async function push(localState, { updatedAt: suppliedUpdatedAt, bookmarkUpdatedAt } = {}) {
    if (!isConfigured() || destroyed) {
      return { success: false, reason: "unconfigured" };
    }

    latestLocalState = localState;
    ensureBookmarkBaseline(localState);
    notifyStatus("syncing", "Saving progress to cloud…");
    try {
      const url = `${normalizeEndpoint(config.endpoint)}/api/sync`;
      const updatedAt = suppliedUpdatedAt ?? nextUpdatedAt();
      const normalizedBookmarks = normalizeBookmarks(localState.bookmarks);

      const payload = {
        chapter: localState.position.chapter,
        verse: localState.position.verse,
        bookmarks: normalizedBookmarks,
        bookmarkChanges: getBookmarkChanges(
          normalizedBookmarks,
          config.bookmarkBaseline || [],
          bookmarkUpdatedAt ?? updatedAt
        ),
        translation: localState.translation || "en.sahih",
        updatedAt,
      };

      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.syncKey}`,
          "X-Sync-Key": config.syncKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const message = formatSyncError(response.status, errorText);
        notifyStatus("error", message);
        return { success: false, error: message };
      }

      const responseData = await response.json();
      if (
        !responseData ||
        typeof responseData !== "object" ||
        !Number.isSafeInteger(responseData.updatedAt) ||
        !Array.isArray(responseData.bookmarks)
      ) {
        throw new Error("Worker returned an invalid sync state.");
      }

      const remoteWon = responseData.updatedAt > updatedAt;
      recordRemoteState(responseData);
      onRemoteUpdate(responseData);
      if (remoteWon) {
        notifyStatus("synced", `Updated from newer cloud data (Ayah ${responseData.chapter}:${responseData.verse})`);
        return { success: true, remoteWon: true, data: responseData };
      }

      saveSyncConfig(storage, config);
      notifyStatus("synced", `Synced ayah ${payload.chapter}:${payload.verse}`);
      return { success: true, data: responseData };
    } catch (err) {
      const message = err?.message || "Network request failed.";
      notifyStatus("offline", `Offline: saved locally (${message})`);
      return { success: false, error: message };
    }
  }

  async function sync(localState) {
    if (!isConfigured() || destroyed) {
      return { success: false, reason: "unconfigured" };
    }

    latestLocalState = localState;
    ensureBookmarkBaseline(localState);
    if (activePromise) return activePromise;

    activePromise = (async () => {
      notifyStatus("syncing", "Synchronizing…");
      try {
        const url = `${normalizeEndpoint(config.endpoint)}/api/sync`;
        const response = await fetch(url, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${config.syncKey}`,
            "X-Sync-Key": config.syncKey,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          const message = formatSyncError(response.status, errorText);
          notifyStatus("error", message);
          return { success: false, error: message };
        }

        const remoteData = await response.json();

        // If remote has no saved progress yet, push local state
        if (remoteData.empty || !remoteData.updatedAt) {
          config.lastSyncedAt = 0;
          config.lastUpdatedAt = 0;
          config.bookmarkBaseline = [];
          saveSyncConfig(storage, config);
          return await push(localState);
        }

        // If this device has never synced before, adopt existing cloud state
        if (config.lastSyncedAt === 0) {
          if (hasBookmarkChanges(localState.bookmarks)) {
            const adoptedState = {
              ...localState,
              position: { chapter: remoteData.chapter, verse: remoteData.verse },
              translation: remoteData.translation || localState.translation,
            };
            return await push(adoptedState, {
              updatedAt: remoteData.updatedAt,
              bookmarkUpdatedAt: nextUpdatedAt(),
            });
          }
          recordRemoteState(remoteData);
          onRemoteUpdate(remoteData);
          notifyStatus("synced", `Synced with cloud (Ayah ${remoteData.chapter}:${remoteData.verse})`);
          return { success: true, direction: "pulled", data: remoteData };
        }

        if (hasBookmarkChanges(localState.bookmarks)) {
          return await push(localState);
        }

        const localUpdatedAt = config.lastUpdatedAt || 0;
        if (remoteData.updatedAt > localUpdatedAt) {
          // Remote is newer than local
          recordRemoteState(remoteData);
          onRemoteUpdate(remoteData);
          notifyStatus("synced", `Updated to Ayah ${remoteData.chapter}:${remoteData.verse}`);
          return { success: true, direction: "pulled", data: remoteData };
        } else if (localUpdatedAt > remoteData.updatedAt) {
          // Local is newer than remote
          return await push(localState);
        } else {
          // Equal timestamps
          recordRemoteState(remoteData);
          saveSyncConfig(storage, config);
          if (bookmarkListsDiffer(remoteData.bookmarks, localState.bookmarks)) {
            onRemoteUpdate({ bookmarks: remoteData.bookmarks });
            notifyStatus("synced", "Merged bookmarks from cloud.");
            return { success: true, direction: "pulled", data: remoteData };
          }
          notifyStatus("synced", "Up to date");
          return { success: true, direction: "equal", data: remoteData };
        }
      } catch (err) {
        const message = err?.message || "Network request failed.";
        notifyStatus("offline", `Offline: saved locally (${message})`);
        return { success: false, error: message };
      } finally {
        activePromise = null;
      }
    })();

    return activePromise;
  }

  function queuePush(localState) {
    latestLocalState = localState;
    if (!isConfigured() || !config.autoSync || destroyed) return;

    config.lastUpdatedAt = Date.now();
    saveSyncConfig(storage, config);

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      push(localState);
    }, debounceMs);
  }

  function destroy() {
    destroyed = true;
    clearTimeout(debounceTimer);
  }

  return {
    getConfig: () => ({ ...config }),
    updateConfig,
    clearConfig,
    isConfigured,
    getStatus: () => ({
      status,
      message: statusMessage,
      lastSyncedAt: config.lastSyncedAt,
    }),
    sync,
    push,
    pull,
    queuePush,
    destroy,
  };
}
