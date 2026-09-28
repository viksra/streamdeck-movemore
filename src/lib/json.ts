import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha1(data: string | Uint8Array): string {
	return createHash("sha1").update(data).digest("hex");
}

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parses JSON that may have been hand-edited (plugin manifests in the wild contain comments and
 * trailing commas). Profile manifests are always written by Stream Deck and use plain JSON.parse.
 */
export function parseJsonLenient(text: string): unknown {
	const clean = stripBom(text);
	try {
		return JSON.parse(clean);
	} catch {
		return JSON.parse(stripTrailingCommas(stripComments(clean)));
	}
}

export async function readJsonLenient(file: string): Promise<unknown> {
	return parseJsonLenient(await readFile(file, "utf8"));
}

/** Removes // and /* *\/ comments outside of string literals. */
function stripComments(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += text[++i] ?? "";
			} else if (ch === '"') {
				inString = false;
			}
		} else if (ch === '"') {
			inString = true;
			out += ch;
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (ch === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
		} else {
			out += ch;
		}
	}
	return out;
}

/** Removes commas directly before a closing bracket, outside of string literals. */
function stripTrailingCommas(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += text[++i] ?? "";
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") continue;
		}
		out += ch;
	}
	return out;
}
