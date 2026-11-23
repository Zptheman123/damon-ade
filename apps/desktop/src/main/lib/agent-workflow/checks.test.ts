import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveChecks, saveProjectChecks } from "./checks";

const root = mkdtempSync(join(tmpdir(), "ade-checks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(name: string) {
	const dir = join(root, name, "ade");
	mkdirSync(dir, { recursive: true });
	return { dir } as Parameters<typeof effectiveChecks>[0];
}

function worktree(
	name: string,
	scripts: Record<string, string>,
	lock?: string,
) {
	const dir = join(root, name, "repo");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
	if (lock) writeFileSync(join(dir, lock), "");
	return dir;
}

describe("which checks verify a task", () => {
	const scripts = {
		typecheck: "tsc",
		lint: "eslint .",
		test: "vitest run",
		dev: "vite",
	};

	it("never configured: the project's own typecheck, lint and test scripts", () => {
		expect(
			effectiveChecks(project("auto"), worktree("auto", scripts), true),
		).toEqual({
			commands: ["npm run typecheck", "npm run lint", "npm run test"],
			source: "auto",
		});
		expect(
			effectiveChecks(
				project("bun"),
				worktree("bun", { test: "bun test" }, "bun.lock"),
				true,
			).commands,
		).toEqual(["bun run test"]);
	});

	it("the app's build counts, but not one that packages an installer or publishes", () => {
		expect(
			effectiveChecks(
				project("build"),
				worktree("build", { ...scripts, build: "electron-vite build" }),
				true,
			).commands,
		).toEqual([
			"npm run typecheck",
			"npm run build",
			"npm run lint",
			"npm run test",
		]);
		for (const build of [
			"electron-vite build && electron-builder",
			"electron-forge make",
			"tauri build",
			"vite build && npm publish",
		]) {
			expect(
				effectiveChecks(
					project(`pkg-${build.length}`),
					worktree(`pkg-${build.length}`, { build }),
					true,
				).commands,
			).toEqual([]);
		}
	});

	it("what the user saved always wins, an empty list included", () => {
		const p = project("saved");
		const wt = worktree("saved", scripts);
		saveProjectChecks(p, ["npm run test -- --run"]);
		expect(effectiveChecks(p, wt, true)).toEqual({
			commands: ["npm run test -- --run"],
			source: "approved",
		});
		saveProjectChecks(p, []);
		expect(effectiveChecks(p, wt, true)).toEqual({
			commands: [],
			source: "none",
		});
	});

	it("off, or nothing to run: no checks", () => {
		expect(
			effectiveChecks(project("off"), worktree("off", scripts), false).source,
		).toBe("none");
		expect(
			effectiveChecks(project("none"), worktree("none", { dev: "vite" }), true)
				.source,
		).toBe("none");
	});
});
