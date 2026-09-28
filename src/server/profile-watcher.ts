import { type FSWatcher, existsSync, watch } from "node:fs";

import { type Log, errorMessage } from "../lib/log.ts";
import { ProfileNotFoundError, listProfileIds, loadProfile } from "../profiles/reader.ts";

const PROFILE_DIR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sdProfile$/i;

export interface ProfileChange {
	/** Upper-case ids of the profiles whose files changed; null when that isn't known (check them all). */
	profiles: string[] | null;
}

export interface WatchOptions {
	/** Quiet time that ends one save: Stream Deck writes several files each time. */
	settleMs?: number;
	/** Longest a report waits while writes keep coming. */
	maxWaitMs?: number;
	/** How soon to try again when the folder can't be watched (yet). */
	retryMs?: number;
}

export interface ProfileWatcher {
	close(): void;
}

/**
 * Watches Stream Deck's profiles folder and reports which profiles were saved, once each burst of
 * writes has settled. Only reads change notifications: files and folders stay free to be renamed
 * or deleted while it runs.
 */
export function watchProfiles(root: string, log: Log, onChange: (change: ProfileChange) => void, options: WatchOptions = {}): ProfileWatcher {
	const settleMs = options.settleMs ?? 250;
	const maxWaitMs = options.maxWaitMs ?? 1500;
	const retryMs = options.retryMs ?? 5000;
	let watcher: FSWatcher | null = null;
	let retryTimer: NodeJS.Timeout | undefined;
	let flushTimer: NodeJS.Timeout | undefined;
	let firstAt = 0;
	let changed = new Set<string>();
	let unknown = false;
	let failed = false;
	let closed = false;

	function flush(): void {
		flushTimer = undefined;
		const change: ProfileChange = { profiles: unknown ? null : [...changed].sort() };
		changed = new Set();
		unknown = false;
		onChange(change);
	}

	function note(filename: string | null): void {
		const top = filename ? filename.split(/[\\/]/)[0] : "";
		const match = PROFILE_DIR.exec(top);
		if (match) changed.add(match[1].toUpperCase());
		else if (top) return; // Not a profile; Stream Deck keeps other files there too.
		else unknown = true;
		const now = Date.now();
		if (flushTimer === undefined) firstAt = now;
		else clearTimeout(flushTimer);
		flushTimer = setTimeout(flush, Math.max(0, Math.min(settleMs, firstAt + maxWaitMs - now)));
	}

	function retry(reason: string): void {
		if (!failed) log.warn(`Can't watch ${root} for changes (${reason}); trying again every ${Math.round(retryMs / 1000)} s.`);
		failed = true;
		retryTimer = setTimeout(start, retryMs);
	}

	function start(): void {
		retryTimer = undefined;
		if (closed) return;
		if (!existsSync(root)) return retry("the folder doesn't exist");
		try {
			watcher = watch(root, { recursive: true }, (_event, filename) => note(filename));
		} catch (err) {
			return retry(errorMessage(err));
		}
		watcher.on("error", (err) => {
			watcher?.close();
			watcher = null;
			if (!closed) retry(errorMessage(err));
		});
		if (failed) {
			log.info(`Watching ${root} for changes again.`);
			failed = false;
			note(null); // Saves may have been missed in the meantime.
		}
	}

	start();
	return {
		close() {
			closed = true;
			clearTimeout(retryTimer);
			clearTimeout(flushTimer);
			watcher?.close();
			watcher = null;
		},
	};
}

/**
 * Reports the profiles whose content really changed (upper-case ids), including ones added or
 * deleted. Windows also reports mere reads when it updates last-access times, the editor server's
 * own reads included, so every report is checked against a fingerprint of the profile first.
 */
export async function watchProfileContent(root: string, log: Log, onChange: (profiles: string[]) => void, options: WatchOptions = {}): Promise<ProfileWatcher> {
	const fingerprints = new Map<string, string>();
	const fingerprint = async (id: string): Promise<string | null> => {
		try {
			return (await loadProfile(root, id)).revision;
		} catch (err) {
			if (err instanceof ProfileNotFoundError) return null;
			// Most likely caught mid-save; the end of the save brings another report.
			return `unreadable: ${errorMessage(err)}`;
		}
	};
	const profileIds = async () => (await listProfileIds(root)).map((id) => id.toUpperCase());

	const failed = (err: unknown) => log.warn(`Couldn't check profiles for changes: ${errorMessage(err)}`);
	let queue = (async () => {
		for (const id of await profileIds()) {
			const print = await fingerprint(id);
			if (print !== null) fingerprints.set(id, print);
		}
	})().catch(failed);
	const check = async (ids: string[] | null) => {
		const changed: string[] = [];
		for (const id of ids ?? [...new Set([...(await profileIds()), ...fingerprints.keys()])]) {
			const print = await fingerprint(id);
			if (print === (fingerprints.get(id) ?? null)) continue;
			if (print === null) fingerprints.delete(id);
			else fingerprints.set(id, print);
			changed.push(id);
		}
		if (changed.length) onChange(changed.sort());
	};
	// Started before the first fingerprints are taken, so no save slips through in between.
	const watcher = watchProfiles(
		root,
		log,
		(change) => {
			queue = queue.then(() => check(change.profiles)).catch(failed);
		},
		options,
	);
	await queue;
	return watcher;
}
