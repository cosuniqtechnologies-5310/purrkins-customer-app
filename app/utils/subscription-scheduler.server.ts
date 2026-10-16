/**
 * In-process scheduler for subscription billing.
 *
 * Runs `runSchedulerTick` on an interval. It is safe to run in several
 * processes at once (cycle claims are atomic in the database) and an external
 * cron may additionally hit `/api/subscriptions/cron` (same code path).
 *
 *   SUBSCRIPTION_SCHEDULER = "on" | "off"   default: on in production, off in dev
 *   SUBSCRIPTION_TICK_MS                    default 300000 (5 minutes)
 */
import { runSchedulerTick, type TickResult } from "./subscription.server";

declare global {
  // eslint-disable-next-line no-var
  var __subscriptionSchedulerTimer: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __subscriptionTickRunning: boolean | undefined;
}

/** Runs one tick unless one is already running in this process. */
export async function tickOnce(): Promise<TickResult | { skipped: true }> {
  if (globalThis.__subscriptionTickRunning) return { skipped: true };
  globalThis.__subscriptionTickRunning = true;
  try {
    const result = await runSchedulerTick();
    if (result.due > 0) {
      console.log(`[subscriptions] tick: ${result.processed}/${result.due} due cycles processed`);
    }
    return result;
  } catch (e) {
    console.error("[subscriptions] tick failed:", e);
    throw e;
  } finally {
    globalThis.__subscriptionTickRunning = false;
  }
}

export function startSubscriptionScheduler() {
  if (globalThis.__subscriptionSchedulerTimer) return;

  const flag = process.env.SUBSCRIPTION_SCHEDULER;
  const enabled = flag ? flag === "on" : process.env.NODE_ENV === "production";
  if (!enabled) return;

  const every = Math.max(30_000, Number(process.env.SUBSCRIPTION_TICK_MS) || 5 * 60_000);
  const safeTick = () => tickOnce().catch(() => undefined);

  globalThis.__subscriptionSchedulerTimer = setInterval(safeTick, every);
  globalThis.__subscriptionSchedulerTimer.unref?.();
  setTimeout(safeTick, 30_000).unref?.();
  console.log(`[subscriptions] scheduler started (every ${Math.round(every / 1000)}s)`);
}
