import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { sha1, stripBom } from "../lib/json.ts";
import { type DeviceDescriptor, describeDevice } from "./devices.ts";
import { type ActionJson, type PageManifest, type ProfileManifest, folderTargetOf, parseCoord } from "./types.ts";

export interface PageRecord {
	/** Upper-case page UUID, which is also the directory name. */
	id: string;
	dir: string;
	manifestPath: string;
	/** SHA-1 of the manifest file bytes; the apply step refuses to overwrite a file that changed. */
	sha1: string;
	manifest: PageManifest;
}

export interface LoadedProfile {
	id: string;
	name: string;
	dir: string;
	manifestPath: string;
	/** SHA-1 of the profile manifest file (it holds the page order). */
	manifestSha1: string;
	manifest: ProfileManifest;
	device: DeviceDescriptor;
	/** Every page directory of the profile (numbered pages, folders and the hidden default page). */
	pages: Map<string, PageRecord>;
	/** Numbered pages, in the order Stream Deck shows them. */
	topLevel: string[];
	/** Pages reachable through "Create Folder" keys, mapped to the key that opens them. */
	folders: Map<string, { page: string; coord: string }>;
	installedBy: string | null;
	/** Hash over all manifests; changes whenever Stream Deck saves anything in this profile. */
	revision: string;
	/**
	 * Hash over what the editor's pending changes depend on: which pages exist, their order, and
	 * which key sits in each slot. Titles, images, settings, key states and the page Stream Deck
	 * is showing don't count, so saving those doesn't invalidate changes made in the editor.
	 */
	layoutRevision: string;
}

export interface ProfileSummary {
	id: string;
	name: string;
	device: DeviceDescriptor;
	pageCount: number;
	folderCount: number;
	keyCount: number;
	installedBy: string | null;
}

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_RE.test(value);
}

export class ProfileError extends Error {}

/** The profile's folder is gone (deleted in Stream Deck). */
export class ProfileNotFoundError extends ProfileError {}

/** Returns the Keypad actions of a page keyed by "col,row" (empty object for an empty page). */
export function keypadActions(manifest: PageManifest): Record<string, ActionJson> {
	const keypad = manifest.Controllers?.find((c) => c.Type === "Keypad");
	return keypad?.Actions ?? {};
}

export async function listProfileIds(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const entries = await readdir(root, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory() && e.name.toLowerCase().endsWith(".sdprofile"))
		.map((e) => e.name.slice(0, -".sdProfile".length))
		.filter(isUuid);
}

export async function loadProfile(root: string, id: string): Promise<LoadedProfile> {
	if (!isUuid(id)) throw new ProfileError(`Invalid profile id: ${id}`);
	const dir = path.join(root, `${id}.sdProfile`);
	const manifestPath = path.join(dir, "manifest.json");
	if (!existsSync(dir)) throw new ProfileNotFoundError(`Profile ${id} was not found.`);
	if (!existsSync(manifestPath)) throw new ProfileError(`Profile ${id} has no manifest.`);

	const manifestBytes = await readFile(manifestPath);
	const manifest = JSON.parse(stripBom(manifestBytes.toString("utf8"))) as ProfileManifest;
	if (!manifest?.Pages || !Array.isArray(manifest.Pages.Pages)) {
		throw new ProfileError(`Profile ${id} has an unsupported manifest format.`);
	}

	const pages = new Map<string, PageRecord>();
	const pagesDir = path.join(dir, "Profiles");
	if (existsSync(pagesDir)) {
		for (const entry of await readdir(pagesDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isUuid(entry.name)) continue;
			const pageDir = path.join(pagesDir, entry.name);
			const pageManifestPath = path.join(pageDir, "manifest.json");
			if (!existsSync(pageManifestPath)) continue;
			const bytes = await readFile(pageManifestPath);
			pages.set(entry.name.toUpperCase(), {
				id: entry.name.toUpperCase(),
				dir: pageDir,
				manifestPath: pageManifestPath,
				sha1: sha1(bytes),
				manifest: JSON.parse(stripBom(bytes.toString("utf8"))) as PageManifest,
			});
		}
	}

	const topLevel = manifest.Pages.Pages.map((p) => p.toUpperCase()).filter((p) => pages.has(p));
	const folders = findFolders(pages, topLevel);

	let maxCol = -1;
	let maxRow = -1;
	for (const page of pages.values()) {
		for (const coord of Object.keys(keypadActions(page.manifest))) {
			const cell = parseCoord(coord);
			if (!cell) continue;
			maxCol = Math.max(maxCol, cell.col);
			maxRow = Math.max(maxRow, cell.row);
		}
	}

	const byId = [...pages.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
	const hashInput = [sha1(manifestBytes), ...byId.map((p) => `${p.id}:${p.sha1}`)];
	const layoutInput = [
		`pages ${topLevel.join(",")}`,
		`default ${String(manifest.Pages.Default ?? "").toUpperCase()}`,
		...byId.map((p) => {
			const actions = keypadActions(p.manifest);
			return `${p.id} ${Object.keys(actions).sort(compareCoords).map((coord) => `${coord}=${keyIdentity(actions[coord])}`).join(";")}`;
		}),
	];

	return {
		id,
		name: manifest.Name || "Unnamed profile",
		dir,
		manifestPath,
		manifestSha1: sha1(manifestBytes),
		manifest,
		device: describeDevice(manifest.Device?.Model ?? "", manifest.Device?.UUID ?? "", maxCol, maxRow),
		pages,
		topLevel,
		folders,
		installedBy: typeof manifest.InstalledByPluginUUID === "string" ? manifest.InstalledByPluginUUID : null,
		revision: sha1(hashInput.join("\n")),
		layoutRevision: sha1(layoutInput.join("\n")),
	};
}

/**
 * Which key sits in a slot: Stream Deck's ActionID (unique per key and kept across saves and
 * restarts), or for a key without one, everything about it except its current state.
 */
function keyIdentity(action: ActionJson): string {
	const id = typeof action?.ActionID === "string" && action.ActionID ? action.ActionID : sha1(JSON.stringify({ ...action, State: undefined }));
	return `${id}>${folderTargetOf(action ?? {}) ?? ""}`;
}

/**
 * Walks from the numbered pages through every "Create Folder" key (depth first) and returns the
 * folders that can be reached, with the key that opens each one.
 */
export function findFolders(
	pages: Map<string, { manifest: PageManifest }>,
	topLevel: string[],
	actionsOf: (pageId: string) => Record<string, ActionJson> = (pageId) => keypadActions(pages.get(pageId)!.manifest),
): Map<string, { page: string; coord: string }> {
	const folders = new Map<string, { page: string; coord: string }>();
	const visit = (pageId: string) => {
		const actions = actionsOf(pageId);
		for (const coord of Object.keys(actions).sort(compareCoords)) {
			const target = folderTargetOf(actions[coord]);
			if (!target || !pages.has(target) || folders.has(target) || topLevel.includes(target)) continue;
			folders.set(target, { page: pageId, coord });
			visit(target);
		}
	};
	for (const pageId of topLevel) visit(pageId);
	return folders;
}

/** Reading order: top row first, left to right. */
export function compareCoords(a: string, b: string): number {
	const ca = parseCoord(a);
	const cb = parseCoord(b);
	if (!ca || !cb) return a < b ? -1 : a > b ? 1 : 0;
	return ca.row - cb.row || ca.col - cb.col;
}

export async function listProfiles(root: string): Promise<{ profiles: ProfileSummary[]; errors: { id: string; message: string }[] }> {
	const profiles: ProfileSummary[] = [];
	const errors: { id: string; message: string }[] = [];
	for (const id of await listProfileIds(root)) {
		try {
			const p = await loadProfile(root, id);
			let keyCount = 0;
			for (const pageId of [...p.topLevel, ...p.folders.keys()]) {
				keyCount += Object.keys(keypadActions(p.pages.get(pageId)!.manifest)).length;
			}
			profiles.push({
				id: p.id,
				name: p.name,
				device: p.device,
				pageCount: p.topLevel.length,
				folderCount: p.folders.size,
				keyCount,
				installedBy: p.installedBy,
			});
		} catch (err) {
			errors.push({ id, message: err instanceof Error ? err.message : String(err) });
		}
	}
	profiles.sort((a, b) => a.device.uuid.localeCompare(b.device.uuid) || a.name.localeCompare(b.name));
	return { profiles, errors };
}
