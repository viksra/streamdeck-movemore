import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { silentLog } from "../src/lib/log.ts";
import { type ProfileChange, watchProfileContent, watchProfiles } from "../src/server/profile-watcher.ts";
import { type Fixture, OTHER_PROFILE, P1, PROFILE, addOtherProfile, createFixture } from "./helpers/fixture.ts";

const A = "5B6FFC0B-E432-4EFB-A7C8-DD1764C80869";
const B = "CB2258F1-D1D2-4A75-9397-F52600BF37A9";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) assert.fail(`Timed out waiting for ${what}`);
		await sleep(20);
	}
}

describe("profile watcher", () => {
	let root: string;
	before(() => {
		root = mkdtempSync(path.join(os.tmpdir(), "movemore-watch-"));
		for (const id of [A, B]) mkdirSync(path.join(root, `${id}.sdProfile`, "Profiles", "P"), { recursive: true });
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	it("reports a save once, with every profile it touched", async () => {
		const changes: ProfileChange[] = [];
		const watcher = watchProfiles(root, silentLog, (c) => changes.push(c), { settleMs: 150 });
		try {
			await sleep(50);
			writeFileSync(path.join(root, `${B}.sdProfile`, "manifest.json"), "{}");
			writeFileSync(path.join(root, `${A}.sdProfile`, "Profiles", "P", "manifest.json"), "{}");
			writeFileSync(path.join(root, `${A}.sdProfile`, "manifest.json"), "{}");
			await waitFor(() => changes.length > 0, "a change");
			await sleep(300);
			assert.deepEqual(changes, [{ profiles: [A, B] }]);
		} finally {
			watcher.close();
		}
	});

	it("ignores files that aren't part of a profile", async () => {
		const changes: ProfileChange[] = [];
		const watcher = watchProfiles(root, silentLog, (c) => changes.push(c), { settleMs: 50 });
		try {
			await sleep(50);
			writeFileSync(path.join(root, "notes.txt"), "not a profile");
			await sleep(300);
			assert.deepEqual(changes, []);
		} finally {
			watcher.close();
		}
	});

	it("waits for the folder to exist, then asks for a full check", async () => {
		const later = path.join(root, "later");
		const changes: ProfileChange[] = [];
		const watcher = watchProfiles(later, silentLog, (c) => changes.push(c), { settleMs: 50, retryMs: 100 });
		try {
			await sleep(150);
			mkdirSync(path.join(later, `${A}.sdProfile`), { recursive: true });
			await waitFor(() => changes.some((c) => c.profiles === null), "the full check");
			writeFileSync(path.join(later, `${A}.sdProfile`, "manifest.json"), "{}");
			await waitFor(() => changes.some((c) => c.profiles?.includes(A)), "the save");
		} finally {
			watcher.close();
		}
	});

	it("stops reporting once closed", async () => {
		const changes: ProfileChange[] = [];
		const watcher = watchProfiles(root, silentLog, (c) => changes.push(c), { settleMs: 50 });
		await sleep(50);
		watcher.close();
		writeFileSync(path.join(root, `${A}.sdProfile`, "manifest.json"), "{}");
		await sleep(300);
		assert.deepEqual(changes, []);
	});
});

describe("profile content watcher", () => {
	let fx: Fixture;
	before(() => {
		fx = createFixture();
		addOtherProfile(fx, {});
	});
	after(() => fx.cleanup());

	it("reports real changes only, including added and deleted profiles", async () => {
		const reports: string[][] = [];
		const watcher = await watchProfileContent(fx.profilesRoot, silentLog, (ids) => reports.push(ids), { settleMs: 50 });
		try {
			// Rewritten with the same bytes, and folders listed: nothing changed.
			const pageFile = path.join(fx.pageDir(P1), "manifest.json");
			const page = readFileSync(pageFile);
			writeFileSync(pageFile, page);
			readdirSync(path.join(fx.profilesRoot, `${PROFILE}.sdProfile`, "Profiles"));
			await sleep(300);
			assert.equal(reports.length, 0, JSON.stringify(reports));

			writeFileSync(pageFile, JSON.stringify({ ...JSON.parse(page.toString("utf8")), Name: "changed" }));
			await waitFor(() => reports.length > 0, "the change");
			assert.deepEqual(reports.splice(0), [[PROFILE]]);

			const copy = "00000000-0000-4000-8000-000000000001";
			cpSync(path.join(fx.profilesRoot, `${OTHER_PROFILE}.sdProfile`), path.join(fx.profilesRoot, `${copy}.sdProfile`), { recursive: true });
			await waitFor(() => reports.flat().includes(copy.toUpperCase()), "the new profile");
			reports.length = 0;
			rmSync(path.join(fx.profilesRoot, `${OTHER_PROFILE}.sdProfile`), { recursive: true });
			await waitFor(() => reports.flat().includes(OTHER_PROFILE), "the deleted profile");
		} finally {
			watcher.close();
		}
	});
});
