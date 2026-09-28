import os from "node:os";
import path from "node:path";

/** %APPDATA% (Roaming). */
export function appDataDir(): string {
	return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
}

/** %APPDATA%\Elgato\StreamDeck */
export function streamDeckDataDir(): string {
	return path.join(appDataDir(), "Elgato", "StreamDeck");
}

/** Profiles folder used by Stream Deck 6.8+ / 7.x. */
export function defaultProfilesRoot(): string {
	return path.join(streamDeckDataDir(), "ProfilesV3");
}

/** Third-party plugins installed for the current user. */
export function userPluginsDir(): string {
	return path.join(streamDeckDataDir(), "Plugins");
}

/** Plugins that ship with the Stream Deck app (Open, Website, Create Folder, ...). */
export function builtinPluginsDir(): string {
	return path.join(programFilesDir(), "Elgato", "StreamDeck", "Plugins");
}

export function defaultStreamDeckExe(): string {
	return path.join(programFilesDir(), "Elgato", "StreamDeck", "StreamDeck.exe");
}

/** Where Move More keeps its backups and transaction files (outside Stream Deck's own folders). */
export function defaultDataDir(): string {
	return path.join(appDataDir(), "StreamDeckMoveMore");
}

function programFilesDir(): string {
	return process.env.ProgramFiles ?? "C:\\Program Files";
}
