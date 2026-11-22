import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Project types and run targets, detected from safe metadata only: package
 * manifests, lock files and engine project files are read; nothing in the
 * repository is executed. The result is a suggestion the user confirms.
 */

export const PROJECT_TYPES = [
	"website",
	"web-app",
	"desktop-app",
	"mobile-app",
	"game",
	"backend-api",
	"cli",
	"library",
	"data-ai",
	"other",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_INFO: Record<
	ProjectType,
	{ name: string; description: string }
> = {
	website: {
		name: "Website",
		description:
			"Pages people visit: marketing, docs, a blog. Previewed in a browser.",
	},
	"web-app": {
		name: "Web application",
		description:
			"An app in the browser, often with its own API. Previewed in a browser.",
	},
	"desktop-app": {
		name: "Desktop application",
		description:
			"A native app (Electron, Tauri, .NET…). Runs as its own window.",
	},
	"mobile-app": {
		name: "Mobile application",
		description:
			"iOS / Android (Expo, React Native, Flutter…). Device, emulator or web preview.",
	},
	game: {
		name: "Game",
		description:
			"A game in an engine (Godot, Unity, Unreal, Roblox) or the browser.",
	},
	"backend-api": {
		name: "Backend / API service",
		description: "A server or API. Tried with requests and logs.",
	},
	cli: {
		name: "Command-line tool",
		description: "A program run in a terminal, with arguments.",
	},
	library: {
		name: "Library / SDK",
		description: "Code other projects use. Checked with tests and examples.",
	},
	"data-ai": {
		name: "Data / AI project",
		description: "Notebooks, pipelines, evaluations, datasets.",
	},
	other: {
		name: "Other / custom",
		description: "Anything else: you set up how it runs.",
	},
};

/** How a run target is used: what the preview can do with it. */
export type RunTargetKind =
	| "web"
	| "service"
	| "mobile"
	| "desktop"
	| "game"
	| "cli"
	| "test"
	| "custom";

export interface RunTargetSuggestion {
	id: string;
	name: string;
	kind: RunTargetKind;
	/** Relative to the repository root ("" for the root). */
	cwd: string;
	command: string;
	/** Where it is expected to serve, when known before it runs. */
	url?: string;
	/** What it needs that may be missing (an SDK, an editor). */
	prerequisite?: string;
}

export interface Detection {
	type: ProjectType;
	framework: string;
	packageManager?: "bun" | "pnpm" | "yarn" | "npm";
	targets: RunTargetSuggestion[];
	/** Why the type was suggested. */
	evidence: string[];
}

type Json = Record<string, unknown>;

function readJson(path: string): Json | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Json;
	} catch {
		return undefined;
	}
}

function has(dir: string, name: string): boolean {
	return existsSync(join(dir, name));
}

function list(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function packageManager(root: string): Detection["packageManager"] {
	if (has(root, "bun.lock") || has(root, "bun.lockb")) return "bun";
	if (has(root, "pnpm-lock.yaml")) return "pnpm";
	if (has(root, "yarn.lock")) return "yarn";
	if (has(root, "package-lock.json")) return "npm";
	return undefined;
}

function runScript(pm: Detection["packageManager"], script: string): string {
	switch (pm) {
		case "bun":
			return `bun run ${script}`;
		case "pnpm":
			return `pnpm ${script}`;
		case "yarn":
			return `yarn ${script}`;
		default:
			return `npm run ${script}`;
	}
}

function deps(pkg: Json): Record<string, string> {
	return {
		...((pkg.dependencies as Record<string, string>) ?? {}),
		...((pkg.devDependencies as Record<string, string>) ?? {}),
	};
}

/** One package.json folder: what it is and how it runs. */
function nodePackage(
	root: string,
	dir: string,
	pm: Detection["packageManager"],
):
	| { type: ProjectType; framework: string; targets: RunTargetSuggestion[] }
	| undefined {
	const pkg = readJson(join(dir, "package.json"));
	if (!pkg) return undefined;
	const d = deps(pkg);
	const scripts = (pkg.scripts as Record<string, string>) ?? {};
	const cwd = relative(root, dir).replace(/\\/g, "/");
	const label = cwd || (typeof pkg.name === "string" ? pkg.name : "app");
	const devScript = scripts.dev
		? "dev"
		: scripts.start
			? "start"
			: scripts.serve
				? "serve"
				: undefined;
	const target = (
		kind: RunTargetKind,
		url?: string,
		extra: Partial<RunTargetSuggestion> = {},
	): RunTargetSuggestion[] =>
		devScript
			? [
					{
						id: `${cwd || "root"}:${devScript}`,
						name: `${label} (${devScript})`,
						kind,
						cwd,
						command: runScript(pm, devScript),
						url,
						...extra,
					},
				]
			: [];

	if (d.expo || d["react-native"]) {
		return {
			type: "mobile-app",
			framework: d.expo ? "Expo" : "React Native",
			targets: target("mobile", undefined, {
				prerequisite: d.expo
					? "A phone with Expo Go, an Android emulator, or the web preview (press w in the Expo output)."
					: "An Android emulator or a connected device (Xcode on macOS for iOS).",
			}),
		};
	}
	if (
		d.electron ||
		d["electron-vite"] ||
		d["@tauri-apps/api"] ||
		d["@tauri-apps/cli"]
	) {
		return {
			type: "desktop-app",
			framework:
				d["@tauri-apps/cli"] || d["@tauri-apps/api"] ? "Tauri" : "Electron",
			targets: target("desktop"),
		};
	}
	if (d.phaser || d["pixi.js"] || d.three || d.kaboom || d["@babylonjs/core"]) {
		return {
			type: "game",
			framework: d.phaser
				? "Phaser"
				: d["pixi.js"]
					? "PixiJS"
					: d.three
						? "three.js"
						: d.kaboom
							? "Kaboom"
							: "Babylon.js",
			targets: target("web", "http://localhost:5173"),
		};
	}
	if (d.next)
		return {
			type: "web-app",
			framework: "Next.js",
			targets: target("web", "http://localhost:3000"),
		};
	if (d.astro)
		return {
			type: "website",
			framework: "Astro",
			targets: target("web", "http://localhost:4321"),
		};
	if (d.gatsby)
		return {
			type: "website",
			framework: "Gatsby",
			targets: target("web", "http://localhost:8000"),
		};
	if (d["@sveltejs/kit"])
		return {
			type: "web-app",
			framework: "SvelteKit",
			targets: target("web", "http://localhost:5173"),
		};
	if (d.nuxt)
		return {
			type: "web-app",
			framework: "Nuxt",
			targets: target("web", "http://localhost:3000"),
		};
	if (d["@remix-run/dev"] || d["@remix-run/react"])
		return { type: "web-app", framework: "Remix", targets: target("web") };
	if (d.vite) {
		const app =
			d.react || d.vue || d.svelte || d["solid-js"] || d["@angular/core"];
		return {
			type: app ? "web-app" : "website",
			framework: `Vite${d.react ? " + React" : d.vue ? " + Vue" : d.svelte ? " + Svelte" : ""}`,
			targets: target("web", "http://localhost:5173"),
		};
	}
	if (d["react-scripts"])
		return {
			type: "web-app",
			framework: "Create React App",
			targets: target("web", "http://localhost:3000"),
		};
	if (d["@angular/core"])
		return {
			type: "web-app",
			framework: "Angular",
			targets: target("web", "http://localhost:4200"),
		};
	if (d.express || d.fastify || d.hono || d.koa || d["@nestjs/core"]) {
		return {
			type: "backend-api",
			framework: d["@nestjs/core"]
				? "NestJS"
				: d.fastify
					? "Fastify"
					: d.hono
						? "Hono"
						: d.koa
							? "Koa"
							: "Express",
			targets: target("service"),
		};
	}
	if (pkg.bin) {
		return {
			type: "cli",
			framework: "Node.js CLI",
			targets: [
				{
					id: `${cwd || "root"}:cli`,
					name: `${label} (run)`,
					kind: "cli",
					cwd,
					command:
						typeof pkg.bin === "string"
							? `node ${pkg.bin} --help`
							: `node ${Object.values(pkg.bin as Record<string, string>)[0]} --help`,
				},
			],
		};
	}
	const test = scripts.test
		? [
				{
					id: `${cwd || "root"}:test`,
					name: `${label} (tests)`,
					kind: "test" as const,
					cwd,
					command: runScript(pm, "test"),
				},
			]
		: [];
	if (pkg.main || pkg.exports || pkg.module) {
		return {
			type: "library",
			framework: "JavaScript / TypeScript library",
			targets: test,
		};
	}
	if (devScript)
		return { type: "web-app", framework: "Node.js", targets: target("web") };
	return undefined;
}

/** The repository's folders that hold their own package.json (monorepos). */
function workspaceDirs(root: string): string[] {
	const dirs: string[] = [];
	for (const group of [
		"apps",
		"packages",
		"services",
		"frontend",
		"backend",
		"web",
		"api",
		"client",
		"server",
		"mobile",
	]) {
		const groupDir = join(root, group);
		if (!existsSync(groupDir)) continue;
		if (has(groupDir, "package.json")) dirs.push(groupDir);
		for (const child of list(groupDir)) {
			const childDir = join(groupDir, child);
			try {
				if (statSync(childDir).isDirectory() && has(childDir, "package.json"))
					dirs.push(childDir);
			} catch {
				// Unreadable: skip.
			}
		}
	}
	return dirs.slice(0, 12);
}

const TYPE_PRIORITY: ProjectType[] = [
	"mobile-app",
	"desktop-app",
	"game",
	"web-app",
	"website",
	"backend-api",
	"cli",
	"library",
	"data-ai",
	"other",
];

/** Suggest a project type, framework and run targets for a repository. */
export function detectProject(root: string): Detection {
	const evidence: string[] = [];
	const targets: RunTargetSuggestion[] = [];
	const files = list(root);

	// Game engines first: their project files are unambiguous.
	if (files.includes("project.godot")) {
		return {
			type: "game",
			framework: "Godot",
			evidence: ["project.godot"],
			targets: [
				{
					id: "godot:editor",
					name: "Godot editor",
					kind: "game",
					cwd: "",
					command: "godot --path . --editor",
					prerequisite: "Godot on PATH (as `godot`).",
				},
				{
					id: "godot:play",
					name: "Play (Godot)",
					kind: "game",
					cwd: "",
					command: "godot --path .",
					prerequisite: "Godot on PATH (as `godot`).",
				},
			],
		};
	}
	const uproject = files.find((f) => f.endsWith(".uproject"));
	if (uproject) {
		return {
			type: "game",
			framework: "Unreal Engine",
			evidence: [uproject],
			targets: [
				{
					id: "unreal:editor",
					name: "Unreal editor",
					kind: "game",
					cwd: "",
					command: `start "" "${uproject}"`,
					prerequisite:
						"Unreal Engine installed and associated with .uproject files.",
				},
			],
		};
	}
	if (has(root, "ProjectSettings/ProjectVersion.txt") && has(root, "Assets")) {
		return {
			type: "game",
			framework: "Unity",
			evidence: ["ProjectSettings/ProjectVersion.txt"],
			targets: [
				{
					id: "unity:editor",
					name: "Unity editor",
					kind: "game",
					cwd: "",
					command: "",
					prerequisite:
						"Open the project from Unity Hub; set the editor path here to launch it from ADE.",
				},
			],
		};
	}
	if (
		files.includes("default.project.json") ||
		files.some((f) => f.endsWith(".rbxlx") || f.endsWith(".rbxl"))
	) {
		return {
			type: "game",
			framework: "Roblox",
			evidence: ["Rojo / Roblox place file"],
			targets: [
				{
					id: "rojo:serve",
					name: "Rojo sync",
					kind: "game",
					cwd: "",
					command: "rojo serve",
					prerequisite:
						"Rojo on PATH and Roblox Studio with the Rojo plugin; play-test in Studio.",
				},
			],
		};
	}
	if (files.includes("pubspec.yaml")) {
		return {
			type: "mobile-app",
			framework: "Flutter",
			evidence: ["pubspec.yaml"],
			targets: [
				{
					id: "flutter:run",
					name: "Flutter (device)",
					kind: "mobile",
					cwd: "",
					command: "flutter run",
					prerequisite: "The Flutter SDK and an emulator or device.",
				},
				{
					id: "flutter:web",
					name: "Flutter (web preview)",
					kind: "web",
					cwd: "",
					command: "flutter run -d web-server --web-port 8080",
					url: "http://localhost:8080",
				},
			],
		};
	}

	const pm = packageManager(root);
	const found: Array<{ type: ProjectType; framework: string }> = [];
	for (const dir of [root, ...workspaceDirs(root)]) {
		const node = nodePackage(root, dir, pm);
		if (!node) continue;
		found.push(node);
		targets.push(...node.targets);
		evidence.push(
			`${relative(root, dir).replace(/\\/g, "/") || "."}/package.json: ${node.framework}`,
		);
	}

	if (files.includes("Cargo.toml")) {
		const cargo = readFileSync(join(root, "Cargo.toml"), "utf8");
		const lib =
			/\[lib\]/.test(cargo) &&
			!/\[\[bin\]\]/.test(cargo) &&
			!has(root, "src/main.rs");
		found.push({ type: lib ? "library" : "cli", framework: "Rust" });
		targets.push(
			lib
				? {
						id: "cargo:test",
						name: "cargo test",
						kind: "test",
						cwd: "",
						command: "cargo test",
					}
				: {
						id: "cargo:run",
						name: "cargo run",
						kind: "cli",
						cwd: "",
						command: "cargo run -- --help",
					},
		);
		evidence.push("Cargo.toml");
	}
	if (files.includes("go.mod")) {
		found.push({
			type: has(root, "main.go") ? "cli" : "backend-api",
			framework: "Go",
		});
		targets.push({
			id: "go:run",
			name: "go run .",
			kind: has(root, "main.go") ? "cli" : "service",
			cwd: "",
			command: "go run .",
		});
		evidence.push("go.mod");
	}
	const py = ["pyproject.toml", "requirements.txt", "setup.py"].find((f) =>
		files.includes(f),
	);
	if (py) {
		const text = (() => {
			try {
				return readFileSync(join(root, py), "utf8").toLowerCase();
			} catch {
				return "";
			}
		})();
		const notebooks = files.some((f) => f.endsWith(".ipynb"));
		if (/fastapi|flask|django/.test(text)) {
			found.push({
				type: "backend-api",
				framework: /fastapi/.test(text)
					? "FastAPI"
					: /flask/.test(text)
						? "Flask"
						: "Django",
			});
			targets.push(
				/django/.test(text)
					? {
							id: "py:django",
							name: "Django server",
							kind: "service",
							cwd: "",
							command: "python manage.py runserver",
							url: "http://localhost:8000",
						}
					: /fastapi/.test(text)
						? {
								id: "py:uvicorn",
								name: "Uvicorn (main:app)",
								kind: "service",
								cwd: "",
								command: "uvicorn main:app --reload",
								url: "http://localhost:8000",
							}
						: {
								id: "py:flask",
								name: "Flask",
								kind: "service",
								cwd: "",
								command: "flask run",
								url: "http://localhost:5000",
							},
			);
		} else if (/streamlit/.test(text)) {
			found.push({ type: "data-ai", framework: "Streamlit" });
			targets.push({
				id: "py:streamlit",
				name: "Streamlit app",
				kind: "web",
				cwd: "",
				command: "streamlit run app.py",
				url: "http://localhost:8501",
			});
		} else if (
			notebooks ||
			/pandas|numpy|torch|tensorflow|scikit|jupyter/.test(text)
		) {
			found.push({ type: "data-ai", framework: "Python (data)" });
			if (notebooks)
				targets.push({
					id: "py:jupyter",
					name: "Jupyter",
					kind: "web",
					cwd: "",
					command: "jupyter lab --no-browser",
					url: "http://localhost:8888",
				});
		} else {
			found.push({ type: "cli", framework: "Python" });
		}
		evidence.push(py);
	}
	if (!found.length && files.includes("index.html")) {
		found.push({ type: "website", framework: "Static HTML" });
		targets.push({
			id: "static:serve",
			name: "Static server",
			kind: "web",
			cwd: "",
			command: "npx --yes serve -l 4173 .",
			url: "http://localhost:4173",
		});
		evidence.push("index.html");
	}

	if (!found.length) {
		return {
			type: "other",
			framework: "Unknown",
			packageManager: pm,
			targets,
			evidence: ["nothing recognised"],
		};
	}
	// The most specific type wins (a web frontend plus an API is a web app).
	const types = new Set(found.map((f) => f.type));
	let type = TYPE_PRIORITY.find((t) => types.has(t)) ?? "other";
	if (type === "backend-api" && (types.has("website") || types.has("web-app")))
		type = "web-app";
	const framework =
		found.find((f) => f.type === type)?.framework ?? found[0].framework;
	return { type, framework, packageManager: pm, targets, evidence };
}
