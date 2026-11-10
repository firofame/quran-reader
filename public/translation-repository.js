import { TRANSLATIONS, parseTranslation } from "./reader.js";

export function createTranslationRepository(fetchTranslation = globalThis.fetch) {
  if (typeof fetchTranslation !== "function") {
    throw new Error("A translation fetch function is required.");
  }

  const cache = new Map();
  const pending = new Map();

  async function load(id, chapters) {
    if (!Object.hasOwn(TRANSLATIONS, id)) {
      throw new Error(`Unknown translation: ${id}.`);
    }
    if (cache.has(id)) return cache.get(id);
    if (pending.has(id)) return pending.get(id);

    const translation = TRANSLATIONS[id];
    const request = (async () => {
      const response = await fetchTranslation(translation.file);
      if (!response.ok) throw new Error(`Translation request failed (${response.status}).`);
      const data = parseTranslation(await response.text(), chapters);
      cache.set(id, data);
      return data;
    })();
    pending.set(id, request);
    try {
      return await request;
    } finally {
      pending.delete(id);
    }
  }

  return {
    load,
    getLoaded(id) {
      return cache.get(id);
    },
  };
}
