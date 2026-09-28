import { existsSync } from "node:fs";
import path from "node:path";

import type { DeviceDescriptor } from "../profiles/devices.ts";
import type { IconIndex } from "../profiles/icons.ts";
import { type LoadedProfile, compareCoords, keypadActions } from "../profiles/reader.ts";
import { ACTION_FOLDER, ACTION_MULTI_PREFIX, ACTION_PARENT_FOLDER, ACTION_SWITCH_PROFILE, type ActionJson, folderTargetOf } from "../profiles/types.ts";
import { type KeyDetails, describeAction } from "./key-details.ts";

export interface EditorKey {
	/** Stable identity for the editing session: "<page id>:<col,row>" at load time. */
	id: string;
	page: string;
	coord: string;
	uuid: string;
	name: string;
	plugin: string;
	kind: "action" | "folder" | "back" | "multi";
	/** Page id opened by a "Create Folder" key. */
	folder: string | null;
	locked: boolean;
	image: string | null;
	title: string;
	showTitle: boolean;
	align: "top" | "middle" | "bottom";
	color: string;
	fontSize: number | null;
	fontFamily: string;
	fontStyle: string;
	underline: boolean;
	/** What the key does (URL, file, hotkey, ...), for the key preview and search. */
	details: string[];
	/** "Go to Page": 1-based page number in the page order as loaded. */
	goto: number | null;
	switchTo: KeyDetails["switchTo"];
}

export interface EditorProfile {
	id: string;
	name: string;
	revision: string;
	layoutRevision: string;
	device: DeviceDescriptor;
	installedBy: string | null;
	/** Numbered pages in order, then every folder page. The editor derives the folder tree from the keys. */
	pages: { id: string; kind: "page" | "folder"; number: number | null }[];
	keys: EditorKey[];
	/** Page id -> number of "Switch Profile" keys in other profiles that open this profile at that page. */
	inboundLinks: Record<string, number>;
}

export function buildEditorModel(profile: LoadedProfile, icons: IconIndex, others: LoadedProfile[] = []): EditorProfile {
	const profileNames = new Map([profile, ...others].map((p) => [p.id.toLowerCase(), p.name]));
	const pages: EditorProfile["pages"] = [
		...profile.topLevel.map((id, i) => ({ id, kind: "page" as const, number: i + 1 })),
		...[...profile.folders.keys()].map((id) => ({ id, kind: "folder" as const, number: null })),
	];
	const keys: EditorKey[] = [];
	for (const { id: pageId } of pages) {
		const record = profile.pages.get(pageId)!;
		const actions = keypadActions(record.manifest);
		for (const coord of Object.keys(actions).sort(compareCoords)) {
			keys.push(toEditorKey(profile, record.dir, pageId, coord, actions[coord], icons, profileNames));
		}
	}
	return {
		id: profile.id,
		name: profile.name,
		revision: profile.revision,
		layoutRevision: profile.layoutRevision,
		device: profile.device,
		installedBy: profile.installedBy,
		pages,
		keys,
		inboundLinks: countInboundLinks(profile, others),
	};
}

/** Counts "Switch Profile" keys elsewhere that open one of this profile's pages by number. */
function countInboundLinks(profile: LoadedProfile, others: LoadedProfile[]): Record<string, number> {
	const counts: Record<string, number> = {};
	const target = profile.id.toLowerCase();
	const visit = (node: unknown) => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!node || typeof node !== "object") return;
		const item = node as ActionJson;
		const s = item.Settings;
		if (item.UUID === ACTION_SWITCH_PROFILE && typeof s?.ProfileUUID === "string" && s.ProfileUUID.toLowerCase() === target) {
			const pageId = typeof s.PageIndex === "number" ? profile.topLevel[s.PageIndex - 1] : undefined;
			if (pageId) counts[pageId] = (counts[pageId] ?? 0) + 1;
		}
		for (const value of Object.values(item)) if (value && typeof value === "object") visit(value);
	};
	for (const other of others) {
		if (other.id === profile.id) continue;
		for (const record of other.pages.values()) {
			for (const controller of record.manifest.Controllers ?? []) visit(Object.values(controller.Actions ?? {}));
		}
	}
	return counts;
}

function toEditorKey(
	profile: LoadedProfile,
	pageDir: string,
	pageId: string,
	coord: string,
	action: ActionJson,
	icons: IconIndex,
	profileNames: Map<string, string>,
): EditorKey {
	const uuid = action.UUID ?? "";
	const stateIndex = typeof action.State === "number" ? action.State : 0;
	const state = action.States?.[stateIndex] ?? action.States?.[0] ?? {};

	let image: string | null = null;
	const m = typeof state.Image === "string" ? /^Images\/([^/\\]+)$/.exec(state.Image) : null;
	if (m && existsSync(path.join(pageDir, "Images", m[1]))) {
		image = `/img/page/${profile.id}/${pageId}/${encodeURIComponent(m[1])}`;
	} else if (icons.resolveImage(uuid, stateIndex)) {
		image = `/img/action/${encodeURIComponent(uuid)}/${stateIndex}`;
	}

	const details = describeAction(action, profileNames);
	const align = state.TitleAlignment === "top" || state.TitleAlignment === "middle" ? state.TitleAlignment : "bottom";
	return {
		id: `${pageId}:${coord}`,
		page: pageId,
		coord,
		uuid,
		name: action.Name ?? uuid,
		plugin: action.Plugin?.Name ?? icons.pluginName(uuid) ?? uuid,
		kind: uuid === ACTION_FOLDER ? "folder" : uuid === ACTION_PARENT_FOLDER ? "back" : uuid.startsWith(ACTION_MULTI_PREFIX) ? "multi" : "action",
		folder: folderTargetOf(action),
		locked: uuid === ACTION_PARENT_FOLDER,
		image,
		title: typeof state.Title === "string" ? state.Title : "",
		showTitle: state.ShowTitle !== false,
		align,
		color: typeof state.TitleColor === "string" && /^#[0-9a-f]{3,8}$/i.test(state.TitleColor) ? state.TitleColor : "#ffffff",
		fontSize: typeof state.FontSize === "number" ? state.FontSize : null,
		fontFamily: typeof state.FontFamily === "string" ? state.FontFamily : "",
		fontStyle: typeof state.FontStyle === "string" ? state.FontStyle : "",
		underline: state.FontUnderline === true,
		details: details.lines,
		goto: details.goto,
		switchTo: details.switchTo,
	};
}
