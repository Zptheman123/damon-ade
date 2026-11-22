import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig, mergeTargets, saveProjectConfig } from "./config";
import { detectProject } from "./detect";

const root = mkdtempSync(join(tmpdir(), "ade-detect-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string, files: Record<string, string>): string {
	const dir = join(root, name);
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(join(dir, file, ".."), { recursive: true });
		writeFileSync(join(dir, file), content);
	}
	return dir;
}

const pkg = (body: object) => JSON.stringify(body);

describe("project type detection (reads files, runs nothing)", () => {
	it("a Vite + React app with bun", () => {
		const d = detectProject(
			repo("vite", {
				"package.json": pkg({
					scripts: { dev: "vite" },
					dependencies: { react: "1" },
					devDependencies: { vite: "1" },
				}),
				"bun.lock": "",
			}),
		);
		expect([d.type, d.framework, d.packageManager]).toEqual([
			"web-app",
			"Vite + React",
			"bun",
		]);
		expect(d.targets).toEqual([
			expect.objectContaining({
				kind: "web",
				cwd: "",
				command: "bun run dev",
				url: "http://localhost:5173",
			}),
		]);
	});

	it("an Expo app is mobile, with what it needs said", () => {
		const d = detectProject(
			repo("expo", {
				"package.json": pkg({
					scripts: { start: "expo start" },
					dependencies: { expo: "1" },
				}),
			}),
		);
		expect([d.type, d.framework]).toEqual(["mobile-app", "Expo"]);
		expect(d.targets[0].prerequisite).toContain("Expo Go");
	});

	it("engine projects: Godot", () => {
		const d = detectProject(
			repo("godot", { "project.godot": "[application]\n" }),
		);
		expect([d.type, d.framework]).toEqual(["game", "Godot"]);
		expect(d.targets.map((t) => t.command)).toContain("godot --path .");
	});

	it("a monorepo with a web frontend and an API: one web app with a target per folder", () => {
		const d = detectProject(
			repo("mono", {
				"package.json": pkg({ name: "mono", private: true }),
				"pnpm-lock.yaml": "",
				"apps/web/package.json": pkg({
					scripts: { dev: "next dev" },
					dependencies: { next: "1" },
				}),
				"apps/api/package.json": pkg({
					scripts: { dev: "tsx watch src" },
					dependencies: { express: "1" },
				}),
			}),
		);
		expect(d.type).toBe("web-app");
		expect(d.targets.map((t) => [t.cwd, t.kind, t.command]).sort()).toEqual([
			["apps/api", "service", "pnpm dev"],
			["apps/web", "web", "pnpm dev"],
		]);
	});

	it("a library, a Rust CLI, and something unknown", () => {
		expect(
			detectProject(
				repo("lib", {
					"package.json": pkg({
						main: "index.js",
						scripts: { test: "vitest" },
					}),
				}),
			).type,
		).toBe("library");
		expect(
			detectProject(
				repo("rust", {
					"Cargo.toml": "[package]\nname='x'\n",
					"src/main.rs": "",
				}),
			).type,
		).toBe("cli");
		expect(detectProject(repo("empty", { "notes.txt": "" })).type).toBe(
			"other",
		);
	});

	it("the configuration keeps user-edited targets and survives reloading", () => {
		const home = join(root, "home");
		const dir = join(root, "vite");
		const edited = {
			id: "root:dev",
			name: "Web",
			kind: "web" as const,
			cwd: "",
			command: "bun run dev -- --port 6000",
			edited: true,
		};
		const merged = mergeTargets([edited], detectProject(dir).targets);
		expect(merged).toHaveLength(1);
		expect(merged[0].command).toContain("6000");
		saveProjectConfig(home, dir, {
			type: "web-app",
			framework: "Vite",
			targets: merged,
		});
		expect(loadProjectConfig(home, dir)).toMatchObject({
			type: "web-app",
			targets: [edited],
		});
		// A config from an unknown future type falls back to "not set", not a crash.
		saveProjectConfig(home, dir, { type: "spaceship" as never, targets: [] });
		expect(loadProjectConfig(home, dir).type).toBeUndefined();
	});
});
