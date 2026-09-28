import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	arrangeDecks,
	clampOffset,
	diffLayouts,
	findTrappedFolder,
	folderTree,
	moveGroup,
	sendToPage,
	treeOrder,
} from "../com.viksra.movemore.sdPlugin/editor/layout-ops.js";

type Layout = Record<string, Record<string, string>>;
const grid = (cols = 5, rows = 3, locked: string[] = []) => ({ cols, rows, isLocked: (id: string) => locked.includes(id) });

/** Builds a page from rows of single-character key ids ("." = empty). */
function page(...rows: string[]): Record<string, string> {
	const cells: Record<string, string> = {};
	rows.forEach((line, row) => [...line].forEach((ch, col) => ch !== "." && (cells[`${col},${row}`] = ch)));
	return cells;
}

/** Renders a page back to rows for readable assertions. */
function draw(cells: Record<string, string>, cols = 5, rows = 3): string[] {
	return Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => cells[`${col},${row}`] ?? ".").join(""));
}

describe("moveGroup on one page", () => {
	it("moves a selection into empty space", () => {
		const layout: Layout = { P: page("AB...", "C....", ".....") };
		const r = moveGroup(layout, "P", ["A", "B", "C"], "P", 2, 1, grid());
		assert.ok(r.ok);
		assert.deepEqual(draw(r.layout.P), [".....", "..AB.", "..C.."]);
		assert.deepEqual(r.displaced, []);
		assert.deepEqual(draw(layout.P), ["AB...", "C....", "....."], "input is not mutated");
	});

	it("rotates the key in the way to where the row started", () => {
		const r = moveGroup({ P: page("ABCD.") }, "P", ["A", "B", "C"], "P", 1, 0, grid(5, 1));
		assert.ok(r.ok);
		assert.deepEqual(draw(r.layout.P, 5, 1), ["DABC."]);
		assert.deepEqual(r.displaced, [{ keyId: "D", from: { page: "P", coord: "3,0" }, to: { page: "P", coord: "0,0" } }]);
	});

	it("swaps two blocks that don't overlap", () => {
		const r = moveGroup({ P: page("AB.XY", "CD.ZW") }, "P", ["A", "B", "C", "D"], "P", 3, 0, grid());
		assert.ok(r.ok);
		assert.deepEqual(draw(r.layout.P), ["XY.AB", "ZW.CD", "....."]);
	});

	it("handles a selection with gaps", () => {
		const r = moveGroup({ P: page("A.B..", "XYZ..") }, "P", ["A", "B"], "P", 0, 1, grid());
		assert.ok(r.ok);
		assert.deepEqual(draw(r.layout.P), ["X.Z..", "AYB..", "....."]);
	});

	it("moves diagonally through its own cells", () => {
		// E and F are in the way; each walks back against the move until it reaches a vacated cell.
		const r = moveGroup({ P: page("AB...", "CDE..", "..F..") }, "P", ["A", "B", "C", "D"], "P", 1, 1, grid());
		assert.ok(r.ok);
		assert.deepEqual(draw(r.layout.P), ["FE...", ".AB..", ".CD.."]);
	});

	it("refuses to push keys off the deck", () => {
		const r = moveGroup({ P: page("....A") }, "P", ["A"], "P", 1, 0, grid());
		assert.equal(r.ok, false);
	});

	it("never moves or displaces a locked key", () => {
		const g = grid(5, 3, ["L"]);
		assert.equal(moveGroup({ P: page("LA...") }, "P", ["L"], "P", 2, 0, g).ok, false);
		assert.equal(moveGroup({ P: page("LA...") }, "P", ["A"], "P", -1, 0, g).ok, false);
	});

	it("is a no-op for a zero offset", () => {
		const layout: Layout = { P: page("A....") };
		const r = moveGroup(layout, "P", ["A"], "P", 0, 0, grid());
		assert.ok(r.ok);
		assert.equal(r.layout, layout);
	});
});

describe("moveGroup across pages", () => {
	it("swaps keys in the way back to the source page", () => {
		const r = moveGroup({ P: page("AB...", "....."), Q: page(".X...", "..Y..") }, "P", ["A", "B"], "Q", 1, 1, grid());
		assert.ok(r.ok);
		assert.deepEqual(draw(r.layout.P), [".Y...", ".....", "....."]);
		assert.deepEqual(draw(r.layout.Q), [".X...", ".AB..", "....."]);
	});
});

describe("clampOffset", () => {
	it("keeps the whole selection on the deck", () => {
		const layout: Layout = { P: page(".AB..", "..C..") };
		assert.deepEqual(clampOffset(layout, "P", ["A", "B", "C"], 10, -3, grid()), { dx: 2, dy: 0 });
		assert.deepEqual(clampOffset(layout, "P", ["A", "B", "C"], -5, 5, grid()), { dx: -1, dy: 1 });
	});
});

describe("sendToPage", () => {
	const g = grid();
	it("keeps positions when they are free on the other page", () => {
		const r = sendToPage({ P: page("AB...", "C...."), Q: page("....X") }, "P", ["A", "B", "C"], "Q", g);
		assert.ok(r.ok);
		assert.equal(r.how, "same");
		assert.deepEqual(draw(r.layout.Q), ["AB..X", "C....", "....."]);
		assert.deepEqual(draw(r.layout.P), [".....", ".....", "....."]);
	});

	it("shifts the arrangement as little as possible when positions are taken", () => {
		const r = sendToPage({ P: page("AB...", "C...."), Q: page("X....") }, "P", ["A", "B", "C"], "Q", g);
		assert.ok(r.ok);
		assert.equal(r.how, "shifted");
		assert.deepEqual(draw(r.layout.Q), ["XAB..", ".C...", "....."]);
	});

	it("packs into free cells when the arrangement does not fit anywhere", () => {
		const r = sendToPage({ P: page("AB...", "CD..."), Q: page("X.X.X", ".X.X.", "X.X.X") }, "P", ["A", "B", "C", "D"], "Q", g);
		assert.ok(r.ok);
		assert.equal(r.how, "packed");
		assert.deepEqual(draw(r.layout.Q), ["XAXBX", "CXDX.", "X.X.X"]);
	});

	it("reports when the page is too full", () => {
		const r = sendToPage({ P: page("AB..."), Q: page("XXXXX", "XXXXX", "XXXX.") }, "P", ["A", "B"], "Q", g);
		assert.ok(!r.ok);
		assert.match(r.message, /1 free key and 2 are needed/);
	});
});

describe("diffLayouts", () => {
	it("lists exactly the keys that changed page or position", () => {
		const before: Layout = { P: page("AB."), Q: page("C..") };
		const after: Layout = { P: page(".BA"), Q: page("..C") };
		assert.deepEqual(diffLayouts(before, after), [
			{ keyId: "A", from: { page: "P", coord: "0,0" }, to: { page: "P", coord: "2,0" } },
			{ keyId: "C", from: { page: "Q", coord: "0,0" }, to: { page: "Q", coord: "2,0" } },
		]);
	});
});

describe("folders", () => {
	const pages = [
		{ id: "P", kind: "page" },
		{ id: "F", kind: "folder" },
		{ id: "G", kind: "folder" },
	];
	const folderOf = (id: string) => ({ f: "F", g: "G" })[id] ?? null;

	it("derives the folder tree from where folder keys sit", () => {
		const tree = folderTree(pages, { P: page("f.."), F: page("Lg."), G: page("L..") }, folderOf);
		assert.deepEqual(tree.topLevel, ["P"]);
		assert.deepEqual([...tree.parentOf], [
			["F", { page: "P", coord: "0,0", keyId: "f" }],
			["G", { page: "F", coord: "1,0", keyId: "g" }],
		]);
	});

	it("detects a folder key moved into its own subtree", () => {
		const before: Layout = { P: page("f.."), F: page("Lg."), G: page("L..") };
		assert.equal(findTrappedFolder(pages, before, { P: page("..."), F: page("Lg."), G: page("Lf.") }, folderOf), "f");
		assert.equal(findTrappedFolder(pages, before, { P: page("fg."), F: page("L.."), G: page("L..") }, folderOf), null);
	});
});

describe("arrangeDecks", () => {
	const xl = { cols: 8, rows: 4 };
	const opts = { ratio: 0.14, header: 34, spacing: 22, min: 30, max: 116 };

	it("fills the space with a single deck, up to the maximum key size", () => {
		assert.deepEqual(arrangeDecks(1, { width: 1100, height: 780 }, xl, { ...opts, header: 0 }), { columns: 1, key: 116 });
		assert.deepEqual(arrangeDecks(1, { width: 600, height: 780 }, xl, { ...opts, header: 0 }), { columns: 1, key: 63 });
	});

	it("stacks wide decks when that keeps keys larger", () => {
		// Two XL pages in a 1100×780 stage: one above the other beats side by side.
		assert.deepEqual(arrangeDecks(2, { width: 1100, height: 780 }, xl, opts), { columns: 1, key: 71 });
	});

	it("uses columns when there is width to spare", () => {
		assert.deepEqual(arrangeDecks(2, { width: 2400, height: 700 }, xl, opts), { columns: 2, key: 116 });
		const five = arrangeDecks(5, { width: 1100, height: 780 }, xl, opts);
		assert.equal(five.columns, 2);
		assert.ok(five.key >= 40 && five.key <= 45, `key ${five.key}`);
	});

	it("never goes below the minimum key size and then fills the width, scrolling vertically", () => {
		// 23 decks: at 30 px an XL deck is 282 px wide, so two fit side by side in 800 px.
		assert.deepEqual(arrangeDecks(23, { width: 800, height: 500 }, xl, opts), { columns: 2, key: 30 });
		assert.deepEqual(arrangeDecks(23, { width: 1570, height: 900 }, xl, opts), { columns: 5, key: 30 });
		assert.deepEqual(arrangeDecks(3, { width: 200, height: 100 }, xl, opts), { columns: 1, key: 30 });
	});

	it("keeps a zoomed key size and fits as many decks per row as the width allows", () => {
		assert.deepEqual(arrangeDecks(23, { width: 1100, height: 780 }, xl, { ...opts, key: 60 }), { columns: 1, key: 60 });
		assert.deepEqual(arrangeDecks(23, { width: 1100, height: 780 }, xl, { ...opts, key: 36 }), { columns: 3, key: 36 });
		assert.deepEqual(arrangeDecks(2, { width: 3000, height: 780 }, xl, { ...opts, key: 36 }), { columns: 2, key: 36 });
	});
});

describe("treeOrder", () => {
	it("lists each page followed by its folders, depth first", () => {
		const pages = [
			{ id: "P", kind: "page" },
			{ id: "Q", kind: "page" },
			{ id: "F", kind: "folder" },
			{ id: "G", kind: "folder" },
			{ id: "H", kind: "folder" },
		];
		const folderOf = (id: string) => ({ f: "F", g: "G", h: "H" })[id] ?? null;
		const tree = folderTree(pages, { P: page("f.h"), Q: page("..."), F: page("Lg."), G: page("L.."), H: page("L..") }, folderOf);
		assert.deepEqual(treeOrder(tree), ["P", "F", "G", "H", "Q"]);
		assert.deepEqual(treeOrder(tree, ["P"]), ["P", "F", "G", "H"], "one page and its folders");
		assert.deepEqual(treeOrder(tree, ["F"]), ["F", "G"]);
	});
});

describe("moveGroup invariants (randomized)", () => {
	it("never loses, duplicates or misplaces keys", () => {
		let seed = 12345;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed % n;
		};
		for (let round = 0; round < 3000; round++) {
			const cols = 2 + rand(7);
			const rows = 1 + rand(4);
			const layout: Layout = { P: {}, Q: {} };
			const locked: string[] = [];
			let n = 0;
			for (const p of ["P", "Q"]) {
				for (let row = 0; row < rows; row++) {
					for (let col = 0; col < cols; col++) {
						if (rand(3) === 0) continue;
						const id = `${p}${n++}`;
						layout[p][`${col},${row}`] = id;
						if (rand(15) === 0) locked.push(id);
					}
				}
			}
			const g = { cols, rows, isLocked: (id: string) => locked.includes(id) };
			const movable = Object.values(layout.P).filter((id) => !locked.includes(id));
			const selection = movable.filter(() => rand(2) === 0);
			if (selection.length === 0) continue;
			const toPage = rand(3) === 0 ? "Q" : "P";
			const r = moveGroup(layout, "P", selection, toPage, rand(2 * cols) - cols, rand(2 * rows) - rows, g);
			if (!r.ok) continue;

			const all = (l: Layout) => Object.values(l).flatMap((cells) => Object.values(cells)).sort();
			assert.deepEqual(all(r.layout), all(layout), "same keys before and after");
			for (const cells of Object.values(r.layout)) {
				for (const coord of Object.keys(cells)) {
					const [col, row] = coord.split(",").map(Number);
					assert.ok(col >= 0 && row >= 0 && col < cols && row < rows, `in bounds: ${coord}`);
				}
			}
			for (const id of locked) {
				const where = (l: Layout) => Object.entries(l).flatMap(([p, cells]) => Object.entries(cells).filter(([, k]) => k === id).map(([c]) => `${p}:${c}`));
				assert.deepEqual(where(r.layout), where(layout), `locked key ${id} stays put`);
			}
		}
	});
});
