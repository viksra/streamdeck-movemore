/**
 * Stream Deck entry point (bin/plugin.js). Runs a small web server for the layout editor and
 * provides the "Layout Editor" key, which opens it in the default browser.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import streamDeck, { type KeyDownEvent, type SendToPluginEvent, SingletonAction } from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import helperSource from "bundled:apply-helper";
import editorFiles from "bundled:editor";
import version from "bundled:version";

import { startHelper } from "./apply/launcher.ts";
import { pruneData } from "./apply/transaction.ts";
import { errorMessage } from "./lib/log.ts";
import { builtinPluginsDir, defaultDataDir, defaultProfilesRoot, defaultStreamDeckExe, userPluginsDir } from "./lib/paths.ts";
import { readStreamDeckSelection } from "./profiles/selection.ts";
import { startServer } from "./server/http.ts";

const ACTION_UUID = "com.viksra.movemore.editor";
const PREFERRED_PORT = 38457;

const dataDir = defaultDataDir();
streamDeck.logger.setLevel("info");
const log = streamDeck.logger.createScope("Move More");

const server = await startServer({
	profilesRoot: defaultProfilesRoot(),
	dataDir,
	editor: editorFiles,
	iconDirs: [userPluginsDir(), builtinPluginsDir()],
	port: PREFERRED_PORT,
	version,
	restarts: true,
	log,
	restartSpec: async () => ({
		processName: "StreamDeck.exe",
		exePath: await findStreamDeckExe(),
		args: [],
		killPids: [process.pid],
		// Enough for the editor to receive its HTTP response before the plugin goes away.
		delayMs: 400,
		// Stream Deck only minimizes to the tray when asked to close, so don't wait for that.
		closeTimeoutMs: 0,
	}),
	runTransaction: async (planPath) => {
		// Written out first: under Marketplace DRM the plugin's own files can't be run by another process.
		const helper = path.join(dataDir, "helper", "apply-helper.mjs");
		await mkdir(path.dirname(helper), { recursive: true });
		await writeFile(helper, helperSource);
		const pid = startHelper(process.execPath, helper, planPath);
		log.info(`Apply helper started (pid ${pid}) for ${planPath}`);
	},
	readSelection: readStreamDeckSelection,
});

pruneData(dataDir).catch((err) => log.warn(`Could not prune old backups: ${errorMessage(err)}`));

/** Opens the editor; given the name of a device, on the profile that device shows. */
async function openEditor(deck?: string): Promise<void> {
	await streamDeck.system.openUrl(deck ? `${server.url}?deck=${encodeURIComponent(deck)}` : server.url);
}

class OpenEditorAction extends SingletonAction {
	override readonly manifestId = ACTION_UUID;

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		try {
			await openEditor(ev.action.device.name);
		} catch (err) {
			log.error(`Could not open the editor: ${errorMessage(err)}`);
			return ev.action.showAlert();
		}
		await ev.action.showOk();
	}

	override async onPropertyInspectorDidAppear(): Promise<void> {
		await streamDeck.ui.sendToPropertyInspector({ event: "info", url: server.url });
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
		const payload = ev.payload as { event?: string } | null;
		if (payload?.event === "open-editor") await openEditor(ev.action.device.name);
		await streamDeck.ui.sendToPropertyInspector({ event: "info", url: server.url });
	}
}

streamDeck.actions.registerAction(new OpenEditorAction());

// streamdeck://plugins/message/com.viksra.movemore/open opens the editor without a key.
streamDeck.system.onDidReceiveDeepLink(() => {
	openEditor().catch((err) => log.error(`Could not open the editor: ${errorMessage(err)}`));
});

await streamDeck.connect();

// The SDK does not exit when Stream Deck goes away; make sure we do, so the port is released.
const parentPid = process.ppid;
setInterval(() => {
	try {
		process.kill(parentPid, 0);
	} catch {
		log.info("Stream Deck has exited; stopping.");
		server.close().finally(() => process.exit(0));
	}
}, 2000).unref();

async function findStreamDeckExe(): Promise<string> {
	const standard = defaultStreamDeckExe();
	if (existsSync(standard)) return standard;
	// Custom install location: ask Windows where our parent process (Stream Deck) runs from.
	const found = await new Promise<string>((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${parentPid}).Path`],
			{ windowsHide: true, timeout: 15000 },
			(err, stdout) => resolve(err ? "" : stdout.trim()),
		);
	});
	if (found && existsSync(found)) return found;
	throw new Error("Could not find StreamDeck.exe, so Stream Deck can't be restarted automatically.");
}
