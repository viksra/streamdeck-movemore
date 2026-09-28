import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROFILE = "5B6FFC0B-E432-4EFB-A7C8-DD1764C80869";
export const P1 = "C4006C36-C72E-4296-B4C3-C49F0FE6CCA4";
export const P2 = "89A29B75-33E4-4B13-9438-CCAEF07B3D59";
export const F1 = "990752E9-3407-4FA4-BE02-375DB4DA67C4";
export const F2 = "AFE3E16C-417F-4ACE-B3A7-EE196A826681";
export const DEFAULT_PAGE = "A17DC009-0BC0-4027-B0A9-B676060B7FD6";

// Tiny distinct "PNG" payloads; content only matters for hashing.
export const IMG_A1 = Buffer.from("png-A-on-page-1");
export const IMG_A2 = Buffer.from("png-A-on-page-2-different");
export const IMG_B = Buffer.from("png-B");
export const IMG_C = Buffer.from("png-C");
export const IMG_D = Buffer.from("png-D");
export const IMG_F = Buffer.from("png-folder");

export const OTHER_PROFILE = "CB2258F1-D1D2-4A75-9397-F52600BF37A9";
export const OTHER_PAGE = "2DDE296F-E52E-4569-B96A-5E55D75B8E21";

export function action(uuid: string, name: string, extra: { image?: string; title?: string; settings?: Record<string, unknown> } = {}) {
	return {
		ActionID: `${uuid}-${Math.random().toString(16).slice(2)}`,
		LinkedTitle: true,
		Name: name,
		Plugin: { Name: name, UUID: uuid, Version: "1.0" },
		Resources: null,
		Settings: extra.settings ?? {},
		State: 0,
		States: [{ ...(extra.image ? { Image: `Images/${extra.image}` } : {}), ...(extra.title ? { Title: extra.title } : {}) }],
		UUID: uuid,
	};
}

const OPEN = "com.elgato.streamdeck.system.open";
const WEBSITE = "com.elgato.streamdeck.system.website";
const FOLDER = "com.elgato.streamdeck.profile.openchild";
const BACK = "com.elgato.streamdeck.profile.backtoparent";

/** "Go to Page" key opening a 1-based page number. */
export function gotoKey(pageIndex: number, title = `To ${pageIndex}`) {
	return action("com.elgato.streamdeck.page.goto", "Go to Page", { title, settings: { PageIndex: pageIndex } });
}

/** "Switch Profile" key opening a profile at a 1-based page number. */
export function switchKey(profileId: string, pageIndex: number, title = "Switch") {
	return action("com.elgato.streamdeck.profile.rotate", "Switch Profile", { title, settings: { DeviceUUID: "", PageIndex: pageIndex, ProfileUUID: profileId.toLowerCase() } });
}

/** Adds (or replaces) a key in a page manifest on disk, keeping Stream Deck's sorted key order. */
export function addKey(fx: Fixture, page: string, coord: string, key: object): void {
	const file = path.join(fx.pageDir(page), "manifest.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	const keypad = manifest.Controllers[0];
	keypad.Actions = Object.fromEntries(Object.entries({ ...(keypad.Actions ?? {}), [coord]: key }).sort(([a], [b]) => (a < b ? -1 : 1)));
	writeFileSync(file, JSON.stringify(manifest));
}

/** A second one-page XL profile ("Jobs") holding the given keys. */
export function addOtherProfile(fx: Fixture, keys: Record<string, object>): void {
	const dir = path.join(fx.profilesRoot, `${OTHER_PROFILE}.sdProfile`);
	mkdirSync(path.join(dir, "Profiles", OTHER_PAGE, "Images"), { recursive: true });
	writeFileSync(
		path.join(dir, "manifest.json"),
		JSON.stringify({
			Device: { Model: "20GAT9901", UUID: "@(1)[4057/108/CL00A0A00001]" },
			Name: "Jobs",
			Pages: { Current: OTHER_PAGE.toLowerCase(), Pages: [OTHER_PAGE.toLowerCase()] },
			Version: "3.0",
		}),
	);
	writeFileSync(path.join(dir, "Profiles", OTHER_PAGE, "manifest.json"), JSON.stringify({ Controllers: [{ Actions: keys, Type: "Keypad" }], Icon: "", Name: "" }));
}

export interface Fixture {
	root: string;
	profilesRoot: string;
	dataDir: string;
	pageDir(page: string): string;
	cleanup(): void;
}

/**
 * Builds a Stream Deck XL profile shaped like the real ProfilesV3 layout:
 *   P1: 0,0 Open [A.png]  1,0 Website  2,0 Folder->F1 [F.png]  0,1 Open [B.png]  7,3 Website "Last"
 *   P2: 0,0 Open [C.png]  1,0 Open [A.png, different bytes than P1's A.png]
 *   F1: 0,0 Parent Folder  1,0 Open [D.png]  2,0 Folder->F2
 *   F2: 0,0 Parent Folder  1,0 Website "Deep"
 */
export function createFixture(): Fixture {
	const root = mkdtempSync(path.join(os.tmpdir(), "movemore-test-"));
	const profilesRoot = path.join(root, "ProfilesV3");
	const profileDir = path.join(profilesRoot, `${PROFILE}.sdProfile`);
	const pageDir = (page: string) => path.join(profileDir, "Profiles", page);

	const writePage = (page: string, actions: Record<string, unknown> | null, images: Record<string, Buffer> = {}) => {
		mkdirSync(path.join(pageDir(page), "Images"), { recursive: true });
		writeFileSync(path.join(pageDir(page), "manifest.json"), JSON.stringify({ Controllers: [{ Actions: actions, Type: "Keypad" }], Icon: "", Name: "" }));
		for (const [name, bytes] of Object.entries(images)) writeFileSync(path.join(pageDir(page), "Images", name), bytes);
	};

	mkdirSync(path.join(profileDir, "Images"), { recursive: true });
	writeFileSync(
		path.join(profileDir, "manifest.json"),
		JSON.stringify({
			Device: { Model: "20GAT9901", UUID: "@(1)[4057/108/CL00A0A00001]" },
			Name: "Default Profile",
			Pages: { Current: P1.toLowerCase(), Default: DEFAULT_PAGE.toLowerCase(), Pages: [P1.toLowerCase(), P2.toLowerCase()] },
			Version: "3.0",
		}),
	);
	writePage(
		P1,
		{
			"0,0": action(OPEN, "Open", { image: "A.png", title: "Lamp" }),
			"0,1": action(OPEN, "Open", { image: "B.png", title: "Fan" }),
			"1,0": action(WEBSITE, "Website", { title: "Mail" }),
			"2,0": action(FOLDER, "Create Folder", { image: "F.png", title: "Tools", settings: { ProfileUUID: F1.toLowerCase() } }),
			"7,3": action(WEBSITE, "Website", { title: "Last" }),
		},
		{ "A.png": IMG_A1, "B.png": IMG_B, "F.png": IMG_F },
	);
	writePage(P2, { "0,0": action(OPEN, "Open", { image: "C.png", title: "Cam" }), "1,0": action(OPEN, "Open", { image: "A.png", title: "Other A" }) }, { "C.png": IMG_C, "A.png": IMG_A2 });
	writePage(F1, {
		"0,0": action(BACK, "Parent Folder"),
		"1,0": action(OPEN, "Open", { image: "D.png", title: "Docs" }),
		"2,0": action(FOLDER, "Create Folder", { title: "Nested", settings: { ProfileUUID: F2.toLowerCase() } }),
	}, { "D.png": IMG_D });
	writePage(F2, { "0,0": action(BACK, "Parent Folder"), "1,0": action(WEBSITE, "Website", { title: "Deep" }) });
	writePage(DEFAULT_PAGE, null);

	return {
		root,
		profilesRoot,
		dataDir: path.join(root, "data"),
		pageDir,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
