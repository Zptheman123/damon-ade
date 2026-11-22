import { describe, expect, it } from "bun:test";
import { permissionAllowed, webviewSourceAllowed } from "./rules";

describe("in-app browser permissions", () => {
	it("pages can't use the microphone, camera, location, or notifications", () => {
		for (const p of [
			"media",
			"geolocation",
			"notifications",
			"hid",
			"serial",
			"usb",
			"midi",
		]) {
			expect(permissionAllowed({ type: "webview" }, p)).toBe(false);
		}
		expect(
			permissionAllowed({ type: "webview" }, "clipboard-sanitized-write"),
		).toBe(true);
	});

	it("ADE's own window keeps the microphone for dictation", () => {
		expect(permissionAllowed({ type: "window" }, "media")).toBe(true);
	});

	it("webviews load only web pages", () => {
		expect(webviewSourceAllowed("http://localhost:5173")).toBe(true);
		expect(webviewSourceAllowed("https://example.com")).toBe(true);
		expect(webviewSourceAllowed("about:blank")).toBe(true);
		expect(webviewSourceAllowed("file:///C:/secrets.txt")).toBe(false);
		expect(webviewSourceAllowed("javascript:alert(1)")).toBe(false);
		expect(webviewSourceAllowed("superset-icon://projects/x")).toBe(false);
	});
});
