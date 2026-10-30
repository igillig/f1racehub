import { revalidateTag } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { CALENDAR_TAG } from "@/lib/calendar";
import { STANDINGS_TAG } from "@/lib/championship";

/**
 * On-demand cache invalidation for the proxy to call, so a schedule correction
 * or a scored race does not wait out the ISR window.
 *
 * Allow-listed on purpose: `revalidateTag` takes any string, and forwarding an
 * arbitrary one would let a caller with the secret drop anything in the cache.
 */
const ALLOWED: readonly string[] = [CALENDAR_TAG, STANDINGS_TAG];

export async function POST(request: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET;

  // Unconfigured means unused; 404 keeps it indistinguishable from absent.
  if (!secret) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // A header keeps the secret out of bodies and access logs.
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const tag =
    typeof body === "object" && body !== null && "tag" in body
      ? (body as { tag: unknown }).tag
      : null;

  if (typeof tag !== "string" || !ALLOWED.includes(tag)) {
    return NextResponse.json(
      { error: "tag must be one of: " + ALLOWED.join(", ") },
      { status: 400 },
    );
  }

  revalidateTag(tag);

  return NextResponse.json({ revalidated: tag, now: Date.now() });
}
