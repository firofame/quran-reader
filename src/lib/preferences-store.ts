import { decodeState } from "./reader";
import type { Chapter, ReaderState } from "./reader";

export const PREFERENCES_KEY = "quran-reader:v1";

export interface PreferencesStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export function createPreferencesStore(storage: PreferencesStorage, chapters: readonly Chapter[]) {
	return {
		load(): ReaderState {
			return decodeState(storage.getItem(PREFERENCES_KEY), chapters);
		},
		save(state: ReaderState): void {
			storage.setItem(PREFERENCES_KEY, JSON.stringify(state));
		},
	};
}
