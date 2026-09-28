// Pure layout operations used by the editor (and covered by the unit tests).
//
// A layout maps page id -> { "col,row": keyId }. Operations never mutate their input; they return
// { ok: true, layout, ... } or { ok: false, message }.

/** @typedef {Record<string, Record<string, string>>} Layout */
/** @typedef {{ cols: number, rows: number, isLocked: (keyId: string) => boolean }} Grid */
/** @typedef {{ page: string, coord: string }} Position */
/** @typedef {{ ok: false, message: string }} Failure */
/** @typedef {{ keyId: string, from: Position, to: Position }} Displacement */
/** @typedef {{ ok: true, layout: Layout, moved: number, displaced: Displacement[] }} MoveResult */
/** @typedef {{ ok: true, layout: Layout, moved: number, how: "same" | "shifted" | "packed" }} SendResult */

/** @param {string} coord */
export function parseCoord(coord) {
	const [col, row] = coord.split(",").map(Number);
	return { col, row };
}

/** @param {number} col @param {number} row */
export function coordOf(col, row) {
	return `${col},${row}`;
}

/** Reading order: top row first, left to right. @param {string} a @param {string} b */
export function compareCoords(a, b) {
	const ca = parseCoord(a);
	const cb = parseCoord(b);
	return ca.row - cb.row || ca.col - cb.col;
}

/** keyId -> position. @param {Layout} layout @returns {Map<string, Position>} */
export function locate(layout) {
	const where = new Map();
	for (const [page, cells] of Object.entries(layout)) {
		for (const [coord, keyId] of Object.entries(cells)) where.set(keyId, { page, coord });
	}
	return where;
}

/** @param {string} message @returns {Failure} */
function fail(message) {
	return { ok: false, message };
}

/**
 * @param {Layout} layout @param {string} page @param {Iterable<string>} keyIds @param {Grid} grid
 * @returns {{ selected: Map<string, string>, error?: undefined } | { error: string, selected?: undefined }}
 */
function selectedCells(layout, page, keyIds, grid) {
	const cells = layout[page] ?? {};
	const coordById = new Map(Object.entries(cells).map(([coord, id]) => [id, coord]));
	const selected = new Map();
	for (const id of keyIds) {
		const coord = coordById.get(id);
		if (coord === undefined) return { error: "A selected key is no longer on this page." };
		if (grid.isLocked(id)) return { error: "The Parent Folder key can't be moved." };
		selected.set(coord, id);
	}
	if (selected.size === 0) return { error: "Select one or more keys first." };
	return { selected };
}

/**
 * Limits an offset so every selected key stays on the deck.
 * @param {Layout} layout @param {string} page @param {Iterable<string>} keyIds @param {number} dx @param {number} dy @param {Grid} grid
 */
export function clampOffset(layout, page, keyIds, dx, dy, grid) {
	const cells = layout[page] ?? {};
	const ids = new Set(keyIds);
	let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
	for (const [coord, id] of Object.entries(cells)) {
		if (!ids.has(id)) continue;
		const { col, row } = parseCoord(coord);
		minCol = Math.min(minCol, col);
		maxCol = Math.max(maxCol, col);
		minRow = Math.min(minRow, row);
		maxRow = Math.max(maxRow, row);
	}
	if (minCol === Infinity) return { dx: 0, dy: 0 };
	// `|| 0` turns -0 into 0.
	return {
		dx: Math.max(-minCol, Math.min(grid.cols - 1 - maxCol, dx)) || 0,
		dy: Math.max(-minRow, Math.min(grid.rows - 1 - maxRow, dy)) || 0,
	};
}

/**
 * Moves a group of keys by (dx, dy), optionally onto another page, keeping their arrangement.
 *
 * Keys already sitting where the group lands are never lost:
 * - on the same page they slide back into the cells the group vacated (following the move
 *   direction), so dragging a row one step right rotates the key that was in the way to its start;
 * - on another page each one swaps with the key that takes its place.
 *
 * @param {Layout} layout @param {string} fromPage @param {Iterable<string>} keyIds @param {string} toPage
 * @param {number} dx @param {number} dy @param {Grid} grid
 * @returns {MoveResult | Failure}
 */
export function moveGroup(layout, fromPage, keyIds, toPage, dx, dy, grid) {
	const picked = selectedCells(layout, fromPage, keyIds, grid);
	if (picked.error) return fail(picked.error);
	const { selected } = picked;
	const samePage = fromPage === toPage;
	if (samePage && dx === 0 && dy === 0) return { ok: true, layout, moved: 0, displaced: [] };

	const targets = new Map();
	for (const [coord, id] of selected) {
		const { col, row } = parseCoord(coord);
		const col2 = col + dx;
		const row2 = row + dy;
		if (col2 < 0 || row2 < 0 || col2 >= grid.cols || row2 >= grid.rows) return fail("That would push keys off the edge of the deck.");
		targets.set(coordOf(col2, row2), id);
	}

	const destCells = layout[toPage] ?? {};
	const displaced = [];
	for (const target of targets.keys()) {
		if (samePage && selected.has(target)) continue;
		const occupant = destCells[target];
		if (occupant === undefined) continue;
		if (grid.isLocked(occupant)) return fail("The Parent Folder key is in the way.");
		let { col, row } = parseCoord(target);
		let dest;
		if (samePage) {
			// Walk back along the move direction until reaching a cell the group vacated.
			do {
				col -= dx;
				row -= dy;
				dest = coordOf(col, row);
			} while (targets.has(dest));
		} else {
			dest = coordOf(col - dx, row - dy);
		}
		displaced.push({ keyId: occupant, from: { page: toPage, coord: target }, to: { page: fromPage, coord: dest } });
	}

	const next = { ...layout, [fromPage]: { ...(layout[fromPage] ?? {}) } };
	if (!samePage) next[toPage] = { ...destCells };
	const source = next[fromPage];
	const dest = next[toPage];
	for (const coord of selected.keys()) delete source[coord];
	for (const d of displaced) delete dest[d.from.coord];
	for (const [coord, id] of targets) dest[coord] = id;
	for (const d of displaced) source[d.to.coord] = d.keyId;
	return { ok: true, layout: next, moved: selected.size, displaced };
}

/**
 * Sends keys to another page without disturbing the keys already there: same positions when
 * they're free, otherwise the same arrangement shifted as little as possible, otherwise the free
 * cells in reading order.
 *
 * @param {Layout} layout @param {string} fromPage @param {Iterable<string>} keyIds @param {string} toPage @param {Grid} grid
 * @returns {SendResult | Failure}
 */
export function sendToPage(layout, fromPage, keyIds, toPage, grid) {
	if (fromPage === toPage) return fail("Those keys are already on this page.");
	const picked = selectedCells(layout, fromPage, keyIds, grid);
	if (picked.error) return fail(picked.error);
	const keys = [...picked.selected].map(([coord, id]) => ({ id, ...parseCoord(coord), coord })).sort((a, b) => compareCoords(a.coord, b.coord));
	const taken = new Set(Object.keys(layout[toPage] ?? {}));
	const fits = (dx, dy) =>
		keys.every((k) => {
			const col = k.col + dx;
			const row = k.row + dy;
			return col >= 0 && row >= 0 && col < grid.cols && row < grid.rows && !taken.has(coordOf(col, row));
		});

	let placement = null;
	if (fits(0, 0)) {
		placement = { how: "same", dx: 0, dy: 0 };
	} else {
		let best = null;
		for (let dy = -grid.rows; dy <= grid.rows; dy++) {
			for (let dx = -grid.cols; dx <= grid.cols; dx++) {
				if (!fits(dx, dy)) continue;
				const cost = Math.abs(dx) + Math.abs(dy);
				if (!best || cost < best.cost) best = { cost, dx, dy };
			}
		}
		if (best) placement = { how: "shifted", dx: best.dx, dy: best.dy };
	}

	const next = { ...layout, [fromPage]: { ...(layout[fromPage] ?? {}) }, [toPage]: { ...(layout[toPage] ?? {}) } };
	for (const k of keys) delete next[fromPage][k.coord];
	if (placement) {
		for (const k of keys) next[toPage][coordOf(k.col + placement.dx, k.row + placement.dy)] = k.id;
		return { ok: true, layout: next, moved: keys.length, how: placement.how };
	}

	const free = [];
	for (let row = 0; row < grid.rows; row++) {
		for (let col = 0; col < grid.cols; col++) if (!taken.has(coordOf(col, row))) free.push(coordOf(col, row));
	}
	if (free.length < keys.length) {
		return fail(`Not enough room: that page has ${free.length} free key${free.length === 1 ? "" : "s"} and ${keys.length} ${keys.length === 1 ? "is" : "are"} needed.`);
	}
	keys.forEach((k, i) => (next[toPage][free[i]] = k.id));
	return { ok: true, layout: next, moved: keys.length, how: "packed" };
}

/**
 * Keys whose page or position differs between two layouts.
 * @param {Layout} original @param {Layout} current
 * @returns {{ keyId: string, from: Position | undefined, to: Position }[]}
 */
export function diffLayouts(original, current) {
	const before = locate(original);
	const moves = [];
	for (const [keyId, to] of locate(current)) {
		const from = before.get(keyId);
		if (!from || from.page !== to.page || from.coord !== to.coord) moves.push({ keyId, from, to });
	}
	return moves;
}

/**
 * Folder structure implied by a layout: which page each folder key sits on. `pages` lists the
 * numbered pages (kind "page") and every folder page; `folderOf(keyId)` returns the page a key opens.
 *
 * @param {{ id: string, kind: string }[]} pages @param {Layout} layout @param {(keyId: string) => string | null} folderOf
 */
export function folderTree(pages, layout, folderOf) {
	const exists = new Set(pages.map((p) => p.id));
	const topLevel = pages.filter((p) => p.kind === "page").map((p) => p.id);
	/** @type {Map<string, Position & { keyId: string }>} */
	const parentOf = new Map();
	/** @type {Map<string, string[]>} */
	const children = new Map();
	const visit = (pageId) => {
		const cells = layout[pageId] ?? {};
		for (const coord of Object.keys(cells).sort(compareCoords)) {
			const target = folderOf(cells[coord]);
			if (!target || !exists.has(target) || parentOf.has(target) || topLevel.includes(target)) continue;
			parentOf.set(target, { page: pageId, coord, keyId: cells[coord] });
			if (!children.has(pageId)) children.set(pageId, []);
			children.get(pageId).push(target);
			visit(target);
		}
	};
	topLevel.forEach(visit);
	return { topLevel, parentOf, children };
}

/**
 * Chooses how many columns to lay several decks out in so their keys come out as large as possible.
 * A deck is `cols` keys wide with gaps of `ratio` × key between keys and 1.5 gaps of padding on
 * each side; each deck also has a header of `header` px, and decks are `spacing` px apart.
 *
 * With `opts.key` set (zoomed in or out) the key size is fixed and only the number of columns is
 * chosen: as many decks per row as fit the width.
 *
 * @param {number} count number of decks to show
 * @param {{ width: number, height: number }} space available pixels
 * @param {{ cols: number, rows: number }} deck keys per deck
 * @param {{ ratio: number, header: number, spacing: number, min: number, max: number, key?: number | null }} opts
 * @returns {{ columns: number, key: number }} key size in whole pixels, clamped to [min, max]
 */
export function arrangeDecks(count, space, deck, opts) {
	const unitW = deck.cols + (deck.cols + 2) * opts.ratio;
	const unitH = deck.rows + (deck.rows + 2) * opts.ratio;
	if (opts.key) {
		const key = Math.round(opts.key);
		const perRow = Math.floor((space.width + opts.spacing) / (unitW * key + opts.spacing));
		return { columns: Math.max(1, Math.min(count, perRow)), key };
	}
	let best = { columns: 1, key: -Infinity };
	for (let columns = 1; columns <= Math.max(1, count); columns++) {
		const rows = Math.ceil(count / columns);
		const byWidth = (space.width - (columns - 1) * opts.spacing) / (columns * unitW);
		const byHeight = (space.height - (rows - 1) * opts.spacing - rows * opts.header) / (rows * unitH);
		const key = Math.min(byWidth, byHeight);
		// Fewer columns win ties, which keeps a natural reading order.
		if (key > best.key + 0.01) best = { columns, key };
	}
	if (best.key < opts.min) {
		// Too many decks to fit: use the minimum size with as many columns as fit, and scroll vertically.
		const perRow = Math.floor((space.width + opts.spacing) / (unitW * opts.min + opts.spacing));
		return { columns: Math.max(1, Math.min(count, perRow)), key: opts.min };
	}
	return { columns: best.columns, key: Math.floor(Math.min(opts.max, best.key)) };
}

/**
 * Pages of a folder tree, depth first: each page followed by its folders (and theirs). Starts from
 * every numbered page, or from the given pages only.
 * @param {{ topLevel: string[], children: Map<string, string[]> }} tree from folderTree()
 * @param {string[]} [roots]
 * @returns {string[]}
 */
export function treeOrder(tree, roots = tree.topLevel) {
	const out = [];
	const visit = (pageId) => {
		out.push(pageId);
		for (const child of tree.children.get(pageId) ?? []) visit(child);
	};
	roots.forEach(visit);
	return out;
}

/**
 * Returns the id of a folder key that would end up inside its own folder, or null.
 * @param {{ id: string, kind: string }[]} pages @param {Layout} before @param {Layout} after
 * @param {(keyId: string) => string | null} folderOf
 * @returns {string | null}
 */
export function findTrappedFolder(pages, before, after, folderOf) {
	const reachableBefore = folderTree(pages, before, folderOf).parentOf;
	const reachableAfter = folderTree(pages, after, folderOf).parentOf;
	for (const [folderPage, opener] of reachableBefore) {
		if (!reachableAfter.has(folderPage)) return opener.keyId;
	}
	return null;
}
