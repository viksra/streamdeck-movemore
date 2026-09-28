/**
 * Runs the layout editor outside Stream Deck against a COPY of a profiles folder. Changes are
 * written straight to that folder (nothing is closed or restarted), which makes it safe for trying
 * the editor and for development.
 *
 *   npm run dev -- --profiles <copy of ProfilesV3> [--data <dir>] [--port 38460] [--selection <file>]
 *
 * The editor follows the profile Stream Deck shows, or with --selection, the one a JSON file names
 * ({ "shown": device id, "devices": [{ "id", "name", "profileId" }] }), so switching can be simulated.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { executeTransaction, windowsProcessControl } from "./apply/executor.ts";
import { consoleLog } from "./lib/log.ts";
import { builtinPluginsDir, defaultProfilesRoot, userPluginsDir } from "./lib/paths.ts";
import { type StreamDeckSelection, readStreamDeckSelection } from "./profiles/selection.ts";
import { startServer } from "./server/http.ts";

const { values } = parseArgs({
	options: {
		profiles: { type: "string" },
		data: { type: "string" },
		port: { type: "string", default: "38460" },
		selection: { type: "string" },
	},
});

if (!values.profiles) {
	console.error("Usage: npm run dev -- --profiles <copy of your ProfilesV3 folder> [--data <dir>] [--port <n>] [--selection <file>]");
	process.exit(1);
}
const selectionFile = values.selection && path.resolve(values.selection);
const profilesRoot = path.resolve(values.profiles);
if (profilesRoot.toLowerCase() === path.resolve(defaultProfilesRoot()).toLowerCase()) {
	console.error("The dev server edits files directly, so it must not point at Stream Deck's live profiles. Use a copy.");
	process.exit(1);
}

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "com.viksra.movemore.sdPlugin");
const server = await startServer({
	profilesRoot,
	dataDir: path.resolve(values.data ?? path.join(path.dirname(profilesRoot), "movemore-data")),
	editorDir: path.join(pluginDir, "editor"),
	iconDirs: [userPluginsDir(), builtinPluginsDir()],
	port: Number(values.port),
	version: (JSON.parse(readFileSync(path.join(pluginDir, "manifest.json"), "utf8")) as { Version: string }).Version,
	restarts: false,
	log: consoleLog,
	restartSpec: async () => null,
	runTransaction: async (planPath) => {
		const result = await executeTransaction(planPath, windowsProcessControl, consoleLog);
		consoleLog.info(`Transaction ${result.txid}: ${result.status} — ${result.message}`);
	},
	readSelection: selectionFile ? async () => JSON.parse(await readFile(selectionFile, "utf8")) as StreamDeckSelection : readStreamDeckSelection,
});
console.log(`Open ${server.url}`);
