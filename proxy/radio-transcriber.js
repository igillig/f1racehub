/**
 * Team radio transcription, in English and Spanish.
 *
 * Every radio clip the dashboard shows is a URL to a short mp3. This module
 * turns that into text with OpenAI's speech-to-text API, renders it in both
 * site languages, and caches the lot in SQLite keyed by the clip URL: a replay
 * loop (or a second viewer, or a proxy restart) never pays for the same clip
 * twice.
 *
 * Flow: a source pushes a clip into `state.team_radio` -> calls `enrichRadios`
 * -> cached text is attached in place immediately, anything missing is queued
 * -> when a job finishes, the entry gets its `transcript` fields and the state
 * is re-broadcast. Nothing here ever blocks the live path.
 *
 * The clip is transcribed verbatim (a Spanish radio stays Spanish), then
 * translated so the UI can show whichever language the viewer picked:
 *   transcript     — what was actually said
 *   transcript_en  — English rendering
 *   transcript_es  — Spanish rendering
 */

import path from "path";
import { getRadioTranscript, saveRadioTranscript } from "./session-store.js";

const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const TRANSLATE_MODEL = process.env.OPENAI_TRANSLATE_MODEL || "gpt-4o-mini";
// Radios are multilingual (Sainz/Alonso switch to Spanish, Ferrari to Italian).
// Left unset the model detects; set OPENAI_TRANSCRIBE_LANGUAGE to pin it.
const LANGUAGE = process.env.OPENAI_TRANSCRIBE_LANGUAGE || null;

const CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI's upload limit
const AUDIO_TIMEOUT_MS = 20_000;
const API_TIMEOUT_MS = 60_000;

// Pushes the model towards pit-wall vocabulary instead of the plain English
// words that sound alike.
const PROMPT =
  "Formula 1 team radio between a driver and their race engineer. " +
  "Expect jargon: box box box, in lap, out lap, undercut, overcut, DRS, " +
  "VSC, safety car, yellow flag, blue flags, delta, lift and coast, " +
  "tyre deg, soft, medium, hard, inters, push now, copy that, mode push.";

const TRANSLATE_SYSTEM = [
  "You caption Formula 1 team radio for a live timing dashboard. The input is",
  "one clip transcribed from a driver talking to their race engineer (or the",
  "engineer answering) during a session: noisy, clipped, often mid-thought.",
  'Reply with JSON only: {"en": "...", "es": "..."}.',
  "",
  "`en`: the message in English. If it was spoken in English, repeat it",
  "unchanged — do not clean it up.",
  "",
  "`es`: the message in Latin American Spanish, translated BY MEANING, the way",
  "an F1 broadcast in Latin America would say it. Never word by word: read the",
  "line as racing talk first and then say that in Spanish. 'Slow grip' is",
  "'poco agarre', not 'agarré lento'. 'It's undriveable' is 'es imposible de",
  "manejar'. 'Keep these rears cool' is 'mantén frías las gomas traseras'.",
  "",
  "Rules for `es`:",
  "- Latin American vocabulary: auto (not coche), manejar (not conducir),",
  "  neumáticos o gomas (not ruedas), llamada de boxes. No Spain-isms: vale,",
  "  tío, chaval, coger, vosotros.",
  "- Neutral tuteo (tú/imperativo: entra, mantén, cuida). Never voseo:",
  "  no mantené, entrá, cuidá, tenés.",
  "- Simple past, not the peninsular present perfect: 'fue empeorando', not",
  "  'ha ido empeorando'; 'se cerró', not 'se ha cerrado'.",
  "- Keep the jargon a Spanish-language broadcast keeps in English: box,",
  "  undercut, overcut, DRS, safety car, virtual safety car, pit lane, stint,",
  "  delta, graining, blistering, push.",
  "- Usual Spanish for the rest: grip = agarre, understeer = subviraje,",
  "  oversteer = sobreviraje, tyre deg = degradación, lap = vuelta, out lap =",
  "  vuelta de salida, in lap = vuelta de entrada, lift and coast = levantar y",
  "  rodar, traffic = tráfico, blue flags = banderas azules.",
  "- Drop filler address words (mate, man, buddy) instead of translating them.",
  "- Keep driver names, team names, car numbers and lap numbers exactly.",
  "- Same length and register as the original: this is a caption beside an",
  "  audio clip, not a summary and not an explanation.",
  "- If the transcript is garbled, render the part that makes sense as racing",
  "  talk rather than inventing a meaning.",
  "",
  "Never add commentary, quotes, notes or anything outside the JSON.",
].join("\n");

// Short strings speech models emit for silence or engine noise. Treated as
// "no speech" rather than shown as a caption.
const HALLUCINATIONS = new Set([
  "you",
  "thank you.",
  "thank you",
  "thanks for watching!",
  "subtitles by the amara.org community",
  "bye.",
  ".",
  "...",
]);

// url -> { text, en, es } | PENDING | FAILED
const PENDING = Symbol("pending");
const FAILED = Symbol("failed");
const memo = new Map();

const queue = [];
const queued = new Set(); // urls with a job in flight or waiting
// Translation (not transcription) that failed for good. In memory only: one
// retry per proxy run is fine, an endless re-queue loop is not.
const translateGaveUp = new Set();
let active = 0;

// Latest state/broadcast seen, so a job that finishes late can patch whatever
// the proxy is serving now.
let liveState = null;
let liveBroadcast = null;

export function isTranscriptionEnabled() {
  return (
    !!process.env.OPENAI_API_KEY && process.env.RADIO_TRANSCRIBE !== "false"
  );
}

/**
 * Attach known transcripts to `state.team_radio` and queue the rest.
 * Safe to call on every radio push — cheap and idempotent.
 */
export function enrichRadios(stateRef, broadcastFn) {
  if (!stateRef || !Array.isArray(stateRef.team_radio)) return;
  liveState = stateRef;
  if (broadcastFn) liveBroadcast = broadcastFn;
  if (!isTranscriptionEnabled()) return;

  const sessionKey = stateRef.session?.session_key ?? null;
  let patched = false;

  for (const radio of stateRef.team_radio) {
    const url = radio?.recording_url;
    if (!url) continue;

    const cached = lookup(url);
    if (cached === PENDING || cached === FAILED) continue;

    if (cached) {
      if (apply(radio, cached)) patched = true;
      // Transcribed before the bilingual pass existed, or its translation
      // failed: fill in the missing language without re-sending the audio.
      if (
        cached.text &&
        (!cached.en || !cached.es) &&
        !translateGaveUp.has(url)
      ) {
        enqueue({
          url,
          kind: "translate",
          text: cached.text,
          sessionKey,
          driverNumber: radio.driver_number ?? null,
          utc: radio.date || null,
          context: describeClip(stateRef, radio),
          attempts: 0,
        });
      }
      continue;
    }

    enqueue({
      url,
      kind: "full",
      sessionKey,
      driverNumber: radio.driver_number ?? null,
      utc: radio.date || null,
      context: describeClip(stateRef, radio),
      attempts: 0,
    });
  }

  if (patched && liveBroadcast) liveBroadcast("update", stateRef);
  pump();
}

/**
 * Who said it and when, for the translation prompt: a line is much easier to
 * read as racing talk when you know it is lap 34 of a race and the speaker is
 * the Ferrari driver.
 */
function describeClip(stateRef, radio) {
  const driver = stateRef.drivers?.[String(radio.driver_number)];
  const parts = [];
  if (driver?.name_acronym || radio.driver_number) {
    const who = driver?.name_acronym || `car ${radio.driver_number}`;
    parts.push(driver?.team_name ? `${who} (${driver.team_name})` : who);
  }
  const sessionName = stateRef.session?.session_name;
  if (sessionName) {
    const circuit =
      stateRef.session?.circuit_short_name || stateRef.session?.location;
    parts.push(circuit ? `${sessionName} at ${circuit}` : sessionName);
  }
  const lap = stateRef.lap_count?.current;
  if (lap) parts.push(`lap ${lap}`);
  return parts.join(", ");
}

/** Drops the in-memory cache (the SQLite one survives). */
export function resetTranscriptionCache() {
  memo.clear();
  queue.length = 0;
  queued.clear();
  translateGaveUp.clear();
}

function enqueue(job) {
  if (queued.has(job.url)) return;
  queued.add(job.url);
  if (job.kind === "full") memo.set(job.url, PENDING);
  queue.push(job);
}

/** Writes the three fields onto a state entry. Returns true if it changed. */
function apply(radio, data) {
  let changed = false;
  const fields = {
    transcript: data.text || undefined,
    transcript_en: data.en || undefined,
    transcript_es: data.es || undefined,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value && radio[key] !== value) {
      radio[key] = value;
      changed = true;
    }
  }
  return changed;
}

function lookup(url) {
  const inMemory = memo.get(url);
  if (inMemory !== undefined) return inMemory;

  let row = null;
  try {
    row = getRadioTranscript(url);
  } catch (err) {
    console.warn(`[radio-tx] DB lookup failed: ${err.message}`);
  }
  if (!row) return undefined;

  if (row.status === "ok" || row.status === "empty") {
    const data = {
      text: row.status === "ok" ? row.text || "" : "",
      en: row.text_en || "",
      es: row.text_es || "",
    };
    memo.set(url, data);
    return data;
  }
  // A previous run gave up on this clip — don't burn attempts forever.
  if ((row.attempts || 0) >= MAX_ATTEMPTS) {
    memo.set(url, FAILED);
    return FAILED;
  }
  return undefined;
}

function pump() {
  while (active < CONCURRENCY && queue.length > 0) {
    // Newest clip first: on a bulk historical load the one at the top of the
    // list is the one the viewer is looking at.
    const job = queue.pop();
    active++;
    runJob(job)
      .catch(() => {})
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function runJob(job) {
  try {
    const text =
      job.kind === "translate" ? job.text : await transcribeClip(job.url);

    if (!text) {
      memo.set(job.url, { text: "", en: "", es: "" });
      persist(job, { text: "", en: null, es: null }, "empty");
      queued.delete(job.url);
      return;
    }

    const { en, es } = await translate(text, job.context);
    const data = { text, en: en || "", es: es || "" };

    memo.set(job.url, data);
    persist(job, { text, en: en || null, es: es || null }, "ok");
    applyToLiveState(job.url, data);
    queued.delete(job.url);
    console.log(`[radio-tx] #${job.driverNumber ?? "?"}: ${text.slice(0, 90)}`);
  } catch (err) {
    job.attempts++;
    if (job.attempts < MAX_ATTEMPTS) {
      console.warn(
        `[radio-tx] attempt ${job.attempts}/${MAX_ATTEMPTS} failed (${err.message}) — retrying`,
      );
      const timer = setTimeout(() => {
        queue.unshift(job);
        pump();
      }, RETRY_DELAY_MS);
      timer.unref?.();
      return;
    }
    console.error(`[radio-tx] giving up on ${job.url}: ${err.message}`);
    queued.delete(job.url);
    if (job.kind === "translate") {
      // The transcript itself is fine — only the translation is missing. The
      // UI falls back to the original words, so leave the row as it is.
      translateGaveUp.add(job.url);
      return;
    }
    memo.set(job.url, FAILED);
    persist(job, { text: "", en: null, es: null }, "failed");
  }
}

function persist(job, data, status) {
  try {
    saveRadioTranscript({
      url: job.url,
      sessionKey: job.sessionKey,
      driverNumber: job.driverNumber,
      utc: job.utc,
      text: data.text,
      textEn: data.en,
      textEs: data.es,
      model: MODEL,
      status,
      attempts: 1,
    });
  } catch (err) {
    console.warn(`[radio-tx] DB write failed: ${err.message}`);
  }
}

function applyToLiveState(url, data) {
  if (!liveState || !Array.isArray(liveState.team_radio)) return;
  const entry = liveState.team_radio.find((r) => r?.recording_url === url);
  // The clip may have aged out of the 30-item window while we were working.
  if (!entry) return;
  if (apply(entry, data) && liveBroadcast) liveBroadcast("update", liveState);
}

async function transcribeClip(url) {
  const buffer = await fetchAudio(url);
  const form = new FormData();
  let name = "radio.mp3";
  try {
    name = path.basename(new URL(url).pathname) || name;
  } catch {
    /* keep the default */
  }
  form.append("file", new Blob([buffer], { type: "audio/mpeg" }), name);
  form.append("model", MODEL);
  form.append("response_format", "json");
  form.append("prompt", PROMPT);
  if (LANGUAGE) form.append("language", LANGUAGE);

  const res = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`openai stt ${res.status}: ${detail}`);
  }
  const json = await res.json();
  const raw = typeof json.text === "string" ? json.text : "";
  const text = sanitise(raw);
  if (!text && raw.trim()) {
    // Kept visible: this is the noise filter firing, and a real radio line
    // landing here is the one way it can go wrong.
    console.log(`[radio-tx] discarded as noise: ${raw.trim().slice(0, 60)}`);
  }
  return text;
}

async function fetchAudio(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "f1-dashboard" },
    signal: AbortSignal.timeout(AUDIO_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`audio ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("empty audio");
  if (buf.length > MAX_AUDIO_BYTES) throw new Error("audio too large");
  return buf;
}

/** One call for both languages — the clip is a sentence, not a document. */
async function translate(text, context) {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: TRANSLATE_SYSTEM },
        // Who is speaking and when, so the model reads the line as part of a
        // session instead of as a stray sentence. Data, not instructions.
        {
          role: "user",
          content: context
            ? `Context: ${context}\nTranscript: ${text}`
            : `Transcript: ${text}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`openai translate ${res.status}: ${detail}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  return {
    en: typeof parsed.en === "string" ? parsed.en.trim() : "",
    es: typeof parsed.es === "string" ? parsed.es.trim() : "",
  };
}

function sanitise(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (HALLUCINATIONS.has(clean.toLowerCase())) return "";
  return clean;
}
