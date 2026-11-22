import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Test double for `claude -p`. A small script, run by the current runtime,
 * that records its arguments, stdin and working directory, then plays the
 * next step of a scenario: write files (in the worktree or the task folder),
 * stream usage lines, print a result, fail, or hang with a child process.
 *
 * Guards make a test fail if anything else would be executed or the network
 * would be reached: no real model is ever called.
 */

export interface FakeStep {
	/** Shown in the call log. */
	name: string;
	/** Files to write: "{task}/plan.md" lands in the task folder, others in cwd. */
	write?: Record<string, string>;
	/** Usage lines to stream (default: one response on the run's model). */
	usage?: Array<{ model?: string; input: number; output: number }>;
	/** Final text (the result line's `result`). */
	text?: string;
	/** Reported total_cost_usd; omit for "unknown". */
	cost?: number;
	subtype?: string;
	isError?: boolean;
	exit?: number;
	stderr?: string;
	/** No result line at all. */
	noResult?: boolean;
	/** Never finish; also start a hanging child and record its pid here. */
	hang?: boolean;
	/** git commands to run in the worktree (e.g. switch branch). */
	git?: string[][];
	/**
	 * Shell commands the agent tries, checked like the installed CLI checks
	 * them against --allowedTools: Tool(cmd) exact, Tool(cmd:*) prefix,
	 * each part of a compound command on its own. Refused ones go to the
	 * result's permission_denials; allowed ones are logged as executed.
	 */
	commands?: Array<{ tool?: "Bash" | "PowerShell"; command: string }>;
	/** Written instead of `write` when any command was refused. */
	writeWhenDenied?: Record<string, string>;
	/** Final text instead of `text` when any command was refused. */
	textWhenDenied?: string;
}

export interface FakeCall {
	step: string;
	args: string[];
	stdin: string;
	cwd: string;
}

const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const stdin = fs.readFileSync(0, "utf8");
const args = process.argv.slice(2);
const scenarioPath = process.env.FAKE_SCENARIO;
const state = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const step = state.steps.shift();
fs.writeFileSync(scenarioPath, JSON.stringify(state));
fs.appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({ step: step ? step.name : "(none)", args, stdin, cwd: process.cwd() }) + "\n",
);
function main() {
  if (!step) {
    process.stderr.write("fake claude: the scenario has no step left");
    process.exit(9);
  }
  const taskDir = (stdin.match(/^Task folder: (.+)$/m) || [])[1];
  const at = (name) => args[args.indexOf(name) + 1];
  const model = at("--model");
  const sessionId = at("--session-id");
  // --allowedTools is variadic: its values run until the next option.
  const allowed = [];
  for (let i = args.indexOf("--allowedTools") + 1; i > 0 && i < args.length && !args[i].startsWith("--"); i++) {
    allowed.push(args[i]);
  }
  const parts = (command) => command.split(/&&|\|\||;|\|/).map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean);
  const permits = (rule, tool, part) => {
    const m = rule.match(/^(\w+)\((.*)\)$/);
    if (!m || m[1] !== tool) return false;
    const body = m[2];
    const prefix = body.match(/^(.+):\*$/);
    if (prefix) return part === prefix[1] || part.startsWith(prefix[1] + " ");
    if (body.includes("*")) {
      // A wildcard: the pieces between the stars, in order.
      const pieces = body.split("*");
      if (!part.startsWith(pieces[0])) return false;
      let pos = pieces[0].length;
      for (let k = 1; k < pieces.length; k++) {
        const last = k === pieces.length - 1;
        const found = last
          ? part.endsWith(pieces[k]) && part.length - pieces[k].length >= pos
            ? part.length - pieces[k].length
            : -1
          : part.indexOf(pieces[k], pos);
        if (found < 0) return false;
        pos = found + pieces[k].length;
      }
      return true;
    }
    return part === body;
  };
  const denials = [];
  let toolUse = 0;
  for (const c of step.commands || []) {
    const tool = c.tool || "Bash";
    const ok = parts(c.command).every((part) => allowed.some((rule) => permits(rule, tool, part)));
    const id = "toolu_" + toolUse++;
    if (ok) {
      fs.appendFileSync(process.env.FAKE_EXEC, JSON.stringify({ tool, command: c.command }) + "\n");
    } else {
      denials.push({ tool_name: tool, tool_use_id: id, tool_input: { command: c.command, description: "run it" } });
    }
  }
  const files = denials.length && step.writeWhenDenied ? step.writeWhenDenied : step.write;
  if (denials.length && step.textWhenDenied) step.text = step.textWhenDenied;
  for (const [file, content] of Object.entries(files || {})) {
    const target = file.startsWith("{task}/")
      ? path.join(taskDir, file.slice(7))
      : path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  for (const gitArgs of step.git || []) {
    require("node:child_process").spawnSync("git", gitArgs, { cwd: process.cwd() });
  }
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  emit({ type: "system", subtype: "init", model, session_id: sessionId });
  let n = 0;
  for (const u of step.usage || [{ input: 1000, output: 200 }]) {
    emit({
      type: "assistant",
      message: {
        id: "msg_" + sessionId + "_" + n++,
        model: u.model || model,
        usage: { input_tokens: u.input, output_tokens: u.output },
        content: [{ type: "text", text: step.text || "working" }],
      },
    });
  }
  if (step.hang) {
    const child = require("node:child_process").spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    fs.writeFileSync(process.env.FAKE_CHILD_PID, String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (step.stderr) process.stderr.write(step.stderr);
  if (!step.noResult) {
    emit({
      type: "result",
      subtype: step.subtype || "success",
      is_error: !!step.isError,
      result: step.text || "done",
      total_cost_usd: step.cost,
      session_id: sessionId,
      num_turns: 3,
      permission_denials: denials,
    });
  }
  process.exit(step.exit || 0);
}
main();
`;

export interface FakeClaude {
	dir: string;
	/** Executable + script, for StageRunSpec.command. */
	command: string[];
	/** Environment the fake needs (merge into the run env). */
	env: Record<string, string>;
	childPidFile: string;
	setSteps: (steps: FakeStep[]) => void;
	remainingSteps: () => number;
	calls: () => FakeCall[];
	/** Commands the fake CLI let the agent run (nothing runs for real). */
	executed: () => Array<{ tool: string; command: string }>;
}

export function createFakeClaude(root: string): FakeClaude {
	const dir = join(root, "fake-claude");
	mkdirSync(dir, { recursive: true });
	const script = join(dir, "claude.js");
	const scenario = join(dir, "scenario.json");
	const log = join(dir, "calls.jsonl");
	const childPidFile = join(dir, "child.pid");
	const exec = join(dir, "executed.jsonl");
	writeFileSync(script, SCRIPT, "utf8");
	writeFileSync(scenario, JSON.stringify({ steps: [] }), "utf8");
	writeFileSync(log, "", "utf8");
	writeFileSync(exec, "", "utf8");
	return {
		dir,
		command: [process.execPath, script],
		env: {
			FAKE_SCENARIO: scenario,
			FAKE_LOG: log,
			FAKE_CHILD_PID: childPidFile,
			FAKE_EXEC: exec,
		},
		childPidFile,
		setSteps: (steps) =>
			writeFileSync(scenario, JSON.stringify({ steps }), "utf8"),
		remainingSteps: () =>
			(JSON.parse(readFileSync(scenario, "utf8")) as { steps: unknown[] }).steps
				.length,
		calls: () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as FakeCall),
		executed: () =>
			readFileSync(exec, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { tool: string; command: string }),
	};
}

/**
 * A spawn that only runs the fake script (or a check command through the
 * test's own shell) from the temp folder. Anything else, such as a real
 * `claude` or `codex`, fails the test.
 */
export function guardedSpawn(fake: FakeClaude, allowedShells: string[] = []) {
	const allowedRoot = resolve(tmpdir()).toLowerCase();
	return ((executable: string, args: readonly string[], options: object) => {
		const isFake =
			executable === process.execPath &&
			resolve(String(args[0] ?? "")).toLowerCase() ===
				resolve(fake.command[1]).toLowerCase();
		const isShell = allowedShells.includes(executable);
		if (/(^|[\\/])(claude|codex)(\.exe|\.cmd)?$/i.test(executable)) {
			throw new Error(`Test tried to run a real model CLI: ${executable}`);
		}
		if (!isFake && !isShell) {
			throw new Error(`Test tried to run an unexpected program: ${executable}`);
		}
		if (
			isFake &&
			!resolve(fake.command[1]).toLowerCase().startsWith(allowedRoot)
		) {
			throw new Error("The fake claude must live in the temp folder");
		}
		return spawn(executable, args as string[], options) as ChildProcess;
	}) as unknown as typeof spawn;
}

/** Make any network call fail the test. Returns a restore function. */
export function blockNetwork(): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: unknown) => {
		throw new Error(`Test tried to reach the network: ${String(input)}`);
	}) as unknown as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function waitFor(
	test: () => boolean,
	timeoutMs = 10_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!test()) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return true;
}
