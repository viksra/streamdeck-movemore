import { execFile } from "node:child_process";

import { isUuid } from "./reader.ts";

/**
 * Which profile Stream Deck shows on each device. Stream Deck doesn't write this into the profile
 * files or tell plugins about it; it keeps it in its Qt settings in the registry, value "Devices":
 * per device the profile selected on it ("ESDProfilesInfo" → "ESDProfilesPreferred"), and which
 * device its window shows ("PreferredDevice").
 */
export interface StreamDeckSelection {
	/** The device the Stream Deck window shows, if known. */
	shown: string | null;
	devices: DeviceSelection[];
}

export interface DeviceSelection {
	/** Stream Deck's device id, as in profile manifests (`Device.UUID`): "@(1)[4057/108/CL00A0A00001]". */
	id: string;
	/** The name the device has in Stream Deck. */
	name: string;
	/** Upper-case id of the profile selected on the device. */
	profileId: string | null;
}

const SETTINGS_KEY = "HKCU\\Software\\Elgato Systems GmbH\\StreamDeck";

export function readStreamDeckSelection(): Promise<StreamDeckSelection> {
	return new Promise((resolve, reject) => {
		execFile("reg.exe", ["query", SETTINGS_KEY, "/v", "Devices"], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
			if (err) return reject(new Error(`Stream Deck's device settings can't be read (${err.message.trim()}).`));
			const hex = /^\s*Devices\s+REG_BINARY\s+([0-9A-F]*)\s*$/im.exec(stdout)?.[1];
			if (hex === undefined) return reject(new Error("Stream Deck's device settings have an unknown format."));
			try {
				resolve(parseSelection(decodeSetting(Buffer.from(hex, "hex"))));
			} catch (e) {
				reject(e);
			}
		});
	});
}

export function parseSelection(settings: unknown): StreamDeckSelection {
	if (!isRecord(settings)) throw new Error("Stream Deck's device settings have an unknown format.");
	const devices: DeviceSelection[] = [];
	for (const [id, device] of Object.entries(settings)) {
		if (!isRecord(device)) continue; // "PreferredDevice"
		const preferred = isRecord(device.ESDProfilesInfo) ? device.ESDProfilesInfo.ESDProfilesPreferred : undefined;
		devices.push({ id, name: typeof device.DeviceName === "string" ? device.DeviceName : "", profileId: isUuid(preferred) ? preferred.toUpperCase() : null });
	}
	const preferred = settings.PreferredDevice;
	const shown = typeof preferred === "string" && devices.some((d) => d.id === preferred) ? preferred : devices.length === 1 ? devices[0].id : null;
	return { shown, devices };
}

/**
 * Decodes a value that QSettings stored as REG_BINARY: the UTF-16 text "@Variant(...)", whose
 * characters are the bytes of the value as QDataStream (version Qt 4.0, big-endian) writes it.
 */
export function decodeSetting(raw: Buffer): unknown {
	const text = raw.toString("utf16le").replace(/\0+$/, "");
	if (!text.startsWith("@Variant(") || !text.endsWith(")")) throw new Error("Not a Qt setting.");
	const inner = text.slice("@Variant(".length, -1);
	const bytes = Buffer.alloc(inner.length);
	for (let i = 0; i < inner.length; i++) {
		const unit = inner.charCodeAt(i);
		if (unit > 0xff) throw new Error("Not a Qt setting.");
		bytes[i] = unit;
	}
	return readVariant(bytes);
}

function readVariant(bytes: Buffer): unknown {
	let pos = 0;
	const take = (n: number) => {
		if (pos + n > bytes.length) throw new Error("Truncated Qt setting.");
		pos += n;
		return pos - n;
	};
	const u32 = () => bytes.readUInt32BE(take(4));
	const string = (): string | null => {
		const length = u32();
		if (length === 0xffffffff) return null;
		if (length % 2) throw new Error("Malformed Qt setting.");
		const at = take(length);
		return Buffer.from(bytes.subarray(at, at + length)).swap16().toString("utf16le");
	};
	const variant = (): unknown => {
		const type = u32();
		switch (type) {
			case 1: // bool
				return bytes[take(1)] !== 0;
			case 2: // int
				return bytes.readInt32BE(take(4));
			case 3: // uint
				return u32();
			case 4: // qlonglong
				return Number(bytes.readBigInt64BE(take(8)));
			case 5: // qulonglong
				return Number(bytes.readBigUInt64BE(take(8)));
			case 6: // double
				return bytes.readDoubleBE(take(8));
			case 8: // QVariantMap
			case 28: { // QVariantHash
				const map: Record<string, unknown> = {};
				for (let n = u32(); n > 0; n--) {
					const key = string() ?? "";
					map[key] = variant();
				}
				return map;
			}
			case 9: { // QVariantList
				const list: unknown[] = [];
				for (let n = u32(); n > 0; n--) list.push(variant());
				return list;
			}
			case 10: // QString
				return string();
			case 11: { // QStringList
				const list: (string | null)[] = [];
				for (let n = u32(); n > 0; n--) list.push(string());
				return list;
			}
			case 12: { // QByteArray
				const length = u32();
				if (length === 0xffffffff) return null;
				const at = take(length);
				return bytes.subarray(at, at + length);
			}
			default:
				throw new Error(`Unsupported value type ${type} in a Qt setting.`);
		}
	};
	return variant();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}
