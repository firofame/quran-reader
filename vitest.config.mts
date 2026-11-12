import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				// Worker tests run inside the Workers runtime.
				plugins: [
					cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }),
				],
				test: {
					name: "worker",
					include: ["test/worker/**/*.spec.ts"],
				},
			},
			{
				// The reader modules are fully typed, so they are tested in Node
				// with the same strict types as the app.
				test: {
					name: "node",
					include: ["test/node/**/*.spec.ts"],
					environment: "node",
				},
			},
		],
	},
});
