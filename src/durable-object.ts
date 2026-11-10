/**
 * SQLite-backed Durable Object that stores one reader's sync space.
 *
 * Each distinct pairing key maps to its own Durable Object, so a reader's
 * position and translation choice stay isolated from every other reader.
 * SQLite gives strongly consistent reads and writes, which matters when a
 * reader switches devices within seconds.
 */

import { DurableObject } from "cloudflare:workers";
import { isValidTimestamp, MAX_TRANSLATION_LENGTH, parseSyncState, type SyncSnapshot } from "./sync-state";

interface SyncRow {
	chapter: number;
	verse: number;
	translation: string | null;
	updated_at: number;
}

/** Raised when a payload cannot be stored, so the API can answer with a 400. */
export class InvalidSyncStateError extends Error {
	constructor() {
		super("Invalid state payload.");
		this.name = "InvalidSyncStateError";
	}
}

export class SyncDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ensureSchema();
		});
	}

	/**
	 * Creates the state table and removes the retired `bookmarks` column so
	 * older sync spaces keep working without a data migration.
	 *
	 * The check runs again before every write, because a sync space that was
	 * created by an older deployment still carries that column, and the column
	 * is `NOT NULL`, which would reject every insert.
	 */
	private ensureSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS sync_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				chapter INTEGER NOT NULL,
				verse INTEGER NOT NULL,
				translation TEXT,
				updated_at INTEGER NOT NULL
			);
		`);
		const cursor = this.ctx.storage.sql.exec("PRAGMA table_info(sync_state);");
		const columns = typeof cursor.toArray === "function" ? cursor.toArray() : [...cursor];
		if (columns.some(column => column.name === "bookmarks")) {
			this.ctx.storage.sql.exec("ALTER TABLE sync_state DROP COLUMN bookmarks;");
		}
	}

	private readRow(): SyncRow | null {
		const cursor = this.ctx.storage.sql.exec(
			"SELECT chapter, verse, translation, updated_at FROM sync_state WHERE id = 1",
		);
		const rows = typeof cursor.toArray === "function" ? cursor.toArray() : [...cursor];
		const row = rows[0];
		if (!row) {
			return null;
		}
		return {
			chapter: Number(row.chapter),
			verse: Number(row.verse),
			translation: typeof row.translation === "string" ? row.translation : null,
			updated_at: Number(row.updated_at),
		};
	}

	/** Returns the stored reading position, repairing an unusable timestamp. */
	async getSnapshot(): Promise<SyncSnapshot> {
		const row = this.readRow();
		if (!row) {
			return { empty: true, updatedAt: 0 };
		}

		const now = Date.now();
		const storedUpdatedAt = Number(row.updated_at);
		const validStoredTimestamp = isValidTimestamp(storedUpdatedAt, now);
		const updatedAt = validStoredTimestamp ? storedUpdatedAt : now;

		if (!validStoredTimestamp) {
			this.ctx.storage.sql.exec("UPDATE sync_state SET updated_at = ? WHERE id = 1", updatedAt);
		}

		return {
			empty: false,
			chapter: row.chapter,
			verse: row.verse,
			translation: row.translation || null,
			updatedAt,
		};
	}

	/**
	 * Stores a reading position using last-write-wins on the client timestamp.
	 *
	 * An unusable stored timestamp is replaced, and a stored state that is
	 * newer than the incoming one is kept.
	 */
	async putState(payload: unknown): Promise<SyncSnapshot> {
		const state = parseSyncState(payload);
		if (!state) {
			throw new InvalidSyncStateError();
		}

		const existing = this.readRow();
		const now = Date.now();
		const existingUpdatedAt = existing ? existing.updated_at : 0;
		const validExistingTimestamp = existing !== null && isValidTimestamp(existingUpdatedAt, now);
		const positionWins = !existing || !validExistingTimestamp || state.updatedAt >= existingUpdatedAt;
		const nextUpdatedAt = positionWins ? state.updatedAt : existingUpdatedAt;

		const translation =
			typeof state.translation === "string" ? state.translation.slice(0, MAX_TRANSLATION_LENGTH) : null;

		this.ensureSchema();

		this.ctx.storage.sql.exec(
			`INSERT INTO sync_state (id, chapter, verse, translation, updated_at)
			 VALUES (1, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   chapter = excluded.chapter,
			   verse = excluded.verse,
			   translation = excluded.translation,
			   updated_at = excluded.updated_at;`,
			positionWins || !existing ? state.chapter : existing.chapter,
			positionWins || !existing ? state.verse : existing.verse,
			positionWins || !existing ? translation : existing.translation,
			nextUpdatedAt,
		);

		return this.getSnapshot();
	}

	/** HTTP access to the same state, used by tests and direct calls. */
	async fetch(request: Request): Promise<Response> {
		const method = request.method.toUpperCase();

		if (method === "GET") {
			return Response.json(await this.getSnapshot());
		}

		if (method === "PUT" || method === "POST") {
			let payload: unknown;
			try {
				payload = await request.json();
			} catch {
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}
			try {
				return Response.json(await this.putState(payload));
			} catch (error) {
				if (error instanceof InvalidSyncStateError) {
					return Response.json({ error: error.message }, { status: 400 });
				}
				throw error;
			}
		}

		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}
}
