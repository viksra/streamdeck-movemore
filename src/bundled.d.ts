// Modules scripts/build.mjs generates while bundling bin/plugin.js. Under Marketplace DRM the
// plugin's own files are encrypted, so everything it needs at runtime is compiled into it.

/** The browser editor's files (index.html, app.js, ...) by name. */
declare module "bundled:editor" {
	const files: Readonly<Record<string, string>>;
	export default files;
}

/** Source of the apply helper, which the plugin writes out and runs as a separate process. */
declare module "bundled:apply-helper" {
	const source: string;
	export default source;
}

/** The plugin's version, from its manifest. */
declare module "bundled:version" {
	const version: string;
	export default version;
}
