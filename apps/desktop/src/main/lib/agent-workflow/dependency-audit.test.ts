import { afterAll, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuditCommandResult,
	auditDependencies,
	auditFeedback,
	detectAuditTool,
	overridesOf,
	parseAudit,
	touchesDependencies,
} from "./dependency-audit";

const root = mkdtempSync(join(tmpdir(), "ade-audit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, files: Record<string, string>): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	for (const [file, content] of Object.entries(files)) {
		writeFileSync(join(dir, file), content);
	}
	return dir;
}

/** npm's `npm audit --json` (v7+) shape. */
const npmReport = (
	vulns: Record<
		string,
		{
			severity: string;
			fixAvailable?:
				| boolean
				| { name: string; version: string; isSemVerMajor: boolean };
		}
	>,
) =>
	JSON.stringify({
		auditReportVersion: 2,
		vulnerabilities: Object.fromEntries(
			Object.entries(vulns).map(([name, v]) => [
				name,
				{
					name,
					severity: v.severity,
					isDirect: false,
					via: [
						{
							title: `${name} issue`,
							url: `https://github.com/advisories/${name}`,
						},
					],
					fixAvailable: v.fixAvailable ?? false,
				},
			]),
		),
		metadata: { vulnerabilities: {} },
	});

/** A fake package manager: answers by command, can rewrite files on fix. */
function fakeManager(
	responses: Record<string, string | (() => string)>,
	onFix?: () => void,
) {
	const ran: string[] = [];
	const run = async ({
		command,
	}: {
		command: string;
	}): Promise<AuditCommandResult> => {
		ran.push(command);
		if (command.includes(" fix")) onFix?.();
		const answer = responses[command];
		const stdout = typeof answer === "function" ? answer() : (answer ?? "");
		return {
			exitCode: stdout.includes('"severity"') ? 1 : 0,
			stdout,
			stderr: "",
		};
	};
	return { run, ran };
}

const signal = new AbortController().signal;
const PKG = JSON.stringify(
	{ name: "app", overrides: { "glob-parent": "^6.0.2" } },
	null,
	2,
);

describe("dependency audit", () => {
	it("uses the project's package manager, from its lockfile", () => {
		expect(
			detectAuditTool(project("npm", { "package-lock.json": "{}" }))?.fix,
		).toBe("npm audit fix --ignore-scripts");
		const pnpm = detectAuditTool(project("pnpm", { "pnpm-lock.yaml": "" }));
		expect([pnpm?.manager, pnpm?.fix]).toEqual(["pnpm", undefined]);
		expect(
			detectAuditTool(project("berry", { "yarn.lock": "", ".yarnrc.yml": "" }))
				?.audit,
		).toBe("yarn npm audit --json --recursive");
		expect(
			detectAuditTool(project("classic", { "yarn.lock": "" }))?.manager,
		).toBe("yarn-classic");
		expect(detectAuditTool(project("bun", { "bun.lock": "" }))?.manager).toBe(
			"bun",
		);
		expect(
			detectAuditTool(project("none", { "package.json": "{}" })),
		).toBeUndefined();
	});

	it("notices dependency changes anywhere in a monorepo", () => {
		expect(touchesDependencies(["apps/web/package.json"])).toBe(true);
		expect(touchesDependencies(["pnpm-lock.yaml"])).toBe(true);
		expect(touchesDependencies(["src/index.ts", "README.md"])).toBe(false);
	});

	it("reads each manager's report", () => {
		expect(
			parseAudit(
				"npm",
				npmReport({ vite: { severity: "moderate", fixAvailable: true } }),
			),
		).toEqual([
			{
				name: "vite",
				severity: "moderate",
				title: "vite issue",
				url: "https://github.com/advisories/vite",
				fix: "npm audit fix",
			},
		]);
		expect(
			parseAudit(
				"pnpm",
				JSON.stringify({
					advisories: {
						1: {
							module_name: "esbuild",
							severity: "high",
							title: "t",
							url: "u",
							patched_versions: ">=0.25.0",
						},
					},
					metadata: {},
				}),
			)?.[0],
		).toMatchObject({
			name: "esbuild",
			severity: "high",
			fix: "patched in >=0.25.0",
		});
		expect(
			parseAudit(
				"yarn-classic",
				`${JSON.stringify({ type: "auditAdvisory", data: { advisory: { module_name: "a", severity: "low" } } })}\n${JSON.stringify({ type: "auditSummary", data: {} })}`,
			)?.map((a) => a.name),
		).toEqual(["a"]);
		expect(
			parseAudit(
				"yarn",
				JSON.stringify({
					value: "b",
					children: { Severity: "critical", Issue: "x" },
				}),
			)?.[0],
		).toMatchObject({ name: "b", severity: "critical" });
		expect(
			parseAudit(
				"bun",
				JSON.stringify({ c: [{ severity: "high", title: "y" }] }),
			)?.[0],
		).toMatchObject({
			name: "c",
			severity: "high",
		});
		expect(parseAudit("npm", "npm ERR! network")).toBeUndefined();
	});

	it("applies npm's non-breaking fix, then reports what it fixed (no --force, no scripts)", async () => {
		const dir = project("fixable", {
			"package.json": PKG,
			"package-lock.json": '{"v":1}',
		});
		let fixed = false;
		const fake = fakeManager(
			{
				"npm audit --json": () =>
					fixed
						? npmReport({})
						: npmReport({ vite: { severity: "moderate", fixAvailable: true } }),
			},
			() => {
				fixed = true;
				writeFileSync(join(dir, "package-lock.json"), '{"v":2}');
			},
		);
		const audit = await auditDependencies({
			cwd: dir,
			policy: "fix",
			run: fake.run,
			signal,
		});
		expect(audit.state).toBe("clean");
		expect(audit.fixed).toEqual(["vite"]);
		expect(fake.ran).toEqual([
			"npm audit --json",
			"npm audit fix --ignore-scripts",
			"npm audit --json",
		]);
		expect(fake.ran.join(" ")).not.toContain("--force");
	});

	it("keeps overrides: a fix that changes them is undone", async () => {
		const dir = project("overrides", {
			"package.json": PKG,
			"package-lock.json": '{"v":1}',
		});
		const fake = fakeManager(
			{
				"npm audit --json": npmReport({
					minimatch: { severity: "moderate", fixAvailable: true },
				}),
			},
			() => {
				writeFileSync(
					join(dir, "package.json"),
					JSON.stringify({ name: "app", overrides: {} }),
				);
				writeFileSync(join(dir, "package-lock.json"), '{"v":2}');
			},
		);
		const audit = await auditDependencies({
			cwd: dir,
			policy: "fix",
			run: fake.run,
			signal,
		});
		expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(PKG);
		expect(readFileSync(join(dir, "package-lock.json"), "utf8")).toBe(
			'{"v":1}',
		);
		expect(audit.notes.join(" ")).toContain("changed the project's overrides");
		expect(overridesOf(PKG)).not.toBe(
			overridesOf(JSON.stringify({ overrides: {} })),
		);
	});

	it("blocks only on high or critical advisories in production dependencies", async () => {
		const dir = project("severity", {
			"package.json": "{}",
			"package-lock.json": "{}",
		});
		const all = npmReport({
			esbuild: {
				severity: "high",
				fixAvailable: { name: "vite", version: "8.0.0", isSemVerMajor: true },
			},
			"left-pad": { severity: "critical" },
			minimist: { severity: "moderate" },
		});
		const devHigh = fakeManager({
			"npm audit --json": all,
			"npm audit --json --omit=dev": npmReport({
				"left-pad": { severity: "critical" },
			}),
		});
		const blocked = await auditDependencies({
			cwd: dir,
			policy: "report",
			run: devHigh.run,
			signal,
		});
		expect(blocked.state).toBe("failed");
		expect(blocked.advisories[0]).toMatchObject({
			name: "left-pad",
			devOnly: false,
		});
		expect(blocked.advisories.find((a) => a.name === "esbuild")?.devOnly).toBe(
			true,
		);
		expect(auditFeedback(blocked)).toContain("left-pad (critical)");
		expect(auditFeedback(blocked)).not.toContain("esbuild");
		expect(auditFeedback(blocked)).toContain(
			"Keep the project's existing overrides",
		);
		// "report": the fix is never run.
		expect(devHigh.ran).not.toContain("npm audit fix --ignore-scripts");

		const onlyDev = fakeManager({
			"npm audit --json": all,
			"npm audit --json --omit=dev": npmReport({
				minimist: { severity: "moderate" },
			}),
		});
		const warned = await auditDependencies({
			cwd: dir,
			policy: "report",
			run: onlyDev.run,
			signal,
		});
		expect(warned.state).toBe("warnings");
		expect(warned.counts).toMatchObject({ critical: 1, high: 1, moderate: 1 });
	});

	it("reports instead of fixing where the fix would rewrite overrides (pnpm), and never fails on an unreadable audit", async () => {
		const dir = project("pnpm-app", {
			"package.json": "{}",
			"pnpm-lock.yaml": "",
		});
		const fake = fakeManager({
			"pnpm audit --json": JSON.stringify({
				advisories: { 1: { module_name: "x", severity: "moderate" } },
				metadata: {},
			}),
			"pnpm audit --json --prod": JSON.stringify({
				advisories: {},
				metadata: {},
			}),
		});
		const audit = await auditDependencies({
			cwd: dir,
			policy: "fix",
			run: fake.run,
			signal,
		});
		expect(audit.state).toBe("warnings");
		expect(fake.ran.some((c) => c.includes("--fix"))).toBe(false);
		expect(audit.notes[0]).toContain("pnpm.overrides");

		const offline = await auditDependencies({
			cwd: project("offline", {
				"package.json": "{}",
				"package-lock.json": "{}",
			}),
			policy: "fix",
			run: async () => ({
				exitCode: 1,
				stdout: "",
				stderr: "npm ERR! code ENOTFOUND",
			}),
			signal,
		});
		expect(offline.state).toBe("unavailable");
		expect(offline.reason).toContain("ENOTFOUND");
		const none = await auditDependencies({
			cwd: project("nolock", { "package.json": "{}" }),
			policy: "fix",
			run: fake.run,
			signal,
		});
		expect(none.state).toBe("skipped");
	});
});
