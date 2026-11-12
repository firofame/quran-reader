import { TRANSLATIONS, parseTranslation } from "./reader";
import type { Chapter, TranslationId, Verse } from "./reader";

export type TranslationFetch = (file: string) => Promise<Response>;

export function createTranslationRepository(fetchTranslation: TranslationFetch = globalThis.fetch) {
	if (typeof fetchTranslation !== "function") {
		throw new Error("A translation fetch function is required.");
	}

	const cache = new Map<TranslationId, Verse[][]>();
	const pending = new Map<TranslationId, Promise<Verse[][]>>();

	async function load(id: string, chapters: readonly Chapter[]): Promise<Verse[][]> {
		if (!Object.hasOwn(TRANSLATIONS, id)) {
			throw new Error(`Unknown translation: ${id}.`);
		}
		const translationId = id as TranslationId;
		const cached = cache.get(translationId);
		if (cached) return cached;
		const pendingRequest = pending.get(translationId);
		if (pendingRequest) return pendingRequest;

		const translation = TRANSLATIONS[translationId];
		const request = (async () => {
			const response = await fetchTranslation(translation.file);
			if (!response.ok) throw new Error(`Translation request failed (${response.status}).`);
			const data = parseTranslation(await response.text(), chapters);
			cache.set(translationId, data);
			return data;
		})();
		pending.set(translationId, request);
		try {
			return await request;
		} finally {
			pending.delete(translationId);
		}
	}

	return {
		load,
		getLoaded(id: TranslationId): Verse[][] | undefined {
			return cache.get(id);
		},
	};
}
