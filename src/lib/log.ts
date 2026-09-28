/**
 * Minimal logging contract shared by the plugin (Stream Deck SDK logger), the dev server (console)
 * and the apply helper (file log). Keeps core modules free of any SDK dependency.
 */
export interface Log {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

export const consoleLog: Log = {
	debug: (...args) => console.debug(...args),
	info: (...args) => console.info(...args),
	warn: (...args) => console.warn(...args),
	error: (...args) => console.error(...args),
};

export const silentLog: Log = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
