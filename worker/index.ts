/**
 * Quran Reader — Cloudflare Worker.
 *
 * The reader itself is built by Vite and served as Workers Static Assets
 * through the Cloudflare Vite plugin. This script answers the health check
 * and the JSON fallback for unknown paths.
 */

export default {
	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/health") {
			return Response.json({ status: "ok", service: "quran" });
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
