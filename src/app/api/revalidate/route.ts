import { revalidateTag } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { CALENDAR_TAG } from "@/lib/calendar";
import { STANDINGS_TAG } from "@/lib/championship";

/**
 * On-demand cache invalidation, for the proxy to call.
 *
 * The calendar and standings pages are ISR with long windows (six hours and
 * one hour), which is right for crawlers but wrong the moment something
 * actually changes — a schedule correction, or a race being scored. The proxy
 * already knows when that happens, so it can drop the tag here instead of
 * everyone waiting out the window.
 *
 * Only the tags below are accepted. `revalidateTag` takes any string, and an
 * endpoint that forwards an arbitrary one lets a caller with the secret
 * invalidate anything in the data cache, including things added later.
 */
const ALLOWED: readonly string[] = [CALENDAR_TAG, STANDINGS_TAG];

export async function POST(request: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET;

  // No secret configured means the endpoint is not in use. Answering 404
  // rather than 500 keeps it indistinguishable from a route that is not there.
  if (!secret) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // The header keeps the secret out of request bodies and access logs that
  // record them.
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
