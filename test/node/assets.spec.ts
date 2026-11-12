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

	it("keeps text-size controls on the reader and reading history in Settings", async () => {
		const html = await readPublicFile("index.html");
		const readerPage = html.slice(html.indexOf('id="reader-page"'), html.indexOf('id="settings-page"'));
		const settingsPage = html.slice(html.indexOf('id="settings-page"'), html.indexOf("</main>"));
		// Text size can be changed while reading the ayah.
		expect(readerPage).toMatch(/id="font-up"/);
		expect(readerPage).toMatch(/id="font-down"/);
		expect(readerPage).not.toMatch(/id="mark-read-(block|btn)"/);
		expect(readerPage).not.toMatch(/id="reading-controls"/);
		// Settings keeps the reading-history catch-up control.
		expect(settingsPage).not.toMatch(/id="font-(up|down)"/);
		expect(settingsPage).toMatch(/id="mark-read-block"/);
		expect(settingsPage).toMatch(/id="mark-read-btn"/);
	});

	it("offers the five daily prayers instead of manual reading anchors", async () => {
		const html = await readPublicFile("index.html");
		// The prayers are fixed, so nothing can be added or removed by hand.
		expect(html).not.toMatch(/id="add-anchor"/);
		expect(html).not.toMatch(/id="anchor-editor"/);
		expect(html).not.toMatch(/Reading anchors/);
		expect(html).not.toMatch(/add-anchor/);
		expect(html).toMatch(/id="prayer-editor"/);
		expect(html).toMatch(/Daily prayers/);
	});

	it("keeps an adhan and an iqama time for every prayer", async () => {
		const html = await readPublicFile("index.html");
		expect(html).toMatch(/adhan and iqama/);
		expect(html).toMatch(/Browser reminders at the adhan and iqama/);

		const app = await readPublicFile("app.js");
		expect(app).toMatch(/\[data-prayer-adhan\]/);
		expect(app).toMatch(/prayerAdhan/);
		expect(app).toMatch(/prayerIqama/);
	});

	it("counts down to the next prayer moment after the daily progress and the ruku", async () => {
		const html = await readPublicFile("index.html");
		const readerPage = html.slice(html.indexOf('id="reader-page"'), html.indexOf('id="settings-page"'));
		// The prayer chips are gone.
		expect(readerPage).not.toMatch(/id="prayer-chips"/);
		expect(readerPage).not.toMatch(/prayer-chip/);
		// The countdown sits after today's progress and the ruku indicator.
		expect(readerPage).toMatch(/id="prayer-countdown"/);
		expect(readerPage).toMatch(/prayer-countdown-time/);
		const today = readerPage.indexOf('id="today-progress"');
		const ruku = readerPage.indexOf('id="ruku-progress-wrap"');
		const countdown = readerPage.indexOf('id="prayer-countdown"');
		expect(today).toBeLessThan(ruku);
		expect(ruku).toBeLessThan(countdown);
	});

	it("keeps the chapter heading and the ruku indicator lean", async () => {
		const app = await readPublicFile("app.js");
		const html = await readPublicFile("index.html");
		// The heading shows the chapter title and the ayah metadata only.
		// The chapter meaning and verse count stay available to screen readers.
		expect(app).toMatch(/class="sr-only">\$\{chapter\.meaning\} · \$\{chapter\.verses\} ayahs/);
		expect(app).not.toMatch(/ruku \$\{localRuku\} of/);
		// The ruku indicator keeps a short label beside today's progress.
		expect(html).toMatch(/class="ruku-progress-label">Ruku</);
		expect(app).not.toMatch(/Verse \$\{progress\.value\}/);
	});

	it("keeps the reader free of anchor markup", async () => {
		const app = await readPublicFile("app.js");
		const html = await readPublicFile("index.html");
		for (const source of [app, html]) {
			expect(source).not.toMatch(/anchor/i);
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

	it("keeps the reading aloud feature out of the reader", async () => {
		const app = await readPublicFile("app.js");
		const html = await readPublicFile("index.html");
		// The reader is read with the eyes: there is no request for an audio
		// reading and no control that asks for one.
		expect(app).not.toMatch(/api\/speech/);
		expect(app).not.toMatch(/data-speak-verse/);
		expect(app).not.toMatch(/new AudioContext\(\)/);
		expect(html).not.toMatch(/id="translation-audio"/);
		// The recitation of the ayah itself is untouched.
		expect(html).toMatch(/id="verse-audio"/);
	});

	it("keeps the modules the reader needs in the offline cache", async () => {
		const worker = await readPublicFile("service-worker.js");
		for (const file of ["app.js", "reader.js", "reader-state.js", "reading-data.js", "translation-repository.js"]) {
			expect(worker, file).toContain(`"./${file}"`);
		}
		// The reading aloud module is gone, so it is no longer cached.
		expect(worker).not.toMatch(/\.\/speech\.js/);
	});
});
