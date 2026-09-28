import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha1 } from "../lib/json.ts";
import type { MovePlan } from "../profiles/planner.ts";
import { isUuid } from "../profiles/reader.ts";

/**
 * A transaction is a folder under <dataDir>/transactions/<txid>/ holding plan.json, the staged
 * files it references, and result.json once it ran. It is executed by apply-helper.js, which runs
 * outside Stream Deck because Stream Deck has to be closed while its profile files change.
 */
export type TxOp =
	/** Create a folder that must not exist yet (a new page). */
	| { op: "mkdir"; dest: string }
	/** Replace (or create, when expectedSha1 is null) a file with a staged copy. */
	| { op: "write"; staged: string; dest: string; expectedSha1: string | null }
	| { op: "delete"; dest: string; expectedSha1: string }
	/** Remove a page folder whose manifest.json still has the given hash. */
	| { op: "deleteDir"; dest: string; expectedSha1: string }
	/** Swap a whole profile folder for a staged one (backup restore). */
	| { op: "replaceDir"; staged: string; dest: string };

export interface RestartSpec {
	/** Image name used to find and close the app, e.g. "StreamDeck.exe". */
	processName: string;
	exePath: string;
	args: string[];
	/** Processes to end once the app has closed (the old plugin instance, so its port frees up). */
	killPids: number[];
	/** Pause before closing the app, so the editor receives its HTTP response first. */
	delayMs: number;
	/** How long a polite close request may take before the process is ended (default 2500 ms). */
	closeTimeoutMs?: number;
}

export interface TxPlan {
	version: 1;
	txid: string;
	kind: "move" | "restore";
	description: string;
	createdAt: string;
	profileId: string;
	profileName: string;
	/** Backup of the edited profile (restores undo the change). */
	backupId: string | null;
	/** Backups of every profile the change writes to, including backupId. */
	backupIds?: string[];
	restart: RestartSpec | null;
	ops: TxOp[];
}

export interface TxResult {
	txid: string;
	status: "ok" | "conflict" | "error";
	message: string;
	finishedAt: string;
}

export interface BackupMeta {
	id: string;
	profileId: string;
	profileName: string;
	deviceName: string;
	createdAt: string;
	reason: string;
	sizeBytes: number;
}

export class TransactionError extends Error {}

const BACKUPS = "backups";
const TRANSACTIONS = "transactions";
const KEEP_BACKUPS = 40;
const KEEP_TRANSACTION_DAYS = 14;

function stamp(date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function newId(): string {
	return `${stamp()}-${randomBytes(3).toString("hex")}`;
}

export function transactionDir(dataDir: string, txid: string): string {
	if (!/^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(txid)) throw new TransactionError("Invalid transaction id.");
	return path.join(dataDir, TRANSACTIONS, txid);
}

export async function readResult(dataDir: string, txid: string): Promise<TxResult | null> {
	const file = path.join(transactionDir(dataDir, txid), "result.json");
	if (!existsSync(file)) return null;
	return JSON.parse(await readFile(file, "utf8")) as TxResult;
}

export async function transactionExists(dataDir: string, txid: string): Promise<boolean> {
	return existsSync(path.join(transactionDir(dataDir, txid), "plan.json"));
}

/** Copies a whole profile folder into <dataDir>/backups/<id>/ and returns the backup id. */
export async function createBackup(
	dataDir: string,
	profile: { id: string; name: string; dir: string; deviceName: string },
	reason: string,
): Promise<BackupMeta> {
	const id = `${newId()}_${profile.id}`;
	const dir = path.join(dataDir, BACKUPS, id);
	await mkdir(dir, { recursive: true });
	await cp(profile.dir, path.join(dir, `${profile.id}.sdProfile`), { recursive: true, errorOnExist: true, force: false });
	const meta: BackupMeta = {
		id,
		profileId: profile.id,
		profileName: profile.name,
		deviceName: profile.deviceName,
		createdAt: new Date().toISOString(),
		reason,
		sizeBytes: await folderSize(dir),
	};
	await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, "\t"));
	return meta;
}

export async function listBackups(dataDir: string): Promise<BackupMeta[]> {
	const root = path.join(dataDir, BACKUPS);
	if (!existsSync(root)) return [];
	const out: BackupMeta[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const metaFile = path.join(root, entry.name, "meta.json");
		if (!entry.isDirectory() || !existsSync(metaFile)) continue;
		try {
			out.push(JSON.parse(await readFile(metaFile, "utf8")) as BackupMeta);
		} catch {
			// Ignore half-written backups.
		}
	}
	return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** "Moved 3 keys, added 1 page and reordered pages in "Default Profile"" */
export function describePlan(plan: MovePlan): string {
	const s = plan.summary;
	const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
	const parts: string[] = [];
	if (s.moved) parts.push(`moved ${count(s.moved, "key")}`);
	if (s.pagesAdded) parts.push(`added ${count(s.pagesAdded, "page")}`);
	if (s.pagesDeleted) parts.push(`deleted ${count(s.pagesDeleted, "page")}`);
	if (s.pagesReordered) parts.push("reordered pages");
	if (parts.length === 0) parts.push("updated page links");
	const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
	return `${text.charAt(0).toUpperCase()}${text.slice(1)} in "${plan.profileName}"`;
}

/** Stages a change plan: backs up every profile it touches, copies every new file into the transaction folder. */
export async function stageMoves(
	dataDir: string,
	plan: MovePlan,
	options: { restart: RestartSpec | null; deviceName?: string },
): Promise<TxPlan> {
	const txid = newId();
	const txDir = transactionDir(dataDir, txid);
	const filesDir = path.join(txDir, "files");
	await mkdir(filesDir, { recursive: true });

	const description = describePlan(plan);
	const reason = `Before: ${description.charAt(0).toLowerCase()}${description.slice(1)}`;
	const backups: BackupMeta[] = [];
	for (const profile of plan.profiles) {
		const why = profile.id === plan.profileId ? reason : `Before updating its links to "${plan.profileName}" (${description.charAt(0).toLowerCase()}${description.slice(1)})`;
		backups.push(await createBackup(dataDir, profile, why));
	}

	const ops: TxOp[] = [];
	let n = 0;
	for (const op of plan.ops) {
		if (op.kind === "mkdir") {
			ops.push({ op: "mkdir", dest: op.dest });
			continue;
		}
		if (op.kind === "deleteDir") {
			ops.push({ op: "deleteDir", dest: op.dest, expectedSha1: op.expectedSha1 });
			continue;
		}
		if (op.kind === "delete") {
			ops.push({ op: "delete", dest: op.dest, expectedSha1: op.expectedSha1 });
			continue;
		}
		const staged = path.join(filesDir, `${String(++n).padStart(4, "0")}${op.kind === "manifest" ? ".json" : path.extname(op.dest)}`);
		if (op.kind === "manifest") {
			await writeFile(staged, op.content, "utf8");
			ops.push({ op: "write", staged, dest: op.dest, expectedSha1: op.expectedSha1 });
		} else {
			await copyFile(op.source, staged);
			if (sha1(await readFile(staged)) !== op.sourceSha1) {
				throw new TransactionError("A key image changed while the move was being prepared. Reload and try again.");
			}
			ops.push({ op: "write", staged, dest: op.dest, expectedSha1: null });
		}
	}

	const txPlan: TxPlan = {
		version: 1,
		txid,
		kind: "move",
		description,
		createdAt: new Date().toISOString(),
		profileId: plan.profileId,
		profileName: plan.profileName,
		backupId: backups.find((b) => b.profileId === plan.profileId)?.id ?? null,
		backupIds: backups.map((b) => b.id),
		restart: options.restart,
		ops,
	};
	await writeFile(path.join(txDir, "plan.json"), JSON.stringify(txPlan, null, "\t"));
	return txPlan;
}

/** Stages putting a backed-up profile folder back in place (after backing up the current state). */
export async function stageRestore(
	dataDir: string,
	profilesRoot: string,
	backupId: string,
	options: { restart: RestartSpec | null },
): Promise<TxPlan> {
	const backups = await listBackups(dataDir);
	const backup = backups.find((b) => b.id === backupId);
	if (!backup || !isUuid(backup.profileId)) throw new TransactionError("That backup no longer exists.");
	const staged = path.join(dataDir, BACKUPS, backup.id, `${backup.profileId}.sdProfile`);
	if (!existsSync(path.join(staged, "manifest.json"))) throw new TransactionError("That backup is incomplete.");

	const dest = path.join(profilesRoot, `${backup.profileId}.sdProfile`);
	const when = new Date(backup.createdAt).toLocaleString();
	let safety: BackupMeta | null = null;
	if (existsSync(dest)) {
		safety = await createBackup(
			dataDir,
			{ id: backup.profileId, name: backup.profileName, dir: dest, deviceName: backup.deviceName },
			`Before restoring the backup from ${when}`,
		);
	}

	const txid = newId();
	const txDir = transactionDir(dataDir, txid);
	await mkdir(txDir, { recursive: true });
	const txPlan: TxPlan = {
		version: 1,
		txid,
		kind: "restore",
		description: `Restored "${backup.profileName}" from the backup of ${when}`,
		createdAt: new Date().toISOString(),
		profileId: backup.profileId,
		profileName: backup.profileName,
		backupId: safety?.id ?? null,
		restart: options.restart,
		ops: [{ op: "replaceDir", staged, dest }],
	};
	await writeFile(path.join(txDir, "plan.json"), JSON.stringify(txPlan, null, "\t"));
	return txPlan;
}

/** Keeps the newest backups and forgets old transaction folders. Never touches anything else. */
export async function pruneData(dataDir: string): Promise<void> {
	const backups = await listBackups(dataDir);
	for (const old of backups.slice(KEEP_BACKUPS)) {
		await rm(path.join(dataDir, BACKUPS, old.id), { recursive: true, force: true });
	}
	const txRoot = path.join(dataDir, TRANSACTIONS);
	if (!existsSync(txRoot)) return;
	const cutoff = Date.now() - KEEP_TRANSACTION_DAYS * 24 * 3600 * 1000;
	for (const entry of await readdir(txRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(entry.name)) continue;
		const dir = path.join(txRoot, entry.name);
		if ((await stat(dir)).mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
	}
}

async function folderSize(dir: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) total += (await stat(path.join(entry.parentPath, entry.name))).size;
	}
	return total;
}
