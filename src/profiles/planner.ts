import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { sha1 } from "../lib/json.ts";
import { type LoadedProfile, findFolders, isUuid, keypadActions } from "./reader.ts";
import {
	ACTION_PAGE_GOTO,
	ACTION_SWITCH_PROFILE,
	type ActionJson,
	type ControllerJson,
	type PageManifest,
	isLockedAction,
	parseCoord,
} from "./types.ts";

export interface KeyRef {
	page: string;
	coord: string;
}

export interface MoveSpec {
	from: KeyRef;
	to: KeyRef;
}

/**
 * Changes to the numbered pages: their final order (existing and new ids), which of those ids are
 * new, and which existing pages go away. Folder pages are never created or deleted here.
 */
export interface PageChanges {
	order: string[];
	created: string[];
	deleted: string[];
}

export interface ChangeRequest {
	moves: MoveSpec[];
	pages?: PageChanges;
}

/**
 * One file-system change. Every op carries enough information for the apply step to verify the
 * file is still in the state the plan was computed from.
 */
export type PlanOp =
	| { kind: "mkdir"; dest: string }
	/** expectedSha1 null: the file must not exist yet. */
	| { kind: "manifest"; dest: string; content: string; expectedSha1: string | null }
	| { kind: "image"; dest: string; source: string; sourceSha1: string }
	| { kind: "delete"; dest: string; expectedSha1: string }
	/** Remove a page folder; expectedSha1 is the hash of its manifest.json. */
	| { kind: "deleteDir"; dest: string; expectedSha1: string };

export interface PlanProfile {
	id: string;
	name: string;
	dir: string;
	deviceName: string;
}

export interface PlanSummary {
	moved: number;
	crossPage: number;
	/** Page manifests written in the edited profile. */
	pages: number;
	imagesCopied: number;
	imagesRemoved: number;
	pagesAdded: number;
	pagesDeleted: number;
	pagesReordered: boolean;
	/** "Go to Page" / "Switch Profile" keys given a new page number. */
	linksUpdated: number;
}

export interface MovePlan {
	profileId: string;
	profileName: string;
	profileDir: string;
	revision: string;
	/** Every profile the plan writes to, the edited one first. Each is backed up before applying. */
	profiles: PlanProfile[];
	ops: PlanOp[];
	summary: PlanSummary;
}

export class PlanError extends Error {}

const IMAGE_REF_RE = /^Images\/([^/\\]+)$/;

export function planMoves(profile: LoadedProfile, moves: MoveSpec[]): MovePlan {
	return planChanges(profile, { moves });
}

/**
 * Turns an edit (key moves plus optional page changes) into concrete file changes: rewritten page
 * manifests, the key images that follow a key to another page (each page keeps its own Images
 * folder), new and removed page folders, the profile's page list, and renumbered page links in
 * this and other profiles.
 *
 * The move list must describe the final position of every key that changes place. Everything is
 * validated independently of the editor: bounds, collisions, locked keys, folder reachability,
 * pages being deleted, and keys that would point at a deleted page.
 */
export function planChanges(profile: LoadedProfile, request: ChangeRequest, others: LoadedProfile[] = []): MovePlan {
	const { cols, rows } = profile.device;
	const pages = normalizePageChanges(profile, request.pages);
	const created = new Set(pages.created);
	const deleted = new Set(pages.deleted);
	const pageDir = (pageId: string) => profile.pages.get(pageId)?.dir ?? path.join(profile.dir, "Profiles", pageId);
	const pageLabel = (pageId: string) => describePage(profile, pages.order, pageId);
	const label = (pageId: string, coord: string) => `${pageLabel(pageId)}, ${describeCoord(coord)}`;

	const editable = new Set([...profile.topLevel, ...profile.folders.keys(), ...created]);
	const before = new Map<string, Map<string, ActionJson>>();
	for (const pageId of editable) {
		const record = profile.pages.get(pageId);
		before.set(pageId, new Map(record ? Object.entries(keypadActions(record.manifest)) : []));
	}

	type Effective = { fromPage: string; fromCoord: string; toPage: string; toCoord: string; action: ActionJson };
	const effective: Effective[] = [];
	const seenFrom = new Set<string>();
	const seenTo = new Set<string>();
	for (const move of request.moves ?? []) {
		const fromPage = String(move?.from?.page ?? "").toUpperCase();
		const toPage = String(move?.to?.page ?? "").toUpperCase();
		const fromCoord = String(move?.from?.coord ?? "");
		const toCoord = String(move?.to?.coord ?? "");
		if (!editable.has(fromPage)) throw new PlanError(`Unknown source page ${fromPage || "(none)"}.`);
		if (!editable.has(toPage)) throw new PlanError(`Unknown destination page ${toPage || "(none)"}.`);
		if (deleted.has(toPage)) throw new PlanError(`${capitalize(pageLabel(toPage))} is being deleted, so keys can't move there.`);
		const action = before.get(fromPage)!.get(fromCoord);
		if (!action) throw new PlanError(`There is no key at ${label(fromPage, fromCoord)} any more.`);
		if (isLockedAction(action)) throw new PlanError(`The "Parent Folder" key at ${label(fromPage, fromCoord)} can't be moved.`);
		const cell = parseCoord(toCoord);
		if (!cell || cell.col >= cols || cell.row >= rows) {
			throw new PlanError(`${toCoord} is outside the ${cols}×${rows} key grid.`);
		}
		const fromKey = `${fromPage}|${fromCoord}`;
		const toKey = `${toPage}|${toCoord}`;
		if (seenFrom.has(fromKey)) throw new PlanError(`The key at ${label(fromPage, fromCoord)} is moved twice.`);
		if (seenTo.has(toKey)) throw new PlanError(`Two keys are moved to ${label(toPage, toCoord)}.`);
		seenFrom.add(fromKey);
		seenTo.add(toKey);
		if (fromKey !== toKey) effective.push({ fromPage, fromCoord, toPage, toCoord, action });
	}
	if (effective.length === 0 && !pages.changed) throw new PlanError("Nothing to apply: no key or page changes.");

	const after = new Map([...before].map(([pageId, keys]) => [pageId, new Map(keys)]));
	for (const mv of effective) after.get(mv.fromPage)!.delete(mv.fromCoord);
	for (const mv of effective) {
		const target = after.get(mv.toPage)!;
		const occupant = target.get(mv.toCoord);
		if (occupant) throw new PlanError(`${capitalize(label(mv.toPage, mv.toCoord))} is taken by "${keyName(occupant)}", which isn't being moved.`);
		target.set(mv.toCoord, mv.action);
	}
	for (const pageId of deleted) {
		if (after.get(pageId)!.size > 0) throw new PlanError(`${capitalize(pageLabel(pageId))} still has keys. Move them to another page before deleting it.`);
	}

	const actionsIn = (state: Map<string, Map<string, ActionJson>>) => (pageId: string) => Object.fromEntries(state.get(pageId) ?? []);
	const reachableAfter = findFolders(profile.pages, pages.order, actionsIn(after));
	for (const [folderId, opener] of profile.folders) {
		if (!reachableAfter.has(folderId)) {
			const name = keyName(before.get(opener.page)!.get(opener.coord)!);
			throw new PlanError(`Folder "${name}" can't be moved into itself: it would become unreachable.`);
		}
	}

	// Keys that change page take their images with them.
	const imageOps: PlanOp[] = [];
	const hashes = new Map<string, string>();
	const hashOf = (file: string) => {
		let h = hashes.get(file);
		if (h === undefined) {
			h = sha1(readFileSync(file));
			hashes.set(file, h);
		}
		return h;
	};
	const newFiles = new Map<string, string>(); // lower-cased destination path -> content hash
	const leftBehind = new Map<string, Set<string>>(); // page id -> image files used by keys that left it
	let crossPage = 0;

	for (const mv of effective) {
		if (mv.fromPage === mv.toPage) continue;
		crossPage++;
		const fromDir = pageDir(mv.fromPage);
		const toDir = pageDir(mv.toPage);
		const moved = structuredClone(mv.action);
		const renames = new Map<string, string>();
		for (const file of collectImageRefs(moved)) {
			addToSet(leftBehind, mv.fromPage, file);
			const source = path.join(fromDir, "Images", file);
			if (!existsSync(source)) continue; // dangling reference: carried over unchanged
			const sourceHash = hashOf(source);
			let name = file;
			for (;;) {
				const dest = path.join(toDir, "Images", name);
				const planned = newFiles.get(dest.toLowerCase());
				if (planned !== undefined) {
					if (planned === sourceHash) break;
				} else if (existsSync(dest)) {
					if (hashOf(dest) === sourceHash) break;
				} else {
					newFiles.set(dest.toLowerCase(), sourceHash);
					imageOps.push({ kind: "image", dest, source, sourceSha1: sourceHash });
					break;
				}
				name = newImageName(path.extname(file));
			}
			if (name !== file) renames.set(file, name);
		}
		if (renames.size > 0) rewriteImageRefs(moved, renames);
		after.get(mv.toPage)!.set(mv.toCoord, moved);
	}

	// Keys that open a page by its number follow that page to its new number.
	const renumber = pageRenumbering(profile.topLevel, pages.order, deleted);
	const profileKey = profile.id.toLowerCase();
	const touched = new Set(effective.flatMap((mv) => [mv.fromPage, mv.toPage]));
	const broken: string[] = [];
	let linksUpdated = 0;
	if (pages.changed) {
		for (const [pageId, keys] of after) {
			for (const [coord, action] of keys) {
				const result = relinkAction(action, profileKey, true, renumber);
				if (result.broken) broken.push(label(pageId, coord));
				if (result.changed) {
					keys.set(coord, result.action);
					linksUpdated += result.changed;
					touched.add(pageId);
				}
			}
		}
	}

	const manifestOps: PlanOp[] = [];
	const cleanupOps: PlanOp[] = [];
	for (const [pageId, record] of profile.pages) {
		if (deleted.has(pageId)) continue;
		const manifest = structuredClone(record.manifest);
		let changed = false;
		if (after.has(pageId) && touched.has(pageId)) {
			setKeypad(manifest, after.get(pageId)!);
			changed = true;
		}
		if (pages.changed) {
			// Dials, and pages the editor doesn't show (like the hidden default page), too.
			for (const controller of manifest.Controllers ?? []) {
				if (after.has(pageId) && controller.Type === "Keypad") continue;
				for (const [coord, action] of Object.entries(controller.Actions ?? {})) {
					const result = relinkAction(action, profileKey, true, renumber);
					if (result.broken) broken.push(label(pageId, coord));
					if (result.changed) {
						controller.Actions![coord] = result.action;
						linksUpdated += result.changed;
						changed = true;
					}
				}
			}
		}
		if (!changed) continue;
		const content = JSON.stringify(manifest);
		manifestOps.push({ kind: "manifest", dest: record.manifestPath, content, expectedSha1: record.sha1 });

		// Stream Deck keeps no unreferenced images, so remove the ones only departed keys used.
		for (const file of leftBehind.get(pageId) ?? []) {
			if (content.includes(file)) continue;
			const dest = path.join(record.dir, "Images", file);
			if (!existsSync(dest) || newFiles.has(dest.toLowerCase())) continue;
			cleanupOps.push({ kind: "delete", dest, expectedSha1: hashOf(dest) });
		}
	}

	const mkdirOps: PlanOp[] = [];
	const template = newPageTemplate(profile);
	for (const pageId of pages.order) {
		if (!created.has(pageId)) continue;
		const dir = pageDir(pageId);
		mkdirOps.push({ kind: "mkdir", dest: dir }, { kind: "mkdir", dest: path.join(dir, "Images") });
		const manifest = structuredClone(template);
		setKeypad(manifest, after.get(pageId)!);
		manifestOps.push({ kind: "manifest", dest: path.join(dir, "manifest.json"), content: JSON.stringify(manifest), expectedSha1: null });
	}

	// "Switch Profile" keys in other profiles that open this profile at a page number.
	const otherOps: PlanOp[] = [];
	const profiles: PlanProfile[] = [{ id: profile.id, name: profile.name, dir: profile.dir, deviceName: profile.device.name }];
	if (pages.changed) {
		for (const other of others) {
			if (other.id === profile.id) continue;
			let touchedOther = false;
			for (const record of other.pages.values()) {
				const manifest = structuredClone(record.manifest);
				let changed = false;
				for (const controller of manifest.Controllers ?? []) {
					for (const [coord, action] of Object.entries(controller.Actions ?? {})) {
						const result = relinkAction(action, profileKey, false, renumber);
						if (result.broken) broken.push(`"${other.name}", ${describeCoord(coord)}`);
						if (result.changed) {
							controller.Actions![coord] = result.action;
							linksUpdated += result.changed;
							changed = true;
						}
					}
				}
				if (!changed) continue;
				otherOps.push({ kind: "manifest", dest: record.manifestPath, content: JSON.stringify(manifest), expectedSha1: record.sha1 });
				touchedOther = true;
			}
			if (touchedOther) profiles.push({ id: other.id, name: other.name, dir: other.dir, deviceName: other.device.name });
		}
	}
	if (broken.length > 0) {
		throw new PlanError(
			`${broken.length === 1 ? "A key opens" : `${broken.length} keys open`} a page that would be deleted (${broken.join("; ")}). ` +
				`Point ${broken.length === 1 ? "it" : "them"} at another page in Stream Deck first.`,
		);
	}

	const profileOps: PlanOp[] = [];
	if (pages.changed) {
		const manifest = structuredClone(profile.manifest);
		manifest.Pages.Pages = pages.order.map((id) => id.toLowerCase());
		if (manifest.Pages.Current && deleted.has(manifest.Pages.Current.toUpperCase())) manifest.Pages.Current = pages.order[0].toLowerCase();
		profileOps.push({ kind: "manifest", dest: profile.manifestPath, content: JSON.stringify(manifest), expectedSha1: profile.manifestSha1 });
	}
	const deleteDirOps: PlanOp[] = [...deleted].map((pageId) => ({ kind: "deleteDir", dest: pageDir(pageId), expectedSha1: profile.pages.get(pageId)!.sha1 }));

	const kept = profile.topLevel.filter((id) => !deleted.has(id));
	const keptNow = pages.order.filter((id) => !created.has(id));
	// Order matters for the apply step: new folders and images first, then manifests, then clean-up.
	return {
		profileId: profile.id,
		profileName: profile.name,
		profileDir: profile.dir,
		revision: profile.revision,
		profiles,
		ops: [...mkdirOps, ...imageOps, ...manifestOps, ...otherOps, ...profileOps, ...cleanupOps, ...deleteDirOps],
		summary: {
			moved: effective.length,
			crossPage,
			pages: manifestOps.length,
			imagesCopied: imageOps.length,
			imagesRemoved: cleanupOps.length,
			pagesAdded: created.size,
			pagesDeleted: deleted.size,
			pagesReordered: kept.some((id, i) => keptNow[i] !== id),
			linksUpdated,
		},
	};
}

function normalizePageChanges(profile: LoadedProfile, input: PageChanges | undefined) {
	const existing = profile.topLevel;
	if (!input) return { order: existing, created: [] as string[], deleted: [] as string[], changed: false };
	const ids = (value: unknown) => (Array.isArray(value) ? value.map((v) => String(v ?? "").toUpperCase()) : null);
	const order = ids(input.order);
	const created = ids(input.created) ?? [];
	const deleted = ids(input.deleted) ?? [];
	if (!order || order.length === 0) throw new PlanError("A profile needs at least one page.");
	for (const id of [...order, ...created, ...deleted]) {
		if (!isUuid(id)) throw new PlanError(`Invalid page id ${id}.`);
	}
	if (new Set(order).size !== order.length) throw new PlanError("A page appears twice in the new page order.");
	for (const id of created) {
		if (profile.pages.has(id)) throw new PlanError("A new page's id is already in use.");
	}
	for (const id of deleted) {
		if (!existing.includes(id)) throw new PlanError("Only numbered pages can be deleted.");
	}
	const expected = new Set([...existing.filter((id) => !deleted.includes(id)), ...created]);
	if (order.length !== expected.size || !order.every((id) => expected.has(id))) {
		throw new PlanError("The new page order doesn't match the pages that exist.");
	}
	const changed = created.length > 0 || deleted.length > 0 || order.length !== existing.length || order.some((id, i) => id !== existing[i]);
	return { order, created, deleted, changed };
}

/** Maps an old 1-based page number to the page's new number; null if that page is deleted. */
function pageRenumbering(oldOrder: string[], newOrder: string[], deleted: Set<string>) {
	return (index: number): number | null => {
		const id = oldOrder[index - 1];
		if (!id) return index; // already points past the last page: leave it alone
		if (deleted.has(id)) return null;
		const at = newOrder.indexOf(id);
		return at >= 0 ? at + 1 : index;
	};
}

/**
 * Renumbers the page links inside an action (including multi-action steps): "Go to Page" when
 * the action lives in the edited profile, and "Switch Profile" keys that open the edited profile.
 * Returns the original object when nothing changes.
 */
export function relinkAction(
	action: ActionJson,
	profileKey: string,
	sameProfile: boolean,
	renumber: (index: number) => number | null,
): { action: ActionJson; changed: number; broken: number } {
	let changed = 0;
	let broken = 0;
	const copy = structuredClone(action);
	const visit = (node: unknown) => {
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		if (!node || typeof node !== "object") return;
		const item = node as ActionJson;
		const settings = item.Settings;
		const index = settings?.PageIndex;
		const opensThisProfile =
			(sameProfile && item.UUID === ACTION_PAGE_GOTO) ||
			(item.UUID === ACTION_SWITCH_PROFILE && typeof settings?.ProfileUUID === "string" && settings.ProfileUUID.toLowerCase() === profileKey);
		if (opensThisProfile && typeof index === "number" && Number.isInteger(index) && index >= 1) {
			const next = renumber(index);
			if (next === null) broken++;
			else if (next !== index) {
				settings!.PageIndex = next;
				changed++;
			}
		}
		for (const value of Object.values(item)) {
			if (value && typeof value === "object") visit(value);
		}
	};
	visit(copy);
	return { action: changed > 0 ? copy : action, changed, broken };
}

/** An empty page shaped like the ones Stream Deck creates (its hidden default page is one). */
function newPageTemplate(profile: LoadedProfile): PageManifest {
	const defaultId = profile.manifest.Pages.Default?.toUpperCase();
	const source = (defaultId && profile.pages.get(defaultId)?.manifest) || profile.pages.get(profile.topLevel[0])?.manifest;
	const base: { Type: string }[] = source?.Controllers?.length ? source.Controllers : [{ Type: "Keypad" }];
	const controllers = base.map((c) => ({ Actions: null, Type: c.Type }));
	if (!controllers.some((c) => c.Type === "Keypad")) controllers.unshift({ Actions: null, Type: "Keypad" });
	return { Controllers: controllers as ControllerJson[], Icon: "", Name: "" };
}

/** Stream Deck (Qt) writes object keys in sorted order and `null` for an empty page. */
function setKeypad(manifest: PageManifest, keys: Map<string, ActionJson>): void {
	let keypad = manifest.Controllers.find((c) => c.Type === "Keypad");
	if (!keypad) {
		keypad = { Actions: null, Type: "Keypad" } as ControllerJson;
		manifest.Controllers.unshift(keypad);
	}
	const entries = [...keys.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	keypad.Actions = entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** File names referenced as "Images/<file>" anywhere inside an action (including multi-action children). */
export function collectImageRefs(value: unknown, out = new Set<string>()): Set<string> {
	if (typeof value === "string") {
		const m = IMAGE_REF_RE.exec(value);
		if (m) out.add(m[1]);
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectImageRefs(item, out);
	}
	return out;
}

function rewriteImageRefs(value: object, renames: Map<string, string>): void {
	const container = value as Record<string, unknown>;
	for (const key of Object.keys(container)) {
		const item = container[key];
		if (typeof item === "string") {
			const m = IMAGE_REF_RE.exec(item);
			const renamed = m ? renames.get(m[1]) : undefined;
			if (renamed) container[key] = `Images/${renamed}`;
		} else if (item && typeof item === "object") {
			rewriteImageRefs(item, renames);
		}
	}
}

const IMAGE_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTVW";

/** Same shape as the names Stream Deck generates: a UUID in base-32 (26 chars) followed by "Z". */
export function newImageName(ext: string): string {
	const bytes = randomBytes(16);
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += IMAGE_ID_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	out += IMAGE_ID_ALPHABET[(value << (5 - bits)) & 31];
	return `${out}Z${ext || ".png"}`;
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
	let set = map.get(key);
	if (!set) map.set(key, (set = new Set()));
	set.add(value);
}

export function keyName(action: ActionJson): string {
	const state = action.States?.[action.State ?? 0] ?? action.States?.[0];
	const title = state?.Title?.replace(/\s+/g, " ").trim();
	return title || action.Name || action.UUID || "key";
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function describeCoord(coord: string): string {
	const cell = parseCoord(coord);
	return cell ? `row ${cell.row + 1}, column ${cell.col + 1}` : coord;
}

/** "page 3" (in the new order; a deleted page keeps its old number) or `folder "Tools"`. */
function describePage(profile: LoadedProfile, order: string[], pageId: string): string {
	const now = order.indexOf(pageId);
	if (now >= 0) return `page ${now + 1}`;
	const was = profile.topLevel.indexOf(pageId);
	if (was >= 0) return `page ${was + 1}`;
	const opener = profile.folders.get(pageId);
	if (opener) {
		const action = keypadActions(profile.pages.get(opener.page)!.manifest)[opener.coord];
		return `folder "${action ? keyName(action) : "folder"}"`;
	}
	return "page";
}
