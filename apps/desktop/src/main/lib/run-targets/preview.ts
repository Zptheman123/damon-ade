import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunTarget } from "main/lib/project-type/config";

/**
 * Whether a run target can be opened in an ordinary browser, and as what.
 * Read from the project's files only (nothing runs):
 *
 * - web targets: the site or app itself (a web game's runtime too);
 * - mobile targets: a web preview only when the project has a web build
 *   (react-native-web), labelled as such;
 * - Electron/Tauri desktop targets: the renderer's dev server, only when the
 *   renderer code does not use the native bridge (window.api, ipcRenderer,
 *   Tauri's invoke...): it is a renderer preview, not the desktop app;
 * - servers (APIs), commands, tests and native games: not a browser preview.
 */

export type BrowserPreview =
	| { kind: "web" | "web-build" | "renderer"; label: string }
	| { kind: "none"; reason: string };

const SOURCE = /\.(tsx?|jsx?|vue|svelte)$/;
const NATIVE_BRIDGE =
	/\bwindow\.(api|electron|electronAPI|ipc)\b|\bipcRenderer\b|from\s+["']electron["']|require\(\s*["']electron["']\s*\)|@tauri-apps\/api|\b__TAURI__\b/;

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function dependencies(dir: string): Record<string, string> {
	const pkg = readJson(join(dir, "package.json"));
	return {
		...((pkg?.dependencies as Record<string, string>) ?? {}),
		...((pkg?.devDependencies as Record<string, string>) ?? {}),
	};
}

/** The first renderer source file that reaches for the native bridge. */
export function nativeBridgeUse(dir: string, limit = 3000): string | undefined {
	const roots = ["src/renderer", "src"]
		.map((r) => join(dir, r))
		.filter(existsSync);
	const start = roots[0];
	if (!start) return undefined;
	const stack = [start];
	let seen = 0;
	while (stack.length && seen < limit) {
		const current = stack.pop() as string;
		let entries: string[] = [];
		try {
			entries = readdirSync(current);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			// In an Electron app, main and preload are expected to use it.
			if (/^(main|preload)$/.test(name) && current === join(dir, "src"))
				continue;
			const full = join(current, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				stack.push(full);
			} else if (SOURCE.test(name)) {
				seen++;
				try {
					if (NATIVE_BRIDGE.test(readFileSync(full, "utf8"))) {
						return full.slice(dir.length + 1).replace(/\\/g, "/");
					}
				} catch {
					// Unreadable: ignore.
				}
			}
		}
	}
	return undefined;
}

export function browserPreview(
	target: RunTarget,
	worktree: string,
	projectType?: string,
): BrowserPreview {
	const dir = join(worktree, target.cwd || ".");
	switch (target.kind) {
		case "web":
			return {
				kind: projectType === "mobile-app" ? "web-build" : "web",
				label:
					projectType === "mobile-app"
						? "Web preview (browser build, not the native app)"
						: projectType === "game"
							? "Web game"
							: projectType === "desktop-app"
								? "Renderer preview (not the full desktop app)"
								: "Local preview",
			};
		case "mobile": {
			const deps = dependencies(dir);
			return deps["react-native-web"] && (deps.expo || deps["react-dom"])
				? {
						kind: "web-build",
						label: "Web preview (browser build, not the native app)",
					}
				: {
						kind: "none",
						reason:
							"This mobile app has no web build (react-native-web), so it opens on a device or emulator, not in a browser.",
					};
		}
		case "desktop": {
			const deps = dependencies(dir);
			const viteRenderer =
				deps["electron-vite"] ||
				(deps.vite && (deps["@tauri-apps/cli"] || deps.electron));
			if (!viteRenderer) {
				return {
					kind: "none",
					reason:
						"This desktop app opens in its own window; it has no browser dev server.",
				};
			}
			const bridge = nativeBridgeUse(dir);
			return bridge
				? {
						kind: "none",
						reason: `Its renderer uses the desktop bridge (${bridge}), which does not exist in a browser. Use Run to open the app.`,
					}
				: {
						kind: "renderer",
						label: "Renderer preview (not the full desktop app)",
					};
		}
		case "custom":
			return target.url
				? { kind: "web", label: "Local preview" }
				: {
						kind: "none",
						reason: "Set the target's address to open it in a browser.",
					};
		case "service":
			return {
				kind: "none",
				reason: "A server or API: test it with the request panel in Run.",
			};
		case "game":
			return {
				kind: "none",
				reason: "This game runs in its engine or its own window.",
			};
		default:
			return {
				kind: "none",
				reason: "A command, not something to open in a browser.",
			};
	}
}
