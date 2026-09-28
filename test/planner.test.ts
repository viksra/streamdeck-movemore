import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type MovePlan, type PlanOp, collectImageRefs, newImageName, planChanges, planMoves } from "../src/profiles/planner.ts";
import { loadProfile } from "../src/profiles/reader.ts";
import {
	DEFAULT_PAGE,
	F1,
	F2,
	type Fixture,
	IMG_A1,
	OTHER_PAGE,
	OTHER_PROFILE,
	P1,
	P2,
	PROFILE,
	addKey,
	addOtherProfile,
	createFixture,
	gotoKey,
	switchKey,
} from "./helpers/fixture.ts";

const NEW = "11111111-2222-4333-8444-555555555555";

type Manifest = { Controllers: { Actions: Record<string, { Name: string; States: { Image?: string; Title?: string }[] }> | null; Type: string }[] };

function manifestOp(plan: MovePlan, page: string): Manifest {
	const op = plan.ops.find((o) => o.kind === "manifest" && o.dest.includes(page));
	assert.ok(op && op.kind === "manifest", `expected a manifest write for ${page}`);
	return JSON.parse(op.content) as Manifest;
}

function titles(m: Manifest): Record<string, string> {
	const actions = m.Controllers[0].Actions ?? {};
	return Object.fromEntries(Object.entries(actions).map(([coord, a]) => [coord, a.States[0].Title ?? a.Name]));
}

const kinds = (ops: PlanOp[]) => ops.map((o) => o.kind);

describe("planMoves", () => {
	let fx: Fixture;
	beforeEach(() => (fx = createFixture()));
	afterEach(() => fx.cleanup());
	const load = () => loadProfile(fx.profilesRoot, PROFILE);

	it("moves several keys within a page and keeps Stream Deck's key order", async () => {
		const plan = planMoves(await load(), [
			{ from: { page: P1, coord: "0,0" }, to: { page: P1, coord: "4,2" } },
			{ from: { page: P1, coord: "0,1" }, to: { page: P1, coord: "4,3" } },
		]);
		assert.deepEqual(kinds(plan.ops), ["manifest"]);
		const m = manifestOp(plan, P1);
		assert.deepEqual(Object.keys(m.Controllers[0].Actions!), ["1,0", "2,0", "4,2", "4,3", "7,3"]);
		assert.deepEqual(titles(m), { "1,0": "Mail", "2,0": "Tools", "4,2": "Lamp", "4,3": "Fan", "7,3": "Last" });
		assert.equal(plan.summary.moved, 2);
		assert.equal(plan.summary.crossPage, 0);
	});

	it("writes JSON byte-compatible with Stream Deck: untouched structure is preserved", async () => {
		const profile = await load();
		const plan = planMoves(profile, [{ from: { page: P1, coord: "7,3" }, to: { page: P1, coord: "6,3" } }]);
		const written = (plan.ops[0] as { content: string }).content;
		const expected = structuredClone(profile.pages.get(P1)!.manifest);
		const actions = expected.Controllers[0].Actions!;
		const moved = actions["7,3"];
		delete actions["7,3"];
		actions["6,3"] = moved;
		const sorted = Object.fromEntries(Object.entries(actions).sort(([a], [b]) => (a < b ? -1 : 1)));
		expected.Controllers[0].Actions = sorted;
		assert.equal(written, JSON.stringify(expected));
	});

	it("allows keys to swap places", async () => {
		const plan = planMoves(await load(), [
			{ from: { page: P1, coord: "0,0" }, to: { page: P1, coord: "1,0" } },
			{ from: { page: P1, coord: "1,0" }, to: { page: P1, coord: "0,0" } },
		]);
		assert.deepEqual(titles(manifestOp(plan, P1)), { "0,0": "Mail", "0,1": "Fan", "1,0": "Lamp", "2,0": "Tools", "7,3": "Last" });
	});

	it("refuses to overwrite a key that is not moving", async () => {
		const profile = await load();
		assert.throws(() => planMoves(profile, [{ from: { page: P1, coord: "0,0" }, to: { page: P1, coord: "1,0" } }]), /taken by "Mail"/);
	});

	it("moves a key to another page together with its image", async () => {
		const plan = planMoves(await load(), [{ from: { page: P1, coord: "0,1" }, to: { page: P2, coord: "5,0" } }]);
		assert.deepEqual(kinds(plan.ops), ["image", "manifest", "manifest", "delete"]);
		const [copy, , , remove] = plan.ops;
		assert.equal(copy.kind === "image" && path.relative(fx.pageDir(P2), copy.dest), path.join("Images", "B.png"));
		assert.equal(copy.kind === "image" && copy.source, path.join(fx.pageDir(P1), "Images", "B.png"));
		assert.equal(remove.kind === "delete" && remove.dest, path.join(fx.pageDir(P1), "Images", "B.png"));
		assert.equal(manifestOp(plan, P2).Controllers[0].Actions!["5,0"].States[0].Image, "Images/B.png");
		assert.equal(manifestOp(plan, P1).Controllers[0].Actions!["0,1"], undefined);
		assert.deepEqual(plan.summary, {
			moved: 1,
			crossPage: 1,
			pages: 2,
			imagesCopied: 1,
			imagesRemoved: 1,
			pagesAdded: 0,
			pagesDeleted: 0,
			pagesReordered: false,
			linksUpdated: 0,
		});
		assert.deepEqual(plan.profiles.map((p) => p.id), [PROFILE]);
	});

	it("renames an image when the destination page already has a different file with that name", async () => {
		const plan = planMoves(await load(), [{ from: { page: P1, coord: "0,0" }, to: { page: P2, coord: "3,0" } }]);
		const copy = plan.ops.find((o) => o.kind === "image")!;
		const newName = path.basename(copy.dest);
		assert.notEqual(newName, "A.png");
		assert.match(newName, /^[0-9A-TVW]{26}Z\.png$/);
		const moved = manifestOp(plan, P2).Controllers[0].Actions!["3,0"];
		assert.equal(moved.States[0].Image, `Images/${newName}`);
		assert.equal(manifestOp(plan, P2).Controllers[0].Actions!["1,0"].States[0].Image, "Images/A.png", "existing key keeps its image");
		assert.ok(plan.ops.some((o) => o.kind === "delete" && o.dest.endsWith(path.join(P1, "Images", "A.png"))));
	});

	it("reuses an identical image instead of copying it again", async () => {
		writeFileSync(path.join(fx.pageDir(P2), "Images", "A.png"), IMG_A1);
		const plan = planMoves(await load(), [{ from: { page: P1, coord: "0,0" }, to: { page: P2, coord: "3,0" } }]);
		assert.equal(plan.ops.filter((o) => o.kind === "image").length, 0);
		assert.equal(manifestOp(plan, P2).Controllers[0].Actions!["3,0"].States[0].Image, "Images/A.png");
	});

	it("keeps an image that is still used on the source page", async () => {
		const profile = await load();
		profile.pages.get(P1)!.manifest.Controllers[0].Actions!["1,0"].States = [{ Image: "Images/B.png" }];
		const plan = planMoves(profile, [{ from: { page: P1, coord: "0,1" }, to: { page: P2, coord: "5,0" } }]);
		assert.equal(plan.ops.filter((o) => o.kind === "delete").length, 0);
	});

	it("moves keys into a folder and writes null for an emptied page", async () => {
		const plan = planMoves(await load(), [
			{ from: { page: P2, coord: "0,0" }, to: { page: F2, coord: "2,0" } },
			{ from: { page: P2, coord: "1,0" }, to: { page: F2, coord: "3,0" } },
		]);
		assert.equal(manifestOp(plan, P2).Controllers[0].Actions, null);
		assert.deepEqual(Object.keys(manifestOp(plan, F2).Controllers[0].Actions!), ["0,0", "1,0", "2,0", "3,0"]);
	});

	it("never moves the Parent Folder key", async () => {
		const profile = await load();
		assert.throws(() => planMoves(profile, [{ from: { page: F1, coord: "0,0" }, to: { page: F1, coord: "5,0" } }]), /Parent Folder/);
	});

	it("refuses to hide a folder inside itself", async () => {
		const profile = await load();
		assert.throws(() => planMoves(profile, [{ from: { page: P1, coord: "2,0" }, to: { page: F1, coord: "5,0" } }]), /Folder "Tools" can't be moved into itself/);
		assert.throws(() => planMoves(profile, [{ from: { page: P1, coord: "2,0" }, to: { page: F2, coord: "5,0" } }]), /into itself/);
	});

	it("allows moving a folder key to another page", async () => {
		const plan = planMoves(await load(), [{ from: { page: P1, coord: "2,0" }, to: { page: P2, coord: "7,0" } }]);
		assert.equal(manifestOp(plan, P2).Controllers[0].Actions!["7,0"].Name, "Create Folder");
	});

	it("validates bounds, duplicates and unknown keys", async () => {
		const profile = await load();
		assert.throws(() => planMoves(profile, [{ from: { page: P1, coord: "0,0" }, to: { page: P1, coord: "8,0" } }]), /outside the 8×4/);
		assert.throws(() => planMoves(profile, [{ from: { page: P1, coord: "0,0" }, to: { page: P1, coord: "a,b" } }]), /outside/);
		assert.throws(() => planMoves(profile, [{ from: { page: P1, coord: "5,5" }, to: { page: P1, coord: "1,1" } }]), /no key at/);
		assert.throws(
			() =>
				planMoves(profile, [
					{ from: { page: P1, coord: "0,0" }, to: { page: P1, coord: "3,3" } },
					{ from: { page: P1, coord: "0,1" }, to: { page: P1, coord: "3,3" } },
				]),
			/Two keys are moved to/,
		);
		assert.throws(() => planMoves(profile, [{ from: { page: P1, coord: "0,0" }, to: { page: "NOPE", coord: "1,1" } }]), /Unknown destination page/);
		assert.throws(() => planMoves(profile, [{ from: { page: P1, coord: "0,0" }, to: { page: P1, coord: "0,0" } }]), /Nothing to apply/);
	});
});

describe("planChanges with page changes", () => {
	let fx: Fixture;
	beforeEach(() => (fx = createFixture()));
	afterEach(() => fx.cleanup());
	const load = () => loadProfile(fx.profilesRoot, PROFILE);
	const opFor = (plan: MovePlan, dest: string) => plan.ops.find((o) => o.dest.toLowerCase() === dest.toLowerCase());
	const written = (plan: MovePlan, dest: string) => {
		const op = opFor(plan, dest);
		assert.ok(op && op.kind === "manifest", `expected a manifest write to ${dest}`);
		return JSON.parse(op.content);
	};
	const profileManifest = () => path.join(fx.profilesRoot, `${PROFILE}.sdProfile`, "manifest.json");
	const pageManifest = (page: string) => path.join(fx.pageDir(page), "manifest.json");

	it("reorders pages and renumbers Go to Page keys so they open the same page", async () => {
		addKey(fx, P1, "5,0", gotoKey(2));
		addKey(fx, P2, "5,0", gotoKey(1));
		const plan = planChanges(await load(), { moves: [], pages: { order: [P2, P1], created: [], deleted: [] } });
		assert.deepEqual(written(plan, profileManifest()).Pages.Pages, [P2.toLowerCase(), P1.toLowerCase()]);
		assert.equal(written(plan, pageManifest(P1)).Controllers[0].Actions["5,0"].Settings.PageIndex, 1);
		assert.equal(written(plan, pageManifest(P2)).Controllers[0].Actions["5,0"].Settings.PageIndex, 2);
		assert.equal(plan.summary.pagesReordered, true);
		assert.equal(plan.summary.linksUpdated, 2);
		assert.ok(!plan.ops.some((o) => o.kind === "mkdir" || o.kind === "deleteDir"));
	});

	it("adds a page shaped like Stream Deck's own and moves keys onto it", async () => {
		addKey(fx, P1, "5,0", gotoKey(2, "To P2"));
		const plan = planChanges(await load(), {
			moves: [{ from: { page: P1, coord: "0,1" }, to: { page: NEW, coord: "3,1" } }],
			pages: { order: [P1, NEW, P2], created: [NEW], deleted: [] },
		});
		const newDir = path.join(fx.profilesRoot, `${PROFILE}.sdProfile`, "Profiles", NEW);
		assert.deepEqual(plan.ops.filter((o) => o.kind === "mkdir").map((o) => o.dest), [newDir, path.join(newDir, "Images")]);
		const create = opFor(plan, path.join(newDir, "manifest.json"));
		assert.ok(create && create.kind === "manifest" && create.expectedSha1 === null);
		const manifest = JSON.parse(create.content);
		assert.deepEqual(Object.keys(manifest), ["Controllers", "Icon", "Name"]);
		assert.equal(manifest.Controllers[0].Actions["3,1"].States[0].Image, "Images/B.png");
		assert.ok(plan.ops.some((o) => o.kind === "image" && o.dest === path.join(newDir, "Images", "B.png")));
		assert.equal(written(plan, pageManifest(P1)).Controllers[0].Actions["5,0"].Settings.PageIndex, 3, "page 2 is now page 3");
		assert.deepEqual(written(plan, profileManifest()).Pages.Pages, [P1, NEW, P2].map((p) => p.toLowerCase()));
		assert.equal(plan.summary.pagesAdded, 1);
		assert.equal(plan.summary.pagesReordered, false);
	});

	it("an empty new page gets a manifest with no keys", async () => {
		const plan = planChanges(await load(), { moves: [], pages: { order: [P1, P2, NEW], created: [NEW], deleted: [] } });
		const defaultPage = await load().then((p) => p.pages.get(DEFAULT_PAGE)!.manifest);
		const created = opFor(plan, path.join(fx.profilesRoot, `${PROFILE}.sdProfile`, "Profiles", NEW, "manifest.json"));
		assert.ok(created && created.kind === "manifest");
		assert.equal(created.content, JSON.stringify(defaultPage));
	});

	it("deletes a page emptied in the same change and moves the current page off it", async () => {
		const manifest = JSON.parse(readFileSync(profileManifest(), "utf8"));
		manifest.Pages.Current = P2.toLowerCase();
		writeFileSync(profileManifest(), JSON.stringify(manifest));
		const plan = planChanges(await load(), {
			moves: [
				{ from: { page: P2, coord: "0,0" }, to: { page: P1, coord: "4,0" } },
				{ from: { page: P2, coord: "1,0" }, to: { page: P1, coord: "4,1" } },
			],
			pages: { order: [P1], created: [], deleted: [P2] },
		});
		const remove = plan.ops.find((o) => o.kind === "deleteDir");
		assert.ok(remove && remove.kind === "deleteDir" && remove.dest === fx.pageDir(P2));
		assert.equal(plan.ops.at(-1), remove, "the folder goes last");
		assert.equal(opFor(plan, pageManifest(P2)), undefined);
		const profileAfter = written(plan, profileManifest());
		assert.deepEqual(profileAfter.Pages.Pages, [P1.toLowerCase()]);
		assert.equal(profileAfter.Pages.Current, P1.toLowerCase());
		assert.ok(!plan.ops.some((o) => o.kind === "delete"), "images of a deleted page go with its folder");
		assert.equal(plan.summary.pagesDeleted, 1);
	});

	it("refuses to delete a page that still has keys", async () => {
		const profile = await load();
		assert.throws(() => planChanges(profile, { moves: [], pages: { order: [P1], created: [], deleted: [P2] } }), /still has keys/);
	});

	it("refuses to delete a page that a key opens", async () => {
		addKey(fx, P1, "5,0", gotoKey(2));
		const profile = await load();
		const moves = [
			{ from: { page: P2, coord: "0,0" }, to: { page: P1, coord: "4,0" } },
			{ from: { page: P2, coord: "1,0" }, to: { page: P1, coord: "4,1" } },
		];
		assert.throws(() => planChanges(profile, { moves, pages: { order: [P1], created: [], deleted: [P2] } }), /a page that would be deleted/);
	});

	it("renumbers Switch Profile keys in other profiles and backs those profiles up too", async () => {
		addOtherProfile(fx, { "0,0": switchKey(PROFILE, 2), "1,0": switchKey("00000000-0000-4000-8000-000000000000", 2) });
		const other = await loadProfile(fx.profilesRoot, OTHER_PROFILE);
		const plan = planChanges(await load(), { moves: [], pages: { order: [P2, P1], created: [], deleted: [] } }, [other]);
		assert.deepEqual(plan.profiles.map((p) => p.id), [PROFILE, OTHER_PROFILE]);
		const otherPage = path.join(fx.profilesRoot, `${OTHER_PROFILE}.sdProfile`, "Profiles", OTHER_PAGE, "manifest.json");
		const actions = written(plan, otherPage).Controllers[0].Actions;
		assert.equal(actions["0,0"].Settings.PageIndex, 1);
		assert.equal(actions["1,0"].Settings.PageIndex, 2, "keys opening other profiles are left alone");
		assert.equal(plan.summary.linksUpdated, 1);
	});

	it("leaves every page link alone when only keys move", async () => {
		addOtherProfile(fx, { "0,0": switchKey(PROFILE, 2) });
		const other = await loadProfile(fx.profilesRoot, OTHER_PROFILE);
		const plan = planChanges(await load(), { moves: [{ from: { page: P1, coord: "7,3" }, to: { page: P1, coord: "6,3" } }] }, [other]);
		assert.deepEqual(plan.profiles.map((p) => p.id), [PROFILE]);
		assert.equal(plan.summary.linksUpdated, 0);
	});

	it("validates page changes", async () => {
		const profile = await load();
		const pages = (order: string[], created: string[] = [], deleted: string[] = []) => ({ moves: [], pages: { order, created, deleted } });
		assert.throws(() => planChanges(profile, pages([])), /at least one page/);
		assert.throws(() => planChanges(profile, pages([P1, P1])), /appears twice/);
		assert.throws(() => planChanges(profile, pages([P1])), /doesn't match/);
		assert.throws(() => planChanges(profile, pages([P1, P2, "nope"], ["nope"])), /Invalid page id/);
		assert.throws(() => planChanges(profile, pages([P1, P2, F1], [F1])), /already in use/);
		assert.throws(() => planChanges(profile, pages([P1, P2], [], [F1])), /Only numbered pages/);
		assert.throws(() => planChanges(profile, pages([P1, P2])), /Nothing to apply/);
		assert.throws(
			() => planChanges(profile, { moves: [{ from: { page: P1, coord: "0,0" }, to: { page: P2, coord: "5,0" } }], pages: { order: [P1], created: [], deleted: [P2] } }),
			/being deleted/,
		);
	});
});

describe("image helpers", () => {
	it("finds image references anywhere in an action, including multi-action children", () => {
		const refs = collectImageRefs({ States: [{ Image: "Images/X.png" }], Actions: [{ Actions: [{ States: [{ Image: "Images/Y.png" }] }] }], Settings: { path: "C:/Images/not-a-ref.png" } });
		assert.deepEqual([...refs].sort(), ["X.png", "Y.png"]);
	});

	it("generates names in Stream Deck's format", () => {
		const names = new Set(Array.from({ length: 200 }, () => newImageName(".png")));
		assert.equal(names.size, 200);
		for (const n of names) assert.match(n, /^[0-9A-TVW]{25}[048CGKOS]Z\.png$/);
	});
});
