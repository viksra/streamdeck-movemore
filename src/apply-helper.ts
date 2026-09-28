/**
 * The apply helper. Bundled into the plugin, which writes it to its data folder and starts it as a
 * separate background process:
 *   node apply-helper.mjs <transaction>/plan.json
 * Closes Stream Deck, applies the staged profile changes, starts Stream Deck again.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";

import { executeTransaction, windowsProcessControl } from "./apply/executor.ts";
import type { Log } from "./lib/log.ts";

const planPath = process.argv[2];
if (!planPath) {
	console.error("Usage: apply-helper <plan.json>");
	process.exit(2);
}

const logFile = path.join(path.dirname(planPath), "helper.log");
const write = (level: string, args: unknown[]) => {
	const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ")}\n`;
	try {
		appendFileSync(logFile, line);
	} catch {
		// Nothing sensible to do if the log can't be written.
	}
};
const log: Log = {
	debug: (...args) => write("DEBUG", args),
	info: (...args) => write("INFO ", args),
	warn: (...args) => write("WARN ", args),
	error: (...args) => write("ERROR", args),
};

const result = await executeTransaction(planPath, windowsProcessControl, log);
process.exit(result.status === "ok" ? 0 : 1);
