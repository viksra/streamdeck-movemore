import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { describeDevice } from "../src/profiles/devices.ts";
import { ProfileNotFoundError, listProfiles, loadProfile } from "../src/profiles/reader.ts";
import { DEFAULT_PAGE, F1, F2, type Fixture, P1, P2, PROFILE, createFixture } from "./helpers/fixture.ts";

describe("profile reader", () => {
	let fx: Fixture;
	before(() => (fx = createFixture()));
	after(() => fx.cleanup());

	it("loads pages in Stream Deck order and finds nested folders", async () => {
		const profile = await loadProfile(fx.profilesRoot, PROFILE);
		assert.equal(profile.name, "Default Profile");
		assert.deepEqual(profile.topLevel, [P1, P2]);
		assert.deepEqual([...profile.folders.entries()], [
			[F1, { page: P1, coord: "2,0" }],
			[F2, { page: F1, coord: "2,0" }],
		]);
		assert.ok(profile.pages.has(DEFAULT_PAGE), "hidden default page is loaded but not listed");
		assert.equal(profile.device.name, "Stream Deck XL");
		assert.equal(profile.device.cols, 8);
		assert.equal(profile.device.rows, 4);
		assert.equal(profile.device.known, true);
		assert.equal(profile.device.serial, "CL00A0A00001");
	});

	it("has a revision that only changes when a manifest changes", async () => {
		const a = await loadProfile(fx.profilesRoot, PROFILE);
		const b = await loadProfile(fx.profilesRoot, PROFILE);
		assert.equal(a.revision, b.revision);
		const file = path.join(fx.pageDir(P2), "manifest.json");
		const original = a.pages.get(P2)!.manifest;
		writeFileSync(file, JSON.stringify({ ...original, Name: "renamed" }));
		const c = await loadProfile(fx.profilesRoot, PROFILE);
		assert.notEqual(c.revision, a.revision);
		writeFileSync(file, JSON.stringify(original));
	});

	it("has a layout revision that only changes when keys or pages move", async () => {
		const pageFile = path.join(fx.pageDir(P1), "manifest.json");
		const profileFile = path.join(fx.profilesRoot, `${PROFILE}.sdProfile`, "manifest.json");
		const page = readFileSync(pageFile, "utf8");
		const profile = readFileSync(profileFile, "utf8");
		const layoutAfter = async (edit: { page?: (actions: Record<string, { ActionID: string; State: number; States: { Title?: string }[] }>) => void; pages?: (pages: string[]) => void; current?: string }) => {
			const p = JSON.parse(page);
			edit.page?.(p.Controllers[0].Actions);
			writeFileSync(pageFile, JSON.stringify(p));
			const m = JSON.parse(profile);
			edit.pages?.(m.Pages.Pages);
			if (edit.current) m.Pages.Current = edit.current;
			writeFileSync(profileFile, JSON.stringify(m));
			return loadProfile(fx.profilesRoot, PROFILE);
		};
		try {
			const before = await loadProfile(fx.profilesRoot, PROFILE);
			// Saved by Stream Deck, but nothing moved: a new title, a toggled key, another page shown.
			const touched = await layoutAfter({
				page: (a) => {
					a["0,0"].States[0].Title = "Desk lamp";
					a["0,0"].State = 1;
				},
				current: P2.toLowerCase(),
			});
			assert.notEqual(touched.revision, before.revision);
			assert.equal(touched.layoutRevision, before.layoutRevision);

			const moved = await layoutAfter({
				page: (a) => {
					a["3,0"] = a["0,0"];
					delete a["0,0"];
				},
			});
			assert.notEqual(moved.layoutRevision, before.layoutRevision, "a key moved to another slot");
			const replaced = await layoutAfter({ page: (a) => (a["0,0"].ActionID = "another-key") });
			assert.notEqual(replaced.layoutRevision, before.layoutRevision, "a different key in the same slot");
			const reordered = await layoutAfter({ pages: (p) => p.reverse() });
			assert.notEqual(reordered.layoutRevision, before.layoutRevision, "pages reordered");
		} finally {
			writeFileSync(pageFile, page);
			writeFileSync(profileFile, profile);
		}
	});

	it("tells a deleted profile apart from a broken one", async () => {
		await assert.rejects(loadProfile(fx.profilesRoot, "00000000-0000-4000-8000-000000000000"), ProfileNotFoundError);
	});

	it("lists profiles with counts", async () => {
		const { profiles, errors } = await listProfiles(fx.profilesRoot);
		assert.deepEqual(errors, []);
		assert.equal(profiles.length, 1);
		assert.equal(profiles[0].pageCount, 2);
		assert.equal(profiles[0].folderCount, 2);
		assert.equal(profiles[0].keyCount, 12);
	});

	it("rejects ids that could escape the profiles folder", async () => {
		await assert.rejects(loadProfile(fx.profilesRoot, "..\\..\\Windows"), /Invalid profile id/);
	});
});

describe("device detection", () => {
	it("knows common models", () => {
		assert.deepEqual(pick(describeDevice("20GAA9902", "@(1)[4057/109/AL00A0A00002]", 4, 2)), { name: "Stream Deck", cols: 5, rows: 3, known: true });
		assert.deepEqual(pick(describeDevice("20GAI9901", "", -1, -1)), { name: "Stream Deck Mini", cols: 3, rows: 2, known: true });
	});

	it("falls back to the USB product id", () => {
		assert.deepEqual(pick(describeDevice("UNKNOWN", "@(1)[4057/132/X]", 0, 0)), { name: "Stream Deck +", cols: 4, rows: 2, known: true });
	});

	it("infers the grid of unknown devices and never hides existing keys", () => {
		assert.deepEqual(pick(describeDevice("VSD", "virtual", 6, 5)), { name: "Stream Deck", cols: 7, rows: 6, known: false });
		assert.deepEqual(pick(describeDevice("20GAI9901", "", 4, 0)), { name: "Stream Deck Mini", cols: 5, rows: 2, known: true });
	});
});

function pick(d: { name: string; cols: number; rows: number; known: boolean }) {
	return { name: d.name, cols: d.cols, rows: d.rows, known: d.known };
}
