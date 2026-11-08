export const SYNC_STORAGE_KEY = "quran-reader:sync:v1";
export const DEFAULT_SYNC_ENDPOINT = "https://quran-reader-sync.firofame.workers.dev";
export const DEFAULT_SYNC_KEY = "firo-quran-sync";

const DEFAULT_CONFIG = {
  endpoint: "",
  syncKey: "",
  lastSyncedAt: 0,
  lastUpdatedAt: 0,
  autoSync: true,
};

export function loadSyncConfig(storage) {
  try {
    const raw = storage.getItem(SYNC_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
    const config = {
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint.trim() : "",
      syncKey: typeof parsed.syncKey === "string" ? parsed.syncKey.trim() : "",
      lastSyncedAt: typeof parsed.lastSyncedAt === "number" ? parsed.lastSyncedAt : 0,
      lastUpdatedAt: typeof parsed.lastUpdatedAt === "number" ? parsed.lastUpdatedAt : 0,
      autoSync: typeof parsed.autoSync === "boolean" ? parsed.autoSync : true,
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
  const chars = "23456789abcdefghjkmnpqrstuvwxyz";
  let randomValues = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(randomValues);
  } else {
    for (let i = 0; i < randomValues.length; i++) {
      randomValues[i] = Math.floor(Math.random() * 256);
    }
  }

  let result = "quran-";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) result += "-";
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

export function createSyncClient({
  storage = globalThis.localStorage,
  fetch = globalThis.fetch?.bind(globalThis),
  onRemoteUpdate = () => {},
  onStatusChange = () => {},
  debounceMs = 1500,
  defaultEndpoint = "",
  defaultSyncKey = "",
} = {}) {
  let config = loadSyncConfig(storage);
  if (!config.endpoint && !config.disabled && defaultEndpoint) {
    config.endpoint = normalizeEndpoint(defaultEndpoint);
    config.syncKey = (defaultSyncKey || "").trim();
  }

  function isConfigured() {
    return Boolean(!config.disabled && config.endpoint && config.syncKey);
  }

  let status = isConfigured() ? "idle" : "unconfigured";
  let statusMessage = "";
  let debounceTimer = null;
  let activePromise = null;
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
    config = {
      ...config,
      ...newFields,
      disabled: false,
      endpoint: newFields.endpoint !== undefined ? normalizeEndpoint(newFields.endpoint) : config.endpoint,
      syncKey: newFields.syncKey !== undefined ? newFields.syncKey.trim() : config.syncKey,
    };
    saveSyncConfig(storage, config);
    notifyStatus(isConfigured() ? "idle" : "unconfigured", "");
  }

  function clearConfig() {
    config = { ...DEFAULT_CONFIG, disabled: true };
    saveSyncConfig(storage, config);
    clearTimeout(debounceTimer);
    notifyStatus("unconfigured", "");
  }

  function formatSyncError(statusCode, errText) {
    if (statusCode === 401) {
      return "Incorrect sync password or unauthorized.";
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
        notifyStatus("synced", "Ready (no remote data yet)");
        return { success: true, empty: true };
      }

      const localUpdatedAt = config.lastUpdatedAt || 0;
      if (remoteData.updatedAt > localUpdatedAt) {
        config.lastSyncedAt = remoteData.updatedAt;
        config.lastUpdatedAt = remoteData.updatedAt;
        saveSyncConfig(storage, config);
        onRemoteUpdate(remoteData);
        notifyStatus("synced", `Synced with cloud (Ayah ${remoteData.chapter}:${remoteData.verse})`);
        return { success: true, updated: true, data: remoteData };
      }

      config.lastSyncedAt = Date.now();
      saveSyncConfig(storage, config);
      notifyStatus("synced", "Already up to date.");
      return { success: true, updated: false, data: remoteData };
    } catch (err) {
      const message = err?.message || "Network request failed.";
      notifyStatus("offline", `Sync unreachable: ${message}`);
      return { success: false, error: message };
    }
  }

  async function push(localState) {
    if (!isConfigured() || destroyed) {
      return { success: false, reason: "unconfigured" };
    }

    notifyStatus("syncing", "Saving progress to cloud…");
    try {
      const url = `${normalizeEndpoint(config.endpoint)}/api/sync`;
      const now = Date.now();
      const updatedAt = Math.max(now, (config.lastUpdatedAt || 0) + 1);

      const payload = {
        chapter: localState.position.chapter,
        verse: localState.position.verse,
        bookmarks: localState.bookmarks || [],
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

      // Check if remote returned a newer state (conflict resolution)
      if (responseData.updatedAt > updatedAt) {
        config.lastSyncedAt = responseData.updatedAt;
        config.lastUpdatedAt = responseData.updatedAt;
        saveSyncConfig(storage, config);
        onRemoteUpdate(responseData);
        notifyStatus("synced", `Updated from newer cloud data (Ayah ${responseData.chapter}:${responseData.verse})`);
        return { success: true, remoteWon: true, data: responseData };
      }

      config.lastSyncedAt = updatedAt;
      config.lastUpdatedAt = updatedAt;
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
          return await push(localState);
        }

        // If this device has never synced before, adopt existing cloud state
        if (config.lastSyncedAt === 0) {
          config.lastSyncedAt = remoteData.updatedAt;
          config.lastUpdatedAt = remoteData.updatedAt;
          saveSyncConfig(storage, config);
          onRemoteUpdate(remoteData);
          notifyStatus("synced", `Synced with cloud (Ayah ${remoteData.chapter}:${remoteData.verse})`);
          return { success: true, direction: "pulled", data: remoteData };
        }

        const localUpdatedAt = config.lastUpdatedAt || 0;
        if (remoteData.updatedAt > localUpdatedAt) {
          // Remote is newer than local
          config.lastSyncedAt = remoteData.updatedAt;
          config.lastUpdatedAt = remoteData.updatedAt;
          saveSyncConfig(storage, config);
          onRemoteUpdate(remoteData);
          notifyStatus("synced", `Updated to Ayah ${remoteData.chapter}:${remoteData.verse}`);
          return { success: true, direction: "pulled", data: remoteData };
        } else if (localUpdatedAt > remoteData.updatedAt) {
          // Local is newer than remote
          return await push(localState);
        } else {
          // Equal timestamps
          config.lastSyncedAt = Date.now();
          saveSyncConfig(storage, config);
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
