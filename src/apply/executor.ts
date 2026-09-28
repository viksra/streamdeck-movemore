import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha1 } from "../lib/json.ts";
import { type Log, errorMessage } from "../lib/log.ts";
import type { TxOp, TxPlan, TxResult } from "./transaction.ts";

/** Process control, injectable so tests can run transactions without touching Stream Deck. */
export interface ProcessControl {
	isRunning(processName: string): Promise<boolean>;
	/** Asks the app to close (WM_CLOSE). */
	close(processName: string): Promise<void>;
	/** Ends the app when it did not close on request. */
	kill(processName: string): Promise<void>;
	killPid(pid: number): Promise<void>;
	start(exePath: string, args: string[]): Promise<void>;
	sleep(ms: number): Promise<void>;
	now(): number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { windowsHide: true, encoding: "utf8", timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});
}

export const windowsProcessControl: ProcessControl = {
	async isRunning(processName) {
		const out = await run("tasklist", ["/FI", `IMAGENAME eq ${processName}`, "/FO", "CSV", "/NH"]);
		return out.toLowerCase().includes(`"${processName.toLowerCase()}"`);
	},
	async close(processName) {
		await run("taskkill", ["/IM", processName]).catch(() => undefined);
	},
	async kill(processName) {
		await run("taskkill", ["/F", "/IM", processName]).catch(() => undefined);
	},
	async killPid(pid) {
		await run("taskkill", ["/F", "/PID", String(pid)]).catch(() => undefined);
	},
	async start(exePath, args) {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(exePath, args, { cwd: path.dirname(exePath), detached: true, stdio: "ignore" });
			child.once("error", reject);
			child.once("spawn", () => {
				child.unref();
				resolve();
			});
		});
	},
	sleep,
	now: () => Date.now(),
};

/**
 * Runs a staged transaction: closes Stream Deck (if the plan asks for it), verifies every file is
 * still exactly as planned, applies the changes (rolling back on any failure), starts Stream Deck
 * again and records the outcome in result.json next to the plan.
 */
export async function executeTransaction(planPath: string, control: ProcessControl, log: Log): Promise<TxResult> {
	const txDir = path.dirname(planPath);
	let plan: TxPlan | null = null;
	let status: TxResult["status"] = "error";
	let message = "";

	try {
		plan = JSON.parse(await readFile(planPath, "utf8")) as TxPlan;
		log.info(`Transaction ${plan.txid}: ${plan.description} (${plan.ops.length} file operations)`);

		if (plan.restart) {
			const { processName, killPids, delayMs } = plan.restart;
			// How long to wait for a polite close before ending the process. Stream Deck only minimizes
			// to the tray when asked to close, so the plugin sets this to 0.
			const graceMs = plan.restart.closeTimeoutMs ?? 2500;
			await control.sleep(delayMs);
			log.info(`Closing ${processName}`);
			let forcedAt = graceMs <= 0 ? 0 : null;
			if (forcedAt === null) await control.close(processName);
			else await control.kill(processName);
			const askedAt = control.now();
			while (await control.isRunning(processName)) {
				const waited = control.now() - askedAt;
				if (waited > 20000) throw new Error(`${processName} did not close, so nothing was changed.`);
				if ((forcedAt === null && waited >= graceMs) || (forcedAt !== null && waited - forcedAt >= 1000)) {
					await control.kill(processName);
					forcedAt = waited;
				}
				await control.sleep(100);
			}
			for (const pid of killPids) await control.killPid(pid);
			await control.sleep(250);
		}

		const conflict = await preflight(plan.ops);
		if (conflict) {
			status = "conflict";
			message = `${conflict} Nothing was changed; reload the editor and try again.`;
			log.warn(message);
		} else {
			await applyOps(plan, txDir, log);
			status = "ok";
			message = plan.description;
			log.info("All changes applied.");
		}
	} catch (err) {
		status = "error";
		message = errorMessage(err);
		log.error(`Transaction failed: ${message}`);
	}

	if (plan?.restart) {
		try {
			if (!(await control.isRunning(plan.restart.processName))) {
				log.info(`Starting ${plan.restart.exePath}`);
				await control.start(plan.restart.exePath, plan.restart.args);
			}
		} catch (err) {
			message += ` Stream Deck could not be started again (${errorMessage(err)}); please start it manually.`;
			log.error(message);
		}
	}

	const result: TxResult = { txid: plan?.txid ?? path.basename(txDir), status, message, finishedAt: new Date().toISOString() };
	await writeFile(path.join(txDir, "result.json"), JSON.stringify(result, null, "\t"));
	return result;
}

/** Returns a description of the first file that is not in the expected state, or null. */
async function preflight(ops: TxOp[]): Promise<string | null> {
	for (const op of ops) {
		if (op.op === "write") {
			if (!existsSync(op.staged)) return `Staged file ${op.staged} is missing.`;
			if (op.expectedSha1 === null) {
				if (existsSync(op.dest)) return `${op.dest} already exists.`;
			} else if (!existsSync(op.dest) || sha1(await readFile(op.dest)) !== op.expectedSha1) {
				return "Stream Deck changed this profile after the editor loaded it.";
			}
		} else if (op.op === "delete") {
			if (existsSync(op.dest) && sha1(await readFile(op.dest)) !== op.expectedSha1) {
				return "Stream Deck changed this profile after the editor loaded it.";
			}
		} else if (op.op === "mkdir") {
			if (existsSync(op.dest)) return `${op.dest} already exists.`;
		} else if (op.op === "deleteDir") {
			const manifest = path.join(op.dest, "manifest.json");
			if (!existsSync(manifest) || sha1(await readFile(manifest)) !== op.expectedSha1) {
				return "Stream Deck changed this profile after the editor loaded it.";
			}
		} else if (!existsSync(op.staged)) {
			return `Backup folder ${op.staged} is missing.`;
		}
	}
	return null;
}

async function applyOps(plan: TxPlan, txDir: string, log: Log): Promise<void> {
	const undo: (() => Promise<void>)[] = [];
	const cleanup: (() => Promise<void>)[] = [];
	try {
		for (const [index, op] of plan.ops.entries()) {
			if (op.op === "mkdir") {
				await mkdir(op.dest, { recursive: true });
				undo.push(() => rm(op.dest, { recursive: true, force: true }));
				continue;
			}
			if (op.op === "deleteDir") {
				// Parked in the transaction folder until everything else succeeded.
				const parked = path.join(txDir, "removed", `${index}-${path.basename(op.dest)}`);
				await mkdir(path.dirname(parked), { recursive: true });
				await retry(() => rename(op.dest, parked));
				undo.push(() => rename(parked, op.dest));
				cleanup.push(() => rm(path.dirname(parked), { recursive: true, force: true }));
				continue;
			}
			if (op.op === "write") {
				const original = existsSync(op.dest) ? await readFile(op.dest) : null;
				await mkdir(path.dirname(op.dest), { recursive: true });
				const tmp = `${op.dest}.movemore-tmp`;
				await copyFile(op.staged, tmp);
				undo.push(async () => {
					await rm(tmp, { force: true });
					if (original) await writeFile(op.dest, original);
					else await rm(op.dest, { force: true });
				});
				await retry(() => rename(tmp, op.dest));
			} else if (op.op === "delete") {
				if (!existsSync(op.dest)) continue;
				const original = await readFile(op.dest);
				await retry(() => rm(op.dest));
				undo.push(() => writeFile(op.dest, original));
			} else {
				const parked = path.join(txDir, "replaced", path.basename(op.dest));
				const existed = existsSync(op.dest);
				if (existed) {
					await mkdir(path.dirname(parked), { recursive: true });
					await retry(() => rename(op.dest, parked));
				}
				undo.push(async () => {
					await rm(op.dest, { recursive: true, force: true });
					if (existed) await rename(parked, op.dest);
				});
				await cp(op.staged, op.dest, { recursive: true, errorOnExist: true, force: false });
				if (existed) cleanup.push(() => rm(path.dirname(parked), { recursive: true, force: true }));
			}
		}
	} catch (err) {
		log.error(`Rolling back after error: ${errorMessage(err)}`);
		for (const step of undo.reverse()) {
			try {
				await step();
			} catch (rollbackErr) {
				log.error(`Rollback step failed: ${errorMessage(rollbackErr)}`);
			}
		}
		throw err;
	}
	for (const step of cleanup) await step().catch((err) => log.warn(`Cleanup failed: ${errorMessage(err)}`));
}

/** Windows can briefly lock a file that a just-closed process had open. */
async function retry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (i >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
			await sleep(150 * i);
		}
	}
}
