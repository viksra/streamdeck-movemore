import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeSetting, parseSelection } from "../src/profiles/selection.ts";

const XL = "@(1)[4057/108/XL0000000001]";
const MK2 = "@(1)[4057/128/MK0000000002]";
const HOME = "5b6ffc0b-e432-4efb-a7c8-dd1764c80869";
const GAMES = "f1f24ad2-459c-46e9-861a-2d24c47f0a3e";

/** Writes a value the way QSettings does on Windows: QDataStream (Qt 4.0) bytes as "@Variant(...)" in UTF-16. */
function qsetting(value: unknown): Buffer {
	const u32 = (n: number) => {
		const b = Buffer.alloc(4);
		b.writeUInt32BE(n);
		return b;
	};
	const string = (s: string) => Buffer.concat([u32(s.length * 2), Buffer.from(s, "utf16le").swap16()]);
	const variant = (v: unknown): Buffer => {
		if (typeof v === "boolean") return Buffer.concat([u32(1), Buffer.from([v ? 1 : 0])]);
		if (typeof v === "number") return Buffer.concat([u32(2), u32(v)]);
		if (typeof v === "string") return Buffer.concat([u32(10), string(v)]);
		const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
		return Buffer.concat([u32(8), u32(entries.length), ...entries.flatMap(([k, x]) => [string(k), variant(x)])]);
	};
	return Buffer.from(`@Variant(${variant(value).toString("latin1")})`, "utf16le");
}

function device(name: string, preferred: string) {
	return {
		DeviceName: name,
		ESDProfilesInfo: { ESDProfilesExpanded: "", ESDProfilesPreferred: preferred, ESDProfilesSorting: preferred },
		map_dev_brightness: 100,
		map_dev_enabled: true,
	};
}

describe("Stream Deck's selected profiles", () => {
	it("reads the profile selected on each device, and the device Stream Deck's window shows", () => {
		const raw = qsetting({ [XL]: device("Stream Deck XL", HOME), [MK2]: device("Desk", GAMES), PreferredDevice: MK2 });
		assert.deepEqual(parseSelection(decodeSetting(raw)), {
			shown: MK2,
			devices: [
				{ id: XL, name: "Stream Deck XL", profileId: HOME.toUpperCase() },
				{ id: MK2, name: "Desk", profileId: GAMES.toUpperCase() },
			],
		});
	});

	it("assumes the only device is the one shown", () => {
		assert.equal(parseSelection(decodeSetting(qsetting({ [XL]: device("Stream Deck XL", HOME) }))).shown, XL);
		const two = { [XL]: device("Stream Deck XL", HOME), [MK2]: device("Desk", GAMES), PreferredDevice: "@(1)[4057/99/GONE]" };
		assert.equal(parseSelection(decodeSetting(qsetting(two))).shown, null);
	});

	it("leaves out a selection that isn't a profile id", () => {
		const selection = parseSelection(decodeSetting(qsetting({ [XL]: device("Stream Deck XL", "") })));
		assert.equal(selection.devices[0].profileId, null);
	});

	it("rejects anything else", () => {
		assert.throws(() => decodeSetting(Buffer.from("plain text", "utf16le")), /Not a Qt setting/);
		const truncated = qsetting({ [XL]: device("Stream Deck XL", HOME) });
		assert.throws(() => decodeSetting(Buffer.concat([truncated.subarray(0, 60), Buffer.from(")", "utf16le")])), /Truncated/);
		const color = Buffer.from(`@Variant(${Buffer.from([0, 0, 0, 67, 1, 255, 255]).toString("latin1")})`, "utf16le");
		assert.throws(() => decodeSetting(color), /Unsupported value type 67/);
		assert.throws(() => parseSelection("text"), /unknown format/);
	});
});
