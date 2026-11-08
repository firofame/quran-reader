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

function normalizePosition(pos) {
  if (
    !pos ||
    typeof pos !== "object" ||
    !Number.isSafeInteger(pos.chapter) ||
    pos.chapter < 1 ||
    pos.chapter > 114 ||
    !Number.isSafeInteger(pos.verse) ||
    pos.verse < 1
  ) {
    return null;
  }
  return {
    chapter: pos.chapter,
    verse: pos.verse,
    translation: typeof pos.translation === "string" ? pos.translation : undefined,
  };
}

function positionsMatch(first, second) {
  if (!first || !second) return false;
  return (
    first.chapter === second.chapter &&
    first.verse === second.verse &&
    (first.translation || "") === (second.translation || "")
  );
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
    if (parsed.lastPosition !== undefined) {
      config.lastPosition = normalizePosition(parsed.lastPosition);
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

function isLocalhost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
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
    if (parsed.protocol === "https:") {
      return `${parsed.protocol}//${parsed.host}`;
    }
    if (parsed.protocol === "http:" && isLocalhost(parsed.hostname)) {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return "";
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
  if (config.lastPosition === undefined) {
    config.lastPosition = null;
  }

  function isConfigured() {
    return Boolean(config.explicitlyConfigured && !config.disabled && config.endpoint && config.syncKey);
  }

  let status = isConfigured() ? "idle" : "unconfigured";
  let statusMessage = "";
  let debounceTimer = null;
  let activePromise = null;
  let latestLocalState = null;
  let localRevision = 0;
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
      config.lastPosition = normalizePosition(newFields.lastPosition);
    } else if (newFields.lastPosition !== undefined) {
      config.lastPosition = normalizePosition(newFields.lastPosition);
    }
    saveSyncConfig(storage, config);
    notifyStatus(isConfigured() ? "idle" : "unconfigured", "");
  }

  function clearConfig() {
    config = { ...DEFAULT_CONFIG, disabled: true, lastPosition: null };
    saveSyncConfig(storage, config);
    clearTimeout(debounceTimer);
    notifyStatus("unconfigured", "");
  }

  function ensureBookmarkBaseline(localState) {
    let changed = false;
    if (config.bookmarkBaseline === null) {
      config.bookmarkBaseline = config.lastSyncedAt > 0
        ? normalizeBookmarks(localState.bookmarks)
        : [];
      changed = true;
    }
    if (config.lastPosition === null && localState?.position) {
      config.lastPosition = normalizePosition({
        ...localState.position,
        translation: localState.translation,
      });
      changed = true;
    }
    if (changed) {
      saveSyncConfig(storage, config);
    }
  }

  function hasBookmarkChanges(bookmarks) {
    return getBookmarkChanges(bookmarks, config.bookmarkBaseline || [], 0).length > 0;
  }

  function bookmarkListsDiffer(first, second) {
    return getBookmarkChanges(first, second, 0).length > 0;
  }

  function hasPositionChanges(localState) {
    if (!localState || !localState.position) return false;
    const currentPos = normalizePosition({
      ...localState.position,
      translation: localState.translation,
    });
    if (!config.lastPosition) return true;
    return !positionsMatch(currentPos, config.lastPosition);
  }

  function recordRemoteState(remoteData) {
    const updatedAt = Number.isSafeInteger(remoteData.updatedAt) && remoteData.updatedAt >= 0
      ? remoteData.updatedAt
      : 0;
    config.lastSyncedAt = updatedAt;
    config.lastUpdatedAt = updatedAt;
    if (Number.isSafeInteger(remoteData.chapter) && Number.isSafeInteger(remoteData.verse)) {
      config.lastPosition = {
        chapter: remoteData.chapter,
        verse: remoteData.verse,
        translation: typeof remoteData.translation === "string" ? remoteData.translation : undefined,
      };
    }
    if (Array.isArray(remoteData.bookmarks)) {
      config.bookmarkBaseline = normalizeBookmarks(remoteData.bookmarks);
    }
    if (latestLocalState && Number.isSafeInteger(remoteData.chapter) && Number.isSafeInteger(remoteData.verse)) {
      latestLocalState = {
        ...latestLocalState,
        position: { chapter: remoteData.chapter, verse: remoteData.verse },
        translation: typeof remoteData.translation === "string" ? remoteData.translation : latestLocalState.translation,
        bookmarks: Array.isArray(remoteData.bookmarks) ? normalizeBookmarks(remoteData.bookmarks) : latestLocalState.bookmarks,
      };
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

  async function push(localState, { updatedAt: suppliedUpdatedAt, bookmarkUpdatedAt, isBookmarkOnly: explicitBookmarkOnly } = {}) {
    if (!isConfigured() || destroyed) {
      return { success: false, reason: "unconfigured" };
    }

    clearTimeout(debounceTimer);
    debounceTimer = null;
    latestLocalState = localState;
    localRevision++;
    const pushRevision = localRevision;
    ensureBookmarkBaseline(localState);
    notifyStatus("syncing", "Saving progress to cloud…");
    try {
      const url = `${normalizeEndpoint(config.endpoint)}/api/sync`;
      const positionChanged = hasPositionChanges(localState);
      const isBookmarkOnly = explicitBookmarkOnly !== undefined
        ? explicitBookmarkOnly
        : (!positionChanged && hasBookmarkChanges(localState.bookmarks));
      const normalizedBookmarks = normalizeBookmarks(localState.bookmarks);

      let updatedAt = suppliedUpdatedAt;
      if (updatedAt === undefined) {
        if (positionChanged || !config.lastUpdatedAt) {
          updatedAt = nextUpdatedAt();
          config.lastUpdatedAt = updatedAt;
        } else {
          updatedAt = config.lastUpdatedAt;
        }
      }

      if (positionChanged) {
        config.lastPosition = normalizePosition({
          ...localState.position,
          translation: localState.translation,
        });
      }

      const effectiveBookmarkUpdatedAt = bookmarkUpdatedAt ?? nextUpdatedAt();

      const payload = {
        chapter: localState.position.chapter,
        verse: localState.position.verse,
        bookmarks: normalizedBookmarks,
        bookmarkChanges: getBookmarkChanges(
          normalizedBookmarks,
          config.bookmarkBaseline || [],
          effectiveBookmarkUpdatedAt
        ),
        translation: localState.translation || "en.sahih",
        updatedAt,
        isBookmarkOnly,
        positionUpdated: !isBookmarkOnly,
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

      // Check if local state was modified while this push was in flight!
      const localChangedInFlight = localRevision > pushRevision;

      if (localChangedInFlight) {
        // Newer local changes were made while this push was in flight.
        // Update baseline and synced time, but do NOT overwrite the newer local position.
        config.lastSyncedAt = Math.max(config.lastSyncedAt, responseData.updatedAt);
        if (Array.isArray(responseData.bookmarks)) {
          config.bookmarkBaseline = normalizeBookmarks(responseData.bookmarks);
        }
        saveSyncConfig(storage, config);
        if (bookmarkListsDiffer(responseData.bookmarks, latestLocalState?.bookmarks || [])) {
          onRemoteUpdate({ bookmarks: responseData.bookmarks });
        }
        return { success: true, supersededLocally: true, data: responseData };
      }

      const positionMatchesLocal = Boolean(
        localState?.position &&
        Number.isSafeInteger(localState.position.chapter) &&
        Number.isSafeInteger(localState.position.verse) &&
        localState.position.chapter === responseData.chapter &&
        localState.position.verse === responseData.verse
      );

      if (isBookmarkOnly && !positionMatchesLocal && responseData.updatedAt <= updatedAt) {
        config.lastSyncedAt = Math.max(config.lastSyncedAt, responseData.updatedAt);
        if (Array.isArray(responseData.bookmarks)) {
          config.bookmarkBaseline = normalizeBookmarks(responseData.bookmarks);
        }
        saveSyncConfig(storage, config);
        if (bookmarkListsDiffer(responseData.bookmarks, latestLocalState?.bookmarks || [])) {
          onRemoteUpdate({ bookmarks: responseData.bookmarks });
        }
        notifyStatus("synced", "Bookmarks synchronized.");
        return { success: true, data: responseData };
      }

      const remoteWon = !isBookmarkOnly && responseData.updatedAt > updatedAt;
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
    localRevision++;
    ensureBookmarkBaseline(localState);
    if (activePromise) return activePromise;

    activePromise = (async () => {
      const syncRevision = localRevision;
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

        // Reconcile against the latest local state after the async GET operation
        const effectiveLocalState = latestLocalState || localState;
        ensureBookmarkBaseline(effectiveLocalState);

        const localChangedInFlight = localRevision > syncRevision;
        const positionChangedInFlight = !positionsMatch(
          normalizePosition({ ...effectiveLocalState.position, translation: effectiveLocalState.translation }),
          normalizePosition({ ...localState.position, translation: localState.translation })
        );

        if (localChangedInFlight && positionChangedInFlight) {
          // Local position changed while GET was in flight.
          // Never overwrite with older remote data; ensure local timestamp beats remote and push.
          const freshUpdatedAt = Math.max(config.lastUpdatedAt || 0, (remoteData.updatedAt || 0) + 1);
          config.lastUpdatedAt = freshUpdatedAt;
          saveSyncConfig(storage, config);
          return await push(effectiveLocalState, {
            updatedAt: freshUpdatedAt,
            bookmarkUpdatedAt: nextUpdatedAt(),
            isBookmarkOnly: false,
          });
        }

        // If remote has no saved progress yet, push local state
        if (remoteData.empty || !remoteData.updatedAt) {
          config.lastSyncedAt = 0;
          config.lastUpdatedAt = 0;
          config.bookmarkBaseline = [];
          saveSyncConfig(storage, config);
          return await push(effectiveLocalState);
        }

        // If this device has never synced before, adopt existing cloud state
        if (config.lastSyncedAt === 0) {
          if (hasBookmarkChanges(effectiveLocalState.bookmarks)) {
            const adoptedState = {
              ...effectiveLocalState,
              position: { chapter: remoteData.chapter, verse: remoteData.verse },
              translation: remoteData.translation || effectiveLocalState.translation,
            };
            return await push(adoptedState, {
              updatedAt: remoteData.updatedAt,
              bookmarkUpdatedAt: nextUpdatedAt(),
              isBookmarkOnly: true,
            });
          }
          recordRemoteState(remoteData);
          onRemoteUpdate(remoteData);
          notifyStatus("synced", `Synced with cloud (Ayah ${remoteData.chapter}:${remoteData.verse})`);
          return { success: true, direction: "pulled", data: remoteData };
        }

        const localUpdatedAt = config.lastUpdatedAt || 0;
        const localHasBookmarkChanges = hasBookmarkChanges(effectiveLocalState.bookmarks);

        if (remoteData.updatedAt > localUpdatedAt) {
          // Remote reading position is newer than local
          if (localHasBookmarkChanges) {
            const adoptedState = {
              ...effectiveLocalState,
              position: { chapter: remoteData.chapter, verse: remoteData.verse },
              translation: remoteData.translation || effectiveLocalState.translation,
            };
            return await push(adoptedState, {
              updatedAt: remoteData.updatedAt,
              bookmarkUpdatedAt: nextUpdatedAt(),
              isBookmarkOnly: true,
            });
          }
          recordRemoteState(remoteData);
          onRemoteUpdate(remoteData);
          notifyStatus("synced", `Updated to Ayah ${remoteData.chapter}:${remoteData.verse}`);
          return { success: true, direction: "pulled", data: remoteData };
        } else if (localUpdatedAt > remoteData.updatedAt) {
          // Local reading position is newer than remote
          return await push(effectiveLocalState, {
            updatedAt: localUpdatedAt,
            bookmarkUpdatedAt: nextUpdatedAt(),
            isBookmarkOnly: false,
          });
        } else {
          // Equal timestamps (position unchanged on both sides)
          if (localHasBookmarkChanges) {
            return await push(effectiveLocalState, {
              updatedAt: localUpdatedAt > 0 ? localUpdatedAt : remoteData.updatedAt,
              bookmarkUpdatedAt: nextUpdatedAt(),
              isBookmarkOnly: true,
            });
          }
          recordRemoteState(remoteData);
          saveSyncConfig(storage, config);
          if (bookmarkListsDiffer(remoteData.bookmarks, effectiveLocalState.bookmarks)) {
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

    localRevision++;
    ensureBookmarkBaseline(localState);
    const positionChanged = hasPositionChanges(localState);
    if (positionChanged) {
      config.lastPosition = normalizePosition({
        ...localState.position,
        translation: localState.translation,
      });
      config.lastUpdatedAt = nextUpdatedAt();
      saveSyncConfig(storage, config);
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      push(latestLocalState || localState);
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
