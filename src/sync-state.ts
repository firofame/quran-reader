/**
 * Shared request and payload validation for the Quran Reader sync API.
 *
 * The schemas live here so the Worker and the Durable Object agree on exactly
 * which payloads are acceptable. Zod keeps the rules declarative and gives the
 * API a single source of truth instead of hand-written field checks.
 */

import { z } from "zod";

/** Timestamps may not be more than five minutes ahead of the Worker clock. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** The largest chapter number in the Quran. */
export const MAX_CHAPTER = 114;

/** Translations are identifiers, not documents, so they stay short. */
export const MAX_TRANSLATION_LENGTH = 50;

/**
 * The body accepted by `PUT /api/sync`.
 *
 * Unknown keys are stripped, so legacy payloads (for example the retired
 * `bookmarks` array) are accepted and ignored instead of rejected.
 */
export const syncStateSchema = z.object({
	chapter: z.number().int().safe().min(1).max(MAX_CHAPTER),
	verse: z.number().int().safe().min(1),
	translation: z.string().nullish(),
	updatedAt: z.number().int().safe().positive(),
});

export type SyncState = z.infer<typeof syncStateSchema>;

/**
 * The stored and returned reading state.
 *
 * An empty sync space reports `empty: true` and carries no position, which
 * matches the payload the reader expects from a fresh service.
 */
export interface SyncSnapshot {
	empty: boolean;
	chapter?: number;
	verse?: number;
	translation?: string | null;
	updatedAt: number;
}

/** True when the timestamp is usable as a last-write-wins marker. */
export function isValidTimestamp(value: number, now: number = Date.now()): boolean {
	return Number.isSafeInteger(value) && value > 0 && value <= now + MAX_FUTURE_SKEW_MS;
}

/**
 * Validates a sync payload.
 *
 * Returns `null` when the payload cannot be stored, so callers can answer with
 * a single, stable error.
 */
export function parseSyncState(payload: unknown, now: number = Date.now()): SyncState | null {
	const parsed = syncStateSchema.safeParse(payload);
	if (!parsed.success) {
		return null;
	}
	if (!isValidTimestamp(parsed.data.updatedAt, now)) {
		return null;
	}
	return parsed.data;
}
