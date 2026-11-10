/**
 * Pairing-key handling for the sync API.
 *
 * Every reader holds a private pairing key. The key is never stored: only its
 * SHA-256 hash is used to derive the Durable Object that owns the sync space,
 * so a leaked hash cannot be replayed as a key.
 */

/**
 * Reads the pairing key from the request.
 *
 * Both `Authorization: Bearer <key>` (RFC 6750) and `X-Sync-Key: <key>` are
 * accepted, and the header name is case-insensitive.
 */
export function extractAuthKey(request: Request): string | null {
	const auth = request.headers.get("Authorization");
	if (auth) {
		const match = auth.match(/^Bearer\s+(.+)$/i);
		if (match && match[1].trim()) {
			return match[1].trim();
		}
	}
	const custom = request.headers.get("X-Sync-Key");
	if (custom && custom.trim()) {
		return custom.trim();
	}
	return null;
}

/** Hashes a pairing key into the Durable Object name that stores its state. */
export async function hashSyncKey(authKey: string): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authKey));
	return Array.from(new Uint8Array(hashBuffer))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
}
