import { app, type Session, session, type WebContents } from "electron";
import { permissionAllowed, webviewSourceAllowed } from "./rules";

/**
 * The in-app browser shows pages ADE does not control: a project's localhost
 * preview, docs, anything the user opens. Those pages share the app's
 * session, so they get none of ADE's privileges:
 *
 * - a webview can't get a preload script, Node, or a relaxed sandbox, and
 *   can only load web pages (http, https, about:blank);
 * - a page in a webview can't use the microphone, camera, location,
 *   notifications, or devices; ADE's own window (dictation) still can.
 *
 * Downloads keep Electron's default: the user chooses where to save, every
 * time.
 */

const APP_PARTITION = "persist:superset";

function isWebview(contents: WebContents | null | undefined): boolean {
	if (!contents || contents.isDestroyed()) return false;
	return contents.getType() === "webview";
}

function hardenSession(ses: Session) {
	ses.setPermissionRequestHandler((contents, permission, callback) => {
		callback(
			permissionAllowed(
				isWebview(contents) ? { type: "webview" } : { type: "window" },
				permission,
			),
		);
	});
	ses.setPermissionCheckHandler((contents, permission) =>
		permissionAllowed(
			isWebview(contents) ? { type: "webview" } : { type: "window" },
			permission,
		),
	);
	ses.setDevicePermissionHandler((details) => {
		// HID, serial, and USB pages: never from the in-app browser.
		const origin = details.origin ?? "";
		return !/^https?:/i.test(origin);
	});
}

/** Call once, after the app is ready. */
export function hardenWebviews() {
	hardenSession(session.fromPartition(APP_PARTITION));
	hardenSession(session.defaultSession);

	app.on("web-contents-created", (_, contents) => {
		contents.on("will-attach-webview", (event, webPreferences, params) => {
			// No privileged bridge, no Node, and nothing but web pages.
			delete webPreferences.preload;
			webPreferences.nodeIntegration = false;
			webPreferences.nodeIntegrationInSubFrames = false;
			webPreferences.contextIsolation = true;
			webPreferences.sandbox = true;
			webPreferences.webSecurity = true;
			webPreferences.allowRunningInsecureContent = false;
			if (!webviewSourceAllowed(params.src)) {
				event.preventDefault();
			}
		});
		if (contents.getType() === "webview") {
			// A page can't navigate itself to file:, javascript:, or app URLs.
			contents.on("will-navigate", (event, url) => {
				if (!webviewSourceAllowed(url)) event.preventDefault();
			});
		}
	});
}
