// Bundles the plugin for Stream Deck's embedded Node.js 20 runtime.
//   node scripts/build.mjs [--watch] [--production]
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdPlugin = path.join(root, "com.viksra.movemore.sdPlugin");
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {esbuild.BuildOptions} */
const common = {
	absWorkingDir: root,
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

/**
 * The "bundled:" modules (see src/bundled.d.ts): the editor's files, the apply helper's source and
 * the version. Marketplace DRM encrypts the plugin's folder, so the plugin can't read them at runtime.
 * @type {esbuild.Plugin}
 */
const bundled = {
	name: "bundled",
	setup(build) {
		build.onResolve({ filter: /^bundled:/ }, (args) => ({ path: args.path, namespace: "bundled" }));
		build.onLoad({ filter: /.*/, namespace: "bundled" }, async ({ path: id }) => {
			const module = (value, watchFiles, watchDirs = []) => ({ contents: `export default ${JSON.stringify(value)};`, loader: "js", watchFiles, watchDirs });
			if (id === "bundled:version") {
				const manifest = path.join(sdPlugin, "manifest.json");
				return module(JSON.parse(await readFile(manifest, "utf8")).Version, [manifest]);
			}
			if (id === "bundled:editor") {
				const dir = path.join(sdPlugin, "editor");
				const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
				const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(path.join(dir, name), "utf8")])));
				return module(files, names.map((name) => path.join(dir, name)), [dir]);
			}
			if (id === "bundled:apply-helper") {
				const helper = await esbuild.build({ ...common, entryPoints: ["src/apply-helper.ts"], outfile: "apply-helper.mjs", write: false, sourcemap: false, metafile: true, logLevel: "warning" });
				return module(helper.outputFiles[0].text, Object.keys(helper.metafile.inputs).map((file) => path.join(root, file)));
			}
			return undefined;
		});
	},
};

const builds = [
	{ ...common, entryPoints: [path.join(root, "src/plugin.ts")], outfile: path.join(sdPlugin, "bin/plugin.js"), plugins: [bundled] },
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
