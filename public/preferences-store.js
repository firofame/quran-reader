import { decodeState } from "./reader.js";

export const PREFERENCES_KEY = "quran-reader:v1";

export function createPreferencesStore(storage, chapters) {
  return {
    load() {
      return decodeState(storage.getItem(PREFERENCES_KEY), chapters);
    },
    save(state) {
      storage.setItem(PREFERENCES_KEY, JSON.stringify(state));
    },
  };
}
