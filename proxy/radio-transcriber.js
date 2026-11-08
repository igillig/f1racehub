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
// gpt-transcribe is the current recommended STT model ($0.0045/min) and the
// only one that takes `keywords`, which is what keeps "we take the hard" from
// coming out as "we take the jar" on a noisy clip. The gpt-4o-* transcribe
// models still work through this env var but are deprecated upstream.
const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-transcribe";
const SUPPORTS_KEYWORDS = MODEL.startsWith("gpt-transcribe");
const TRANSLATE_MODEL = process.env.OPENAI_TRANSLATE_MODEL || "gpt-4o-mini";
// Team radio is conducted in English — that is the working language on the
// pit wall, and it is what the feed carries.
//
// Saying so matters: left to detect freely, the model sometimes decides a
// noisy English clip is Welsh or Dutch and the whole line comes out as
// nonsense. Declaring the language removes that failure mode outright.
//
// OPENAI_TRANSCRIBE_LANGUAGES takes a comma-separated list if a session ever
// needs more (a driver switching to Spanish or Italian would otherwise come
// back as an English approximation of what they said, not their own words).
const LANGUAGE = process.env.OPENAI_TRANSCRIBE_LANGUAGE || null;
const EXPECTED_LANGUAGES = (process.env.OPENAI_TRANSCRIBE_LANGUAGES || "en")
  .split(",")
  .map((code) => code.trim())
  .filter(Boolean);

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

// Literal terms the model should expect to hear. Sent as `keywords` to
// gpt-transcribe; folded into the prompt for the older models.
const JARGON_KEYWORDS = [
  "box box box",
  "in lap",
  "out lap",
  "undercut",
  "overcut",
  "DRS",
  "VSC",
  "safety car",
  "virtual safety car",
  "yellow flag",
  "blue flags",
  "red flag",
  "chequered flag",
  "delta",
  "lift and coast",
  "deg",
  "graining",
  "blistering",
  "front wing",
  "rear wing",
  "understeer",
  "oversteer",
  "balance",
  "soft",
  "medium",
  "hard",
  "inters",
  "wets",
  "slicks",
  "compound",
  "stint",
  "pit lane",
  "pit wall",
  "engine mode",
  "strat mode",
  "push now",
  "copy that",
  "affirm",
  "negative",
  "standby",
  "plan A",
  "plan B",
  "track limits",
  "harvesting",
  "overtake mode",
];

const TRANSLATE_SYSTEM = [
  "You caption Formula 1 team radio for a live timing dashboard. The input is",
  "one clip transcribed from a driver talking to their race engineer (or the",
  "engineer answering) during a session: noisy, clipped, often mid-thought.",
  "",
  "Reply with JSON only, in this shape:",
  '{"segments": [{"speaker": "driver", "en": "...", "es": "..."}]}',
  "",
  "Split the clip into one segment per speaking turn, in order. Most clips",
  "are a single turn — then return exactly one segment. Only split when the",
  "words clearly change speaker, and never split one person's sentence.",
  "",
  "`speaker` is who is talking in that turn:",
  '- "driver": the one driving. Reports how the car feels (grip, balance,',
  "  understeer, brakes, tyres), complains, asks what is happening, answers",
  "  an instruction (copy, understood, yeah).",
  '- "engineer": the pit wall. Gives instructions and information: box this',
  "  lap, target delta, mode changes, gaps and positions, who is behind,",
  "  flags, weather, we are checking, well done.",
  '- "unknown": genuinely impossible to tell. Use it sparingly — the context',
  "  line names the driver, so a first-person report about the car is the",
  "  driver and an instruction aimed at them is the engineer.",
  "",
  "`en`: that turn in English, essentially as spoken. Keep the clipped,",
  "unpolished register; do not tidy the grammar or add words.",
  "",
  "The transcript comes from noisy audio and DOES contain mis-heard words.",
  "When a word makes no sense on a pit-to-car radio but one racing word is",
  'the obvious match by sound, use that word in both languages: "we take the',
  'jar" is "we take the hard" (the hard tyre), "boss boss" is "box box",',
  '"Dallas" next to a lap time is "delta". Only when the fix is obvious —',
  "never guess at a new fact, a name, a number or an instruction that is not",
  "there. If a stretch stays unintelligible, leave it as it is in `en` and",
  "render it vaguely in `es` rather than inventing a literal meaning for it:",
  "an implausible noun (jarabe, sandía) in a radio caption is always wrong.",
  "",
  "`es`: that turn in Latin American Spanish, translated BY MEANING, the way",
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
  "- If the turn was already spoken in Spanish, keep the speaker's own words",
  "  instead of re-wording them; only swap Spain-isms for the neutral term.",
  "  Same for `en` when the turn was spoken in English. Nothing is ever",
  "  translated twice: both fields come from the original words.",
  "- Keep driver names, team names, car numbers and lap numbers exactly.",
  "- Same length and register as the original: this is a caption beside an",
  "  audio clip, not a summary and not an explanation.",
  "- If the transcript is garbled, render the part that makes sense as racing",
  "  talk rather than inventing a meaning.",
  "",
  "- Translate each turn on its own, but read the whole clip first: a reply",
  "  often only makes sense next to the instruction before it.",
  "",
  "Never add commentary, quotes, notes, speaker names inside the text, or",
  "anything outside the JSON.",
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
      // `segments` missing entirely = cached before the speaker split
      // existed; re-run the text-only pass to fill it in.
      if (
        cached.text &&
        (!cached.en || !cached.es || !Array.isArray(cached.segments)) &&
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
      keywords: clipKeywords(stateRef),
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

/**
 * Literal terms to prime the transcription with: the jargon list plus the
 * names actually on track this session. Driver surnames and team names are
 * exactly what a noisy clip mangles, and they are the words a caption is
 * read for.
 */
function clipKeywords(stateRef) {
  const names = new Set();
  for (const driver of Object.values(stateRef.drivers || {})) {
    if (driver?.name_acronym) names.add(driver.name_acronym);
    if (driver?.full_name) {
      const surname = String(driver.full_name).trim().split(/\s+/).pop();
      if (surname && surname.length > 2) names.add(surname);
    }
    if (driver?.team_name) names.add(driver.team_name);
  }
  const circuit =
    stateRef.session?.circuit_short_name || stateRef.session?.location;
  if (circuit) names.add(circuit);
  // Keyword values may not contain line breaks or angle brackets, or the
  // whole request is rejected.
  return [...JARGON_KEYWORDS, ...names]
    .map((k) =>
      String(k)
        .replace(/[<>\r\n]/g, " ")
        .trim(),
    )
    .filter(Boolean);
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
  // Who said what, in order. Only worth sending when the clip actually has
  // two voices — a single turn is already covered by the flat fields.
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (segments.length > 1) {
    const serialised = JSON.stringify(segments);
    if (JSON.stringify(radio.transcript_segments) !== serialised) {
      radio.transcript_segments = segments;
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
    // null (not []) when the column is empty: that is how a row cached
    // before the speaker split is told apart from one with a single turn.
    let segments = null;
    if (row.segments) {
      try {
        const parsed = JSON.parse(row.segments);
        if (Array.isArray(parsed)) segments = parsed;
      } catch {
        /* a malformed row just means no turn split */
      }
    }
    const data = {
      text: row.status === "ok" ? row.text || "" : "",
      en: row.text_en || "",
      es: row.text_es || "",
      segments,
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
      job.kind === "translate" ? job.text : await transcribeClip(job.url, job);

    if (!text) {
      memo.set(job.url, { text: "", en: "", es: "", segments: [] });
      persist(job, { text: "", en: null, es: null, segments: null }, "empty");
      queued.delete(job.url);
      return;
    }

    const { en, es, segments } = await translate(text, job.context);
    const data = { text, en: en || "", es: es || "", segments };

    memo.set(job.url, data);
    persist(job, { text, en: en || null, es: es || null, segments }, "ok");
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
    persist(job, { text: "", en: null, es: null, segments: null }, "failed");
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
      segments: data.segments && data.segments.length ? data.segments : null,
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

async function transcribeClip(url, job) {
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

  const keywords = job?.keywords?.length ? job.keywords : JARGON_KEYWORDS;
  if (SUPPORTS_KEYWORDS) {
    // Structured term hints — far stronger than naming them in the prompt.
    for (const keyword of keywords) form.append("keywords[]", keyword);
    form.append(
      "prompt",
      job?.context ? `${PROMPT} This clip: ${job.context}.` : PROMPT,
    );
    // `languages` replaces the singular `language` on this model; sending
    // both is rejected.
    const expected = LANGUAGE ? [LANGUAGE] : EXPECTED_LANGUAGES;
    for (const code of expected) form.append("languages[]", code);
  } else {
    form.append(
      "prompt",
      [
        PROMPT,
        job?.context ? `This clip: ${job.context}.` : "",
        keywords.join(", "),
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (LANGUAGE) form.append("language", LANGUAGE);
  }

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

  const ROLES = new Set(["driver", "engineer", "unknown"]);
  const segments = Array.isArray(parsed.segments)
    ? parsed.segments
        .map((seg) => ({
          speaker: ROLES.has(seg?.speaker) ? seg.speaker : "unknown",
          en: typeof seg?.en === "string" ? seg.en.trim() : "",
          es: typeof seg?.es === "string" ? seg.es.trim() : "",
        }))
        .filter((seg) => seg.en || seg.es)
    : [];
  if (segments.length === 0) throw new Error("translate returned no segments");

  return {
    segments,
    // Flat renderings stay the contract for anything that shows one line.
    en: segments
      .map((seg) => seg.en)
      .filter(Boolean)
      .join(" "),
    es: segments
      .map((seg) => seg.es)
      .filter(Boolean)
      .join(" "),
  };
}

function sanitise(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (HALLUCINATIONS.has(clean.toLowerCase())) return "";
  return clean;
}
