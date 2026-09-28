// Bundles the plugin for Stream Deck's embedded Node.js 20 runtime.
//   node scripts/build.mjs [--watch] [--production]
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdPlugin = path.join(root, "com.viksra.movemore.sdPlugin");
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {esbuild.BuildOptions} */
const common = {
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	sourcemap: production ? false : "linked",
	logLevel: "info",
	// `ws` (used by the SDK) is CommonJS and calls require(); give ESM output a real require.
	banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
	// Optional native speed-ups of `ws`; it falls back to JavaScript when they are missing.
	external: ["bufferutil", "utf-8-validate"],
};

const builds = [
	{ ...common, entryPoints: [path.join(root, "src/plugin.ts")], outfile: path.join(sdPlugin, "bin/plugin.js") },
	{ ...common, entryPoints: [path.join(root, "src/apply-helper.ts")], outfile: path.join(sdPlugin, "bin/apply-helper.js") },
	{ ...common, entryPoints: [path.join(root, "src/dev-server.ts")], outfile: path.join(root, "dist/dev-server.js") },
];

// Start from an empty bin/ so a production build never ships stale source maps.
await rm(path.join(sdPlugin, "bin"), { recursive: true, force: true });
// Node decides between CommonJS and ESM from the nearest package.json.
await mkdir(path.join(sdPlugin, "bin"), { recursive: true });
await writeFile(path.join(sdPlugin, "bin/package.json"), '{ "type": "module" }\n');

if (watch) {
	for (const options of builds) await (await esbuild.context(options)).watch();
	console.log("Watching for changes...");
} else {
	await Promise.all(builds.map((options) => esbuild.build(options)));
}
