/**
 * Shapes of the files Stream Deck 7 writes under ProfilesV3. Only the fields Move More reads are
 * typed; everything else is carried through untouched.
 *
 *   <PROFILE-UUID>.sdProfile/
 *     manifest.json                 -> ProfileManifest
 *     Profiles/<PAGE-UUID>/
 *       manifest.json               -> PageManifest (a page, a folder, or the hidden default page)
 *       Images/<ID>.png             -> custom key images, referenced as "Images/<ID>.png"
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProfileManifest {
	Device: { Model: string; UUID: string };
	Name: string;
	Pages: { Current?: string; Default?: string; Pages: string[] };
	Version: string;
	InstalledByPluginUUID?: string;
	[key: string]: unknown;
}

export interface StateJson {
	Image?: string;
	Title?: string;
	ShowTitle?: boolean;
	TitleAlignment?: string;
	TitleColor?: string;
	FontFamily?: string;
	FontSize?: number;
	FontStyle?: string;
	FontUnderline?: boolean;
	[key: string]: unknown;
}

export interface ActionJson {
	ActionID?: string;
	Name?: string;
	UUID?: string;
	Plugin?: { Name?: string; UUID?: string; Version?: string };
	Settings?: { [key: string]: JsonValue };
	State?: number;
	States?: StateJson[];
	[key: string]: unknown;
}

export interface ControllerJson {
	Type: string;
	/** Keyed by "col,row". Stream Deck writes `null` for an empty page. */
	Actions: Record<string, ActionJson> | null;
	[key: string]: unknown;
}

export interface PageManifest {
	Controllers: ControllerJson[];
	Icon?: string;
	Name?: string;
	[key: string]: unknown;
}

export const ACTION_FOLDER = "com.elgato.streamdeck.profile.openchild";
export const ACTION_PARENT_FOLDER = "com.elgato.streamdeck.profile.backtoparent";
export const ACTION_MULTI_PREFIX = "com.elgato.streamdeck.multiactions";
/** "Go to Page": Settings.PageIndex is a 1-based page number in the same profile. */
export const ACTION_PAGE_GOTO = "com.elgato.streamdeck.page.goto";
/** "Switch Profile": Settings.ProfileUUID + Settings.PageIndex (1-based page number, 0 = unset). */
export const ACTION_SWITCH_PROFILE = "com.elgato.streamdeck.profile.rotate";

/** Keys Move More never moves: the "Parent Folder" key Stream Deck pins inside every folder. */
export function isLockedAction(action: ActionJson): boolean {
	return action.UUID === ACTION_PARENT_FOLDER;
}

/** Page id (upper-case directory name) that a "Create Folder" key opens, if any. */
export function folderTargetOf(action: ActionJson): string | null {
	if (action.UUID !== ACTION_FOLDER) return null;
	const target = action.Settings?.ProfileUUID;
	return typeof target === "string" && target.length > 0 ? target.toUpperCase() : null;
}

export interface Cell {
	col: number;
	row: number;
}

const COORD_RE = /^(\d{1,3}),(\d{1,3})$/;

export function parseCoord(coord: string): Cell | null {
	const m = COORD_RE.exec(coord);
	return m ? { col: Number(m[1]), row: Number(m[2]) } : null;
}

export function formatCoord(col: number, row: number): string {
	return `${col},${row}`;
}
