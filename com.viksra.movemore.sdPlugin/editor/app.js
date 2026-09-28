import * as ops from "./layout-ops.js";

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const el = {
	profiles: $("profiles"),
	search: $("search"),
	searchCount: $("search-count"),
	searchPrev: $("search-prev"),
	searchNext: $("search-next"),
	crumbs: $("crumbs"),
	view: $("view"),
	pending: $("pending"),
	undo: $("btn-undo"),
	redo: $("btn-redo"),
	discard: $("btn-discard"),
	apply: $("btn-apply"),
	banner: $("banner"),
	stage: $("stage"),
	panes: $("panes"),
	marquee: $("marquee"),
	empty: $("empty"),
	selinfo: $("selinfo"),
	moveTo: $("btn-moveto"),
	cut: $("btn-cut"),
	paste: $("btn-paste"),
	selectAll: $("btn-selall"),
	zoomOut: $("zoom-out"),
	zoomFit: $("zoom-fit"),
	zoomIn: $("zoom-in"),
	backups: $("btn-backups"),
	help: $("btn-help"),
	mode: $("mode"),
	dragBadge: $("drag-badge"),
	peek: $("peek"),
	menu: $("menu"),
	toasts: $("toasts"),
	dialog: $("dialog"),
	overlay: $("overlay"),
	overlayTitle: $("overlay-title"),
	overlayText: $("overlay-text"),
};

/** Tiny element builder; text is always inserted as text, never as HTML. */
function h(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (name === "class") node.className = value;
		else if (name === "dataset") Object.assign(node.dataset, value);
		else if (name === "style") for (const [prop, v] of Object.entries(value)) node.style.setProperty(prop, v);
		else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
		else node.setAttribute(name, value === true ? "" : value);
	}
	for (const child of children.flat(Infinity)) {
		if (child === undefined || child === null || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

const ICONS = {
	page: '<svg viewBox="0 0 20 20"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/></svg>',
	folder: '<svg viewBox="0 0 20 20"><path d="M2.5 6.5a2 2 0 0 1 2-2h3.3l1.8 2h5.9a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/></svg>',
	lock: '<svg viewBox="0 0 20 20"><rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>',
	profile: '<svg viewBox="0 0 20 20"><path d="m10 3 7 3.5-7 3.5-7-3.5z"/><path d="m3 10 7 3.5 7-3.5"/><path d="m3 13.5 7 3.5 7-3.5"/></svg>',
	plus: '<svg viewBox="0 0 20 20"><path d="M10 4.5v11M4.5 10h11"/></svg>',
	close: '<svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/></svg>',
	more: '<svg viewBox="0 0 20 20"><circle cx="5" cy="10" r=".6"/><circle cx="10" cy="10" r=".6"/><circle cx="15" cy="10" r=".6"/></svg>',
	up: '<svg viewBox="0 0 20 20"><path d="m5.5 12.5 4.5-4.5 4.5 4.5"/></svg>',
	down: '<svg viewBox="0 0 20 20"><path d="m5.5 7.5 4.5 4.5 4.5-4.5"/></svg>',
	trash: '<svg viewBox="0 0 20 20"><path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6"/></svg>',
};

function icon(name) {
	const template = document.createElement("template");
	template.innerHTML = ICONS[name];
	const svg = template.content.firstElementChild;
	svg.setAttribute("aria-hidden", "true");
	return svg;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const oneLine = (text) => (text || "").replace(/\s+/g, " ").trim();
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const where = (coord) => {
	const { col, row } = ops.parseCoord(coord);
	return `row ${row + 1}, column ${col + 1}`;
};

function storage(key, value) {
	try {
		if (value === undefined) return localStorage.getItem(key);
		localStorage.setItem(key, value);
	} catch {
		// Storage can be unavailable (private windows); it only remembers view preferences.
	}
	return null;
}

// ---------------------------------------------------------------------------------------------
// Server API
// ---------------------------------------------------------------------------------------------

async function request(method, url, body) {
	const headers = { "X-Move-More": "1" };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status, code: data.code });
	return data;
}

const api = {
	get: (url) => request("GET", url),
	post: (url, body = {}) => request("POST", url, body),
};

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

const S = {
	server: null,
	profiles: [],
	profile: null,
	/** keyId -> key info from the server */
	keys: new Map(),
	/** Layouts map page id -> { "col,row": keyId }. */
	original: {},
	layout: {},
	/** Numbered pages in their pending order, and as loaded. */
	pageOrder: [],
	originalOrder: [],
	/** Pages added in the editor that don't exist on disk yet. */
	newPages: new Set(),
	undo: [],
	redo: [],
	/** Pages shown side by side, in order. Always contains the active page. */
	panes: [],
	/** The active page: selection, cursor and keyboard commands apply to it. */
	pageId: null,
	selection: new Set(),
	anchor: null,
	/** Empty or occupied slot last clicked on the active page; Ctrl+V pastes there. */
	cursor: null,
	/** Keys cut with Ctrl+X: { page, keyIds } */
	clipboard: null,
	drag: null,
	/** Live result of a drag: { layout?, moving, displaced?, toPage?, into?, intoKey?, invalid? } */
	preview: null,
	/** Sidebar page the pointer is over while dragging keys. */
	dropTarget: null,
	/** Sidebar page being dragged to a new position. */
	pageDrag: null,
	search: { query: "", terms: [], matches: [], index: -1 },
	/** Fixed key size in px when zoomed; null fits the window. */
	zoom: null,
	metrics: { key: 88, gap: 12, fitKey: 88 },
	busy: false,
	/** The profile changed on disk while moves were pending; they can't be applied. */
	stale: false,
	/** What Stream Deck showed when last asked: { shown: device id, devices: [{ id, name, profileId }] }, or null. */
	streamDeck: null,
};

/** Deck proportions: gap between keys as a fraction of the key size. */
const GAP_RATIO = 0.14;
/** Height of a pane header plus the space below it, in px. */
const PANE_HEADER = 34;
/** Space between panes, in px (matches .panes gap in the CSS). */
const PANE_SPACING = 22;
const ZOOM_MIN = 24;
const ZOOM_MAX = 160;
/** How long to hold dragged keys over a folder key before they'd drop into the folder. */
const FOLDER_DWELL_MS = 550;

const keyEls = new Map();
/** pageId -> { root, head, label, kindIcon, dot, count, grid, cells } */
const paneEls = new Map();
let paneShape = "";
let lastArrangement = "";
/** Lower-cased text each key is searched by (title, action, plugin, URL, ...). */
let searchText = new Map();

const gridSpec = () => ({ cols: S.profile.device.cols, rows: S.profile.device.rows, isLocked: (id) => !!S.keys.get(id)?.locked });
const folderOf = (keyId) => S.keys.get(keyId)?.folder ?? null;
/** The numbered pages in their pending order, then every folder page. */
const pagesList = () => [...S.pageOrder.map((id) => ({ id, kind: "page" })), ...S.profile.pages.filter((p) => p.kind === "folder")];
const tree = () => ops.folderTree(pagesList(), S.layout, folderOf);
const keyMoves = () => (S.profile ? ops.diffLayouts(S.original, S.layout) : []);

/** What changed about the numbered pages themselves. */
function pageChanges() {
	const created = S.pageOrder.filter((id) => S.newPages.has(id));
	const deleted = S.originalOrder.filter((id) => !S.pageOrder.includes(id));
	const kept = S.originalOrder.filter((id) => S.pageOrder.includes(id));
	const keptNow = S.pageOrder.filter((id) => !S.newPages.has(id));
	const reordered = kept.some((id, i) => keptNow[i] !== id);
	const renumbered = S.pageOrder.length !== S.originalOrder.length || S.pageOrder.some((id, i) => id !== S.originalOrder[i]);
	return { created, deleted, reordered, changed: created.length > 0 || deleted.length > 0 || renumbered };
}

const isDirty = () => keyMoves().length > 0 || pageChanges().changed;

function coordOfKey(keyId, pageId = S.pageId) {
	for (const [coord, id] of Object.entries(S.layout[pageId] ?? {})) if (id === keyId) return coord;
	return null;
}

function keyTitle(keyId) {
	const key = S.keys.get(keyId);
	return oneLine(key?.title) || key?.name || "key";
}

function pageKind(pageId) {
	if (S.pageOrder.includes(pageId)) return "page";
	return S.profile.pages.find((p) => p.id === pageId)?.kind ?? null;
}

function isReachable(pageId, t = tree()) {
	return t.topLevel.includes(pageId) || t.parentOf.has(pageId);
}

/** Short page label for the sidebar: "Page 2" or the folder key's title. */
function pageLabel(pageId, t = tree()) {
	const kind = pageKind(pageId);
	if (kind === "page") return `Page ${S.pageOrder.indexOf(pageId) + 1}`;
	if (kind !== "folder") return "Page";
	const opener = t.parentOf.get(pageId);
	return (opener && oneLine(S.keys.get(opener.keyId)?.title)) || "Folder";
}

/** Label for sentences: "Page 2" or "folder “Tools”". */
function pageName(pageId, t = tree()) {
	return pageKind(pageId) === "folder" ? `folder “${pageLabel(pageId, t)}”` : pageLabel(pageId, t);
}

function pagePath(pageId, t = tree()) {
	const path = [pageId];
	let current = pageId;
	while (t.parentOf.has(current)) {
		current = t.parentOf.get(current).page;
		path.unshift(current);
	}
	return path;
}

/** The page a "Go to Page" / "Switch Profile to this profile" number pointed at when loaded. */
const pageAtNumber = (number) => S.originalOrder[number - 1] ?? null;
const opensThisProfile = (key) => key.switchTo && key.switchTo.profileId === S.profile.id.toLowerCase() && key.switchTo.page;

/** Keys (here and in other profiles) that open a numbered page by its number. */
function linksTo(pageId) {
	let count = S.profile.inboundLinks?.[pageId] ?? 0;
	for (const key of S.keys.values()) {
		if (key.goto && pageAtNumber(key.goto) === pageId) count++;
		if (opensThisProfile(key) && pageAtNumber(key.switchTo.page) === pageId) count++;
	}
	return count;
}

/** How many page-number links the pending page order changes. */
function linksRenumbered() {
	let count = 0;
	const moved = (id, number) => id && S.pageOrder.indexOf(id) + 1 !== number;
	for (const key of S.keys.values()) {
		if (key.goto && moved(pageAtNumber(key.goto), key.goto)) count++;
		if (opensThisProfile(key) && moved(pageAtNumber(key.switchTo.page), key.switchTo.page)) count++;
	}
	for (const [pageId, n] of Object.entries(S.profile.inboundLinks ?? {})) {
		if (moved(pageId, S.originalOrder.indexOf(pageId) + 1)) count += n;
	}
	return count;
}

// ---------------------------------------------------------------------------------------------
// Pages shown side by side
// ---------------------------------------------------------------------------------------------

/** Makes an open page the active one. Selection and cursor belong to a single page. */
function activate(pageId) {
	if (pageId === S.pageId) return;
	S.pageId = pageId;
	S.selection = new Set();
	S.anchor = null;
	S.cursor = null;
	savePanes();
}

/** Shows a page: focuses it if it's already open, otherwise shows it in place of the active page. */
function showPage(pageId) {
	if (!pageId) return;
	closeMenu();
	if (!S.panes.includes(pageId)) {
		S.panes = S.panes.includes(S.pageId) ? S.panes.map((p) => (p === S.pageId ? pageId : p)) : [...S.panes, pageId];
		savePanes();
	}
	activate(pageId);
	render(false);
	scrollPaneIntoView(pageId);
}

/** Opens a page next to the ones already shown. */
function openPane(pageId, { focus = true } = {}) {
	if (!pageId) return;
	closeMenu();
	if (!S.panes.includes(pageId)) {
		S.panes = [...S.panes, pageId];
		savePanes();
	}
	if (focus) activate(pageId);
	render(false);
	scrollPaneIntoView(pageId);
}

function closePane(pageId) {
	if (S.panes.length < 2 || !S.panes.includes(pageId)) return;
	const index = S.panes.indexOf(pageId);
	S.panes = S.panes.filter((p) => p !== pageId);
	if (S.pageId === pageId) activate(S.panes[Math.max(0, index - 1)]);
	savePanes();
	render(false);
}

/** The pages a preset view shows. */
function presetPanes(mode, t) {
	if (mode === "one") return [S.pageId];
	if (mode === "family") return ops.treeOrder(t, [pagePath(S.pageId, t)[0]]);
	if (mode === "pages") return [...t.topLevel];
	return ops.treeOrder(t);
}

/**
 * Switches between the preset views: "one" (the active page), "family" (its page and folders),
 * "pages" (every numbered page) and "all" (every page followed by its folders, as in the sidebar).
 */
function setView(mode) {
	const t = tree();
	// Folders aren't shown in "All pages", so a folder's page becomes the active one.
	if (mode === "pages" && !t.topLevel.includes(S.pageId)) activate(pagePath(S.pageId, t)[0]);
	S.panes = presetPanes(mode, t);
	S.zoom = null;
	savePanes();
	render(false);
	scrollPaneIntoView(S.pageId);
}

/** Which preset view the open pages match, or null for a hand-picked set. */
function currentView(t) {
	if (S.panes.length === 1) return "one";
	const open = new Set(S.panes);
	const matches = (list) => list.length === open.size && list.every((p) => open.has(p));
	if (matches(t.topLevel)) return "pages";
	if (matches(ops.treeOrder(t))) return "all";
	if (matches(presetPanes("family", t))) return "family";
	return null;
}

/** After pages were added, removed or reordered, keep a preset view showing what it promises. */
function refreshView(preset) {
	const t = tree();
	if (preset && preset !== "one") S.panes = presetPanes(preset, t);
	sanitizePanes(t);
	savePanes();
}

/** Drops pages that no longer exist or can't be reached and keeps the active page valid. */
function sanitizePanes(t = tree()) {
	S.panes = [...new Set(S.panes)].filter((p) => isReachable(p, t));
	if (S.panes.length === 0 && t.topLevel.length) S.panes = [t.topLevel[0]];
	if (!S.panes.includes(S.pageId)) {
		S.pageId = S.panes[0] ?? null;
		S.selection = new Set();
		S.cursor = null;
	}
}

function savePanes() {
	if (S.profile) storage(`movemore:panes:${S.profile.id}`, JSON.stringify({ panes: S.panes, active: S.pageId }));
}

function scrollPaneIntoView(pageId) {
	paneEls.get(pageId)?.root.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

function snapshot() {
	return { layout: S.layout, pageOrder: S.pageOrder, newPages: new Set(S.newPages), pageId: S.pageId, selection: [...S.selection] };
}

/** Records an edit (layout and/or page changes) so it can be undone. */
function commitState(patch, { selection, message, tone = "ok", action } = {}) {
	const preset = currentView(tree());
	S.undo.push(snapshot());
	if (S.undo.length > 300) S.undo.shift();
	S.redo = [];
	if (patch.layout) S.layout = patch.layout;
	if (patch.pageOrder) S.pageOrder = patch.pageOrder;
	if (patch.newPages) S.newPages = patch.newPages;
	if (selection) S.selection = new Set(selection);
	if (S.clipboard && !S.clipboard.keyIds.every((id) => coordOfKey(id, S.clipboard.page))) S.clipboard = null;
	if (patch.pageOrder) refreshView(preset);
	updateSearch();
	render();
	if (message) toast(message, tone, action);
}

const commit = (layout, options) => commitState({ layout }, options);

function restore(snap) {
	const preset = currentView(tree());
	S.layout = snap.layout;
	S.pageOrder = snap.pageOrder;
	S.newPages = snap.newPages;
	S.clipboard = null;
	refreshView(preset);
	const t = tree();
	if (snap.pageId !== S.pageId && isReachable(snap.pageId, t)) {
		if (!S.panes.includes(snap.pageId)) S.panes = S.panes.map((p) => (p === S.pageId ? snap.pageId : p));
		S.pageId = snap.pageId;
	}
	S.selection = new Set(snap.selection.filter((id) => coordOfKey(id)));
	S.cursor = null;
	updateSearch();
	render();
}

function undo() {
	const prev = S.undo.pop();
	if (!prev || S.busy) return;
	S.redo.push(snapshot());
	restore(prev);
}

function redo() {
	const next = S.redo.pop();
	if (!next || S.busy) return;
	S.undo.push(snapshot());
	restore(next);
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

async function boot() {
	try {
		S.server = await api.get("/api/state");
	} catch (err) {
		return showEmpty("Can't reach Move More", `The editor's server isn't responding (${err.message}). Make sure Stream Deck is running.`);
	}
	el.mode.hidden = S.server.restarts;
	el.apply.textContent = S.server.restarts ? "Apply…" : "Apply to test copy…";
	if (!S.server.found) {
		return showEmpty("No Stream Deck profiles found", "Move More looks for Stream Deck 7 profiles in:", S.server.profilesRoot);
	}
	const [selection] = await Promise.all([readSelection(), refreshProfiles()]);
	if (S.profiles.length === 0) return showEmpty("No profiles yet", "Create a profile in Stream Deck first.");
	// Start on the profile Stream Deck shows: on the deck whose key opened the editor, or in its window.
	S.streamDeck = selection;
	const deck = new URLSearchParams(location.search).get("deck");
	if (deck !== null) history.replaceState(null, "", location.pathname);
	const last = storage("movemore:profile");
	const initial =
		findProfile(selectedProfile(S.streamDeck, deck)) ?? S.profiles.find((p) => p.id === last) ?? [...S.profiles].sort((a, b) => b.keyCount - a.keyCount)[0];
	await openProfile(initial.id);
}

async function refreshProfiles() {
	const { profiles } = await api.get("/api/profiles");
	S.profiles = profiles;
}

const findProfile = (id) => (id ? S.profiles.find((p) => p.id.toUpperCase() === id.toUpperCase()) : undefined);

async function openProfile(id, options = {}) {
	loadModel(await api.get(`/api/profiles/${id}`), options);
}

/** Opens another profile. That discards unapplied changes, so it asks first unless told to discard them. */
async function switchProfile(id, { discard = false } = {}) {
	if (id === S.profile?.id || S.busy) return false;
	if (isDirty() && !discard) {
		const ok = await confirmDialog({
			title: "Discard unapplied changes?",
			body: [h("p", {}, `Your changes to “${S.profile.name}” haven't been applied yet.`)],
			confirm: "Discard and switch",
			danger: true,
		});
		if (!ok) return false;
	}
	S.search.query = "";
	el.search.value = "";
	try {
		await openProfile(id);
		return true;
	} catch (err) {
		toast(err.message, "error");
		return false;
	}
}

/**
 * Shows a profile as the server described it. keepView keeps the pages shown, zoom and scrolling;
 * keepEdits also keeps unapplied changes, undo history and the selection, which is only possible
 * while every key is still where it was (same layout revision).
 */
function loadModel(model, { keepView = false, keepEdits = false } = {}) {
	const id = model.id;
	const same = S.profile?.id === id;
	const previous = keepView && same ? { panes: S.panes, active: S.pageId, zoom: S.zoom, scroll: [el.stage.scrollLeft, el.stage.scrollTop] } : null;
	const edits =
		keepEdits && same && model.layoutRevision === S.profile.layoutRevision
			? { layout: S.layout, pageOrder: S.pageOrder, newPages: S.newPages, undo: S.undo, redo: S.redo, selection: S.selection, anchor: S.anchor, cursor: S.cursor, clipboard: S.clipboard }
			: null;
	const previousKeys = S.keys;
	S.profile = model;
	S.keys = new Map(model.keys.map((k) => [k.id, k]));
	const layout = {};
	for (const page of model.pages) layout[page.id] = {};
	for (const key of model.keys) layout[key.page][key.coord] = key.id;
	S.original = layout;
	S.layout = edits?.layout ?? layout;
	S.originalOrder = model.pages.filter((p) => p.kind === "page").map((p) => p.id);
	S.pageOrder = edits?.pageOrder ?? [...S.originalOrder];
	S.newPages = edits?.newPages ?? new Set();
	S.undo = edits?.undo ?? [];
	S.redo = edits?.redo ?? [];
	S.selection = edits?.selection ?? new Set();
	S.anchor = edits?.anchor ?? null;
	S.cursor = edits?.cursor ?? null;
	S.clipboard = edits?.clipboard ?? null;
	S.preview = null;
	S.stale = false;
	S.zoom = previous?.zoom ?? null;
	searchText = new Map(model.keys.map((k) => [k.id, [k.title, k.name, k.plugin, ...k.details].join(" ").toLowerCase()]));
	if (edits) {
		// Same keys in the same places: only redraw the ones whose look or details changed.
		for (const [keyId, node] of keyEls) {
			if (JSON.stringify(previousKeys.get(keyId)) === JSON.stringify(S.keys.get(keyId))) continue;
			node.remove();
			keyEls.delete(keyId);
			if (peek.keyId === keyId) hidePeek();
		}
	} else {
		hidePeek();
		keyEls.clear();
		for (const pane of paneEls.values()) pane.root.remove();
		paneEls.clear();
		paneShape = "";
		lastArrangement = "";
	}

	let view = previous;
	if (!view) {
		try {
			view = JSON.parse(storage(`movemore:panes:${id}`) || "null");
		} catch {
			view = null;
		}
	}
	S.panes = Array.isArray(view?.panes) ? view.panes : [];
	S.pageId = typeof view?.active === "string" ? view.active : null;
	sanitizePanes();
	storage("movemore:profile", id);
	updateSearch();
	hideBanner();
	el.empty.hidden = true;
	render(false);
	if (previous) [el.stage.scrollLeft, el.stage.scrollTop] = previous.scroll;
}

async function reloadProfile() {
	hideBanner();
	await refreshProfiles().catch(() => {});
	await openProfile(S.profile.id, { keepView: true }).catch((err) => (err.status === 404 ? profileGone() : toast(err.message, "error")));
}

function showEmpty(title, text, code) {
	el.panes.hidden = true;
	el.empty.hidden = false;
	el.empty.replaceChildren(h("h2", {}, title), h("p", {}, text), code ? h("code", {}, code) : null);
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

/** Recomputes the matches (in sidebar order) after the query or the layout changed. */
function updateSearch() {
	const s = S.search;
	s.terms = s.query.toLowerCase().split(/\s+/).filter(Boolean);
	const current = s.matches[s.index];
	s.matches = [];
	if (s.terms.length && S.profile) {
		const t = tree();
		for (const pageId of ops.treeOrder(t)) {
			const cells = S.layout[pageId] ?? {};
			for (const coord of Object.keys(cells).sort(ops.compareCoords)) {
				const keyId = cells[coord];
				const key = S.keys.get(keyId);
				let text = searchText.get(keyId) ?? "";
				if (key.goto) text += ` page ${S.pageOrder.indexOf(pageAtNumber(key.goto)) + 1}`;
				if (s.terms.every((term) => text.includes(term))) s.matches.push(keyId);
			}
		}
	}
	s.index = current ? s.matches.indexOf(current) : -1;
}

function renderSearch() {
	const s = S.search;
	const active = s.terms.length > 0;
	el.searchCount.hidden = !active;
	el.searchPrev.hidden = el.searchNext.hidden = !active || s.matches.length === 0;
	el.searchCount.classList.toggle("none", active && s.matches.length === 0);
	el.searchCount.textContent = !active ? "" : s.matches.length === 0 ? "No keys" : s.index >= 0 ? `${s.index + 1} of ${s.matches.length}` : plural(s.matches.length, "key");
}

/** Goes to the next/previous match: shows its page and selects it so it can be moved at once. */
function goToMatch(step) {
	const s = S.search;
	if (s.matches.length === 0) return;
	s.index = s.index < 0 ? (step > 0 ? 0 : s.matches.length - 1) : (s.index + step + s.matches.length) % s.matches.length;
	const keyId = s.matches[s.index];
	const at = ops.locate(S.layout).get(keyId);
	if (!at) return;
	if (!S.panes.includes(at.page)) showPage(at.page);
	else activate(at.page);
	if (!S.keys.get(keyId)?.locked) {
		S.selection = new Set([keyId]);
		S.anchor = keyId;
	}
	render(false);
	const node = keyEls.get(keyId);
	node?.scrollIntoView({ block: "nearest", inline: "nearest" });
	if (node && !reducedMotion()) {
		node.classList.remove("flash");
		void node.offsetWidth;
		node.classList.add("flash");
	}
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function render(animate = true) {
	if (!S.profile) return;
	const t = tree();
	renderSidebar(t);
	renderTopbar(t);
	renderPanes(animate, t);
	renderActionbar();
	renderSearch();
}

function renderSidebar(t) {
	const dirtyPages = new Set(keyMoves().flatMap((m) => [m.from.page, m.to.page]));
	const groups = new Map();
	for (const p of S.profiles) {
		if (!groups.has(p.device.uuid)) groups.set(p.device.uuid, []);
		groups.get(p.device.uuid).push(p);
	}
	const nodes = [];
	for (const profiles of groups.values()) {
		const device = profiles[0].device;
		const list = h("ul", { class: "tree" });
		for (const p of profiles) {
			const active = p.id === S.profile.id;
			list.append(
				h(
					"li",
					{},
					h(
						"button",
						{ class: `nav-item profile${active ? " active" : ""}`, type: "button", dataset: { profile: p.id }, "aria-current": active ? "true" : null },
						icon("profile"),
						h("span", { class: "grow" }, p.name, h("span", { class: "sub" }, `${plural(p.pageCount, "page")} · ${plural(p.keyCount, "key")}`)),
						p.installedBy ? h("span", { class: "badge", title: `Installed by ${p.installedBy}` }, "plugin") : null,
					),
				),
			);
			if (active) list.append(h("li", {}, pageTree(t, dirtyPages)));
		}
		nodes.push(
			h("div", { class: "device" }, h("div", { class: "device-head" }, device.name, device.serial ? h("small", {}, `…${device.serial.slice(-4)}`) : null), list),
		);
	}
	el.profiles.replaceChildren(...nodes);
}

function pageTree(t, dirtyPages) {
	const list = h("ul", { class: "tree" });
	const searching = S.search.terms.length > 0;
	const found = new Map();
	if (searching) {
		const at = ops.locate(S.layout);
		for (const keyId of S.search.matches) {
			const page = at.get(keyId)?.page;
			if (page) found.set(page, (found.get(page) ?? 0) + 1);
		}
	}
	const add = (pageId, depth) => {
		const kind = pageKind(pageId);
		const top = kind === "page";
		const count = Object.keys(S.layout[pageId] ?? {}).length;
		const matches = found.get(pageId) ?? 0;
		const classes = ["nav-item", "page"];
		if (pageId === S.pageId) classes.push("active");
		else if (S.panes.includes(pageId)) classes.push("open");
		if (S.dropTarget === pageId) classes.push("drop");
		if (searching && !matches) classes.push("no-match");
		const label = pageLabel(pageId, t);
		const actions = [];
		if (!S.panes.includes(pageId)) {
			actions.push(
				h("button", { class: "row-action", type: "button", dataset: { openAlongside: pageId }, title: `Show ${label} alongside`, "aria-label": `Show ${label} alongside` }, icon("plus")),
			);
		}
		if (top) {
			actions.push(h("button", { class: "row-action", type: "button", dataset: { pageMenu: pageId }, title: `${label} options`, "aria-label": `${label} options` }, icon("more")));
		}
		list.append(
			h(
				"li",
				{ class: "page-row", dataset: top ? { rowPage: pageId } : {} },
				h(
					"button",
					{
						class: classes.join(" "),
						type: "button",
						style: { "--depth": String(depth) },
						dataset: top ? { page: pageId, dropPage: pageId, topPage: pageId } : { page: pageId, dropPage: pageId },
						title: top ? "Drag to reorder · Ctrl+click to show alongside" : "Ctrl+click to show alongside",
						"aria-current": pageId === S.pageId ? "page" : null,
					},
					icon(top ? "page" : "folder"),
					h("span", { class: "grow" }, label),
					S.newPages.has(pageId) ? h("span", { class: "badge new" }, "new") : null,
					dirtyPages.has(pageId) ? h("span", { class: "dot", title: "Has unapplied changes" }) : null,
					searching ? h("span", { class: `meta${matches ? " found" : ""}`, title: `${plural(matches, "match", "matches")}` }, matches) : h("span", { class: "meta" }, count),
				),
				actions.length ? h("div", { class: "row-actions" }, actions) : null,
			),
		);
		for (const child of t.children.get(pageId) ?? []) add(child, depth + 1);
	};
	for (const pageId of t.topLevel) add(pageId, 1);
	list.append(
		h(
			"li",
			{ class: "page-row add-row", dataset: { rowPage: "end" } },
			h("button", { class: "add-page", type: "button", dataset: { addPage: "" }, title: "Add an empty page at the end" }, icon("plus"), "Add page"),
		),
	);
	return list;
}

function renderTopbar(t) {
	const path = pagePath(S.pageId, t);
	const crumbs = [h("button", { type: "button", onclick: () => showPage(t.topLevel[0]) }, S.profile.name)];
	path.forEach((pageId, i) => {
		const last = i === path.length - 1;
		crumbs.push(h("span", { class: "sep", "aria-hidden": "true" }, "›"));
		crumbs.push(h("button", { type: "button", "aria-current": last ? "page" : null, onclick: last ? null : () => showPage(pageId) }, pageLabel(pageId, t)));
	});
	el.crumbs.replaceChildren(...crumbs);

	const view = currentView(t);
	const everything = ops.treeOrder(t);
	const family = presetPanes("family", t);
	for (const button of el.view.querySelectorAll("[data-view]")) {
		const mode = button.dataset.view;
		button.setAttribute("aria-pressed", String(mode === view));
		button.disabled =
			S.busy || (mode === "pages" && t.topLevel.length < 2) || (mode === "all" && everything.length < 2) || (mode === "family" && family.length < 2);
	}

	const moves = keyMoves();
	const pc = pageChanges();
	const parts = [];
	if (moves.length) parts.push(h("span", {}, h("strong", {}, plural(moves.length, "key")), " moved"));
	if (pc.created.length) parts.push(`${plural(pc.created.length, "page")} added`);
	if (pc.deleted.length) parts.push(`${plural(pc.deleted.length, "page")} deleted`);
	if (pc.reordered) parts.push("pages reordered");
	const nodes = [];
	parts.forEach((part, i) => nodes.push(...(i ? [" · "] : []), part));
	el.pending.replaceChildren(...(nodes.length ? nodes : ["No changes yet"]));
	const dirty = moves.length > 0 || pc.changed;
	el.undo.disabled = S.undo.length === 0 || S.busy;
	el.redo.disabled = S.redo.length === 0 || S.busy;
	el.discard.disabled = !dirty || S.busy;
	el.apply.disabled = !dirty || S.busy || S.stale;
	el.apply.title = S.stale ? "Reload first: keys or pages were changed in Stream Deck." : "";
}

function renderActionbar() {
	const n = S.selection.size;
	el.moveTo.disabled = n === 0 || S.busy;
	el.cut.disabled = n === 0 || S.busy;
	el.paste.disabled = !S.clipboard || S.busy;
	el.selectAll.disabled = S.busy;
	el.zoomFit.textContent = S.zoom ? `${Math.round((S.zoom / S.metrics.fitKey) * 100)}%` : "Fit";
	el.zoomOut.disabled = S.metrics.key <= ZOOM_MIN;
	el.zoomIn.disabled = S.metrics.key >= ZOOM_MAX;
	const dropHint = S.panes.length > 1 ? ", drop on another page or folder shown here," : "";
	if (S.clipboard) {
		const count = S.clipboard.keyIds.length;
		el.selinfo.replaceChildren(
			h("strong", {}, `${plural(count, "key")} cut`),
			` from ${pageName(S.clipboard.page)} — click where the top-left key should go, then press `,
			h("kbd", {}, "Ctrl+V"),
			". ",
			h("kbd", {}, "Esc"),
			" cancels.",
		);
	} else if (n > 0) {
		el.selinfo.replaceChildren(
			h("strong", {}, `${plural(n, "key")} selected`),
			" — drag to move, nudge with ",
			h("kbd", {}, "←↑→↓"),
			`${dropHint} or drop on a page in the sidebar.`,
		);
	} else {
		el.selinfo.replaceChildren("Click a key to select it. ", h("kbd", {}, "Ctrl"), "-click or drag a box to select several.");
	}
}

function createPane(pageId) {
	const { cols, rows } = S.profile.device;
	const cells = new Map();
	const cellNodes = [];
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const coord = ops.coordOf(col, row);
			const cell = h("div", { class: "cell", role: "gridcell", dataset: { coord }, "aria-label": `Row ${row + 1}, column ${col + 1}` });
			cells.set(coord, cell);
			cellNodes.push(cell);
		}
	}
	const grid = h("div", { class: "grid", role: "grid", "aria-multiselectable": "true" }, cellNodes);
	grid.style.setProperty("--cols", String(cols));
	const kindIcon = h("span", { class: "pane-icon" });
	const label = h("span", { class: "pane-label" });
	const dot = h("span", { class: "dot", title: "Has unapplied changes" });
	const count = h("span", { class: "meta" });
	const close = h(
		"button",
		{ class: "pane-close", type: "button", title: "Stop showing this page", "aria-label": "Stop showing this page", onclick: () => closePane(pageId) },
		icon("close"),
	);
	const head = h("div", { class: "pane-head" }, kindIcon, label, dot, count, close);
	const root = h("section", { class: "pane", dataset: { pane: pageId } }, head, h("div", { class: "deck" }, grid));
	const pane = { root, head, kindIcon, label, dot, count, grid, cells };
	paneEls.set(pageId, pane);
	return pane;
}

function renderPanes(animate, t) {
	if (!S.pageId) {
		el.panes.hidden = true;
		return;
	}
	el.panes.hidden = false;
	const shape = `${S.profile.id}|${S.profile.device.cols}x${S.profile.device.rows}`;
	if (shape !== paneShape) {
		for (const pane of paneEls.values()) pane.root.remove();
		paneEls.clear();
		paneShape = shape;
	}
	const arrangement = `${shape}|${S.panes.join(",")}|${S.zoom ?? "fit"}`;
	const rearranged = arrangement !== lastArrangement;
	const before = animate && !rearranged && !reducedMotion() ? keyRects() : null;

	for (const [pageId, pane] of paneEls) {
		if (!S.panes.includes(pageId)) {
			pane.root.remove();
			paneEls.delete(pageId);
		}
	}
	const several = S.panes.length > 1;
	const dirtyPages = new Set(keyMoves().flatMap((m) => [m.from.page, m.to.page]));
	S.panes.forEach((pageId, index) => {
		const pane = paneEls.get(pageId) ?? createPane(pageId);
		if (el.panes.children[index] !== pane.root) el.panes.insertBefore(pane.root, el.panes.children[index] ?? null);
		pane.head.hidden = !several;
		pane.root.classList.toggle("active", several && pageId === S.pageId);
		pane.root.classList.toggle("target", !!S.preview?.layout && S.preview.toPage === pageId && pageId !== S.drag?.fromPage);
		const kind = pageKind(pageId) === "folder" ? "folder" : "page";
		if (pane.kindIcon.dataset.kind !== kind) {
			pane.kindIcon.dataset.kind = kind;
			pane.kindIcon.replaceChildren(icon(kind));
		}
		pane.label.textContent = pagePath(pageId, t).map((p) => pageLabel(p, t)).join(" › ");
		pane.dot.hidden = !dirtyPages.has(pageId);
		pane.count.textContent = String(Object.keys(S.layout[pageId] ?? {}).length);
		pane.root.setAttribute("aria-label", pageName(pageId, t));
	});
	if (rearranged) {
		lastArrangement = arrangement;
		fitPanes();
	}

	const view = S.preview?.layout ?? S.layout;
	const originalWhere = ops.locate(S.original);
	const currentWhere = ops.locate(S.layout);
	const searching = S.search.terms.length > 0;
	const matches = new Set(S.search.matches);
	const currentMatch = S.search.matches[S.search.index];
	const placed = new Set();
	for (const pageId of S.panes) {
		const pane = paneEls.get(pageId);
		for (const [coord, id] of Object.entries(view[pageId] ?? {})) {
			const cell = pane.cells.get(coord);
			if (!cell) continue;
			const node = keyElement(id);
			if (node.parentElement !== cell) cell.append(node);
			placed.add(id);
			const orig = originalWhere.get(id);
			const current = currentWhere.get(id);
			const selected = S.selection.has(id);
			node.classList.toggle("selected", selected && !S.preview);
			node.classList.toggle("moving", !!S.preview?.moving.has(id));
			node.classList.toggle("displaced", !!S.preview?.displaced?.has(id));
			node.classList.toggle("drop-into", !!S.preview && S.preview.intoKey === id && !S.preview.invalid);
			node.classList.toggle("leaving", S.dropTarget !== null && selected);
			node.classList.toggle("cut", !!S.clipboard?.keyIds.includes(id));
			node.classList.toggle("moved", !orig || !current || orig.page !== current.page || orig.coord !== current.coord);
			node.classList.toggle("match", searching && matches.has(id) && id !== currentMatch);
			node.classList.toggle("match-current", searching && id === currentMatch);
			node.classList.toggle("dim", searching && !matches.has(id));
			node.setAttribute("aria-selected", String(selected));
		}
		for (const [coord, cell] of pane.cells) {
			cell.classList.toggle("cursor", pageId === S.pageId && coord === S.cursor && !S.drag && !!S.clipboard);
		}
	}
	for (const node of el.panes.querySelectorAll(".key")) {
		if (!placed.has(node.dataset.id)) node.remove();
	}
	el.panes.classList.toggle("dragging", S.drag?.mode === "move");
	el.panes.classList.toggle("invalid", !!S.preview?.invalid);
	if (before) playFlip(before);
}

function keyElement(id) {
	let node = keyEls.get(id);
	if (node) return node;
	const key = S.keys.get(id);
	node = h("div", { class: `key${key.locked ? " locked" : ""}`, dataset: { id }, "aria-label": oneLine(key.title) ? `${oneLine(key.title)}, ${key.name}` : key.name });
	if (key.image) {
		const img = h("img", { src: key.image, alt: "", draggable: "false", decoding: "async" });
		img.addEventListener("error", () => img.replaceWith(fallback(key)), { once: true });
		node.append(img);
	} else {
		node.append(fallback(key));
	}
	if (key.showTitle && key.title) {
		const title = h("div", { class: `key-title t-${key.align}`, dataset: { size: key.fontSize ?? "" } }, key.title);
		title.style.color = key.color;
		const style = key.fontStyle.toLowerCase();
		title.style.fontWeight = style.includes("bold") ? "700" : style.includes("regular") || style.includes("italic") ? "400" : "550";
		if (style.includes("italic")) title.style.fontStyle = "italic";
		if (key.underline) title.style.textDecoration = "underline";
		node.append(title);
	}
	if (key.kind === "folder") node.append(h("span", { class: "key-badge" }, icon("folder")));
	if (key.locked) node.append(h("span", { class: "key-badge" }, icon("lock")));
	sizeTitle(node);
	keyEls.set(id, node);
	return node;
}

function fallback(key) {
	return h("div", { class: "key-fallback" }, h("b", {}, key.name), key.plugin && key.plugin !== key.name ? h("span", {}, key.plugin) : null);
}

/** Stream Deck sizes titles for a 72 px key; scale them to the size drawn here. */
function sizeTitle(node, size = S.metrics.key) {
	const title = node.querySelector(".key-title");
	if (title) title.style.fontSize = `${((Number(title.dataset.size) || 10) * size * 1.1) / 72}px`;
}

function keyRects() {
	const rects = new Map();
	for (const node of el.panes.querySelectorAll(".key")) rects.set(node, node.getBoundingClientRect());
	return rects;
}

/** FLIP: animate keys from where they were drawn to where they are now (also across pages). */
function playFlip(before) {
	for (const [node, rect] of before) {
		if (!node.isConnected) continue;
		const now = node.getBoundingClientRect();
		const dx = rect.left - now.left;
		const dy = rect.top - now.top;
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
		node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 170, easing: "cubic-bezier(.2,.8,.2,1)" });
	}
}

// ---------------------------------------------------------------------------------------------
// Sizing and zoom
// ---------------------------------------------------------------------------------------------

/** Sizes keys so the pages shown fit the stage (or at the zoomed size), choosing columns of decks. */
function fitPanes() {
	if (!S.profile) return;
	const { cols, rows } = S.profile.device;
	const box = el.stage.getBoundingClientRect();
	const count = Math.max(1, S.panes.length);
	const space = { width: box.width - 64, height: box.height - 64 };
	const options = { ratio: GAP_RATIO, header: count > 1 ? PANE_HEADER : 0, spacing: PANE_SPACING, min: 30, max: 116 };
	const fit = ops.arrangeDecks(count, space, { cols, rows }, options);
	const { columns, key } = S.zoom ? ops.arrangeDecks(count, space, { cols, rows }, { ...options, key: S.zoom }) : fit;
	const gap = Math.max(4, Math.round(key * GAP_RATIO));
	S.metrics = { key, gap, fitKey: fit.key };
	el.panes.style.setProperty("--key", `${key}px`);
	el.panes.style.setProperty("--gap", `${gap}px`);
	el.panes.style.setProperty("--pane-cols", String(columns));
	for (const node of keyEls.values()) sizeTitle(node);
	renderActionbar();
}

new ResizeObserver(() => fitPanes()).observe(el.stage);

/**
 * Zooms keys to a new size, keeping the key slot under (x, y) — or the middle of the view — in
 * place. A size within a few pixels of "fit" snaps back to fitting the window.
 */
function setZoom(size, x, y) {
	if (!S.profile) return;
	hidePeek();
	const view = el.stage.getBoundingClientRect();
	const px = x ?? view.left + view.width / 2;
	const py = y ?? view.top + view.height / 2;
	const pageId = paneAt(px, py);
	const cell = pageId ? cellIn(pageId, px, py, true) : null;
	const cellNode = cell ? paneEls.get(pageId).cells.get(ops.coordOf(cell.col, cell.row)) : null;
	const before = cellNode?.getBoundingClientRect();

	const next = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, size)));
	S.zoom = Math.abs(next - S.metrics.fitKey) <= 2 ? null : next;
	lastArrangement = "";
	render(false);

	if (before && cellNode?.isConnected) {
		const after = cellNode.getBoundingClientRect();
		el.stage.scrollLeft += after.left + ((px - before.left) / before.width) * after.width - px;
		el.stage.scrollTop += after.top + ((py - before.top) / before.height) * after.height - py;
	}
}

const zoomBy = (factor, x, y) => setZoom(S.metrics.key * factor, x, y);

el.stage.addEventListener(
	"wheel",
	(e) => {
		if (!(e.ctrlKey || e.metaKey) || !S.profile) return;
		e.preventDefault();
		zoomBy(Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * 0.0022))), e.clientX, e.clientY);
	},
	{ passive: false },
);

// ---------------------------------------------------------------------------------------------
// Key preview on hover
// ---------------------------------------------------------------------------------------------

const peek = { keyId: null, timer: 0 };

function hidePeek() {
	clearTimeout(peek.timer);
	peek.keyId = null;
	el.peek.hidden = true;
}

function onStageHover(e) {
	if (S.drag || e.buttons || S.busy || !el.menu.hidden || el.dialog.open) return hidePeek();
	const node = e.target instanceof Element ? e.target.closest(".key") : null;
	const keyId = node?.dataset.id ?? null;
	if (keyId === peek.keyId) return;
	hidePeek();
	peek.keyId = keyId;
	if (keyId) peek.timer = setTimeout(() => showPeek(keyId, node), 450);
}

/** What a key does, including links whose page numbers depend on pending page changes. */
function keyFacts(key) {
	const lines = [...key.details];
	if (key.goto) {
		const target = pageAtNumber(key.goto);
		lines.unshift(target && S.pageOrder.includes(target) ? `Opens ${pageLabel(target)}` : `Opens page ${key.goto}`);
	}
	if (key.switchTo) {
		if (opensThisProfile(key)) {
			const target = pageAtNumber(key.switchTo.page);
			lines.unshift(target ? `Opens ${pageLabel(target)} of this profile` : `Opens page ${key.switchTo.page} of this profile`);
		} else {
			const name = key.switchTo.profileName ? `“${key.switchTo.profileName}”` : "another profile";
			lines.unshift(`Switches to ${name}${key.switchTo.page ? `, page ${key.switchTo.page}` : ""}`);
		}
	}
	if (key.kind === "folder" && key.folder) {
		const count = Object.keys(S.layout[key.folder] ?? {}).length;
		lines.unshift(`Opens a folder with ${plural(count, "key")}`);
	}
	return lines;
}

function showPeek(keyId, node) {
	if (!node.isConnected || S.drag) return;
	const key = S.keys.get(keyId);
	const at = ops.locate(S.layout).get(keyId);
	const was = ops.locate(S.original).get(keyId);
	const size = 112;
	const face = node.cloneNode(true);
	face.className = key.locked ? "key locked" : "key";
	face.removeAttribute("aria-selected");
	sizeTitle(face, size);
	const title = oneLine(key.title) || key.name;
	const t = tree();
	const place = at ? `${pagePath(at.page, t).map((p) => pageLabel(p, t)).join(" › ")} · ${where(at.coord)}` : "";
	const moved = was && at && (was.page !== at.page || was.coord !== at.coord);
	el.peek.replaceChildren(
		h("div", { class: "peek-face", style: { "--key": `${size}px` } }, face),
		h(
			"div",
			{ class: "peek-info" },
			h("div", { class: "peek-title" }, title),
			h("div", { class: "peek-sub" }, key.plugin && key.plugin !== key.name ? `${key.name} · ${key.plugin}` : key.name),
			(() => {
				const lines = keyFacts(key);
				return lines.length ? h("ul", { class: "peek-lines" }, lines.map((line) => h("li", {}, line))) : null;
			})(),
			h("div", { class: "peek-where" }, place),
			moved ? h("div", { class: "peek-moved" }, `Moves here from ${pageLabel(was.page, t)} · ${where(was.coord)}`) : null,
		),
	);
	el.peek.hidden = false;
	const r = node.getBoundingClientRect();
	const card = el.peek.getBoundingClientRect();
	const margin = 10;
	let left = r.right + margin;
	if (left + card.width > window.innerWidth - 8) left = r.left - card.width - margin;
	left = Math.max(8, Math.min(left, window.innerWidth - card.width - 8));
	const top = Math.max(8, Math.min(r.top, window.innerHeight - card.height - 8));
	el.peek.style.left = `${left}px`;
	el.peek.style.top = `${top}px`;
}

el.stage.addEventListener("pointermove", onStageHover);
el.stage.addEventListener("pointerleave", hidePeek);

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

function movableOnPage() {
	return Object.values(S.layout[S.pageId] ?? {}).filter((id) => !S.keys.get(id)?.locked);
}

/** Selects every key on the active page — or, while searching, every match on it. */
function selectAll() {
	let keys = movableOnPage();
	if (S.search.terms.length) {
		const matches = new Set(S.search.matches);
		keys = keys.filter((id) => matches.has(id));
		if (keys.length === 0) toast("No matches on this page.", "info", null, 2500);
	}
	S.selection = new Set(keys);
	render();
}

function selectRange(fromId, toId) {
	const a = ops.parseCoord(coordOfKey(fromId));
	const b = ops.parseCoord(coordOfKey(toId));
	const selected = new Set();
	for (const [coord, id] of Object.entries(S.layout[S.pageId] ?? {})) {
		const c = ops.parseCoord(coord);
		const inside = c.col >= Math.min(a.col, b.col) && c.col <= Math.max(a.col, b.col) && c.row >= Math.min(a.row, b.row) && c.row <= Math.max(a.row, b.row);
		if (inside && !S.keys.get(id)?.locked) selected.add(id);
	}
	S.selection = selected;
}

// ---------------------------------------------------------------------------------------------
// Pointer interaction on the decks: selection, box selection, dragging keys
// ---------------------------------------------------------------------------------------------

/** The page whose pane (header or deck) is under the pointer; only the visible part of the stage counts. */
function paneAt(x, y) {
	const visible = el.stage.getBoundingClientRect();
	if (x < visible.left || x >= visible.right || y < visible.top || y >= visible.bottom) return null;
	for (const [pageId, pane] of paneEls) {
		const r = pane.root.getBoundingClientRect();
		if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return pageId;
	}
	return null;
}

function cellIn(pageId, x, y, clamp = false) {
	const rect = paneEls.get(pageId).grid.getBoundingClientRect();
	const { key, gap } = S.metrics;
	const pitch = key + gap;
	const col = Math.floor((x - rect.left + gap / 2) / pitch);
	const row = Math.floor((y - rect.top + gap / 2) / pitch);
	const { cols, rows } = S.profile.device;
	if (clamp) return { col: Math.min(cols - 1, Math.max(0, col)), row: Math.min(rows - 1, Math.max(0, row)) };
	if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
	return { col, row };
}

function onPointerDown(e) {
	if (e.button !== 0 || S.busy || !S.profile || !S.pageId || S.drag) return;
	if (e.target.closest("button")) return;
	hidePeek();
	closeMenu();
	// preventDefault() below keeps focus where it was; give the keyboard back to the decks.
	if (document.activeElement instanceof HTMLElement && document.activeElement.closest("input, textarea")) document.activeElement.blur();
	const additive = e.ctrlKey || e.metaKey;
	const pageId = paneAt(e.clientX, e.clientY);
	if (!pageId) {
		// Empty stage around the decks.
		if (!additive && !e.shiftKey && (S.selection.size || S.cursor)) {
			S.selection = new Set();
			S.cursor = null;
			render();
		}
		return;
	}
	e.preventDefault();
	activate(pageId);
	if (e.target.closest(".pane-head")) return render();

	const cell = cellIn(pageId, e.clientX, e.clientY);
	const coord = cell ? ops.coordOf(cell.col, cell.row) : null;
	const keyId = coord ? S.layout[pageId]?.[coord] : undefined;
	const key = keyId ? S.keys.get(keyId) : null;
	el.stage.setPointerCapture(e.pointerId);
	if (coord) S.cursor = coord;

	if (key && !key.locked) {
		if (additive) {
			if (S.selection.has(keyId)) S.selection.delete(keyId);
			else S.selection.add(keyId);
			S.anchor = keyId;
			return render();
		}
		if (e.shiftKey && S.anchor && coordOfKey(S.anchor)) {
			selectRange(S.anchor, keyId);
			return render();
		}
		const wasSelected = S.selection.has(keyId);
		if (!wasSelected) {
			S.selection = new Set([keyId]);
			S.anchor = keyId;
		}
		S.drag = { mode: "press", pointerId: e.pointerId, x: e.clientX, y: e.clientY, fromPage: pageId, grab: cell, keyId, collapse: wasSelected && S.selection.size > 1 };
	} else {
		if (!additive && !e.shiftKey) S.selection = new Set();
		S.drag = { mode: "marquee", pointerId: e.pointerId, x: e.clientX, y: e.clientY, fromPage: pageId, base: new Set(S.selection), active: false };
	}
	render();
}

function onPointerMove(e) {
	if (S.pageDrag) return onPageDragMove(e);
	const d = S.drag;
	if (!d || e.pointerId !== d.pointerId) return;
	if (d.mode === "press") {
		if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
		d.mode = "move";
		d.offset = null;
		S.cursor = null;
		S.preview = { moving: new Set(S.selection) };
		render();
	}
	if (d.mode === "move") {
		d.lastEvent = e;
		updateMove(e);
		updateAutoScroll(e);
	} else if (d.mode === "marquee") {
		updateMarquee(e);
	}
}

/** The folder key under the pointer that dragged keys could be dropped into, if any. */
function folderKeyAt(toPage, x, y) {
	const cell = cellIn(toPage, x, y);
	const keyId = cell ? S.layout[toPage]?.[ops.coordOf(cell.col, cell.row)] : null;
	const key = keyId && !S.selection.has(keyId) ? S.keys.get(keyId) : null;
	return key?.kind === "folder" && key.folder && isReachable(key.folder) ? key : null;
}

function updateMove(e) {
	const d = S.drag;
	const count = S.selection.size;
	const moving = new Set(S.selection);

	const sidebarTarget = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop-page]")?.dataset.dropPage ?? null;
	if (sidebarTarget && sidebarTarget !== d.fromPage) {
		disarmFolder(d);
		showBadge(e, `Move ${plural(count, "key")} to ${pageName(sidebarTarget)}`);
		if (S.dropTarget !== sidebarTarget) {
			S.dropTarget = sidebarTarget;
			S.preview = null;
			d.offset = null;
			render();
		}
		return;
	}
	if (S.dropTarget) {
		S.dropTarget = null;
		d.offset = null;
	}

	const toPage = paneAt(e.clientX, e.clientY);
	if (!toPage) {
		// Between or outside the decks: dropping here changes nothing.
		disarmFolder(d);
		if (d.offset !== "none") {
			d.offset = "none";
			S.preview = { moving };
			render();
		}
		showBadge(e, "Drop on a key slot to move");
		return;
	}

	// Holding the keys over a folder key for a moment drops them into that folder.
	const folder = folderKeyAt(toPage, e.clientX, e.clientY);
	if (folder) {
		if (d.dwellKey !== folder.id) {
			disarmFolder(d);
			d.dwellKey = folder.id;
			d.dwellTimer = setTimeout(() => {
				if (S.drag !== d || d.dwellKey !== folder.id) return;
				d.armed = true;
				d.offset = null;
				updateMove(d.lastEvent);
			}, FOLDER_DWELL_MS);
		}
		if (d.armed) return previewIntoFolder(e, folder);
	} else {
		disarmFolder(d);
	}

	const cell = cellIn(toPage, e.clientX, e.clientY, true);
	const { dx, dy } = ops.clampOffset(S.layout, d.fromPage, S.selection, cell.col - d.grab.col, cell.row - d.grab.row, gridSpec());
	const offset = `${toPage}|${dx},${dy}`;
	if (offset !== d.offset) {
		d.offset = offset;
		if (toPage === d.fromPage && dx === 0 && dy === 0) {
			S.preview = { moving };
		} else {
			const result = ops.moveGroup(S.layout, d.fromPage, S.selection, toPage, dx, dy, gridSpec());
			const trapped = result.ok && toPage !== d.fromPage ? ops.findTrappedFolder(pagesList(), S.layout, result.layout, folderOf) : null;
			if (!result.ok) S.preview = { moving, invalid: result.message };
			else if (trapped) S.preview = { moving, invalid: `“${keyTitle(trapped)}” can't go inside its own folder` };
			else S.preview = { layout: result.layout, moving, displaced: new Set(result.displaced.map((x) => x.keyId)), toPage };
		}
		render();
	}

	const p = S.preview;
	let text = plural(count, "key");
	if (p?.invalid) text = p.invalid;
	else if (p?.layout && p.toPage !== d.fromPage) {
		text = `Move ${plural(count, "key")} to ${pageName(p.toPage)}`;
		if (p.displaced.size) text += ` · ${plural(p.displaced.size, "key")} will swap back`;
	} else if (p?.displaced?.size) {
		text = `${plural(count, "key")} · ${plural(p.displaced.size, "key")} will make room`;
	}
	if (folder) text += ` · hold to drop into “${keyTitle(folder.id)}”`;
	showBadge(e, text, !!p?.invalid);
}

/** Preview for dropping the selection into the folder a folder key opens. */
function previewIntoFolder(e, folder) {
	const d = S.drag;
	const moving = new Set(S.selection);
	const name = keyTitle(folder.id);
	const offset = `into|${folder.id}`;
	if (d.offset !== offset) {
		d.offset = offset;
		if (folder.folder === d.fromPage) {
			S.preview = { moving, invalid: `Those keys are already in “${name}”`, intoKey: folder.id };
		} else {
			const result = ops.sendToPage(S.layout, d.fromPage, S.selection, folder.folder, gridSpec());
			const trapped = result.ok ? ops.findTrappedFolder(pagesList(), S.layout, result.layout, folderOf) : null;
			if (!result.ok) S.preview = { moving, invalid: result.message, intoKey: folder.id };
			else if (trapped) S.preview = { moving, invalid: `“${keyTitle(trapped)}” can't go inside its own folder`, intoKey: folder.id };
			else S.preview = { layout: result.layout, moving, intoKey: folder.id, into: folder.folder, toPage: folder.folder, how: result.how };
		}
		render();
	}
	const p = S.preview;
	showBadge(e, p.invalid ?? `Drop ${plural(S.selection.size, "key")} into “${name}”`, !!p.invalid);
}

function disarmFolder(d) {
	clearTimeout(d.dwellTimer);
	if (d.armed) d.offset = null;
	d.dwellKey = null;
	d.armed = false;
}

function updateMarquee(e) {
	const d = S.drag;
	if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
	d.active = true;
	const left = Math.min(d.x, e.clientX);
	const right = Math.max(d.x, e.clientX);
	const top = Math.min(d.y, e.clientY);
	const bottom = Math.max(d.y, e.clientY);
	Object.assign(el.marquee.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
	el.marquee.hidden = false;
	const grid = paneEls.get(d.fromPage).grid.getBoundingClientRect();
	const { key, gap } = S.metrics;
	const selection = new Set(d.base);
	for (const [coord, id] of Object.entries(S.layout[d.fromPage] ?? {})) {
		if (S.keys.get(id)?.locked) continue;
		const { col, row } = ops.parseCoord(coord);
		const x = grid.left + col * (key + gap);
		const y = grid.top + row * (key + gap);
		if (x < right && x + key > left && y < bottom && y + key > top) selection.add(id);
	}
	S.selection = selection;
	renderPanes(false, tree());
	renderActionbar();
}

function onPointerUp(e) {
	if (S.pageDrag) return onPageDragEnd(e);
	const d = S.drag;
	if (!d || e.pointerId !== d.pointerId) return;
	S.drag = null;
	clearTimeout(d.dwellTimer);
	stopAutoScroll();
	hideBadge();
	el.marquee.hidden = true;
	if (d.mode === "press") {
		if (d.collapse) {
			S.selection = new Set([d.keyId]);
			S.anchor = d.keyId;
		}
		return render();
	}
	if (d.mode === "move") {
		const target = S.dropTarget;
		const preview = S.preview;
		S.dropTarget = null;
		S.preview = null;
		if (target) return sendSelectionTo(target);
		if (preview?.invalid) toast(preview.invalid, "warn");
		if (preview?.into && preview.layout) return dropIntoFolder(preview);
		if (preview?.layout) return dropMoved(d.fromPage, preview);
	}
	render();
}

/** Commits a drag preview; after a drop on another page, that page becomes the active one. */
function dropMoved(fromPage, preview) {
	const count = preview.moving.size;
	const swapped = preview.displaced.size;
	let message = null;
	if (preview.toPage === fromPage) {
		if (swapped) message = `Moved ${plural(count, "key")}; ${plural(swapped, "key")} shifted into the space they left.`;
	} else {
		message = `Moved ${plural(count, "key")} to ${pageName(preview.toPage)}.`;
		if (swapped) message = `${message.slice(0, -1)}; ${plural(swapped, "key")} that ${swapped === 1 ? "was" : "were"} in the way went to ${pageName(fromPage)}.`;
	}
	commit(preview.layout, { message });
	if (preview.toPage !== S.pageId) {
		S.pageId = preview.toPage;
		S.anchor = null;
		S.cursor = null;
		savePanes();
		render();
	}
}

function dropIntoFolder(preview) {
	const ids = [...preview.moving];
	const name = keyTitle(preview.intoKey);
	const how = { same: "", shifted: " (shifted to fit)", packed: " (placed in the free spots)" }[preview.how] ?? "";
	commit(preview.layout, {
		selection: [],
		message: `Moved ${plural(ids.length, "key")} into “${name}”${how}.`,
		action: {
			label: "Show",
			run: () => {
				showPage(preview.into);
				S.selection = new Set(ids.filter((id) => coordOfKey(id)));
				render();
			},
		},
	});
}

function cancelDrag() {
	if (S.pageDrag) {
		endPageDrag();
		return true;
	}
	if (!S.drag) return false;
	clearTimeout(S.drag.dwellTimer);
	S.drag = null;
	stopAutoScroll();
	S.preview = null;
	S.dropTarget = null;
	el.marquee.hidden = true;
	hideBadge();
	render();
	return true;
}

function showBadge(e, text, bad = false) {
	el.dragBadge.textContent = text;
	el.dragBadge.classList.toggle("bad", bad);
	el.dragBadge.hidden = false;
	// Below and right of the pointer; left of it where the window ends, so it's never cut off.
	const { width, height } = el.dragBadge.getBoundingClientRect();
	const right = e.clientX + 14 + width <= window.innerWidth - 8;
	el.dragBadge.style.left = `${Math.max(8, right ? e.clientX + 14 : e.clientX - 14 - width)}px`;
	el.dragBadge.style.top = `${Math.min(e.clientY + 14, window.innerHeight - 8 - height)}px`;
}

function hideBadge() {
	el.dragBadge.hidden = true;
}

// While dragging keys near the edge of the stage, scroll it so decks further away can be reached.
// The stage's "scroll" listener re-runs hit testing as the decks slide by.
const autoScroll = { frame: 0, vx: 0, vy: 0 };

function updateAutoScroll(e) {
	const r = el.stage.getBoundingClientRect();
	const edge = 56;
	const speed = (distance) => (distance < edge ? Math.ceil(((edge - Math.max(0, distance)) / edge) * 22) : 0);
	const insideX = e.clientX >= r.left && e.clientX < r.right;
	const insideY = e.clientY >= r.top && e.clientY < r.bottom;
	autoScroll.vy = insideX ? speed(r.bottom - e.clientY) - speed(e.clientY - r.top) : 0;
	autoScroll.vx = insideY ? speed(r.right - e.clientX) - speed(e.clientX - r.left) : 0;
	if ((autoScroll.vx || autoScroll.vy) && !autoScroll.frame) autoScroll.frame = requestAnimationFrame(stepAutoScroll);
}

function stepAutoScroll() {
	autoScroll.frame = 0;
	if (S.drag?.mode !== "move" || (!autoScroll.vx && !autoScroll.vy)) return;
	const { scrollLeft, scrollTop } = el.stage;
	el.stage.scrollBy(autoScroll.vx, autoScroll.vy);
	if (el.stage.scrollLeft !== scrollLeft || el.stage.scrollTop !== scrollTop) autoScroll.frame = requestAnimationFrame(stepAutoScroll);
}

function stopAutoScroll() {
	cancelAnimationFrame(autoScroll.frame);
	Object.assign(autoScroll, { frame: 0, vx: 0, vy: 0 });
}

el.stage.addEventListener("scroll", () => {
	hidePeek();
	// Decks moved under a stationary pointer (auto-scroll or mouse wheel): refresh the drop preview.
	if (S.drag?.mode === "move" && S.drag.lastEvent) updateMove(S.drag.lastEvent);
});

el.stage.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", cancelDrag);
el.stage.addEventListener("lostpointercapture", (e) => {
	if (S.drag && e.pointerId === S.drag.pointerId) cancelDrag();
});

// Pointer capture makes the stage the target of click events, so listen there.
el.stage.addEventListener("dblclick", (e) => {
	if (!S.profile) return;
	const pageId = paneAt(e.clientX, e.clientY);
	const cell = pageId ? cellIn(pageId, e.clientX, e.clientY) : null;
	const keyId = cell ? S.layout[pageId]?.[ops.coordOf(cell.col, cell.row)] : null;
	const key = keyId ? S.keys.get(keyId) : null;
	if (key?.kind === "folder" && key.folder && isReachable(key.folder)) showPage(key.folder);
});

// ---------------------------------------------------------------------------------------------
// Reordering pages by dragging them in the sidebar
// ---------------------------------------------------------------------------------------------

let suppressClick = false;

el.profiles.addEventListener("pointerdown", (e) => {
	const row = e.button === 0 && !S.busy && !S.drag ? e.target.closest("[data-top-page]") : null;
	if (!row) return;
	S.pageDrag = { id: row.dataset.topPage, pointerId: e.pointerId, y: e.clientY, active: false, index: null };
});

function onPageDragMove(e) {
	const d = S.pageDrag;
	if (e.pointerId !== d.pointerId) return;
	if (!d.active) {
		if (Math.abs(e.clientY - d.y) < 6) return;
		d.active = true;
		hidePeek();
		el.profiles.classList.add("reordering");
		el.profiles.querySelector(`[data-row-page="${d.id}"]`)?.classList.add("dragging");
	}
	// Insert before the first numbered page whose middle is below the pointer (or at the end).
	const rows = [...el.profiles.querySelectorAll("[data-row-page]")];
	let target = rows.find((row) => {
		const r = row.getBoundingClientRect();
		return row.dataset.rowPage !== "end" && e.clientY < r.top + r.height / 2;
	});
	target ??= rows.find((row) => row.dataset.rowPage === "end");
	d.index = target?.dataset.rowPage === "end" ? S.pageOrder.length : S.pageOrder.indexOf(target?.dataset.rowPage);
	for (const row of rows) row.classList.toggle("insert-before", row === target);
}

function onPageDragEnd(e) {
	const d = S.pageDrag;
	if (e.pointerId !== d.pointerId) return;
	endPageDrag();
	if (!d.active || d.index === null || d.index < 0) return;
	suppressClick = true;
	setTimeout(() => (suppressClick = false), 0);
	const from = S.pageOrder.indexOf(d.id);
	movePage(d.id, d.index > from ? d.index - 1 : d.index);
}

function endPageDrag() {
	S.pageDrag = null;
	el.profiles.classList.remove("reordering");
	for (const row of el.profiles.querySelectorAll(".insert-before, .dragging")) row.classList.remove("insert-before", "dragging");
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function nudge(dx, dy) {
	if (S.selection.size === 0) return;
	const result = ops.moveGroup(S.layout, S.pageId, S.selection, S.pageId, dx, dy, gridSpec());
	if (!result.ok) return toast(result.message, "warn");
	commit(result.layout);
}

function sendSelectionTo(target) {
	const ids = [...S.selection];
	if (ids.length === 0) return toast("Select the keys you want to move first.", "warn");
	const result = ops.sendToPage(S.layout, S.pageId, ids, target, gridSpec());
	if (!result.ok) {
		render();
		return toast(result.message, "warn");
	}
	const trapped = ops.findTrappedFolder(pagesList(), S.layout, result.layout, folderOf);
	if (trapped) {
		render();
		return toast(`“${keyTitle(trapped)}” can't go inside its own folder.`, "warn");
	}
	const how = { same: "same positions", shifted: "shifted to fit", packed: "placed in the free spots" }[result.how];
	commit(result.layout, {
		selection: [],
		message: `Moved ${plural(ids.length, "key")} to ${pageName(target)} (${how}).`,
		action: {
			label: "Show",
			run: () => {
				showPage(target);
				S.selection = new Set(ids.filter((id) => coordOfKey(id)));
				render();
			},
		},
	});
}

function cut() {
	if (S.selection.size === 0) return toast("Select the keys you want to move first.", "warn");
	S.clipboard = { page: S.pageId, keyIds: [...S.selection] };
	S.cursor = null;
	render();
}

function paste() {
	const clip = S.clipboard;
	if (!clip) return toast("Nothing to paste: select keys and press Ctrl+X first.", "warn");
	const coords = clip.keyIds.map((id) => coordOfKey(id, clip.page));
	if (coords.some((c) => c === null)) {
		S.clipboard = null;
		render();
		return toast("The cut keys have moved since; cut them again.", "warn");
	}
	const cellsOf = coords.map(ops.parseCoord);
	const topLeft = { col: Math.min(...cellsOf.map((c) => c.col)), row: Math.min(...cellsOf.map((c) => c.row)) };
	const target = S.cursor ? ops.parseCoord(S.cursor) : topLeft;
	const { dx, dy } = ops.clampOffset(S.layout, clip.page, clip.keyIds, target.col - topLeft.col, target.row - topLeft.row, gridSpec());
	if (clip.page === S.pageId && dx === 0 && dy === 0) {
		return toast("Click the slot where the top-left key should go, then paste.", "info");
	}
	const result = ops.moveGroup(S.layout, clip.page, clip.keyIds, S.pageId, dx, dy, gridSpec());
	if (!result.ok) return toast(result.message, "warn");
	const trapped = ops.findTrappedFolder(pagesList(), S.layout, result.layout, folderOf);
	if (trapped) return toast(`“${keyTitle(trapped)}” can't go inside its own folder.`, "warn");
	S.clipboard = null;
	const swapped = result.displaced.length;
	let message = `Moved ${plural(clip.keyIds.length, "key")} here.`;
	if (swapped) {
		message = clip.page === S.pageId
			? `Moved ${plural(clip.keyIds.length, "key")}; ${plural(swapped, "key")} shifted into the space they left.`
			: `Moved ${plural(clip.keyIds.length, "key")} here; ${plural(swapped, "key")} that ${swapped === 1 ? "was" : "were"} in the way went to ${pageName(clip.page)}.`;
	}
	commit(result.layout, { selection: clip.keyIds, message });
	S.cursor = null;
	render();
}

/** Adds an empty page after `afterId` (or at the end) and shows it next to the current view. */
function addPage(afterId) {
	closeMenu();
	const id = crypto.randomUUID().toUpperCase();
	const order = [...S.pageOrder];
	const at = afterId ? order.indexOf(afterId) + 1 : order.length;
	order.splice(at, 0, id);
	const single = S.panes.length === 1;
	commitState(
		{ layout: { ...S.layout, [id]: {} }, pageOrder: order, newPages: new Set([...S.newPages, id]) },
		{ message: `Added Page ${at + 1}. It's created when you apply.`, tone: "info", action: { label: "Undo", run: undo } },
	);
	// In the one-page view, show the new page alongside so keys can be dragged onto it right away.
	if (single) openPane(id, { focus: false });
	else scrollPaneIntoView(id);
}

/** Why a page can't be deleted right now, or null. */
function cannotDelete(pageId) {
	const label = pageLabel(pageId);
	if (S.pageOrder.length < 2) return "A profile needs at least one page.";
	const count = Object.keys(S.layout[pageId] ?? {}).length;
	if (count) return `${label} still has ${plural(count, "key")}. Move ${count === 1 ? "it" : "them"} to another page first.`;
	const links = linksTo(pageId);
	if (links) {
		return `${plural(links, "key")} open${links === 1 ? "s" : ""} ${label} by its number. Point ${links === 1 ? "it" : "them"} at another page in Stream Deck first.`;
	}
	return null;
}

function deletePage(pageId) {
	closeMenu();
	const reason = cannotDelete(pageId);
	if (reason) return toast(reason, "warn", null, 6000);
	const label = pageLabel(pageId);
	const layout = { ...S.layout };
	delete layout[pageId];
	commitState(
		{ layout, pageOrder: S.pageOrder.filter((id) => id !== pageId) },
		{ message: `Deleted ${label}.`, tone: "info", action: { label: "Undo", run: undo } },
	);
}

function movePage(pageId, toIndex) {
	closeMenu();
	const order = S.pageOrder.filter((id) => id !== pageId);
	order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, pageId);
	if (order.every((id, i) => id === S.pageOrder[i])) return;
	const before = pageLabel(pageId);
	commitState({ pageOrder: order }, { message: `${before} is now Page ${order.indexOf(pageId) + 1}.`, tone: "info", action: { label: "Undo", run: undo } });
}

function discard() {
	if (!isDirty()) return;
	commitState(
		{ layout: S.original, pageOrder: [...S.originalOrder], newPages: new Set() },
		{ selection: [], message: "Discarded all unapplied changes.", tone: "info", action: { label: "Undo", run: undo } },
	);
}

async function apply() {
	const moves = keyMoves();
	const pc = pageChanges();
	if ((!moves.length && !pc.changed) || S.busy) return;
	const pages = new Set(moves.flatMap((m) => [m.from.page, m.to.page]));
	const crossPage = moves.filter((m) => m.from.page !== m.to.page).length;
	const relinked = linksRenumbered();
	const restarts = S.server.restarts;
	const facts = [];
	if (moves.length) facts.push(h("li", {}, h("strong", {}, plural(moves.length, "key")), ` in “${S.profile.name}” will move, on ${plural(pages.size, "page")}.`));
	if (crossPage) facts.push(h("li", {}, `${plural(crossPage, "key")} change${crossPage === 1 ? "s" : ""} page; ${crossPage === 1 ? "its" : "their"} images move along.`));
	if (pc.created.length) facts.push(h("li", {}, h("strong", {}, plural(pc.created.length, "new page")), " will be created."));
	if (pc.deleted.length) facts.push(h("li", {}, h("strong", {}, plural(pc.deleted.length, "empty page")), " will be deleted."));
	if (pc.reordered) facts.push(h("li", {}, "The pages get their new order."));
	if (relinked) facts.push(h("li", {}, `${plural(relinked, "key")} that open${relinked === 1 ? "s" : ""} a page by its number will be renumbered so ${relinked === 1 ? "it keeps" : "they keep"} opening the same page.`));
	facts.push(h("li", {}, "A backup of the profile is saved first — restore it any time from ", h("strong", {}, "Backups"), "."));
	const ok = await confirmDialog({
		title: restarts ? "Apply and restart Stream Deck?" : "Apply to the test copy?",
		body: [
			h("ul", { class: "facts" }, facts),
			h(
				"p",
				{},
				restarts
					? "Stream Deck has to close while its profile files are updated, then it starts again (a few seconds). Any other plugins restart with it."
					: "Test mode: the copy of your profiles is edited directly; Stream Deck isn't touched.",
			),
		],
		confirm: restarts ? "Apply & restart" : "Apply",
	});
	if (!ok) return;
	const body = {
		profileId: S.profile.id,
		revision: S.profile.revision,
		layoutRevision: S.profile.layoutRevision,
		moves: moves.map((m) => ({ from: m.from, to: m.to })),
	};
	if (pc.changed) body.pages = { order: S.pageOrder, created: pc.created, deleted: pc.deleted };
	await runTransaction(() => api.post("/api/apply", body), S.profile.id, "Applying changes");
}

async function runTransaction(start, profileId, title) {
	S.busy = true;
	hidePeek();
	render();
	showOverlay(title, "Saving a backup…");
	try {
		const res = await start();
		const result = await waitForResult(res.txid, res.restarting);
		if (result.status === "ok") {
			await refreshProfiles().catch(() => {});
			await openProfile(profileId, { keepView: true });
			toast(S.server.restarts ? "Done: Stream Deck restarted with the new layout." : "Done: the test copy was updated.", "ok");
		} else if (result.status === "conflict") {
			showBanner(result.message, [{ label: "Reload", run: reloadProfile }]);
		} else {
			toast(result.message || "Something went wrong; nothing was changed.", "error", null, 12000);
		}
	} catch (err) {
		if (err.code === "stale") showStale();
		else toast(err.message, "error", null, 12000);
	} finally {
		S.busy = false;
		hideOverlay();
		render();
	}
}

async function waitForResult(txid, restarting) {
	const started = Date.now();
	let lostContact = false;
	if (restarting) setOverlayText("Closing Stream Deck…");
	for (;;) {
		await sleep(restarting ? 700 : 120);
		try {
			const result = await api.get(`/api/transactions/${txid}`);
			if (result.status !== "pending") return result;
			if (lostContact) setOverlayText("Stream Deck is starting…");
		} catch {
			lostContact = true;
			setOverlayText("Stream Deck is restarting — this takes a few seconds…");
		}
		if (Date.now() - started > 120000) {
			return {
				status: "error",
				message: "Stream Deck hasn't come back after two minutes. If it isn't running, start it from the Start menu; the backup is listed under Backups.",
			};
		}
	}
}

function showStale() {
	S.stale = true;
	renderTopbar(tree());
	showBanner("Keys or pages were added, moved or removed in Stream Deck while you were editing here, so these changes can't be applied safely.", [
		{ label: "Reload latest", run: reloadProfile },
	]);
}

/** The open profile's folder is gone: it was deleted in Stream Deck. */
function profileGone() {
	S.stale = true;
	S.profile.gone = true;
	renderTopbar(tree());
	showBanner(`“${S.profile.name}” was deleted in Stream Deck. Pick another profile on the left.`);
}

// ---------------------------------------------------------------------------------------------
// Live updates: what Stream Deck saves shows up here right away
// ---------------------------------------------------------------------------------------------

const live = { running: false, again: false, list: false, timer: 0, toast: null };

/** Nothing is being dragged, chosen or applied, so a newer model can be swapped in. */
const settled = () => !S.busy && !S.drag && !S.pageDrag && el.menu.hidden && !el.dialog.open;

/**
 * Brings the editor up to date with what Stream Deck saved (list: also the profile list). Runs one
 * at a time, and waits while something is being dragged, chosen or applied.
 */
function checkRevision({ list = false } = {}) {
	live.list ||= list;
	if (live.running) {
		live.again = true;
		return;
	}
	clearTimeout(live.timer);
	if (!S.profile) return;
	if (!settled()) {
		live.timer = setTimeout(checkRevision, 600);
		return;
	}
	live.running = true;
	const withList = live.list;
	live.list = false;
	syncWithStreamDeck(withList)
		.catch(() => {
			// Server briefly unavailable (e.g. Stream Deck restarting); the next change or check catches up.
		})
		.finally(() => {
			live.running = false;
			if (live.again) {
				live.again = false;
				checkRevision();
			}
		});
}

/**
 * Unapplied changes survive as long as every key is still where it was: new titles, images, key
 * states, or another page shown on the device just update the keys. When keys or pages moved, the
 * editor reloads if there's nothing to lose, and asks otherwise.
 */
async function syncWithStreamDeck(withList) {
	const id = S.profile.id;
	const later = () => {
		live.list ||= withList;
		live.timer = setTimeout(checkRevision, 600);
	};
	if (withList) {
		await refreshProfiles();
		if (!settled()) return later();
		renderSidebar(tree());
	}
	if (S.profile.gone) return;
	let latest;
	try {
		latest = await api.get(`/api/profiles/${id}/revision`);
	} catch (err) {
		if (err.status === 404 && S.profile?.id === id) profileGone();
		return;
	}
	if (S.profile?.id !== id || latest.revision === S.profile.revision) return;
	const moved = latest.layoutRevision !== S.profile.layoutRevision;
	if (moved && isDirty()) {
		if (!S.stale) showStale();
		return;
	}
	const model = await api.get(`/api/profiles/${id}`);
	if (S.profile?.id !== id) return;
	if (!settled()) return later();
	if (model.layoutRevision !== S.profile.layoutRevision && isDirty()) {
		if (!S.stale) showStale();
		return;
	}
	loadModel(model, { keepView: true, keepEdits: true });
	if (moved && !live.toast?.isConnected) live.toast = toast("Updated from Stream Deck.", "info");
}

/** Hears about every save the server sees; the timer and window focus checks are the fallback. */
function listenForChanges() {
	if (typeof EventSource !== "function") return;
	const events = new EventSource("/api/events");
	let lost = false;
	events.addEventListener("change", () => {
		checkRevision({ list: true });
		checkSelection();
	});
	events.addEventListener("open", () => {
		// Catch up on anything saved while the server was away (Stream Deck restarting).
		if (lost) {
			checkRevision({ list: true });
			checkSelection();
		}
		lost = false;
	});
	events.addEventListener("error", () => {
		lost = true;
	});
}

// ---------------------------------------------------------------------------------------------
// Following Stream Deck: when it switches to another profile, so does the editor
// ---------------------------------------------------------------------------------------------

/** Which profile Stream Deck shows on each device, or null when the server can't tell. */
async function readSelection() {
	try {
		return (await api.get("/api/selection")).selection;
	} catch {
		return null;
	}
}

/** The profile Stream Deck shows on the device with this name, or else on the device its window shows. */
function selectedProfile(selection, deckName = null) {
	if (!selection) return null;
	const named = selection.devices.filter((d) => d.name === deckName);
	const device = named.length === 1 ? named[0] : selection.devices.find((d) => d.id === selection.shown);
	return device?.profileId ?? null;
}

/**
 * The profile Stream Deck switched to between two readings, if any: in its window (another profile
 * or another device), or on a device the window doesn't show (with a Switch Profile key, say).
 */
function switchedTo(before, now) {
	if (!before || !now) return null;
	if (now.shown !== before.shown) return selectedProfile(now);
	const was = new Map(before.devices.map((d) => [d.id, d.profileId]));
	const changed = now.devices.filter((d) => d.profileId && d.profileId !== was.get(d.id));
	return (changed.find((d) => d.id === now.shown) ?? changed[0])?.profileId ?? null;
}

/** The name a profile's device has in Stream Deck. */
const deviceName = (profile) => S.streamDeck?.devices.find((d) => d.id === profile.device.uuid)?.name || profile.device.name;

const follow = { running: false, target: null };

/**
 * Asks which profiles Stream Deck shows (it doesn't announce switching) and follows a switch as
 * soon as nothing is being dragged, chosen or applied.
 */
async function checkSelection() {
	if (follow.running || !S.profile) return;
	follow.running = true;
	try {
		const now = await readSelection();
		if (!now) return;
		follow.target = switchedTo(S.streamDeck, now) ?? follow.target;
		S.streamDeck = now;
		if (follow.target) await followStreamDeck();
	} finally {
		follow.running = false;
	}
}

/** Shows the profile Stream Deck switched to; with unapplied changes, only offers to. */
async function followStreamDeck() {
	let profile = findProfile(follow.target);
	if (!profile) {
		// Created in Stream Deck a moment ago, or not one the editor can show.
		await refreshProfiles().catch(() => {});
		profile = findProfile(follow.target);
	}
	if (!profile || profile.id === S.profile.id) {
		follow.target = null;
		if (el.banner.dataset.kind === "follow") hideBanner();
		return;
	}
	if (!settled()) return; // The next check tries again.
	follow.target = null;
	const where = `“${profile.name}” on ${deviceName(profile)}`;
	if (isDirty() && !S.profile.gone) {
		showBanner(
			`Stream Deck switched to ${where}. Your changes to “${S.profile.name}” aren't applied yet.`,
			[
				{ label: "Switch to it…", run: () => switchProfile(profile.id) },
				{ label: "Keep editing", run: hideBanner },
			],
			"follow",
		);
		return;
	}
	if (await switchProfile(profile.id, { discard: true })) toast(`Following Stream Deck: ${where}.`, "info");
}

// ---------------------------------------------------------------------------------------------
// Menus, dialogs, toasts, overlay, banner
// ---------------------------------------------------------------------------------------------

function showMenu(items, anchor, { above = false, owner = "" } = {}) {
	el.menu.replaceChildren(...items);
	el.menu.dataset.for = owner;
	el.menu.hidden = false;
	const a = anchor.getBoundingClientRect();
	const m = el.menu.getBoundingClientRect();
	el.menu.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - m.width - 8))}px`;
	const below = a.bottom + 6;
	el.menu.style.top = `${above || below + m.height > window.innerHeight - 8 ? Math.max(8, a.top - m.height - 6) : below}px`;
	el.menu.querySelector("button:not(:disabled)")?.focus();
}

function menuItem(iconName, label, run, { disabled = false, danger = false, title } = {}) {
	return h(
		"button",
		{ class: `nav-item${danger ? " danger" : ""}`, type: "button", role: "menuitem", disabled, title, onclick: run },
		iconName ? icon(iconName) : null,
		h("span", { class: "grow" }, label),
	);
}

function openMoveMenu() {
	if (S.selection.size === 0) return;
	const t = tree();
	const items = [h("div", { class: "menu-label" }, `Move ${plural(S.selection.size, "selected key")} to…`)];
	const add = (pageId, depth) => {
		items.push(
			h(
				"button",
				{
					class: "nav-item page",
					type: "button",
					role: "menuitem",
					style: { "--depth": String(depth - 1) },
					disabled: pageId === S.pageId,
					onclick: () => {
						closeMenu();
						sendSelectionTo(pageId);
					},
				},
				icon(pageKind(pageId) === "folder" ? "folder" : "page"),
				h("span", { class: "grow" }, pageLabel(pageId, t)),
				h("span", { class: "meta" }, Object.keys(S.layout[pageId] ?? {}).length),
			),
		);
		for (const child of t.children.get(pageId) ?? []) add(child, depth + 1);
	};
	for (const pageId of t.topLevel) add(pageId, 1);
	showMenu(items, el.moveTo, { above: true, owner: "move" });
}

function openPageMenu(pageId, anchor) {
	const index = S.pageOrder.indexOf(pageId);
	const label = pageLabel(pageId);
	const blocked = cannotDelete(pageId);
	showMenu(
		[
			h("div", { class: "menu-label" }, label),
			S.panes.includes(pageId) ? null : menuItem("plus", "Show alongside", () => openPane(pageId)),
			menuItem("up", "Move up", () => movePage(pageId, index - 1), { disabled: index <= 0 }),
			menuItem("down", "Move down", () => movePage(pageId, index + 1), { disabled: index >= S.pageOrder.length - 1 }),
			h("div", { class: "menu-sep" }),
			menuItem("plus", "Add page after", () => addPage(pageId)),
			menuItem("trash", "Delete page", () => deletePage(pageId), { danger: true, title: blocked ?? "Deletes this empty page" }),
		].filter(Boolean),
		anchor,
		{ owner: pageId },
	);
}

function closeMenu() {
	el.menu.hidden = true;
}

function confirmDialog({ title, body = [], confirm = "OK", cancel = "Cancel", danger = false }) {
	return new Promise((resolve) => {
		const dialog = el.dialog;
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
			if (dialog.open) dialog.close();
		};
		dialog.replaceChildren(
			h("div", { class: "dialog-body" }, h("h2", {}, title), body),
			h(
				"div",
				{ class: "dialog-actions" },
				h("button", { class: "btn", type: "button", onclick: () => done(false) }, cancel),
				h("button", { class: `btn ${danger ? "danger" : "primary"}`, type: "button", autofocus: true, onclick: () => done(true) }, confirm),
			),
		);
		// Esc fires "cancel". (A "close" event may still be queued from the previous dialog, so it
		// can't be used to detect cancellation.)
		dialog.oncancel = (e) => {
			e.preventDefault();
			done(false);
		};
		dialog.showModal();
	});
}

function showDialog(title, body, actions) {
	el.dialog.replaceChildren(h("div", { class: "dialog-body" }, h("h2", {}, title), body), h("div", { class: "dialog-actions" }, actions));
	el.dialog.oncancel = null;
	el.dialog.showModal();
}

function closeButton(label = "Close") {
	return h("button", { class: "btn primary", type: "button", autofocus: true, onclick: () => el.dialog.close() }, label);
}

function openHelp() {
	const row = (keys, text) => h("tr", {}, h("td", {}, keys), h("td", {}, text));
	const kbd = (k) => h("kbd", {}, k);
	showDialog(
		"How to move keys",
		[
			h(
				"table",
				{ class: "shortcuts" },
				h(
					"tbody",
					{},
					row(["Click, ", kbd("Ctrl"), "-click"], "Select a key; add or remove keys"),
					row([kbd("Shift"), "-click"], "Select every key in the rectangle between two keys"),
					row("Drag on empty space", "Draw a box to select keys"),
					row("Drag selected keys", "Move them together; keys in the way slide into the space they left"),
					row([kbd("←"), kbd("↑"), kbd("→"), kbd("↓")], "Nudge the selection by one key"),
					row("Hold dragged keys over a folder key", "After a moment, dropping puts them inside that folder"),
					row("Page + folders, All pages, All + folders", "Show several pages and folders side by side"),
					row(["+ next to a page, or ", kbd("Ctrl"), "-click it"], "Show just that page or folder alongside the others"),
					row("Drag onto another page or folder shown", "Drop on the exact slot; keys in the way swap back to where you dragged from"),
					row("Drop on a page in the sidebar", "Move to that page or folder, keeping the arrangement when there's room"),
					row([kbd("Ctrl+X"), " then ", kbd("Ctrl+V")], "Move to an exact spot on a page that isn't shown"),
					row([kbd("Ctrl+F"), ", then ", kbd("Enter")], "Find keys by title, action, URL or hotkey; Enter selects the next match"),
					row([kbd("Ctrl+A")], "Select all keys on the page (while searching: all matches on it)"),
					row([kbd("Ctrl"), "+scroll, ", kbd("Ctrl++"), " / ", kbd("Ctrl+−"), " / ", kbd("Ctrl+0")], "Zoom in, out, or back to fit"),
					row("Hover a key", "See what it does (URL, file, hotkey, …) and where it came from"),
					row("Drag a page in the sidebar, or its ⋯ menu", "Reorder pages; add or delete (empty) pages"),
					row("Double-click a folder key", "Open the folder"),
					row([kbd("Ctrl+Z"), " / ", kbd("Ctrl+Y")], "Undo / redo"),
				),
			),
			h(
				"p",
				{ style: { "margin-top": "14px" } },
				"Nothing changes on your Stream Deck until you press Apply. Keys that open a page by its number (Go to Page, Switch Profile) are renumbered so they keep opening the same page. The Parent Folder key inside folders stays where Stream Deck puts it.",
			),
		],
		[closeButton("Got it")],
	);
}

async function openBackups() {
	let data;
	try {
		data = await api.get("/api/backups");
	} catch (err) {
		return toast(err.message, "error");
	}
	const list = data.backups.length
		? h(
				"ul",
				{ class: "backup-list" },
				data.backups.map((b) =>
					h(
						"li",
						{},
						h(
							"div",
							{ class: "grow" },
							h("div", { class: "when" }, `${new Date(b.createdAt).toLocaleString()} · ${b.profileName}`),
							h("div", { class: "what" }, `${b.reason} · ${b.deviceName} · ${formatSize(b.sizeBytes)}`),
						),
						h("button", { class: "btn small", type: "button", disabled: S.busy, onclick: () => restoreBackup(b) }, "Restore"),
					),
				),
			)
		: h("p", {}, "No backups yet. One is saved automatically every time you apply changes.");
	showDialog(
		"Backups",
		[h("p", {}, "Move More saves a copy of a profile before every change. Restoring puts that copy back; the current state is backed up first."), list],
		[
			h("button", { class: "btn ghost left", type: "button", onclick: () => api.post("/api/open-backups").catch((err) => toast(err.message, "error")) }, "Open folder"),
			closeButton(),
		],
	);
}

async function restoreBackup(backup) {
	el.dialog.close();
	const restarts = S.server.restarts;
	const ok = await confirmDialog({
		title: `Restore “${backup.profileName}”?`,
		body: [
			h(
				"p",
				{},
				`The profile goes back to how it was on ${new Date(backup.createdAt).toLocaleString()}. ` +
					(isDirty() ? "Your unapplied changes are discarded. " : "") +
					(restarts ? "Stream Deck restarts to load it." : ""),
			),
		],
		confirm: restarts ? "Restore & restart" : "Restore",
	});
	if (!ok) return;
	await runTransaction(() => api.post("/api/restore", { backupId: backup.id }), backup.profileId, "Restoring backup");
}

function formatSize(bytes) {
	return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function toast(message, tone = "info", action = null, timeout = 4500) {
	const node = h("div", { class: `toast ${tone}`, role: tone === "error" ? "alert" : "status" }, h("span", {}, message));
	if (action) {
		node.append(
			h(
				"button",
				{
					type: "button",
					onclick: () => {
						node.remove();
						action.run();
					},
				},
				action.label,
			),
		);
	}
	el.toasts.append(node);
	while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
	setTimeout(() => node.remove(), action ? timeout + 3000 : timeout);
	return node;
}

function showOverlay(title, text) {
	el.overlayTitle.textContent = title;
	el.overlayText.textContent = text;
	el.overlay.hidden = false;
}

function setOverlayText(text) {
	el.overlayText.textContent = text;
}

function hideOverlay() {
	el.overlay.hidden = true;
}

function showBanner(text, actions = [], kind = "") {
	el.banner.replaceChildren(
		h("span", {}, text),
		h("span", { class: "spacer" }),
		...actions.map((a) => h("button", { class: "btn small", type: "button", onclick: a.run }, a.label)),
	);
	el.banner.dataset.kind = kind;
	el.banner.hidden = false;
}

function hideBanner() {
	el.banner.hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

el.profiles.addEventListener("click", async (e) => {
	if (suppressClick) return;
	const alongside = e.target.closest("[data-open-alongside]");
	if (alongside) return openPane(alongside.dataset.openAlongside);
	const menu = e.target.closest("[data-page-menu]");
	if (menu) {
		e.stopPropagation();
		const pageId = menu.dataset.pageMenu;
		return !el.menu.hidden && el.menu.dataset.for === pageId ? closeMenu() : openPageMenu(pageId, menu);
	}
	if (e.target.closest("[data-add-page]")) return addPage();
	const pageButton = e.target.closest("[data-page]");
	if (pageButton) return e.ctrlKey || e.metaKey ? openPane(pageButton.dataset.page) : showPage(pageButton.dataset.page);
	const profileButton = e.target.closest("[data-profile]");
	if (profileButton) await switchProfile(profileButton.dataset.profile);
});

el.search.addEventListener("input", () => {
	S.search.query = el.search.value;
	S.search.index = -1;
	updateSearch();
	render(false);
});
el.search.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		goToMatch(e.shiftKey ? -1 : 1);
	} else if (e.key === "Escape") {
		// Done searching: back to the decks, with the match you went to still selected.
		e.preventDefault();
		el.search.value = "";
		S.search.query = "";
		updateSearch();
		el.search.blur();
		render(false);
	}
});
el.searchNext.addEventListener("click", () => goToMatch(1));
el.searchPrev.addEventListener("click", () => goToMatch(-1));

el.view.addEventListener("click", (e) => {
	const button = e.target.closest("[data-view]");
	if (button && !button.disabled && button.getAttribute("aria-pressed") !== "true") setView(button.dataset.view);
});
el.zoomIn.addEventListener("click", () => zoomBy(1.2));
el.zoomOut.addEventListener("click", () => zoomBy(1 / 1.2));
el.zoomFit.addEventListener("click", () => setZoom(S.metrics.fitKey));
el.undo.addEventListener("click", undo);
el.redo.addEventListener("click", redo);
el.discard.addEventListener("click", discard);
el.apply.addEventListener("click", apply);
el.moveTo.addEventListener("click", (e) => {
	e.stopPropagation();
	if (!el.menu.hidden && el.menu.dataset.for === "move") closeMenu();
	else openMoveMenu();
});
el.cut.addEventListener("click", cut);
el.paste.addEventListener("click", paste);
el.selectAll.addEventListener("click", selectAll);
el.backups.addEventListener("click", openBackups);
el.help.addEventListener("click", openHelp);
document.addEventListener("pointerdown", (e) => {
	if (!el.menu.hidden && !el.menu.contains(e.target) && e.target !== el.moveTo && !e.target.closest?.("[data-page-menu]")) closeMenu();
});

window.addEventListener("keydown", (e) => {
	if (!S.profile || el.dialog.open || S.busy) return;
	const mod = e.ctrlKey || e.metaKey;
	const key = e.key.toLowerCase();
	if (mod && key === "f") {
		e.preventDefault();
		el.search.focus();
		el.search.select();
		return;
	}
	if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]")) return;
	hidePeek();
	if (e.key === "Escape") {
		if (!el.menu.hidden) closeMenu();
		else if (!cancelDrag()) {
			if (S.clipboard) S.clipboard = null;
			else S.selection = new Set();
		}
		render();
		return;
	}
	if (S.drag || S.pageDrag || !el.menu.hidden) return;
	if (mod && (key === "=" || key === "+")) {
		e.preventDefault();
		zoomBy(1.2);
	} else if (mod && key === "-") {
		e.preventDefault();
		zoomBy(1 / 1.2);
	} else if (mod && key === "0") {
		e.preventDefault();
		setZoom(S.metrics.fitKey);
	} else if (mod && key === "z") {
		e.preventDefault();
		if (e.shiftKey) redo();
		else undo();
	} else if (mod && key === "y") {
		e.preventDefault();
		redo();
	} else if (mod && key === "a") {
		e.preventDefault();
		selectAll();
	} else if (mod && key === "x") {
		e.preventDefault();
		cut();
	} else if (mod && key === "v") {
		e.preventDefault();
		paste();
	} else if (!mod && e.key.startsWith("Arrow") && S.selection.size) {
		e.preventDefault();
		const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
		nudge(dx, dy);
	}
});

window.addEventListener("focus", () => {
	checkRevision({ list: true });
	checkSelection();
});
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") checkSelection();
});
setInterval(() => checkRevision(), 10000);
// Stream Deck doesn't announce profile switches, so ask while the editor can be seen.
setInterval(() => {
	if (document.visibilityState === "visible") checkSelection();
}, 2000);
window.addEventListener("beforeunload", (e) => {
	if (isDirty() && !S.busy) e.preventDefault();
});

boot()
	.then(listenForChanges)
	.catch((err) => showEmpty("Something went wrong", err.message));
