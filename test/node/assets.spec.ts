import { describe, expect, it } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = new URL("../../public/", import.meta.url);

/** Every file the reader needs at runtime. */
const READER_FILES = [
	"index.html",
	"styles.css",
	"app.js",
	"reader.js",
	"reader-state.js",
	"reading-data.js",
	"preferences-store.js",
	"translation-repository.js",
	"quran-data.js",
	"service-worker.js",
	"manifest.webmanifest",
	"favicon.svg",
	"icon-192.png",
	"icon-512.png",
	"en.sahih.txt",
];

async function readPublicFile(name: string): Promise<string> {
	return readFile(fileURLToPath(new URL(name, PUBLIC_DIR).href), "utf8");
}

describe("published assets", () => {
	it("ships every file the reader needs", async () => {
		for (const file of READER_FILES) {
			const info = await stat(fileURLToPath(new URL(file, PUBLIC_DIR).href));
			expect(info.isFile(), file).toBe(true);
			expect(info.size, file).toBeGreaterThan(0);
		}
	});

	it("ships nothing that the Worker must not publish", async () => {
		const published = (await readdir(fileURLToPath(PUBLIC_DIR.href))).sort();
		expect(published).toEqual([...READER_FILES].sort());
	});

	it("lists every cached asset in the service worker", async () => {
		const serviceWorker = await readPublicFile("service-worker.js");
		for (const file of READER_FILES) {
			// The service worker never caches itself.
			if (file === "service-worker.js") continue;
			expect(serviceWorker, file).toContain(`"./${file}"`);
		}
	});

	it("references only published assets from the reader page", async () => {
		const html = await readPublicFile("index.html");
		const referenced = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), match => match[1]);
		for (const reference of referenced) {
			if (/^(https?:|#|data:|mailto:)/.test(reference)) continue;
			// The brand link points at the reader root.
			if (reference === "./") continue;
			expect(READER_FILES, reference).toContain(reference.replace(/^\.\//, ""));
		}
	});

	it("keeps the manifest and the icons in sync", async () => {
		const manifest = JSON.parse(await readPublicFile("manifest.webmanifest"));
		expect(manifest.start_url).toBe("./");
		expect(manifest.display).toBe("standalone");
		expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual(
			expect.arrayContaining(["icon-192.png", "icon-512.png"]),
		);
	});
});
