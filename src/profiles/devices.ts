export interface DeviceSpec {
	name: string;
	cols: number;
	rows: number;
}

export interface DeviceDescriptor extends DeviceSpec {
	model: string;
	uuid: string;
	/** Hardware serial parsed from the device UUID, when present. */
	serial: string | null;
	/** False when the key grid had to be inferred from the profile contents. */
	known: boolean;
}

/** Model numbers as written in profile manifests (`Device.Model`). */
const BY_MODEL: Record<string, DeviceSpec> = {
	"20GAA9901": { name: "Stream Deck", cols: 5, rows: 3 },
	"20GAA9902": { name: "Stream Deck", cols: 5, rows: 3 },
	"20GBA9901": { name: "Stream Deck MK.2", cols: 5, rows: 3 },
	"20GAI9901": { name: "Stream Deck Mini", cols: 3, rows: 2 },
	"20GAI9902": { name: "Stream Deck Mini", cols: 3, rows: 2 },
	"20GAT9901": { name: "Stream Deck XL", cols: 8, rows: 4 },
	"20GAT9902": { name: "Stream Deck XL", cols: 8, rows: 4 },
	"20GBD9901": { name: "Stream Deck +", cols: 4, rows: 2 },
	"20GBJ9901": { name: "Stream Deck Neo", cols: 4, rows: 2 },
};

/** USB product IDs (Elgato vendor 4057 / 0x0FD9), taken from the `@(1)[vid/pid/serial]` device UUID. */
const BY_PID: Record<number, DeviceSpec> = {
	0x0060: { name: "Stream Deck", cols: 5, rows: 3 },
	0x006d: { name: "Stream Deck", cols: 5, rows: 3 },
	0x0080: { name: "Stream Deck MK.2", cols: 5, rows: 3 },
	0x00a5: { name: "Stream Deck MK.2", cols: 5, rows: 3 },
	0x00b9: { name: "Stream Deck MK.2 Module", cols: 5, rows: 3 },
	0x0063: { name: "Stream Deck Mini", cols: 3, rows: 2 },
	0x0090: { name: "Stream Deck Mini", cols: 3, rows: 2 },
	0x00b8: { name: "Stream Deck Mini Module", cols: 3, rows: 2 },
	0x006c: { name: "Stream Deck XL", cols: 8, rows: 4 },
	0x008f: { name: "Stream Deck XL", cols: 8, rows: 4 },
	0x00ba: { name: "Stream Deck XL Module", cols: 8, rows: 4 },
	0x0084: { name: "Stream Deck +", cols: 4, rows: 2 },
	0x009a: { name: "Stream Deck Neo", cols: 4, rows: 2 },
	0x0086: { name: "Stream Deck Pedal", cols: 3, rows: 1 },
	0x00aa: { name: "Stream Deck Studio", cols: 16, rows: 2 },
};

export function parseDeviceUuid(uuid: string): { vid: number; pid: number; serial: string } | null {
	const m = /\[(\d+)\/(\d+)\/([^\]]*)\]/.exec(uuid);
	return m ? { vid: Number(m[1]), pid: Number(m[2]), serial: m[3] } : null;
}

/**
 * Works out the key grid of the device a profile belongs to. Known hardware wins, but the grid is
 * always grown to cover every key that exists in the profile so nothing is ever hidden.
 */
export function describeDevice(model: string, uuid: string, maxCol: number, maxRow: number): DeviceDescriptor {
	const parsed = parseDeviceUuid(uuid);
	const spec = BY_MODEL[model] ?? (parsed && parsed.vid === 4057 ? BY_PID[parsed.pid] : undefined);
	const base = spec ?? { name: "Stream Deck", cols: maxCol >= 0 ? maxCol + 1 : 5, rows: maxRow >= 0 ? maxRow + 1 : 3 };
	return {
		model,
		uuid,
		serial: parsed?.serial || null,
		known: spec !== undefined,
		name: base.name,
		cols: Math.max(base.cols, maxCol + 1),
		rows: Math.max(base.rows, maxRow + 1),
	};
}
