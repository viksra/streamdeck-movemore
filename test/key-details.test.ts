import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ActionJson } from "../src/profiles/types.ts";
import { describeAction, formatHotkey } from "../src/server/key-details.ts";

const names = new Map([["cb2258f1-d1d2-4a75-9397-f52600bf37a9", "Jobs"]]);
const describe_ = (action: ActionJson) => describeAction(action, names);

describe("key details", () => {
	it("formats hotkeys and skips Stream Deck's empty placeholder slots", () => {
		assert.equal(formatHotkey({ KeyCtrl: true, VKeyCode: 76 }), "Ctrl+L");
		assert.equal(formatHotkey({ KeyCtrl: true, KeyOption: true, KeyShift: true, VKeyCode: 121 }), "Ctrl+Alt+Shift+F10");
		assert.equal(formatHotkey({ KeyCmd: true, VKeyCode: 68 }), "Win+D");
		assert.equal(formatHotkey({ VKeyCode: 179 }), "Play/Pause");
		assert.equal(formatHotkey({ KeyShift: true, VKeyCode: 16 }), "Shift");
		assert.equal(formatHotkey({ VKeyCode: -1 }), null);
		const hotkey = describe_({
			UUID: "com.elgato.streamdeck.system.hotkey",
			Settings: { Coalesce: true, Hotkeys: [{ KeyCtrl: true, VKeyCode: 67 }, { VKeyCode: -1 }, { VKeyCode: -1 }] },
		});
		assert.deepEqual(hotkey.lines, ["Ctrl+C"]);
	});

	it("shows websites, files and apps", () => {
		assert.deepEqual(describe_({ UUID: "com.elgato.streamdeck.system.website", Settings: { openInBrowser: true, path: "https://example.com/x" } }).lines, ["https://example.com/x"]);
		assert.deepEqual(describe_({ UUID: "com.elgato.streamdeck.system.open", Settings: { path: '"C:\\Tools\\run it.bat"' } }).lines, ["C:\\Tools\\run it.bat"]);
		assert.deepEqual(describe_({ UUID: "com.elgato.streamdeck.system.openapp", Settings: { app_name: "", bundle_path: "C:\\Apps\\Thing.exe" } }).lines, ["Thing.exe"]);
		assert.deepEqual(describe_({ UUID: "com.elgato.streamdeck.soundboard.playaudio", Settings: { path: "C:\\Sounds\\horn.mp3" } }).lines, ["horn.mp3"]);
		const imported = { UUID: "com.elgato.streamdeck.soundboard.playaudio", Settings: { path: "C:\\Audio\\8f734580-b6b6-42e1-a32f-e138d0937e46.mp3" } };
		assert.deepEqual(describe_(imported).lines, [], "Stream Deck's GUID names for imported sounds say nothing");
	});

	it("never reveals the text a Text key types", () => {
		assert.deepEqual(describe_({ UUID: "com.elgato.streamdeck.system.text", Settings: { pastedText: "hunter2" } }).lines, ["Types text"]);
	});

	it("reports page links as numbers the editor can follow", () => {
		assert.equal(describe_({ UUID: "com.elgato.streamdeck.page.goto", Settings: { PageIndex: 3 } }).goto, 3);
		assert.deepEqual(describe_({ UUID: "com.elgato.streamdeck.profile.rotate", Settings: { PageIndex: 2, ProfileUUID: "CB2258F1-D1D2-4A75-9397-F52600BF37A9" } }).switchTo, {
			profileId: "cb2258f1-d1d2-4a75-9397-f52600bf37a9",
			profileName: "Jobs",
			page: 2,
		});
		assert.equal(describe_({ UUID: "com.elgato.streamdeck.profile.rotate", Settings: { PageIndex: 0, ProfileUUID: "x" } }).switchTo?.page, null);
	});

	it("counts multi-action steps and leaves other plugins' settings alone", () => {
		const multi = describe_({
			UUID: "com.elgato.streamdeck.multiactions.routine",
			Settings: {},
			Actions: [{ Actions: [{ UUID: "com.elgato.streamdeck.system.hotkey" }, { UUID: "com.elgato.streamdeck.multiactions.delay" }, { UUID: "x.y" }] }],
		});
		assert.deepEqual(multi.lines, ["3 steps"]);
		assert.deepEqual(describe_({ UUID: "com.example.plugin.action", Settings: { apiToken: "secret" } }).lines, []);
	});
});
