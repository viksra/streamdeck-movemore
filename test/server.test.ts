import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { executeTransaction, windowsProcessControl } from "../src/apply/executor.ts";
import { silentLog } from "../src/lib/log.ts";
import { keypadActions, loadProfile } from "../src/profiles/reader.ts";
import { type RunningServer, type ServerOptions, startServer } from "../src/server/http.ts";
import { type Fixture, P1, P2, PROFILE, addOtherProfile, createFixture, switchKey } from "./helpers/fixture.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw request so tests can control the Host/Origin headers (fetch forbids setting Host). */
function request(port: number, method: string, url: string, options: { headers?: Record<string, string>; body?: unknown } = {}) {
	return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
		const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { Host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
		});
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

const WRITE_HEADERS = { "Content-Type": "application/json", "X-Move-More": "1" };

/** Listens to the server's change stream the way the editor page's EventSource does. */
function openEvents(port: number) {
	return new Promise<{ status: number; type: string; next(event: string, timeoutMs?: number): Promise<string>; close(): void }>((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/events", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
			const frames: { event: string; data: string }[] = [];
			let buffer = "";
			let wake = () => {};
			res.setEncoding("utf8");
			res.on("error", () => {}); // Closing the stream from this side aborts it.
			res.on("data", (chunk: string) => {
				buffer += chunk;
				for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const event = /^event: (.*)$/m.exec(frame)?.[1];
					if (event) frames.push({ event, data: /^data: (.*)$/m.exec(frame)?.[1] ?? "" });
				}
				wake();
			});
			resolve({
				status: res.statusCode ?? 0,
				type: String(res.headers["content-type"]),
				async next(event, timeoutMs = 4000) {
					const deadline = Date.now() + timeoutMs;
					for (;;) {
						const index = frames.findIndex((f) => f.event === event);
						if (index >= 0) return frames.splice(index, 1)[0].data;
						if (Date.now() > deadline) throw new Error(`No "${event}" event within ${timeoutMs} ms.`);
						await new Promise<void>((done) => {
							wake = done;
							setTimeout(done, 50);
						});
					}
				},
				close: () => req.destroy(),
			});
		});
		req.on("error", reject);
		req.end();
	});
}

describe("editor HTTP server", () => {
	let fx: Fixture;
	let server: RunningServer;
	let port: number;
	let options: (port: number) => ServerOptions;

	before(async () => {
		fx = createFixture();
		addOtherProfile(fx, { "0,0": switchKey(PROFILE, 2) });
		const editorDir = path.join(fx.root, "editor");
		mkdirSync(editorDir);
		writeFileSync(path.join(editorDir, "index.html"), "<!doctype html><title>editor</title>");
		options = (port) => ({
			profilesRoot: fx.profilesRoot,
			dataDir: fx.dataDir,
			editorDir,
			iconDirs: [],
			port,
			version: "test",
			restarts: false,
			log: silentLog,
			restartSpec: async () => null,
			runTransaction: async (planPath) => {
				await executeTransaction(planPath, windowsProcessControl, silentLog);
			},
		});
		server = await startServer(options(38490));
		port = server.port;
	});
	after(async () => {
		await server.close();
		fx.cleanup();
	});

	it("serves the editor page with a strict content security policy", async () => {
		const res = await request(port, "GET", "/");
		assert.equal(res.status, 200);
		assert.match(res.body, /<title>editor/);
		assert.match(String(res.headers["content-security-policy"]), /script-src 'self'/);
	});

	it("rejects other host names (DNS rebinding)", async () => {
		const res = await request(port, "GET", "/api/profiles", { headers: { Host: `evil.example:${port}` } });
		assert.equal(res.status, 403);
	});

	it("lists profiles and returns the editor model", async () => {
		const list = JSON.parse((await request(port, "GET", "/api/profiles")).body);
		assert.equal(list.profiles[0].id, PROFILE);
		const model = JSON.parse((await request(port, "GET", `/api/profiles/${PROFILE}`)).body);
		assert.deepEqual(model.pages.map((p: { kind: string }) => p.kind), ["page", "page", "folder", "folder"]);
		const lamp = model.keys.find((k: { title: string }) => k.title === "Lamp");
		assert.equal(lamp.image, `/img/page/${PROFILE}/${P1}/A.png`);
		const back = model.keys.find((k: { kind: string }) => k.kind === "back");
		assert.equal(back.locked, true);
		const folder = model.keys.find((k: { kind: string }) => k.kind === "folder");
		assert.equal(folder.folder, "990752E9-3407-4FA4-BE02-375DB4DA67C4");
		assert.deepEqual(model.inboundLinks, { [P2]: 1 }, "the Jobs profile opens page 2 of this profile");
	});

	it("serves key images but not arbitrary files", async () => {
		const ok = await request(port, "GET", `/img/page/${PROFILE}/${P1}/A.png`);
		assert.equal(ok.status, 200);
		assert.equal(ok.headers["content-type"], "image/png");
		assert.equal((await request(port, "GET", `/img/page/${PROFILE}/${P1}/..%2F..%2Fmanifest.json`)).status, 400);
		assert.equal((await request(port, "GET", "/..%2F..%2Fpackage.json")).status, 404);
	});

	it("only accepts changes from the editor page itself", async () => {
		const body = { profileId: PROFILE, revision: "x", moves: [] };
		assert.equal((await request(port, "POST", "/api/apply", { body, headers: { "Content-Type": "text/plain" } })).status, 403);
		assert.equal((await request(port, "POST", "/api/apply", { body, headers: { ...WRITE_HEADERS, Origin: "https://evil.example" } })).status, 403);
	});

	it("reports a stale revision", async () => {
		const res = await request(port, "POST", "/api/apply", { body: { profileId: PROFILE, revision: "old", moves: [] }, headers: WRITE_HEADERS });
		assert.equal(res.status, 409);
		assert.equal(JSON.parse(res.body).code, "stale");
	});

	it("reports both revisions, and a profile deleted in Stream Deck as missing", async () => {
		const body = JSON.parse((await request(port, "GET", `/api/profiles/${PROFILE}/revision`)).body);
		assert.match(body.revision, /^[0-9a-f]{40}$/);
		assert.match(body.layoutRevision, /^[0-9a-f]{40}$/);
		assert.equal((await request(port, "GET", "/api/profiles/00000000-0000-4000-8000-000000000000/revision")).status, 404);
	});

	it("tells open editor pages when Stream Deck saves a profile, and only then", async () => {
		const events = await openEvents(port);
		const pageFile = path.join(fx.pageDir(P2), "manifest.json");
		const original = readFileSync(pageFile);
		try {
			assert.equal(events.status, 200);
			assert.match(events.type, /^text\/event-stream/);
			// Windows reports reads too when it updates last-access times; that's no change.
			utimesSync(pageFile, new Date(Date.now() - 3 * 3600_000), statSync(pageFile).mtime);
			await request(port, "GET", `/api/profiles/${PROFILE}`);
			await assert.rejects(events.next("change", 800), /No "change" event/);

			writeFileSync(pageFile, JSON.stringify({ ...JSON.parse(original.toString("utf8")), Name: "Renamed in Stream Deck" }));
			assert.deepEqual(JSON.parse(await events.next("change")), { profiles: [PROFILE] });
		} finally {
			events.close();
			writeFileSync(pageFile, original);
		}
	});

	it("tells editor pages which profile Stream Deck shows, sharing one reading between them", async () => {
		const selection = { shown: "@(1)[4057/108/X]", devices: [{ id: "@(1)[4057/108/X]", name: "Stream Deck XL", profileId: PROFILE }] };
		let reads = 0;
		const second = await startServer({
			...options(38496),
			readSelection: async () => {
				reads++;
				return selection;
			},
		});
		try {
			const [a, b] = await Promise.all([request(second.port, "GET", "/api/selection"), request(second.port, "GET", "/api/selection")]);
			assert.deepEqual(JSON.parse(a.body), { selection });
			assert.deepEqual(JSON.parse(b.body), { selection });
			assert.equal(reads, 1);
		} finally {
			await second.close();
		}
	});

	it("says it can't tell which profile Stream Deck shows when that can't be read", async () => {
		assert.deepEqual(JSON.parse((await request(port, "GET", "/api/selection")).body), { selection: null });
		const failing = await startServer({
			...options(38497),
			readSelection: async () => {
				throw new Error("No such registry value.");
			},
		});
		try {
			assert.deepEqual(JSON.parse((await request(failing.port, "GET", "/api/selection")).body), { selection: null });
		} finally {
			await failing.close();
		}
	});

	it("still closes promptly while an editor page is listening", async () => {
		const second = await startServer(options(38495));
		const events = await openEvents(second.port);
		const closed = await Promise.race([second.close().then(() => true), sleep(3000).then(() => false)]);
		events.close();
		assert.equal(closed, true);
	});

	it("explains invalid moves", async () => {
		const { revision } = JSON.parse((await request(port, "GET", `/api/profiles/${PROFILE}/revision`)).body);
		const res = await request(port, "POST", "/api/apply", {
			body: { profileId: PROFILE, revision, moves: [{ from: { page: P1, coord: "0,0" }, to: { page: P1, coord: "1,0" } }] },
			headers: WRITE_HEADERS,
		});
		assert.equal(res.status, 400);
		assert.match(JSON.parse(res.body).error, /taken by "Mail"/);
	});

	it("applies moves, records the transaction and lists the backup", async () => {
		const { revision } = JSON.parse((await request(port, "GET", `/api/profiles/${PROFILE}/revision`)).body);
		const res = await request(port, "POST", "/api/apply", {
			body: {
				profileId: PROFILE,
				revision,
				moves: [
					{ from: { page: P1, coord: "0,0" }, to: { page: P2, coord: "4,0" } },
					{ from: { page: P1, coord: "1,0" }, to: { page: P1, coord: "0,0" } },
				],
			},
			headers: { ...WRITE_HEADERS, Origin: `http://127.0.0.1:${port}` },
		});
		assert.equal(res.status, 202, res.body);
		const { txid } = JSON.parse(res.body);
		const tx = JSON.parse((await request(port, "GET", `/api/transactions/${txid}`)).body);
		assert.equal(tx.status, "ok", tx.message);

		const profile = await loadProfile(fx.profilesRoot, PROFILE);
		assert.equal(keypadActions(profile.pages.get(P1)!.manifest)["0,0"].Name, "Website");
		assert.equal(keypadActions(profile.pages.get(P2)!.manifest)["4,0"].States?.[0].Title, "Lamp");

		const backups = JSON.parse((await request(port, "GET", "/api/backups")).body);
		assert.equal(backups.backups.length, 1);
		assert.equal((await request(port, "GET", "/api/transactions/20990101-000000-abcdef")).status, 404);
	});

	it("keeps what Stream Deck saved in the meantime, unless keys moved", async () => {
		const { revision, layoutRevision } = JSON.parse((await request(port, "GET", `/api/profiles/${PROFILE}/revision`)).body);
		// While a move is pending in the editor, Stream Deck saves a new title for "Cam".
		const pageFile = path.join(fx.pageDir(P2), "manifest.json");
		const page = JSON.parse(readFileSync(pageFile, "utf8"));
		page.Controllers[0].Actions["0,0"].States[0].Title = "Camera";
		writeFileSync(pageFile, JSON.stringify(page));

		const apply = (from: string, to: string) =>
			request(port, "POST", "/api/apply", {
				body: { profileId: PROFILE, revision, layoutRevision, moves: [{ from: { page: P2, coord: from }, to: { page: P2, coord: to } }] },
				headers: WRITE_HEADERS,
			});
		const res = await apply("1,0", "2,0");
		assert.equal(res.status, 202, res.body);
		const tx = JSON.parse((await request(port, "GET", `/api/transactions/${JSON.parse(res.body).txid}`)).body);
		assert.equal(tx.status, "ok", tx.message);
		const keys = keypadActions((await loadProfile(fx.profilesRoot, PROFILE)).pages.get(P2)!.manifest);
		assert.equal(keys["2,0"].States?.[0].Title, "Other A");
		assert.equal(keys["0,0"].States?.[0].Title, "Camera", "the title saved in Stream Deck is kept");

		// Now the keys aren't where the editor saw them any more.
		const stale = await apply("2,0", "3,0");
		assert.equal(stale.status, 409);
		assert.equal(JSON.parse(stale.body).code, "stale");
	});
});
