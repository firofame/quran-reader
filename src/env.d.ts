/**
 * Optional environment variables that are not part of the default deployment.
 *
 * `SYNC_SECRET` restricts the sync API to one shared key. Leave it unset for
 * normal use: every pairing key then gets its own isolated sync space.
 */
declare namespace Cloudflare {
	interface Env {
		SYNC_SECRET?: string;
	}
}

interface Env {
	SYNC_SECRET?: string;
}
