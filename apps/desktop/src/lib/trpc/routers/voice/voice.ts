import { TRPCError } from "@trpc/server";
import { transcribeWav, voiceStatus } from "main/lib/voice/transcribe";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/** Dictation for the composers: is it available here, and transcribe. */
export const createVoiceRouter = () =>
	router({
		status: publicProcedure.query(() => voiceStatus()),

		/** A recorded WAV (base64) → text. The audio never leaves the computer. */
		transcribe: publicProcedure
			.input(
				z.object({
					wavBase64: z
						.string()
						.min(100)
						.max(30 * 1024 * 1024),
				}),
			)
			.mutation(async ({ input }) => {
				try {
					return {
						text: await transcribeWav(Buffer.from(input.wavBase64, "base64")),
					};
				} catch (error) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}),
	});
