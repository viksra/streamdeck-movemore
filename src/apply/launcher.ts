import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Starts the apply helper as a separate background process — the usual "restart to apply" pattern
 * used by app updaters: the helper closes Stream Deck, writes the staged files, and starts Stream
 * Deck again. Returns the helper's process id.
 */
export function startHelper(nodeExe: string, helperScript: string, planPath: string): number | undefined {
	const child = spawn(nodeExe, [helperScript, planPath], {
		cwd: path.dirname(helperScript),
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	return child.pid;
}
