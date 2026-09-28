import path from "node:path";

import { ACTION_MULTI_PREFIX, ACTION_PAGE_GOTO, ACTION_PARENT_FOLDER, ACTION_SWITCH_PROFILE, type ActionJson } from "../profiles/types.ts";

export interface KeyDetails {
	/** Short facts about what the key does, shown in the editor's key preview and used by search. */
	lines: string[];
	/** "Go to Page": 1-based page number in the profile as loaded. */
	goto: number | null;
	/** "Switch Profile": the profile it opens and the page number (null when not set). */
	switchTo: { profileId: string; profileName: string | null; page: number | null } | null;
}

/** Windows virtual-key codes, as stored in Stream Deck hotkeys. */
const VK_NAMES: Record<number, string> = {
	8: "Backspace",
	9: "Tab",
	13: "Enter",
	16: "Shift",
	17: "Ctrl",
	18: "Alt",
	19: "Pause",
	20: "Caps Lock",
	27: "Esc",
	32: "Space",
	33: "Page Up",
	34: "Page Down",
	35: "End",
	36: "Home",
	37: "Left",
	38: "Up",
	39: "Right",
	40: "Down",
	44: "Print Screen",
	45: "Insert",
	46: "Delete",
	91: "Win",
	92: "Win",
	93: "Menu",
	106: "Num *",
	107: "Num +",
	109: "Num -",
	110: "Num .",
	111: "Num /",
	144: "Num Lock",
	145: "Scroll Lock",
	173: "Mute",
	174: "Volume Down",
	175: "Volume Up",
	176: "Next Track",
	177: "Previous Track",
	178: "Stop",
	179: "Play/Pause",
	186: ";",
	187: "=",
	188: ",",
	189: "-",
	190: ".",
	191: "/",
	192: "`",
	219: "[",
	220: "\\",
	221: "]",
	222: "'",
};

function virtualKeyName(code: number): string {
	if (code >= 48 && code <= 57) return String.fromCharCode(code);
	if (code >= 65 && code <= 90) return String.fromCharCode(code);
	if (code >= 96 && code <= 105) return `Num ${code - 96}`;
	if (code >= 112 && code <= 135) return `F${code - 111}`;
	return VK_NAMES[code] ?? `Key ${code}`;
}

type Hotkey = { KeyCtrl?: boolean; KeyOption?: boolean; KeyShift?: boolean; KeyCmd?: boolean; VKeyCode?: number };

/** "Ctrl+Shift+F10"; null for the empty placeholder slots Stream Deck stores. */
export function formatHotkey(hotkey: Hotkey): string | null {
	const code = typeof hotkey?.VKeyCode === "number" ? hotkey.VKeyCode : -1;
	if (code < 0) return null;
	const parts: string[] = [];
	if (hotkey.KeyCtrl) parts.push("Ctrl");
	if (hotkey.KeyOption) parts.push("Alt");
	if (hotkey.KeyShift) parts.push("Shift");
	if (hotkey.KeyCmd) parts.push("Win");
	const key = virtualKeyName(code);
	if (!parts.includes(key)) parts.push(key);
	return parts.join("+");
}

function countSteps(node: unknown): number {
	if (Array.isArray(node)) return node.reduce((sum: number, item) => sum + countSteps(item), 0);
	if (!node || typeof node !== "object") return 0;
	const item = node as ActionJson;
	if (Array.isArray(item.Actions)) return countSteps(item.Actions);
	return typeof item.UUID === "string" ? 1 : 0;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * Describes what an action does, from the settings of Stream Deck's built-in actions. Settings of
 * other plugins are not interpreted (and could hold tokens), and "Text" keys only say that they
 * type text, never what.
 */
export function describeAction(action: ActionJson, profileNames: Map<string, string>): KeyDetails {
	const uuid = action.UUID ?? "";
	const s = action.Settings ?? {};
	const details: KeyDetails = { lines: [], goto: null, switchTo: null };
	switch (uuid) {
		case "com.elgato.streamdeck.system.website": {
			if (text(s.path)) details.lines.push(text(s.path));
			break;
		}
		case "com.elgato.streamdeck.system.open": {
			const target = text(s.path).replace(/^"(.*)"$/, "$1");
			if (target) details.lines.push(target);
			break;
		}
		case "com.elgato.streamdeck.system.openapp": {
			const app = text(s.app_name) || path.win32.basename(text(s.bundle_path));
			if (app) details.lines.push(app);
			break;
		}
		case "com.elgato.streamdeck.system.hotkey":
		case "com.elgato.streamdeck.system.hotkeyswitch": {
			const combos = (Array.isArray(s.Hotkeys) ? s.Hotkeys : []).map((h) => formatHotkey(h as unknown as Hotkey)).filter((c): c is string => !!c);
			if (combos.length) details.lines.push(combos.join(", "));
			break;
		}
		case "com.elgato.streamdeck.system.text":
			details.lines.push("Types text");
			break;
		case "com.elgato.streamdeck.soundboard.playaudio": {
			// Sounds imported into Stream Deck's library get a GUID name, which says nothing.
			const file = path.win32.basename(text(s.path));
			if (file && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/i.test(file)) details.lines.push(file);
			break;
		}
		case "com.elgato.streamdeck.page.next":
			details.lines.push("Next page");
			break;
		case "com.elgato.streamdeck.page.previous":
			details.lines.push("Previous page");
			break;
		case ACTION_PAGE_GOTO:
			if (typeof s.PageIndex === "number" && s.PageIndex >= 1) details.goto = s.PageIndex;
			break;
		case ACTION_SWITCH_PROFILE: {
			const id = text(s.ProfileUUID).toLowerCase();
			if (id) {
				const page = typeof s.PageIndex === "number" && s.PageIndex >= 1 ? s.PageIndex : null;
				details.switchTo = { profileId: id, profileName: profileNames.get(id) ?? null, page };
			}
			break;
		}
		case ACTION_PARENT_FOLDER:
			details.lines.push("Returns to the parent folder");
			break;
		default:
			if (uuid.startsWith(ACTION_MULTI_PREFIX) && Array.isArray(action.Actions)) {
				const steps = countSteps(action.Actions);
				details.lines.push(`${steps} step${steps === 1 ? "" : "s"}`);
			}
	}
	return details;
}
