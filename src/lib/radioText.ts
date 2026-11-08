import { RadioCapture } from "@/types/f1";

/**
 * The caption to show for a radio clip, in the viewer's language.
 *
 * Falls back to the verbatim transcript: the translation pass runs after the
 * transcription one and can be missing (older cached clip, or a failed call),
 * and showing what was actually said beats showing nothing.
 */
export function radioCaption(
  radio: Pick<RadioCapture, "transcript" | "transcriptEn" | "transcriptEs">,
  language: "es" | "en",
): string | undefined {
  const preferred = language === "en" ? radio.transcriptEn : radio.transcriptEs;
  return preferred || radio.transcript || undefined;
}
