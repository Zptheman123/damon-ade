import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Speech to text for the composers' microphone. On Windows it uses the
 * system's own speech recognizer (System.Speech, the installed language):
 * offline, on this computer, no account and no cost. The audio is a WAV
 * the renderer recorded; it is written to a temporary file, transcribed
 * and deleted. Other systems have no local recognizer wired here, and say
 * so instead of sending audio anywhere.
 */

export interface VoiceStatus {
	available: boolean;
	engine: string;
	/** Why it is not available, and what would make it so. */
	reason?: string;
}

let cached: VoiceStatus | undefined;

const POWERSHELL = "powershell.exe";

export function voiceStatus(): VoiceStatus {
	if (cached) return cached;
	if (process.platform !== "win32") {
		cached = {
			available: false,
			engine: "none",
			reason:
				"Dictation uses Windows' offline speech recognizer, which this system does not have. Your system's own dictation (for example macOS Dictation) still types into the box.",
		};
		return cached;
	}
	const probe = spawnSync(
		POWERSHELL,
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Add-Type -AssemblyName System.Speech; ([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1).Culture.Name",
		],
		{ encoding: "utf8", windowsHide: true, timeout: 15_000 },
	);
	const culture = probe.stdout?.trim();
	cached = culture
		? {
				available: true,
				engine: `Windows speech recognition (${culture}, offline, on this computer)`,
			}
		: {
				available: false,
				engine: "none",
				reason:
					"No Windows speech recognizer is installed. Add one in Settings › Time & language › Speech, then restart ADE.",
			};
	return cached;
}

/** Transcribe a 16-bit PCM WAV. Resolves to the text ("" when nothing was recognized). */
export function transcribeWav(
	wav: Buffer,
	timeoutMs = 90_000,
): Promise<string> {
	const status = voiceStatus();
	if (!status.available) return Promise.reject(new Error(status.reason));
	const dir = mkdtempSync(join(tmpdir(), "ade-voice-"));
	const file = join(dir, "dictation.wav");
	writeFileSync(file, wav);
	const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$recognizer.SetInputToWaveFile($env:ADE_DICTATION_FILE)
$parts = @()
while ($true) {
  # At the end of the audio it returns nothing, or throws "no audio input".
  try { $result = $recognizer.Recognize() } catch { break }
  if ($null -eq $result) { break }
  $parts += $result.Text
}
$recognizer.Dispose()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output ($parts -join ' ')
`;
	return new Promise((resolve, reject) => {
		const child = spawn(
			POWERSHELL,
			["-NoProfile", "-NonInteractive", "-Command", script],
			{
				env: { ...process.env, ADE_DICTATION_FILE: file },
				windowsHide: true,
			},
		);
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Transcription took too long."));
		}, timeoutMs);
		child.stdout.on("data", (d) => {
			out += d.toString();
		});
		child.stderr.on("data", (d) => {
			err += d.toString();
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
			if (code === 0) resolve(out.trim());
			else
				reject(
					new Error(
						`Transcription failed: ${err.trim().split("\n")[0] || `exit ${code}`}`,
					),
				);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
			reject(error);
		});
	});
}
