/**
 * Quran Reader — Cloudflare Worker.
 *
 * The reader itself is served from `public/` as Workers Static Assets. This
 * script only answers the health check and the JSON fallback for unknown paths.
 */

export default {
	fetch(request: Request): Response {
		const { pathname } = new URL(request.url);
		if (pathname === "/health") {
			return Response.json({ status: "ok", service: "quran" });
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
