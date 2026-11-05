import { TRANSLATIONS, validPosition } from "./reader.js";

export function reduceReaderState(state, action, chapters) {
  if (!action || typeof action !== "object") {
    throw new Error("A reader state action is required.");
  }

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
    case "bookmark/toggle": {
      if (!validPosition(action.position, chapters)) {
        throw new Error("Cannot bookmark an invalid ayah.");
      }
      const { chapter, verse } = action.position;
      const bookmarked = state.bookmarks.some(item => item.chapter === chapter && item.verse === verse);
      return {
        ...state,
        bookmarks: bookmarked
          ? state.bookmarks.filter(item => item.chapter !== chapter || item.verse !== verse)
          : [...state.bookmarks, { chapter, verse }],
      };
    }
    case "font-size/adjust":
      if (!Number.isInteger(action.delta)) {
        throw new Error("The reading text size adjustment must be an integer.");
      }
      return { ...state, fontSize: Math.max(17, Math.min(29, state.fontSize + action.delta)) };
    case "theme/toggle":
      return { ...state, theme: state.theme === "dark" ? "light" : "dark" };
    default:
      throw new Error(`Unknown reader state action: ${String(action.type)}.`);
  }
}
