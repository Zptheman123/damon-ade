/** The in-app browser's rules, kept free of Electron so they are easy to test. */

/** What a page in the in-app browser may still do. */
export const WEBVIEW_ALLOWED_PERMISSIONS = new Set([
	"clipboard-sanitized-write",
	"fullscreen",
]);

const WEBVIEW_SRC = /^(https?:|about:blank$)/i;

/** Whether a permission is granted: anything for ADE, very little for pages. */
export function permissionAllowed(
	requester: { type: string } | null,
	permission: string,
): boolean {
	if (requester?.type === "webview") {
		return WEBVIEW_ALLOWED_PERMISSIONS.has(permission);
	}
	return true;
}

/** Whether a webview may be created with this source. */
export function webviewSourceAllowed(src: string | undefined): boolean {
	return !src || WEBVIEW_SRC.test(src.trim());
}
