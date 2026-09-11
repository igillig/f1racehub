import { NextRequest, NextResponse } from "next/server";

// Contact form → email to the site owner via Resend's HTTP API.
// Env: RESEND_API_KEY (required), CONTACT_TO_EMAIL (required),
//      CONTACT_FROM_EMAIL (optional; Resend's onboarding sender by default —
//      it can only deliver to the Resend account owner's address, which is
//      exactly what a contact form needs, and avoids domain verification).

export const runtime = "nodejs";

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "F1 RaceHub <onboarding@resend.dev>";

const MAX_NAME = 80;
const MAX_EMAIL = 120;
const MAX_MESSAGE = 3000;
const MIN_MESSAGE = 10;

// Per-IP rate limit (in-memory; fine for a single-instance deploy)
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 3;
const hits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  // Opportunistic cleanup so the map doesn't grow forever
  if (hits.size > 1000) {
    hits.forEach((times, key) => {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
    });
  }
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface ContactBody {
  name?: unknown;
  email?: unknown;
  message?: unknown;
  website?: unknown; // honeypot — real users never fill it
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL;
  if (!apiKey || !to) {
    console.error("[contact] RESEND_API_KEY / CONTACT_TO_EMAIL not configured");
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  let body: ContactBody;
  try {
    body = (await req.json()) as ContactBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Honeypot hit: pretend success so bots don't learn anything
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return NextResponse.json({ ok: true });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (
    name.length === 0 ||
    name.length > MAX_NAME ||
    email.length > MAX_EMAIL ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    message.length < MIN_MESSAGE ||
    message.length > MAX_MESSAGE
  ) {
    return NextResponse.json({ error: "invalid_fields" }, { status: 400 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const subject = `[F1 RaceHub] Contacto de ${name}`;
  const text = `Nombre: ${name}\nEmail: ${email}\nIP: ${ip}\n\n${message}`;
  const html = `<p><strong>Nombre:</strong> ${escapeHtml(name)}<br/>
<strong>Email:</strong> ${escapeHtml(email)}<br/>
<strong>IP:</strong> ${escapeHtml(ip)}</p>
<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(message)}</pre>`;

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM_EMAIL || DEFAULT_FROM,
        to: [to],
        reply_to: email,
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      console.error("[contact] Resend error", res.status, await res.text());
      return NextResponse.json({ error: "send_failed" }, { status: 502 });
    }
  } catch (err) {
    console.error("[contact] Resend request failed", err);
    return NextResponse.json({ error: "send_failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
