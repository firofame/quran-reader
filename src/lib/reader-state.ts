import { TRANSLATIONS, validPosition } from "./reader";
import type { Chapter, ReaderAction, ReaderState, Theme } from "./reader";

/** Binds the chapter catalog so the reducer satisfies React's useReducer signature. */
export function createReaderReducer(chapters: readonly Chapter[]) {
	return (state: ReaderState, action: ReaderAction): ReaderState => reduceReaderState(state, action, chapters);
}

export function reduceReaderState(state: ReaderState, action: ReaderAction, chapters: readonly Chapter[]): ReaderState {
	switch (action.type) {
		case "position/set": {
			if (!validPosition(action.position, chapters)) {
				throw new Error("Cannot set an invalid ayah.");
			}
			return {
				...state,
				position: { chapter: action.position.chapter, verse: action.position.verse },
			};
		}
		case "translation/set":
			if (!Object.hasOwn(TRANSLATIONS, action.translation)) {
				throw new Error("Cannot select an unsupported translation.");
			}
			return { ...state, translation: action.translation };
		case "font-size/adjust":
			if (!Number.isInteger(action.delta)) {
				throw new Error("The reading text size adjustment must be an integer.");
			}
			return { ...state, fontSize: Math.max(17, Math.min(29, state.fontSize + action.delta)) };
		case "theme/toggle": {
			const theme: Theme = state.theme === "dark" ? "light" : "dark";
			return { ...state, theme };
		}
		case "reading-data/update":
			return { ...state, readingData: action.update(state.readingData) };
		default:
			throw new Error(`Unknown reader state action: ${String((action as ReaderAction).type)}.`);
	}
}
