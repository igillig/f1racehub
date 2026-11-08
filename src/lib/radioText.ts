import { RadioCapture, RadioSegment } from "@/types/f1";

type Lang = "es" | "en";
type RadioText = Pick<
  RadioCapture,
  "transcript" | "transcriptEn" | "transcriptEs" | "transcriptSegments"
>;

/** One turn ready to render: who spoke and what they said, already localised. */
export interface RadioTurn {
  speaker: RadioSegment["speaker"];
  text: string;
}

/**
 * The whole clip as one line, in the viewer's language.
 *
 * Falls back to the verbatim transcript: the translation pass runs after the
 * transcription one and can be missing (older cached clip, or a failed call),
 * and showing what was actually said beats showing nothing.
 */
export function radioCaption(
  radio: RadioText,
  language: Lang,
): string | undefined {
  const preferred = language === "en" ? radio.transcriptEn : radio.transcriptEs;
  return preferred || radio.transcript || undefined;
}

/**
 * The clip split by speaker, when the proxy could tell two voices apart.
 *
 * Returns a single unlabelled turn for the usual one-voice clip, so callers
 * can render one code path. Empty when there is nothing to show yet.
 */
export function radioTurns(radio: RadioText, language: Lang): RadioTurn[] {
  const segments = radio.transcriptSegments;
  if (segments && segments.length > 1) {
    const turns = segments
      .map((seg) => ({
        speaker: seg.speaker,
        text: (language === "en" ? seg.en : seg.es) || seg.en || seg.es || "",
      }))
      .filter((turn) => turn.text);
    if (turns.length > 0) return turns;
  }

  const caption = radioCaption(radio, language);
  return caption ? [{ speaker: "unknown", text: caption }] : [];
}
