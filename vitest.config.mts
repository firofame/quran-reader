import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				// Worker and static asset tests run inside the Workers runtime.
				plugins: [
					cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }),
				],
				test: {
					name: "worker",
					include: ["test/worker/**/*.spec.ts"],
				},
			},
			{
				// The reader modules are plain browser JavaScript, so they are tested in Node.
				test: {
					name: "node",
					include: ["test/node/**/*.spec.ts"],
					environment: "node",
				},
			},
		],
	},
});
