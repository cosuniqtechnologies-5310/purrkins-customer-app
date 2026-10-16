import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { timingSafeEqual } from "node:crypto";
import { tickOnce } from "../utils/subscription-scheduler.server";

/**
 * External trigger for the billing scheduler (e.g. a system cron / uptime pinger).
 *
 *   curl -X POST https://<app>/api/subscriptions/cron -H "Authorization: Bearer $CRON_SECRET"
 *
 * Disabled (503) until CRON_SECRET is set.
 */
function authorized(request: Request): boolean | "disabled" {
  const secret = process.env.CRON_SECRET;
  if (!secret) return "disabled";
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : request.headers.get("x-cron-secret") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: Request) {
  const auth = authorized(request);
  if (auth === "disabled") return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await tickOnce();
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
