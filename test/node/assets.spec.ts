import { describe, expect, it } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = new URL("../../public/", import.meta.url);
const SRC_DIR = new URL("../../src/", import.meta.url);
const ROOT = new URL("../..", import.meta.url);

/** The static files that ship with the built reader. */
const PUBLIC_FILES = ["favicon.svg", "icon-192.png", "icon-512.png", "en.hilali.txt"];

/** Collects every UI source file so the invariants can scan them at once. */
async function collectSources(): Promise<string> {
	const sources: string[] = [];
	const componentDir = new URL("components/", SRC_DIR);
	for (const entry of await readdir(fileURLToPath(componentDir))) {
		if (/\.(ts|tsx)$/.test(entry)) {
			sources.push(await readFile(fileURLToPath(new URL(entry, componentDir)), "utf8"));
		}
	}
	sources.push(await readFile(fileURLToPath(new URL("App.tsx", SRC_DIR).href), "utf8"));
	sources.push(await readFile(fileURLToPath(new URL("main.tsx", SRC_DIR).href), "utf8"));
	sources.push(await readFile(fileURLToPath(new URL("index.css", SRC_DIR).href), "utf8"));
	sources.push(await readFile(fileURLToPath(new URL("index.html", ROOT).href), "utf8"));
	return sources.join("\n");
}

describe("published assets", () => {
	it("ships every static file the reader needs", async () => {
		for (const file of PUBLIC_FILES) {
			const info = await stat(fileURLToPath(new URL(file, PUBLIC_DIR).href));
			expect(info.isFile(), file).toBe(true);
			expect(info.size, file).toBeGreaterThan(0);
		}
	});

	it("ships nothing that the Worker must not publish", async () => {
		const published = (await readdir(fileURLToPath(PUBLIC_DIR.href))).sort();
		expect(published).toEqual([...PUBLIC_FILES].sort());
	});

	it("references only published assets from the reader page", async () => {
		const html = await readFile(fileURLToPath(new URL("index.html", ROOT).href), "utf8");
		const referenced = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), match => match[1]);
		for (const reference of referenced) {
			if (/^(https?:|#|data:|mailto:)/.test(reference)) continue;
			// The app entry is bundled by Vite.
			if (reference.startsWith("/src/")) continue;
			expect(PUBLIC_FILES, reference).toContain(reference.replace(/^\//, ""));
		}
	});
});

describe("reading comfort invariants", () => {
	it("does not trigger navigation on touch scrolling or swipe gestures", async () => {
		const sources = await collectSources();
		// No touch event listeners exist in the app.
		expect(sources).not.toMatch(/addEventListener\(\s*["']touch/i);
		// No pointer dragging listeners exist in the app.
		expect(sources).not.toMatch(/addEventListener\(\s*["']pointer/i);
		// No gesture/swipe helper or tracking state exists.
		expect(sources).not.toMatch(/swipeDirection|ayahTouch|is-dragging/i);
	});

	it("keeps text selection and copying working without dragging or selection locks", async () => {
		const css = await readFile(fileURLToPath(new URL("index.css", SRC_DIR).href), "utf8");
		// No user-select: none disabling selection in reader or verses.
		expect(css).not.toMatch(/user-select:\s*none/i);
		// No grab/grabbing cursors on reading content or verses.
		expect(css).not.toMatch(/cursor:\s*grab/i);
		expect(css).not.toMatch(/cursor:\s*grabbing/i);
	});

	it("applies no page-flip animation or 3D transform during navigation", async () => {
		const sources = await collectSources();
		expect(sources).not.toMatch(/page-turn|pageTurn|beginPageTurn|settlePageTurn|page-preview/i);
		expect(sources).not.toMatch(/rotateY|perspective:/i);
	});
});

describe("reader layout invariants", () => {
	it("keeps text-size controls on the reader and reading history in Settings", async () => {
		const reader = await readFile(fileURLToPath(new URL("components/Reader.tsx", SRC_DIR).href), "utf8");
		const settings = await readFile(fileURLToPath(new URL("components/SettingsPage.tsx", SRC_DIR).href), "utf8");
		// Text size can be changed while reading the ayah.
		expect(reader).toMatch(/id="font-up"/);
		expect(reader).toMatch(/id="font-down"/);
		expect(reader).not.toMatch(/mark-read-(block|btn)/);
		// Settings keeps the reading-history catch-up control.
		expect(settings).not.toMatch(/id="font-(up|down)"/);
		expect(settings).toMatch(/id="mark-read-block"/);
		expect(settings).toMatch(/id="mark-read-btn"/);
	});

	it("offers the five daily prayers instead of manual reading anchors", async () => {
		const settings = await readFile(fileURLToPath(new URL("components/SettingsPage.tsx", SRC_DIR).href), "utf8");
		// The prayers are fixed, so nothing can be added or removed by hand.
		expect(settings).toMatch(/id="prayer-editor"/);
		expect(settings).toMatch(/Daily prayers/);
		const sources = await collectSources();
		expect(sources).not.toMatch(/anchor/i);
	});

	it("keeps an adhan and an iqama time for every prayer", async () => {
		const settings = await readFile(fileURLToPath(new URL("components/SettingsPage.tsx", SRC_DIR).href), "utf8");
		expect(settings).toMatch(/adhan and iqama/);
		expect(settings).toMatch(/Browser reminders at the adhan and 5 minutes before iqama/);
		expect(settings).toMatch(/adhan time/);
		expect(settings).toMatch(/iqama time/);
	});

	it("counts down to the next prayer moment after the daily progress and shows ruku progress on the separation line", async () => {
		const panel = await readFile(fileURLToPath(new URL("components/DailyPanel.tsx", SRC_DIR).href), "utf8");
		// The prayer chips are gone.
		expect(panel).not.toMatch(/prayer-chip/);
		// The countdown sits in the daily panel, and ruku progress sits on the line below.
		expect(panel).toMatch(/id="prayer-countdown"/);
		expect(panel).toMatch(/prayer-countdown-time/);
		const today = panel.indexOf('id="today-progress"');
		const countdown = panel.indexOf('id="prayer-countdown"');
		const ruku = panel.indexOf('id="ruku-progress"');
		expect(today).toBeLessThan(countdown);
		expect(countdown).toBeLessThan(ruku);
		expect(panel).toMatch(/Ruku completed/);
	});

	it("keeps overall ruku progress markup and progress bars out of the reader", async () => {
		const sources = await collectSources();
		expect(sources).not.toMatch(/overall-progress|surah-progress|ayah-nav-position/);
	});

	it("keeps the reader footer attribution out of the reader", async () => {
		const sources = await collectSources();
		expect(sources).not.toMatch(/reader-footer|metadata-credit|attribution/);
		expect(sources).not.toMatch(/A translation of the meanings of the Quran/);
	});

	it("formats the verse reference as Ayah: verse / totalVerses", async () => {
		const verseCard = await readFile(fileURLToPath(new URL("components/VerseCard.tsx", SRC_DIR).href), "utf8");
		expect(verseCard).toMatch(/Ayah: \{verse\.verse\} \/ \{totalVerses\}/);
	});

	it("keeps the reading aloud feature out of the reader", async () => {
		const sources = await collectSources();
		// The reader is read with the eyes: there is no request for an audio
		// reading and no control that asks for one.
		expect(sources).not.toMatch(/api\/speech/);
		expect(sources).not.toMatch(/data-speak-verse/);
		expect(sources).not.toMatch(/AudioContext/);
		// The recitation of the ayah itself is untouched.
		expect(sources).toMatch(/id="verse-audio"/);
	});

	it("keeps the translation picker out of the reader", async () => {
		const sources = await collectSources();
		expect(sources).not.toMatch(/id="translation"/);
		expect(sources).not.toMatch(/abdulhameed/i);
	});
});

describe("installable app", () => {
	it("keeps the manifest and the icons in sync", async () => {
		const config = await readFile(fileURLToPath(new URL("vite.config.ts", ROOT).href), "utf8");
		expect(config).toMatch(/short_name: 'Quran Reader'/);
		expect(config).toMatch(/display: 'standalone'/);
		expect(config).toMatch(/start_url: '\.\/'/);
		expect(config).toMatch(/icon-192\.png/);
		expect(config).toMatch(/icon-512\.png/);
	});

	it("registers the generated service worker with automatic updates", async () => {
		const entry = await readFile(fileURLToPath(new URL("main.tsx", SRC_DIR).href), "utf8");
		expect(entry).toMatch(/registerSW/);
	});
});
