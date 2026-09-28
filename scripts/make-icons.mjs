// Renders the PNG plugin icon (Stream Deck requires PNG for it) from assets/marketplace.svg.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = await readFile(path.join(root, "assets/marketplace.svg"));
const out = path.join(root, "com.viksra.movemore.sdPlugin/imgs/plugin");

for (const [size, name] of [
	[256, "marketplace.png"],
	[512, "marketplace@2x.png"],
]) {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
	await writeFile(path.join(out, name), png);
	console.log(`wrote ${name} (${size}x${size})`);
}
