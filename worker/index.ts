/**
 * Quran Reader — Cloudflare Worker.
 *
 * The reader itself is built by Vite and served as Workers Static Assets
 * through the Cloudflare Vite plugin. This script answers the health check,
 * the reading of a translation aloud, and the JSON fallback for unknown paths.
 */

import { handleSpeech, handleSpeechStatus } from "./speech.ts";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/health") {
			return Response.json({ status: "ok", service: "quran" });
		}
		if (pathname === "/api/speech/status") {
			return handleSpeechStatus(env);
		}
		if (pathname.startsWith("/api/speech/")) {
			return handleSpeech(request, env, ctx);
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
