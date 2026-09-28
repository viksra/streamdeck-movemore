// Property inspector for the "Layout Editor" action. Stream Deck calls
// connectElgatoStreamDeckSocket() once the page has loaded.
let socket = null;
let context = null;
let action = null;

function sendToPlugin(payload) {
	if (socket && socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify({ event: "sendToPlugin", action, context, payload }));
	}
}

window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, info, actionInfo) => {
	context = uuid;
	action = JSON.parse(actionInfo).action;
	socket = new WebSocket(`ws://127.0.0.1:${port}`);
	socket.addEventListener("open", () => {
		socket.send(JSON.stringify({ event: registerEvent, uuid }));
		sendToPlugin({ event: "get-info" });
	});
	socket.addEventListener("message", (message) => {
		const data = JSON.parse(message.data);
		if (data.event === "sendToPropertyInspector" && data.payload && data.payload.event === "info") {
			document.getElementById("url").textContent = data.payload.url;
		}
	});
};

document.getElementById("open").addEventListener("click", () => sendToPlugin({ event: "open-editor" }));
