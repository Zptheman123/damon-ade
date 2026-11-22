import { useCallback, useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

export type VoiceState =
	| { kind: "idle" }
	| { kind: "starting" }
	| { kind: "recording"; seconds: number; level: number }
	| { kind: "transcribing" }
	| { kind: "error"; message: string };

const RATE = 16_000;
const MAX_SECONDS = 120;

/** Float32 samples at the device rate → 16 kHz 16-bit mono WAV, base64. */
function encodeWav(chunks: Float32Array[], inputRate: number): string {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const ratio = inputRate / RATE;
	const length = Math.floor(total / ratio);
	const samples = new Int16Array(length);
	let i = 0;
	let pos = 0;
	const flat = new Float32Array(total);
	for (const c of chunks) {
		flat.set(c, pos);
		pos += c.length;
	}
	for (; i < length; i++) {
		const v = Math.max(-1, Math.min(1, flat[Math.floor(i * ratio)] ?? 0));
		samples[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
	}
	const buffer = new ArrayBuffer(44 + samples.length * 2);
	const view = new DataView(buffer);
	const text = (offset: number, s: string) => {
		for (let k = 0; k < s.length; k++)
			view.setUint8(offset + k, s.charCodeAt(k));
	};
	text(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	text(8, "WAVE");
	text(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, RATE, true);
	view.setUint32(28, RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, "data");
	view.setUint32(40, samples.length * 2, true);
	new Int16Array(buffer, 44).set(samples);
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let k = 0; k < bytes.length; k += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
	}
	return btoa(binary);
}

/**
 * Dictation into a composer's draft: start asks for the microphone, the
 * button shows it is listening, stop transcribes (on this computer) and
 * hands the text over; cancel throws the recording away. Nothing is sent
 * by itself, and the microphone is released whenever recording ends or the
 * composer goes away.
 */
export function useVoiceDictation(onText: (text: string) => void) {
	const { data: status } = electronTrpc.voice.status.useQuery(undefined, {
		staleTime: Number.POSITIVE_INFINITY,
	});
	const transcribe = electronTrpc.voice.transcribe.useMutation();
	const [state, setState] = useState<VoiceState>({ kind: "idle" });
	const session = useRef<{
		stream: MediaStream;
		context: AudioContext;
		processor: ScriptProcessorNode;
		chunks: Float32Array[];
		timer: ReturnType<typeof setInterval>;
		started: number;
	} | null>(null);

	const release = useCallback(() => {
		const s = session.current;
		session.current = null;
		if (!s) return;
		clearInterval(s.timer);
		s.processor.disconnect();
		for (const track of s.stream.getTracks()) track.stop();
		void s.context.close();
	}, []);

	// Never keep the microphone after the composer goes away.
	useEffect(() => release, [release]);

	const stop = useCallback(async () => {
		const s = session.current;
		if (!s) return;
		const chunks = s.chunks;
		const rate = s.context.sampleRate;
		release();
		if (chunks.reduce((n, c) => n + c.length, 0) < rate * 0.4) {
			setState({
				kind: "error",
				message: "That was too short to hear anything.",
			});
			return;
		}
		setState({ kind: "transcribing" });
		try {
			const { text } = await transcribe.mutateAsync({
				wavBase64: encodeWav(chunks, rate),
			});
			if (!text.trim()) {
				setState({
					kind: "error",
					message:
						"No speech was recognized. Try again, closer to the microphone.",
				});
				return;
			}
			onText(text.trim());
			setState({ kind: "idle" });
		} catch (error) {
			setState({
				kind: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}, [release, transcribe, onText]);

	const start = useCallback(async () => {
		if (session.current) return;
		if (status && !status.available) {
			setState({
				kind: "error",
				message: status.reason ?? "Dictation is not available here.",
			});
			return;
		}
		setState({ kind: "starting" });
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (error) {
			const name = (error as DOMException)?.name;
			setState({
				kind: "error",
				message:
					name === "NotAllowedError"
						? "Microphone access was denied. Allow it for ADE in Windows Settings › Privacy & security › Microphone."
						: name === "NotFoundError"
							? "No microphone was found."
							: `The microphone could not be opened: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}
		const context = new AudioContext();
		const source = context.createMediaStreamSource(stream);
		const processor = context.createScriptProcessor(4096, 1, 1);
		const chunks: Float32Array[] = [];
		let level = 0;
		processor.onaudioprocess = (event) => {
			const data = event.inputBuffer.getChannelData(0);
			chunks.push(new Float32Array(data));
			let peak = 0;
			for (let k = 0; k < data.length; k += 64)
				peak = Math.max(peak, Math.abs(data[k] ?? 0));
			level = peak;
		};
		source.connect(processor);
		processor.connect(context.destination);
		const started = Date.now();
		const timer = setInterval(() => {
			const seconds = Math.floor((Date.now() - started) / 1000);
			setState({ kind: "recording", seconds, level });
			if (seconds >= MAX_SECONDS) void stop();
		}, 200);
		session.current = { stream, context, processor, chunks, timer, started };
		setState({ kind: "recording", seconds: 0, level: 0 });
	}, [status, stop]);

	const cancel = useCallback(() => {
		release();
		setState({ kind: "idle" });
	}, [release]);

	return {
		state,
		available: status?.available ?? true,
		engine: status?.engine,
		unavailableReason: status?.reason,
		start,
		stop,
		cancel,
		dismiss: () => setState({ kind: "idle" }),
	};
}
