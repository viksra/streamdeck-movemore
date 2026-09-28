import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type ProcessControl, executeTransaction } from "../src/apply/executor.ts";
import { type RestartSpec, type TxPlan, listBackups, readResult, stageMoves, stageRestore, transactionDir } from "../src/apply/transaction.ts";
import { silentLog } from "../src/lib/log.ts";
import { planChanges, planMoves } from "../src/profiles/planner.ts";
import { keypadActions, loadProfile } from "../src/profiles/reader.ts";
import { type Fixture, IMG_B, OTHER_PAGE, OTHER_PROFILE, P1, P2, PROFILE, addOtherProfile, createFixture, switchKey } from "./helpers/fixture.ts";

/** Fake process control: the "app" keeps running for `runningFor` isRunning() checks. */
function fakeControl(runningFor = 2): ProcessControl & { calls: string[] } {
	let clock = 0;
	let checks = 0;
	const calls: string[] = [];
	return {
		calls,
		async isRunning() {
			checks++;
			return checks <= runningFor;
		},
		async close(name) {
			calls.push(`close ${name}`);
		},
		async kill(name) {
			calls.push(`kill ${name}`);
		},
		async killPid(pid) {
			calls.push(`killPid ${pid}`);
		},
		async start(exe) {
			calls.push(`start ${exe}`);
		},
		async sleep(ms) {
			clock += ms;
		},
		now: () => clock,
	};
}

const noControl: ProcessControl = {
	isRunning: async () => assert.fail("should not be called"),
	close: async () => assert.fail("should not be called"),
	kill: async () => assert.fail("should not be called"),
	killPid: async () => assert.fail("should not be called"),
	start: async () => assert.fail("should not be called"),
	sleep: async () => {},
	now: () => 0,
};

const restart: RestartSpec = { processName: "StreamDeck.exe", exePath: "C:\\SD\\StreamDeck.exe", args: [], killPids: [4242], delayMs: 1500 };

describe("transactions", () => {
	let fx: Fixture;
	beforeEach(() => (fx = createFixture()));
	afterEach(() => fx.cleanup());

	async function stageCrossPageMove(restartSpec: RestartSpec | null = null): Promise<{ tx: TxPlan; planPath: string }> {
		const profile = await loadProfile(fx.profilesRoot, PROFILE);
		const plan = planMoves(profile, [
			{ from: { page: P1, coord: "0,1" }, to: { page: P2, coord: "5,0" } },
			{ from: { page: P1, coord: "0,0" }, to: { page: P1, coord: "3,3" } },
		]);
		const tx = await stageMoves(fx.dataDir, plan, { deviceName: profile.device.name, restart: restartSpec });
		return { tx, planPath: path.join(transactionDir(fx.dataDir, tx.txid), "plan.json") };
	}

	it("backs up the profile, applies every change and records the result", async () => {
		const before = readFileSync(path.join(fx.pageDir(P1), "manifest.json"), "utf8");
		const { tx, planPath } = await stageCrossPageMove();

		const backups = await listBackups(fx.dataDir);
		assert.equal(backups.length, 1);
		assert.equal(backups[0].id, tx.backupId);
		assert.match(backups[0].reason, /^Before: moved 2 keys/);
		const backupManifest = path.join(fx.dataDir, "backups", tx.backupId!, `${PROFILE}.sdProfile`, "Profiles", P1, "manifest.json");
		assert.equal(readFileSync(backupManifest, "utf8"), before);

		const result = await executeTransaction(planPath, noControl, silentLog);
		assert.equal(result.status, "ok", result.message);
		assert.deepEqual(await readResult(fx.dataDir, tx.txid), result);

		const profile = await loadProfile(fx.profilesRoot, PROFILE);
		assert.deepEqual(Object.keys(keypadActions(profile.pages.get(P1)!.manifest)), ["1,0", "2,0", "3,3", "7,3"]);
		assert.deepEqual(Object.keys(keypadActions(profile.pages.get(P2)!.manifest)), ["0,0", "1,0", "5,0"]);
		assert.deepEqual(readFileSync(path.join(fx.pageDir(P2), "Images", "B.png")), IMG_B);
		assert.equal(existsSync(path.join(fx.pageDir(P1), "Images", "B.png")), false);
		assert.equal(existsSync(path.join(fx.pageDir(P1), "manifest.json.movemore-tmp")), false);
	});

	it("changes nothing when Stream Deck saved the profile in the meantime", async () => {
		const { planPath } = await stageCrossPageMove();
		const file = path.join(fx.pageDir(P2), "manifest.json");
		const edited = readFileSync(file, "utf8").replace('"Icon":""', '"Icon":"x"');
		writeFileSync(file, edited);
		const p1Before = readFileSync(path.join(fx.pageDir(P1), "manifest.json"), "utf8");

		const result = await executeTransaction(planPath, noControl, silentLog);
		assert.equal(result.status, "conflict");
		assert.equal(readFileSync(file, "utf8"), edited);
		assert.equal(readFileSync(path.join(fx.pageDir(P1), "manifest.json"), "utf8"), p1Before);
		assert.equal(existsSync(path.join(fx.pageDir(P2), "Images", "B.png")), false);
	});

	it("rolls back files already written when a later step fails", async () => {
		const { planPath } = await stageCrossPageMove();
		const plan = JSON.parse(readFileSync(planPath, "utf8")) as TxPlan;
		// A destination whose parent folder is actually a file: preflight passes, mkdir fails later.
		const blocker = path.join(fx.root, "blocker");
		writeFileSync(blocker, "not a folder");
		plan.ops.push({ op: "write", staged: plan.ops[0].op === "write" ? plan.ops[0].staged : "", dest: path.join(blocker, "x.png"), expectedSha1: null });
		writeFileSync(planPath, JSON.stringify(plan));
		const snapshot = (page: string) => readFileSync(path.join(fx.pageDir(page), "manifest.json"), "utf8");
		const p1 = snapshot(P1);
		const p2 = snapshot(P2);

		const result = await executeTransaction(planPath, noControl, silentLog);
		assert.equal(result.status, "error");
		assert.equal(snapshot(P1), p1);
		assert.equal(snapshot(P2), p2);
		assert.equal(existsSync(path.join(fx.pageDir(P2), "Images", "B.png")), false, "copied image removed again");
		assert.equal(existsSync(path.join(fx.pageDir(P1), "Images", "B.png")), true, "deleted image restored");
	});

	it("closes Stream Deck first, ends the old plugin, then starts Stream Deck again", async () => {
		const { planPath } = await stageCrossPageMove(restart);
		const control = fakeControl(3);
		const result = await executeTransaction(planPath, control, silentLog);
		assert.equal(result.status, "ok", result.message);
		assert.deepEqual(control.calls, ["close StreamDeck.exe", "killPid 4242", "start C:\\SD\\StreamDeck.exe"]);
	});

	it("ends Stream Deck right away when no polite close is wanted", async () => {
		const { planPath } = await stageCrossPageMove({ ...restart, closeTimeoutMs: 0 });
		const control = fakeControl(3);
		const result = await executeTransaction(planPath, control, silentLog);
		assert.equal(result.status, "ok", result.message);
		assert.equal(control.calls[0], "kill StreamDeck.exe");
		assert.ok(!control.calls.some((c) => c.startsWith("close")));
		assert.equal(control.calls.at(-1), "start C:\\SD\\StreamDeck.exe");
	});

	it("force-closes Stream Deck when it only minimizes to the tray", async () => {
		const { planPath } = await stageCrossPageMove(restart);
		// Polled every 100 ms: still running after the 2.5 s grace period.
		const control = fakeControl(40);
		const result = await executeTransaction(planPath, control, silentLog);
		assert.equal(result.status, "ok", result.message);
		assert.equal(control.calls[0], "close StreamDeck.exe");
		assert.ok(control.calls.includes("kill StreamDeck.exe"));
		assert.equal(control.calls.at(-1), "start C:\\SD\\StreamDeck.exe");
	});

	it("gives up without changing anything when Stream Deck will not close", async () => {
		const { planPath } = await stageCrossPageMove(restart);
		const p1 = readFileSync(path.join(fx.pageDir(P1), "manifest.json"), "utf8");
		const control = fakeControl(Number.POSITIVE_INFINITY);
		const result = await executeTransaction(planPath, control, silentLog);
		assert.equal(result.status, "error");
		assert.match(result.message, /did not close/);
		assert.equal(readFileSync(path.join(fx.pageDir(P1), "manifest.json"), "utf8"), p1);
		assert.ok(!control.calls.some((c) => c.startsWith("start")), "Stream Deck is still running, so it is not started twice");
	});

	it("restores a backup and keeps a safety backup of the replaced state", async () => {
		const original = readFileSync(path.join(fx.pageDir(P1), "manifest.json"), "utf8");
		const { tx, planPath } = await stageCrossPageMove();
		await executeTransaction(planPath, noControl, silentLog);
		assert.notEqual(readFileSync(path.join(fx.pageDir(P1), "manifest.json"), "utf8"), original);

		const restore = await stageRestore(fx.dataDir, fx.profilesRoot, tx.backupId!, { restart: null });
		const result = await executeTransaction(path.join(transactionDir(fx.dataDir, restore.txid), "plan.json"), noControl, silentLog);
		assert.equal(result.status, "ok", result.message);
		assert.equal(readFileSync(path.join(fx.pageDir(P1), "manifest.json"), "utf8"), original);
		assert.deepEqual(readFileSync(path.join(fx.pageDir(P1), "Images", "B.png")), IMG_B);
		assert.equal(existsSync(path.join(fx.pageDir(P2), "Images", "B.png")), false);

		const backups = await listBackups(fx.dataDir);
		assert.equal(backups.length, 2);
		assert.match(backups.find((b) => b.id !== tx.backupId)!.reason, /^Before restoring the backup/);
	});

	it("adds and deletes pages on disk and updates the page list", async () => {
		const NEW = "11111111-2222-4333-8444-555555555555";
		const profile = await loadProfile(fx.profilesRoot, PROFILE);
		const plan = planChanges(profile, {
			moves: [
				{ from: { page: P2, coord: "0,0" }, to: { page: NEW, coord: "0,0" } },
				{ from: { page: P2, coord: "1,0" }, to: { page: P1, coord: "4,0" } },
			],
			pages: { order: [NEW, P1], created: [NEW], deleted: [P2] },
		});
		const tx = await stageMoves(fx.dataDir, plan, { restart: null });
		const result = await executeTransaction(path.join(transactionDir(fx.dataDir, tx.txid), "plan.json"), noControl, silentLog);
		assert.equal(result.status, "ok", result.message);
		assert.equal(result.message, 'Moved 2 keys, added 1 page and deleted 1 page in "Default Profile"');

		assert.equal(existsSync(fx.pageDir(P2)), false);
		assert.equal(existsSync(path.join(fx.pageDir(NEW), "Images", "C.png")), true);
		const reloaded = await loadProfile(fx.profilesRoot, PROFILE);
		assert.deepEqual(reloaded.topLevel, [NEW, P1]);
		assert.equal(keypadActions(reloaded.pages.get(NEW)!.manifest)["0,0"].States?.[0].Title, "Cam");
		assert.equal(existsSync(path.join(transactionDir(fx.dataDir, tx.txid), "removed")), false, "parked folder cleaned up");
	});

	it("puts deleted pages back and removes new ones when a later step fails", async () => {
		const NEW = "11111111-2222-4333-8444-555555555555";
		const profile = await loadProfile(fx.profilesRoot, PROFILE);
		const plan = planChanges(profile, {
			moves: [
				{ from: { page: P2, coord: "0,0" }, to: { page: NEW, coord: "0,0" } },
				{ from: { page: P2, coord: "1,0" }, to: { page: P1, coord: "4,0" } },
			],
			pages: { order: [NEW, P1], created: [NEW], deleted: [P2] },
		});
		const tx = await stageMoves(fx.dataDir, plan, { restart: null });
		const planPath = path.join(transactionDir(fx.dataDir, tx.txid), "plan.json");
		const staged = JSON.parse(readFileSync(planPath, "utf8")) as TxPlan;
		const blocker = path.join(fx.root, "blocker");
		writeFileSync(blocker, "not a folder");
		const someStagedFile = staged.ops.find((o) => o.op === "write");
		staged.ops.push({ op: "write", staged: someStagedFile && someStagedFile.op === "write" ? someStagedFile.staged : "", dest: path.join(blocker, "x"), expectedSha1: null });
		writeFileSync(planPath, JSON.stringify(staged));
		const profileManifest = path.join(fx.profilesRoot, `${PROFILE}.sdProfile`, "manifest.json");
		const before = { profile: readFileSync(profileManifest, "utf8"), p2: readFileSync(path.join(fx.pageDir(P2), "manifest.json"), "utf8") };

		const result = await executeTransaction(planPath, noControl, silentLog);
		assert.equal(result.status, "error");
		assert.equal(readFileSync(profileManifest, "utf8"), before.profile);
		assert.equal(readFileSync(path.join(fx.pageDir(P2), "manifest.json"), "utf8"), before.p2);
		assert.equal(existsSync(fx.pageDir(NEW)), false);
	});

	it("backs up every profile a change writes to", async () => {
		addOtherProfile(fx, { "0,0": switchKey(PROFILE, 2) });
		const profile = await loadProfile(fx.profilesRoot, PROFILE);
		const other = await loadProfile(fx.profilesRoot, OTHER_PROFILE);
		const plan = planChanges(profile, { moves: [], pages: { order: [P2, P1], created: [], deleted: [] } }, [other]);
		const tx = await stageMoves(fx.dataDir, plan, { restart: null });
		assert.equal(tx.backupIds?.length, 2);
		const backups = await listBackups(fx.dataDir);
		assert.deepEqual(backups.map((b) => b.profileName).sort(), ["Default Profile", "Jobs"]);
		assert.equal(backups.find((b) => b.profileId === PROFILE)!.id, tx.backupId);
		const result = await executeTransaction(path.join(transactionDir(fx.dataDir, tx.txid), "plan.json"), noControl, silentLog);
		assert.equal(result.status, "ok", result.message);
		const jobs = await loadProfile(fx.profilesRoot, OTHER_PROFILE);
		assert.equal(keypadActions(jobs.pages.get(OTHER_PAGE)!.manifest)["0,0"].Settings?.PageIndex, 1);
	});

	it("rejects malformed transaction ids", () => {
		assert.throws(() => transactionDir(fx.dataDir, "../../etc"), /Invalid transaction id/);
	});
});
