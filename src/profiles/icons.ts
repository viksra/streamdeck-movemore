import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { parseJsonLenient } from "../lib/json.ts";
import type { Log } from "../lib/log.ts";

interface ActionEntry {
	pluginDir: string;
	pluginName: string;
	actionName: string;
	states: string[];
	icon: string | null;
}

interface PluginManifest {
	Name?: string;
	Actions?: { UUID?: string; Name?: string; Icon?: string; States?: { Image?: string }[] }[];
}

const IMAGE_EXTS = [".png", ".svg", ".gif", ".jpg", ".jpeg", ".webp"];

/**
 * Index of every installed plugin action (user plugins and the ones bundled with Stream Deck), used
 * to show the default image of keys that have no custom image.
 */
export class IconIndex {
	readonly #dirs: string[];
	readonly #log: Log;
	#actions = new Map<string, ActionEntry>();
	#resolved = new Map<string, string | null>();

	constructor(dirs: string[], log: Log) {
		this.#dirs = dirs;
		this.#log = log;
	}

	async load(): Promise<void> {
		const actions = new Map<string, ActionEntry>();
		for (const root of this.#dirs) {
			if (!existsSync(root)) continue;
			for (const entry of await readdir(root, { withFileTypes: true })) {
				if (!entry.name.toLowerCase().endsWith(".sdplugin")) continue;
				const pluginDir = path.join(root, entry.name);
				const manifestPath = path.join(pluginDir, "manifest.json");
				if (!existsSync(manifestPath)) continue;
				try {
					const text = await readFile(manifestPath, "utf8");
					// Marketplace plugins may ship an encrypted manifest; their keys fall back to a text tile.
					if (text.startsWith("ELGATO")) continue;
					const manifest = parseJsonLenient(text) as PluginManifest;
					for (const action of manifest.Actions ?? []) {
						if (!action.UUID || actions.has(action.UUID)) continue;
						actions.set(action.UUID, {
							pluginDir,
							pluginName: manifest.Name ?? entry.name,
							actionName: action.Name ?? action.UUID,
							states: (action.States ?? []).map((s) => s.Image ?? ""),
							icon: action.Icon ?? null,
						});
					}
				} catch (err) {
					this.#log.warn(`Skipping plugin manifest ${manifestPath}: ${err instanceof Error ? err.message : err}`);
				}
			}
		}
		this.#actions = actions;
		this.#resolved.clear();
	}

	has(uuid: string): boolean {
		return this.#actions.has(uuid);
	}

	pluginName(uuid: string): string | null {
		return this.#actions.get(uuid)?.pluginName ?? null;
	}

	/** Absolute path of the default image for an action state, or null when none can be found. */
	resolveImage(uuid: string, state: number): string | null {
		const cacheKey = `${uuid}#${state}`;
		if (this.#resolved.has(cacheKey)) return this.#resolved.get(cacheKey)!;
		const entry = this.#actions.get(uuid);
		let found: string | null = null;
		if (entry) {
			const candidates = [entry.states[state], entry.states[0], entry.icon].filter((c): c is string => !!c);
			for (const candidate of candidates) {
				found = findImageFile(entry.pluginDir, candidate);
				if (found) break;
			}
		}
		this.#resolved.set(cacheKey, found);
		return found;
	}
}

/** Manifest image paths usually omit the extension and may have an @2x variant. */
function findImageFile(pluginDir: string, relative: string): string | null {
	const base = path.resolve(pluginDir, relative);
	if (!base.startsWith(path.resolve(pluginDir) + path.sep)) return null;
	const ext = path.extname(base).toLowerCase();
	if (IMAGE_EXTS.includes(ext) && existsSync(base)) return base;
	for (const suffix of ["@2x", ""]) {
		for (const e of IMAGE_EXTS) {
			const file = `${base}${suffix}${e}`;
			if (existsSync(file)) return file;
		}
	}
	return null;
}
