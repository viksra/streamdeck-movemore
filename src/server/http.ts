import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import path from "node:path";

import { type RestartSpec, TransactionError, listBackups, readResult, stageMoves, stageRestore, transactionDir, transactionExists } from "../apply/transaction.ts";
import { type Log, errorMessage } from "../lib/log.ts";
import { IconIndex } from "../profiles/icons.ts";
import { type LoadedProfile, ProfileError, ProfileNotFoundError, isUuid, listProfileIds, listProfiles, loadProfile } from "../profiles/reader.ts";
import { type MoveSpec, type PageChanges, PlanError, planChanges } from "../profiles/planner.ts";
import type { StreamDeckSelection } from "../profiles/selection.ts";
import { buildEditorModel } from "./editor-model.ts";
import { watchProfileContent } from "./profile-watcher.ts";

export interface ServerOptions {
	profilesRoot: string;
	dataDir: string;
	/** Folder with the browser editor (index.html, app.js, ...). */
	editorDir: string;
	/** Plugin folders scanned for default key images. */
	iconDirs: string[];
	/** Preferred port; the next few are tried when it is taken. */
	port: number;
	version: string;
	/** True when applying restarts Stream Deck (plugin); false when files are edited directly (dev). */
	restarts: boolean;
	log: Log;
	/** How to restart Stream Deck around a change; null to edit files directly. */
	restartSpec(): Promise<RestartSpec | null>;
	/** Hands a staged transaction to whatever executes it. */
	runTransaction(planPath: string): Promise<void>;
	/** Which profile Stream Deck shows on each device, for the editor to follow; omit to not follow. */
	readSelection?(): Promise<StreamDeckSelection>;
}

export interface RunningServer {
	port: number;
	url: string;
	close(): Promise<void>;
}

/** Editor pages that can listen for changes at once (each holds one connection open). */
const MAX_EVENT_STREAMS = 12;

/** Editor pages ask every few seconds; they share one reading for this long. */
const SELECTION_MAX_AGE_MS = 1000;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".gif": "image/gif",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
};

class HttpError extends Error {
	readonly status: number;
	readonly code: string | undefined;
	constructor(status: number, message: string, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

function statusOf(err: unknown): number {
	if (err instanceof HttpError) return err.status;
	if (err instanceof ProfileNotFoundError) return 404;
	if (err instanceof PlanError || err instanceof ProfileError || err instanceof TransactionError) return 400;
	return 500;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
	const { log } = options;
	const icons = new IconIndex(options.iconDirs, log);
	await icons.load();
	let busy = false;
	let port = options.port;

	/** Every other readable profile: needed for "Switch Profile" keys that point between profiles. */
	async function loadOthers(profileId: string): Promise<LoadedProfile[]> {
		const others: LoadedProfile[] = [];
		for (const id of await listProfileIds(options.profilesRoot)) {
			if (id === profileId) continue;
			try {
				others.push(await loadProfile(options.profilesRoot, id));
			} catch (err) {
				log.warn(`Skipping unreadable profile ${id}: ${errorMessage(err)}`);
			}
		}
		return others;
	}

	let lastSelection: { at: number; result: Promise<StreamDeckSelection | null> } | null = null;
	let selectionFailed = false;

	/** Which profile Stream Deck shows on each device; null when that can't be told. */
	function selection(): Promise<StreamDeckSelection | null> {
		const read = options.readSelection;
		if (!read) return Promise.resolve(null);
		if (lastSelection && Date.now() - lastSelection.at < SELECTION_MAX_AGE_MS) return lastSelection.result;
		const result = read().then(
			(value) => {
				selectionFailed = false;
				return value;
			},
			(err: unknown) => {
				if (!selectionFailed) log.warn(`The editor can't follow Stream Deck's profile switches: ${errorMessage(err)}`);
				selectionFailed = true;
				return null;
			},
		);
		lastSelection = { at: Date.now(), result };
		return result;
	}

	/** Editor pages listening for profile changes (server-sent events). */
	const streams = new Set<ServerResponse>();

	function openEventStream(req: IncomingMessage, res: ServerResponse): void {
		if (streams.size >= MAX_EVENT_STREAMS) throw new HttpError(503, "Too many editor pages are open.");
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			// Frees the connection as soon as the stream ends, so closing the server never waits on it.
			Connection: "close",
		});
		// Reconnect quickly once Stream Deck (and this server with it) has restarted.
		res.write("retry: 1500\n\n");
		streams.add(res);
		req.on("close", () => streams.delete(res));
	}

	function broadcast(event: string, data: unknown): void {
		const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const res of streams) res.write(frame);
	}

	const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
	const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// Reject DNS-rebinding requests: only our own host names may talk to this server.
		if (!allowedHosts().has(String(req.headers.host ?? "").toLowerCase())) throw new HttpError(403, "Forbidden host.");
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

		if (parts[0] === "api") return api(req, res, parts.slice(1));
		if (parts[0] === "img") return image(res, parts.slice(1));
		if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
		return serveFile(res, options.editorDir, parts.length ? parts.join("/") : "index.html");
	}

	async function api(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
		const route = `${req.method} /${parts.map((p, i) => (i === 1 ? ":id" : p)).join("/")}`;
		if (req.method === "POST") await checkWriteRequest(req);

		switch (route) {
			case "GET /state":
				// An editor page is starting: pick up plugins installed since (for default key images).
				await icons.load();
				return json(res, 200, {
					version: options.version,
					restarts: options.restarts,
					profilesRoot: options.profilesRoot,
					dataDir: options.dataDir,
					found: existsSync(options.profilesRoot),
				});
			case "GET /profiles":
				return json(res, 200, await listProfiles(options.profilesRoot));
			case "GET /profiles/:id": {
				const profile = await loadProfile(options.profilesRoot, parts[1]);
				return json(res, 200, buildEditorModel(profile, icons, await loadOthers(profile.id)));
			}
			case "GET /profiles/:id/revision": {
				const profile = await loadProfile(options.profilesRoot, parts[1]);
				return json(res, 200, { revision: profile.revision, layoutRevision: profile.layoutRevision });
			}
			case "GET /selection":
				return json(res, 200, { selection: await selection() });
			case "GET /events":
				return openEventStream(req, res);
			case "POST /apply":
				return exclusive(async () => {
					const body = (await readJson(req)) as { profileId?: unknown; revision?: unknown; layoutRevision?: unknown; moves?: unknown; pages?: unknown };
					if (!isUuid(body.profileId) || !Array.isArray(body.moves)) throw new HttpError(400, "Malformed request.");
					if (body.pages !== undefined && (typeof body.pages !== "object" || body.pages === null)) throw new HttpError(400, "Malformed request.");
					const profile = await loadProfile(options.profilesRoot, body.profileId);
					// The plan is made from the files as they are now, so new titles, images or key states
					// saved since the editor loaded are kept. Only keys or pages that moved make it stale.
					const stale = typeof body.layoutRevision === "string" ? profile.layoutRevision !== body.layoutRevision : profile.revision !== body.revision;
					if (stale) {
						throw new HttpError(409, "Keys or pages were changed in Stream Deck after the editor loaded this profile. Reload to get the latest layout.", "stale");
					}
					const plan = planChanges(profile, { moves: body.moves as MoveSpec[], pages: body.pages as PageChanges | undefined }, await loadOthers(profile.id));
					const tx = await stageMoves(options.dataDir, plan, { restart: await options.restartSpec() });
					log.info(`Staged ${tx.txid}: ${tx.description}`);
					await options.runTransaction(path.join(transactionDir(options.dataDir, tx.txid), "plan.json"));
					return json(res, 202, { txid: tx.txid, restarting: options.restarts, summary: plan.summary });
				});
			case "GET /transactions/:id": {
				if (!(await transactionExists(options.dataDir, parts[1]))) throw new HttpError(404, "Unknown transaction.");
				return json(res, 200, (await readResult(options.dataDir, parts[1])) ?? { txid: parts[1], status: "pending" });
			}
			case "GET /backups":
				return json(res, 200, { backups: await listBackups(options.dataDir), dir: path.join(options.dataDir, "backups") });
			case "POST /restore":
				return exclusive(async () => {
					const body = (await readJson(req)) as { backupId?: unknown };
					if (typeof body.backupId !== "string") throw new HttpError(400, "Malformed request.");
					const tx = await stageRestore(options.dataDir, options.profilesRoot, body.backupId, { restart: await options.restartSpec() });
					log.info(`Staged ${tx.txid}: ${tx.description}`);
					await options.runTransaction(path.join(transactionDir(options.dataDir, tx.txid), "plan.json"));
					return json(res, 202, { txid: tx.txid, restarting: options.restarts });
				});
			case "POST /open-backups": {
				const dir = path.join(options.dataDir, "backups");
				await mkdir(dir, { recursive: true });
				spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref();
				return json(res, 200, { ok: true });
			}
			default:
				throw new HttpError(404, "Not found.");
		}

		async function exclusive(fn: () => Promise<void>): Promise<void> {
			if (busy) throw new HttpError(409, "Another change is being applied right now.", "busy");
			busy = true;
			try {
				await fn();
			} finally {
				busy = false;
			}
		}
	}

	/** Browsers only send these headers from our own page; they force a CORS preflight elsewhere. */
	async function checkWriteRequest(req: IncomingMessage): Promise<void> {
		const origin = req.headers.origin;
		if (origin !== undefined && !allowedOrigins().has(origin)) throw new HttpError(403, "Forbidden origin.");
		if (req.headers["x-move-more"] !== "1") throw new HttpError(403, "Missing request header.");
		if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Expected JSON.");
	}

	async function image(res: ServerResponse, parts: string[]): Promise<void> {
		if (parts[0] === "page" && parts.length === 4) {
			const [, profileId, pageId, file] = parts;
			if (!isUuid(profileId) || !isUuid(pageId) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(file)) throw new HttpError(400, "Bad image path.");
			return serveFile(res, path.join(options.profilesRoot, `${profileId}.sdProfile`, "Profiles", pageId, "Images"), file);
		}
		if (parts[0] === "action" && parts.length === 3) {
			const found = icons.resolveImage(parts[1], Number(parts[2]) || 0);
			if (!found) throw new HttpError(404, "No image.");
			return serveFile(res, path.dirname(found), path.basename(found));
		}
		throw new HttpError(404, "Not found.");
	}

	const server: Server = createServer((req, res) => {
		handle(req, res).catch((err: unknown) => {
			const status = statusOf(err);
			if (status === 500) log.error(`${req.method} ${req.url} failed:`, err);
			if (!res.headersSent) json(res, status, { error: errorMessage(err), code: err instanceof HttpError ? err.code : undefined });
			else res.end();
		});
	});

	for (let attempt = 0; ; attempt++) {
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen({ port, host: "127.0.0.1" }, () => {
					server.off("error", reject);
					resolve();
				});
			});
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 9) throw err;
			log.warn(`Port ${port} is in use, trying ${port + 1}`);
			port++;
		}
	}

	// Tell open editor pages when Stream Deck saves a profile, so they show it right away.
	const watcher = await watchProfileContent(options.profilesRoot, log, (profiles) => broadcast("change", { profiles }));
	// Comments keep idle streams open and reveal pages that went away.
	const heartbeat = setInterval(() => {
		for (const res of streams) res.write(": keep-alive\n\n");
	}, 30000);
	heartbeat.unref();

	const url = `http://127.0.0.1:${port}/`;
	log.info(`Layout editor listening on ${url}`);
	return {
		port,
		url,
		close: () => {
			watcher.close();
			clearInterval(heartbeat);
			for (const res of streams) res.end();
			streams.clear();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
	res.end(text);
}

function serveFile(res: ServerResponse, root: string, relative: string): Promise<void> {
	const base = path.resolve(root);
	const file = path.resolve(base, relative);
	const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
	if (!file.startsWith(base + path.sep) || !type || !existsSync(file) || !statSync(file).isFile()) {
		throw new HttpError(404, "Not found.");
	}
	res.writeHead(200, {
		"Content-Type": type,
		"Cache-Control": "no-cache",
		"X-Content-Type-Options": "nosniff",
		...(type.startsWith("text/html") ? { "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } : {}),
	});
	return new Promise((resolve, reject) => {
		createReadStream(file).on("error", reject).on("end", resolve).pipe(res);
	});
}

function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new HttpError(413, "Request too large."));
				req.destroy();
			} else {
				chunks.push(chunk);
			}
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new HttpError(400, "Invalid JSON."));
			}
		});
		req.on("error", reject);
	});
}
