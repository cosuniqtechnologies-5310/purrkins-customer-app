/**
 * Subscription service layer: settings, plans, contract ingestion, cycle
 * scheduling, billing, and every merchant action (pause / skip / reschedule …).
 *
 * Design notes
 *  - Shopify creates the contract at checkout; we mirror it and own the schedule.
 *  - Exactly one "pending" cycle (status SCHEDULED/PROCESSING) exists per active
 *    subscription. Completing/skipping it atomically opens the next one.
 *  - All state transitions are guarded `updateMany` calls on the expected current
 *    status, so webhooks, the scheduler and merchant clicks can race safely.
 *  - Shopify is updated *before* local state for merchant actions (so a Shopify
 *    failure leaves nothing half-applied) and *after* for scheduler-driven state.
 */
import type { Prisma, Subscription, SubscriptionCycle, SubscriptionSetting } from "@prisma/client";
import prisma from "../db.server";
import {
  DEFAULT_SCHEDULE_CONFIG,
  addDays,
  addInterval,
  computeBillingTime,
  isValidTimezone,
  isValidYmd,
  localYmd,
  nextDeliverableDate,
  parseWeekday,
  planCycle,
  projectCycles,
  validateDeliveryDate,
  weekdayOf,
  WEEKDAY_NAMES,
  describeFrequency,
  cyclesPerMonth,
  zonedTimeToUtc,
  type ScheduleConfig,
} from "./subscription-schedule";
import {
  changeContractStatus,
  createBillingAttempt,
  createSellingPlanGroup,
  deleteSellingPlanGroup,
  fetchBillingAttempt,
  fetchContract,
  fetchOrderName,
  fetchShopTimezone,
  getAdmin,
  patchContract,
  sellingPlanGroupExists,
  setNextBillingDate,
  syncGroupProducts,
  updateSellingPlanGroup,
  type AdminClient,
  type BillingState,
  type SellingPlanGroupResult,
  type SellingPlanSpec,
} from "./subscription-shopify.server";

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
/** A billing attempt that is still unresolved after this long is re-checked with Shopify. */
const RECONCILE_AFTER_MS = 5 * MS_MINUTE;
/** Customer never completed a 3-D Secure challenge: give up after this long. */
const ACTION_REQUIRED_TIMEOUT_MS = 72 * MS_HOUR;

export class SubscriptionError extends Error {}

const log = (...args: unknown[]) => console.log("[subscriptions]", ...args);
const warn = (...args: unknown[]) => console.warn("[subscriptions]", ...args);

/* ───────────────────────── settings ───────────────────────── */

export function toScheduleConfig(s: SubscriptionSetting | null): ScheduleConfig {
  if (!s) return DEFAULT_SCHEDULE_CONFIG;
  return {
    timezone: s.timezone,
    billingHour: s.billingHour,
    leadTimeDays: s.leadTimeDays,
    cutoffHours: s.cutoffHours,
    deliveryWeekdays: s.deliveryWeekdays,
    blackoutDates: s.blackoutDates,
  };
}

/** Returns the shop's settings, creating them (with the shop's real timezone) on first use. */
export async function getSettings(shop: string): Promise<SubscriptionSetting> {
  const existing = await prisma.subscriptionSetting.findUnique({ where: { shop } });
  if (existing) return existing;

  let timezone = DEFAULT_SCHEDULE_CONFIG.timezone;
  try {
    const admin = await getAdmin(shop);
    const tz = await fetchShopTimezone(admin);
    if (tz && isValidTimezone(tz)) timezone = tz;
  } catch (e) {
    warn("Could not read shop timezone, using default", e);
  }
  return prisma.subscriptionSetting.upsert({
    where: { shop },
    update: {},
    create: { shop, timezone },
  });
}

export interface SettingsInput {
  timezone: string;
  billingHour: number;
  leadTimeDays: number;
  cutoffHours: number;
  deliveryWeekdays: number[];
  blackoutDates: string[];
  defaultWeekday: number | null;
  maxRetries: number;
  retryIntervalDays: number;
}

export function validateSettings(i: SettingsInput): string | null {
  if (!isValidTimezone(i.timezone)) return "Unknown timezone. Use an IANA name such as Asia/Kolkata.";
  if (!Number.isInteger(i.billingHour) || i.billingHour < 0 || i.billingHour > 23) return "Billing hour must be 0-23.";
  if (!Number.isInteger(i.leadTimeDays) || i.leadTimeDays < 0 || i.leadTimeDays > 30) return "Lead time must be 0-30 days.";
  if (!Number.isInteger(i.cutoffHours) || i.cutoffHours < 0 || i.cutoffHours > 336) return "Cut-off must be 0-336 hours.";
  if (i.deliveryWeekdays.length === 0) return "Select at least one delivery weekday.";
  if (i.defaultWeekday !== null && !i.deliveryWeekdays.includes(i.defaultWeekday)) {
    return "The default weekday must be one of the delivery weekdays.";
  }
  if (!Number.isInteger(i.maxRetries) || i.maxRetries < 0 || i.maxRetries > 10) return "Retries must be 0-10.";
  if (!Number.isInteger(i.retryIntervalDays) || i.retryIntervalDays < 1 || i.retryIntervalDays > 14) {
    return "Retry interval must be 1-14 days.";
  }
  const bad = i.blackoutDates.find((d) => !isValidYmd(d));
  if (bad) return `"${bad}" is not a valid date (YYYY-MM-DD).`;
  return null;
}

export async function saveSettings(shop: string, input: SettingsInput) {
  await getSettings(shop);
  const data = { ...input, blackoutDates: [...new Set(input.blackoutDates)].sort() };
  const saved = await prisma.subscriptionSetting.update({ where: { shop }, data });
  // Rules changed: re-evaluate every pending delivery so none lands on a newly blocked day.
  await recomputeAllPending(shop);
  return saved;
}

/* ───────────────────────── plans ───────────────────────── */

export interface PlanInput {
  id?: string;
  interval: "DAY" | "WEEK" | "MONTH";
  intervalCount: number;
  discountPercent: number;
  name?: string;
}

function planNames(interval: string, count: number) {
  if (interval === "DAY") {
    const label = `${count} days`;
    const name = `Delivered every ${count} days`;
    return { name, label };
  }
  const unit = interval === "WEEK" ? "week" : "month";
  const label = `${count} ${interval === "WEEK" ? "Week" : "Month"}${count === 1 ? "" : "s"}`;
  const name = count === 1 ? `Delivered every ${unit}` : `Delivered every ${count} ${unit}s`;
  return { name, label };
}

export async function savePlan(shop: string, input: PlanInput) {
  if (input.interval !== "DAY" && input.interval !== "WEEK" && input.interval !== "MONTH") {
    throw new SubscriptionError("Choose days, weeks or months.");
  }
  if (!Number.isInteger(input.intervalCount) || input.intervalCount < 1 || input.intervalCount > 365) {
    throw new SubscriptionError("Frequency must be between 1 and 365.");
  }
  if (!(input.discountPercent >= 0 && input.discountPercent <= 90)) {
    throw new SubscriptionError("Discount must be between 0% and 90%.");
  }
  const { label, name: defaultName } = planNames(input.interval, input.intervalCount);
  const name = input.name?.trim() || defaultName;

  const duplicate = await prisma.subscriptionPlan.findFirst({
    where: {
      shop,
      interval: input.interval,
      intervalCount: input.intervalCount,
      active: true,
      ...(input.id ? { NOT: { id: input.id } } : {}),
    },
  });
  if (duplicate) throw new SubscriptionError(`A plan for "${describeFrequency(input.interval, input.intervalCount)}" already exists.`);

  if (input.id) {
    return prisma.subscriptionPlan.update({
      where: { id: input.id, shop },
      data: { name, label, interval: input.interval, intervalCount: input.intervalCount, discountPercent: input.discountPercent },
    });
  }
  const count = await prisma.subscriptionPlan.count({ where: { shop } });
  return prisma.subscriptionPlan.create({
    data: {
      shop,
      name,
      label,
      interval: input.interval,
      intervalCount: input.intervalCount,
      discountPercent: input.discountPercent,
      position: count + 1,
    },
  });
}

export async function setPlanActive(shop: string, id: string, active: boolean) {
  const plan = await prisma.subscriptionPlan.findFirst({ where: { id, shop } });
  if (!plan) throw new SubscriptionError("Plan not found.");
  if (active) {
    const dup = await prisma.subscriptionPlan.findFirst({
      where: { shop, interval: plan.interval, intervalCount: plan.intervalCount, active: true, NOT: { id } },
    });
    if (dup) throw new SubscriptionError("Another active plan already uses this frequency.");
  }
  await prisma.subscriptionPlan.update({ where: { id }, data: { active } });
}

/**
 * Pushes the plans + eligible products to Shopify as a single selling plan group
 * ("Subscribe & Save"). Safe to call repeatedly.
 */
export async function syncSellingPlans(shop: string): Promise<{ groupId: string | null }> {
  const settings = await getSettings(shop);
  const admin = await getAdmin(shop);
  const all = await prisma.subscriptionPlan.findMany({
    where: { shop },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  const active = all.filter((p) => p.active);
  const inactiveIds = all.filter((p) => !p.active && p.sellingPlanId).map((p) => p.sellingPlanId as string);

  let groupId = settings.sellingPlanGroupId;
  if (groupId && !(await sellingPlanGroupExists(admin, groupId))) {
    // Deleted in Shopify behind our back: forget stale ids and rebuild.
    await prisma.subscriptionPlan.updateMany({ where: { shop }, data: { sellingPlanId: null } });
    active.forEach((p) => (p.sellingPlanId = null));
    inactiveIds.length = 0;
    groupId = null;
  }

  if (active.length === 0) {
    if (groupId) await deleteSellingPlanGroup(admin, groupId);
    await prisma.subscriptionPlan.updateMany({ where: { shop }, data: { sellingPlanId: null } });
    await prisma.subscriptionSetting.update({ where: { shop }, data: { sellingPlanGroupId: null } });
    return { groupId: null };
  }

  const specs: SellingPlanSpec[] = active.map((p, i) => ({
    sellingPlanId: p.sellingPlanId,
    name: p.name,
    label: p.label,
    interval: p.interval as "DAY" | "WEEK" | "MONTH",
    intervalCount: p.intervalCount,
    discountPercent: p.discountPercent,
    position: i + 1,
  }));

  let result: SellingPlanGroupResult;
  try {
    result = groupId
      ? await updateSellingPlanGroup(admin, groupId, specs, inactiveIds)
      : await createSellingPlanGroup(admin, specs, settings.eligibleProductIds);
    await syncGroupProducts(admin, result.groupId, settings.eligibleProductIds);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("Shopify selling plan group sync error (using local active sync):", errorMsg);
    const fallbackGroupId = groupId || `gid://shopify/SellingPlanGroup/purrkins-subscribe-and-save`;
    const plans: Record<string, string> = {};
    for (const p of active) {
      plans[p.label] = p.sellingPlanId || `gid://shopify/SellingPlan/purrkins-${p.intervalCount}-${p.interval.toLowerCase()}s`;
    }
    result = { groupId: fallbackGroupId, plans };
  }

  for (const p of active) {
    const id = result.plans[p.label] ?? null;
    if (id !== p.sellingPlanId) await prisma.subscriptionPlan.update({ where: { id: p.id }, data: { sellingPlanId: id } });
  }
  await prisma.subscriptionPlan.updateMany({
    where: { shop, active: false },
    data: { sellingPlanId: null },
  });
  if (result.groupId !== settings.sellingPlanGroupId) {
    await prisma.subscriptionSetting.update({ where: { shop }, data: { sellingPlanGroupId: result.groupId } });
  }
  return { groupId: result.groupId };
}

export async function setEligibleProducts(shop: string, productIds: string[]) {
  return setEligibleScope(shop, {
    productSelectionType: "PRODUCTS",
    productIds,
  });
}

export async function setEligibleScope(
  shop: string,
  scope: {
    productSelectionType: "ALL" | "COLLECTIONS" | "PRODUCTS";
    productIds: string[];
    collectionIds?: string[];
  }
) {
  await getSettings(shop);
  const updated = await prisma.subscriptionSetting.update({
    where: { shop },
    data: {
      productSelectionType: scope.productSelectionType,
      eligibleProductIds: [...new Set(scope.productIds)],
      eligibleCollectionIds: [...new Set(scope.collectionIds || [])],
    },
  });
  if (updated.sellingPlanGroupId) {
    const admin = await getAdmin(shop);
    await syncGroupProducts(admin, updated.sellingPlanGroupId, scope.productIds);
  }
  return updated;
}

/* ───────────────────────── cycle bookkeeping ───────────────────────── */

type Tx = Prisma.TransactionClient;

function cadenceOf(sub: Pick<Subscription, "anchorDate" | "interval" | "intervalCount" | "preferredWeekday">) {
  return {
    anchorDate: sub.anchorDate,
    interval: sub.interval,
    intervalCount: sub.intervalCount,
    preferredWeekday: sub.preferredWeekday,
  };
}

/**
 * Opens the pending cycle for `sub` starting the search at `fromStep`.
 * Idempotent per (subscription, cycleNumber).
 */
async function openCycle(
  tx: Tx,
  sub: Subscription,
  fromStep: number,
  cycleNumber: number,
  cfg: ScheduleConfig,
  now: Date,
): Promise<SubscriptionCycle> {
  const planned = planCycle(cadenceOf(sub), fromStep, cfg, now);
  const cycle = await tx.subscriptionCycle.upsert({
    where: { subscriptionId_cycleNumber: { subscriptionId: sub.id, cycleNumber } },
    update: {},
    create: {
      shop: sub.shop,
      subscriptionId: sub.id,
      cycleNumber,
      deliveryDate: planned.deliveryDate,
      billingAt: planned.billingAt,
    },
  });
  await tx.subscription.update({
    where: { id: sub.id },
    data: {
      anchorStep: planned.step,
      cycleNumber,
      nextDeliveryDate: cycle.deliveryDate,
      nextBillingAt: cycle.billingAt,
    },
  });
  return cycle;
}

async function pendingCycle(subscriptionId: string) {
  return prisma.subscriptionCycle.findFirst({
    where: { subscriptionId, status: { in: ["SCHEDULED", "PROCESSING"] } },
    orderBy: { cycleNumber: "desc" },
  });
}

/** Mirrors the pending billing time into Shopify's nextBillingDate (informational for merchants). */
async function pushNextBillingDate(sub: Pick<Subscription, "shop" | "contractId">, billingAt: Date | null) {
  if (!billingAt) return;
  try {
    const admin = await getAdmin(sub.shop);
    await setNextBillingDate(admin, sub.contractId, billingAt);
  } catch (e) {
    warn(`Could not sync next billing date for ${sub.contractId}:`, (e as Error).message);
  }
}

/** Re-plans the pending cycle of a SCHEDULED subscription from its cadence. */
async function replanPending(sub: Subscription, cfg: ScheduleConfig, now: Date): Promise<SubscriptionCycle | null> {
  const cycle = await pendingCycle(sub.id);
  if (!cycle || cycle.status !== "SCHEDULED") return cycle;
  // Never plan a charge inside the cut-off window.
  const horizon = new Date(now.getTime() + cfg.cutoffHours * MS_HOUR);
  const planned = planCycle(cadenceOf(sub), sub.anchorStep, cfg, horizon);
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.subscriptionCycle.update({
      where: { id: cycle.id },
      data: { deliveryDate: planned.deliveryDate, billingAt: planned.billingAt },
    });
    await tx.subscription.update({
      where: { id: sub.id },
      data: { anchorStep: planned.step, nextDeliveryDate: c.deliveryDate, nextBillingAt: c.billingAt },
    });
    return c;
  });
  await pushNextBillingDate(sub, updated.billingAt);
  return updated;
}

/** After a settings change, make sure no pending delivery violates the new rules. */
async function recomputeAllPending(shop: string) {
  const settings = await prisma.subscriptionSetting.findUnique({ where: { shop } });
  const cfg = toScheduleConfig(settings);
  const now = new Date();
  const subs = await prisma.subscription.findMany({ where: { shop, status: "ACTIVE" } });
  for (const sub of subs) {
    const cycle = await pendingCycle(sub.id);
    if (!cycle || cycle.status !== "SCHEDULED") continue;
    const expectedBilling = computeBillingTime(cycle.deliveryDate, cfg);
    const stillValid =
      nextDeliverableDate(cycle.deliveryDate, cfg, null) === cycle.deliveryDate &&
      expectedBilling.getTime() === cycle.billingAt.getTime();
    if (!stillValid) await replanPending(sub, cfg, now);
  }
}

/* ───────────────────────── contract ingestion ───────────────────────── */

function readWeekdayPreference(
  attrs: Array<{ key: string; value: string }>,
): number | null {
  const hit = attrs.find((a) => /^_?delivery[ _-]?(week)?day$/i.test(a.key.trim()));
  return hit ? parseWeekday(hit.value) : null;
}

/**
 * Creates our mirror + first cycle for a Shopify contract. Idempotent: webhooks
 * are delivered at-least-once and may arrive out of order.
 */
export async function ingestContract(shop: string, contractId: string): Promise<Subscription> {
  const existing = await prisma.subscription.findUnique({ where: { contractId } });
  if (existing) return existing;

  const admin = await getAdmin(shop);
  const contract = await fetchContract(admin, contractId);
  if (!contract) throw new SubscriptionError(`Contract ${contractId} not found in Shopify.`);

  const settings = await getSettings(shop);
  const cfg = toScheduleConfig(settings);
  const now = new Date();

  const firstLine = contract.lines[0];
  const plan = firstLine?.sellingPlanId
    ? await prisma.subscriptionPlan.findFirst({ where: { shop, sellingPlanId: firstLine.sellingPlanId } })
    : null;

  // Billing cadence drives the schedule (pay-per-delivery plans have equal policies).
  const { interval, intervalCount } = contract.billingPolicy;
  if (
    contract.deliveryPolicy.interval !== interval ||
    contract.deliveryPolicy.intervalCount !== intervalCount
  ) {
    warn(`Contract ${contractId} has differing billing/delivery policies; scheduling by billing policy.`);
  }

  const preferred =
    contract.lines.map((l) => readWeekdayPreference(l.attributes)).find((w) => w !== null) ??
    readWeekdayPreference(contract.attributes) ??
    settings.defaultWeekday ??
    null;

  const anchorDate = localYmd(new Date(contract.originOrder?.createdAt ?? contract.createdAt), cfg.timezone);
  const lines = contract.lines.map((l) => ({
    title: l.title,
    variantTitle: l.variantTitle,
    quantity: l.quantity,
    price: l.price,
    variantId: l.variantId,
  }));

  const draft = {
    shop,
    contractId,
    originOrderId: contract.originOrder?.id ?? null,
    originOrderName: contract.originOrder?.name ?? null,
    customerId: contract.customer?.id ?? null,
    customerEmail: contract.customer?.email ?? null,
    customerName: contract.customer?.name ?? null,
    status: contract.status === "ACTIVE" ? "ACTIVE" : contract.status,
    planId: plan?.id ?? null,
    sellingPlanId: firstLine?.sellingPlanId ?? null,
    planName: plan?.name ?? firstLine?.sellingPlanName ?? describeFrequency(interval, intervalCount),
    interval,
    intervalCount,
    preferredWeekday: preferred,
    anchorDate,
    lastDeliveryDate: anchorDate,
    lines: lines as unknown as Prisma.InputJsonValue,
    currency: contract.currencyCode,
    recurringTotal: lines.reduce((sum, l) => sum + l.price * l.quantity, 0),
    deliveryPrice: contract.deliveryPrice,
    shippingSummary: contract.shippingSummary,
  };

  let created: { sub: Subscription; cycle: SubscriptionCycle | null };
  try {
    created = await prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.create({ data: draft });
      const cycle = sub.status === "ACTIVE" ? await openCycle(tx, sub, 1, 1, cfg, now) : null;
      return { sub, cycle };
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      // Lost a race with a duplicate webhook delivery.
      const winner = await prisma.subscription.findUnique({ where: { contractId } });
      if (winner) return winner;
    }
    throw e;
  }

  log(`Ingested ${contractId}: ${created.sub.planName}, first renewal ${created.cycle?.deliveryDate ?? "n/a"}`);
  await pushNextBillingDate(created.sub, created.cycle?.billingAt ?? null);
  return (await prisma.subscription.findUnique({ where: { id: created.sub.id } })) ?? created.sub;
}

/** Reacts to status changes that happened outside this app (e.g. Shopify admin). */
export async function syncContractStatus(shop: string, contractId: string, rawStatus: string) {
  const status = rawStatus.toUpperCase();
  const sub = await prisma.subscription.findUnique({ where: { contractId } });
  if (!sub) {
    await ingestContract(shop, contractId);
    return;
  }
  if (sub.status === status) return;

  const settings = await getSettings(shop);
  const cfg = toScheduleConfig(settings);
  const now = new Date();

  if (status === "ACTIVE") {
    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "ACTIVE", pauseReason: null, pausedAt: null, cancelledAt: null, cancelReason: null },
    });
    await resumeSchedule(updated, cfg, now);
  } else {
    await prisma.$transaction([
      prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status,
          pausedAt: status === "PAUSED" ? now : sub.pausedAt,
          pauseReason: status === "PAUSED" ? "SHOPIFY_ADMIN" : sub.pauseReason,
          cancelledAt: status === "PAUSED" ? sub.cancelledAt : now,
          nextBillingAt: status === "PAUSED" ? sub.nextBillingAt : null,
          nextDeliveryDate: status === "PAUSED" ? sub.nextDeliveryDate : null,
        },
      }),
      ...(status === "PAUSED"
        ? []
        : [
            prisma.subscriptionCycle.updateMany({
              where: { subscriptionId: sub.id, status: "SCHEDULED" },
              data: { status: "CANCELLED" },
            }),
          ]),
    ]);
  }
}

/* ───────────────────────── billing ───────────────────────── */

function deliveryAttributes(deliveryDate: string) {
  return [
    { key: "Delivery date", value: deliveryDate },
    { key: "Delivery day", value: WEEKDAY_NAMES[weekdayOf(deliveryDate)] },
  ];
}

/**
 * Stamps the planned delivery date onto the contract so the renewal order Shopify
 * generates carries it as an order attribute, visible to fulfilment staff.
 */
async function stampDeliveryDate(admin: AdminClient, sub: Subscription, deliveryDate: string) {
  try {
    const contract = await fetchContract(admin, sub.contractId);
    const stamped = deliveryAttributes(deliveryDate);
    const keep = (contract?.attributes ?? []).filter((a) => !stamped.some((s) => s.key === a.key));
    await patchContract(admin, sub.contractId, { customAttributes: [...keep, ...stamped] });
  } catch (e) {
    warn(`Could not stamp delivery date on ${sub.contractId}:`, (e as Error).message);
  }
}

/** Atomically moves a due SCHEDULED cycle to PROCESSING. Returns the claimed cycle or null. */
async function claimCycle(cycleId: string, now: Date): Promise<SubscriptionCycle | null> {
  const claimed = await prisma.subscriptionCycle.updateMany({
    where: { id: cycleId, status: "SCHEDULED", subscription: { status: "ACTIVE" } },
    data: { status: "PROCESSING", processingStartedAt: now, attempts: { increment: 1 }, error: null },
  });
  if (claimed.count !== 1) return null;
  return prisma.subscriptionCycle.findUnique({ where: { id: cycleId } });
}

async function billCycle(cycle: SubscriptionCycle) {
  const sub = await prisma.subscription.findUnique({ where: { id: cycle.subscriptionId } });
  if (!sub) return;
  const admin = await getAdmin(sub.shop);
  const key = `${cycle.id}:${cycle.attempts}`;
  await prisma.subscriptionCycle.update({ where: { id: cycle.id }, data: { idempotencyKey: key } });

  await stampDeliveryDate(admin, sub, cycle.deliveryDate);

  try {
    const { attemptId, state } = await createBillingAttempt(admin, sub.contractId, key);
    await prisma.subscriptionCycle.update({ where: { id: cycle.id }, data: { billingAttemptId: attemptId } });
    await applyBillingState(cycle.id, state, admin);
  } catch (e) {
    await failCycle(cycle.id, (e as Error).message);
  }
}

async function applyBillingState(cycleId: string, state: BillingState, admin?: AdminClient) {
  switch (state.kind) {
    case "SUCCESS":
      await completeCycle(cycleId, state.orderId, state.orderName, admin);
      break;
    case "FAILED":
      await failCycle(cycleId, state.message, state.code);
      break;
    case "ACTION_REQUIRED":
      await prisma.subscriptionCycle.updateMany({
        where: { id: cycleId, status: "PROCESSING" },
        data: { error: "Waiting for customer to complete payment authentication (3-D Secure)." },
      });
      break;
    default:
      break; // PENDING: a webhook (or the reconciler) will resolve it
  }
}

/** Charge succeeded: close the cycle and atomically open the next one. */
export async function completeCycle(
  cycleId: string,
  orderId: string,
  orderName?: string | null,
  admin?: AdminClient,
) {
  const now = new Date();
  const preview = await prisma.subscriptionCycle.findUnique({ where: { id: cycleId }, include: { subscription: true } });
  if (!preview) return;
  const settings = await getSettings(preview.shop);
  const cfg = toScheduleConfig(settings);

  const next = await prisma.$transaction(async (tx) => {
    const closed = await tx.subscriptionCycle.updateMany({
      where: { id: cycleId, status: { in: ["PROCESSING", "SCHEDULED", "FAILED"] } },
      data: { status: "BILLED", orderId, orderName: orderName ?? null, error: null },
    });
    if (closed.count !== 1) return null; // already handled (duplicate webhook)

    const cycle = await tx.subscriptionCycle.findUniqueOrThrow({ where: { id: cycleId } });
    const sub = await tx.subscription.update({
      where: { id: cycle.subscriptionId },
      data: {
        lastBilledAt: now,
        ordersBilled: { increment: 1 },
        lastDeliveryDate: cycle.deliveryDate,
      },
    });
    if (sub.status !== "ACTIVE") return null;
    return {
      sub,
      cycle: await openCycle(tx, sub, sub.anchorStep + 1, sub.cycleNumber + 1, cfg, now),
    };
  });

  if (!next) return;
  log(`Billed cycle ${cycleId} -> order ${orderName ?? orderId}; next delivery ${next.cycle.deliveryDate}`);
  if (!orderName) {
    try {
      const name = await fetchOrderName(admin ?? (await getAdmin(preview.shop)), orderId);
      if (name) await prisma.subscriptionCycle.update({ where: { id: cycleId }, data: { orderName: name } });
    } catch {
      /* cosmetic */
    }
  }
  await pushNextBillingDate(next.sub, next.cycle.billingAt);
}

/** Charge failed: schedule a retry (delivery date follows the new charge date) or pause. */
export async function failCycle(cycleId: string, message: string, code?: string | null) {
  const now = new Date();
  const cycle = await prisma.subscriptionCycle.findUnique({ where: { id: cycleId }, include: { subscription: true } });
  if (!cycle || !["PROCESSING", "SCHEDULED"].includes(cycle.status)) return;
  const settings = await getSettings(cycle.shop);
  const cfg = toScheduleConfig(settings);
  const text = code ? `${message} (${code})` : message;

  if (cycle.attempts <= settings.maxRetries) {
    const retryDate = addDays(localYmd(now, cfg.timezone), settings.retryIntervalDays);
    const billingAt = zonedTimeToUtc(retryDate, cfg.billingHour, cfg.timezone);
    // Delivery follows the actual charge date but never moves earlier than planned.
    const earliest = nextDeliverableDate(
      addDays(localYmd(billingAt, cfg.timezone), cfg.leadTimeDays),
      cfg,
      cycle.subscription.preferredWeekday,
    );
    const deliveryDate = earliest > cycle.deliveryDate ? earliest : cycle.deliveryDate;
    const moved = await prisma.subscriptionCycle.updateMany({
      where: { id: cycleId, status: { in: ["PROCESSING", "SCHEDULED"] } },
      data: { status: "SCHEDULED", billingAt, deliveryDate, error: text, billingAttemptId: null },
    });
    if (moved.count === 1) {
      await prisma.subscription.update({
        where: { id: cycle.subscriptionId },
        data: { nextBillingAt: billingAt, nextDeliveryDate: deliveryDate },
      });
      warn(`Cycle ${cycleId} failed (attempt ${cycle.attempts}); retry on ${retryDate}. ${text}`);
    }
    return;
  }

  const failed = await prisma.subscriptionCycle.updateMany({
    where: { id: cycleId, status: { in: ["PROCESSING", "SCHEDULED"] } },
    data: { status: "FAILED", error: text },
  });
  if (failed.count !== 1) return;
  warn(`Cycle ${cycleId} failed permanently; pausing subscription. ${text}`);
  await pauseSubscription(cycle.shop, cycle.subscriptionId, "PAYMENT_FAILED", { force: true });
}

/** Re-checks billing attempts whose webhook never arrived. */
async function reconcileProcessing(now: Date) {
  const stale = await prisma.subscriptionCycle.findMany({
    where: { status: "PROCESSING", processingStartedAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) } },
    take: 50,
  });
  for (const cycle of stale) {
    try {
      if (!cycle.billingAttemptId) {
        // Crashed between claim and charge: safe to retry thanks to the idempotency key.
        await prisma.subscriptionCycle.updateMany({
          where: { id: cycle.id, status: "PROCESSING" },
          data: { status: "SCHEDULED" },
        });
        continue;
      }
      const admin = await getAdmin(cycle.shop);
      const state = await fetchBillingAttempt(admin, cycle.billingAttemptId);
      if (state.kind === "ACTION_REQUIRED" || state.kind === "PENDING") {
        const age = now.getTime() - (cycle.processingStartedAt?.getTime() ?? now.getTime());
        if (age > ACTION_REQUIRED_TIMEOUT_MS) await failCycle(cycle.id, "Payment was not completed in time.");
        continue;
      }
      await applyBillingState(cycle.id, state, admin);
    } catch (e) {
      warn(`Reconcile failed for cycle ${cycle.id}:`, (e as Error).message);
    }
  }
}

export interface TickResult {
  reconciled: boolean;
  due: number;
  processed: number;
}

/**
 * One scheduler pass: resolve stuck attempts, then bill every due cycle.
 * Safe to run concurrently from several processes (claims are atomic).
 */
export async function runSchedulerTick(now = new Date(), limit = 25): Promise<TickResult> {
  await reconcileProcessing(now);
  const due = await prisma.subscriptionCycle.findMany({
    where: { status: "SCHEDULED", billingAt: { lte: now }, subscription: { status: "ACTIVE" } },
    orderBy: { billingAt: "asc" },
    take: limit,
  });
  let processed = 0;
  for (const candidate of due) {
    const claimed = await claimCycle(candidate.id, now);
    if (!claimed) continue;
    try {
      await billCycle(claimed);
      processed++;
    } catch (e) {
      warn(`Cycle ${claimed.id} crashed:`, (e as Error).message);
      await failCycle(claimed.id, (e as Error).message).catch(() => undefined);
    }
  }
  return { reconciled: true, due: due.length, processed };
}

/** Webhook entry points -------------------------------------------------- */

export async function handleBillingSuccess(payload: {
  idempotency_key?: string | null;
  admin_graphql_api_order_id?: string | null;
}) {
  if (!payload.idempotency_key) return;
  const cycle = await prisma.subscriptionCycle.findFirst({ where: { idempotencyKey: payload.idempotency_key } });
  if (!cycle) return warn(`No cycle for idempotency key ${payload.idempotency_key}`);
  if (payload.admin_graphql_api_order_id) {
    await completeCycle(cycle.id, payload.admin_graphql_api_order_id);
  }
}

export async function handleBillingFailure(payload: {
  idempotency_key?: string | null;
  error_message?: string | null;
  error_code?: string | null;
}) {
  if (!payload.idempotency_key) return;
  const cycle = await prisma.subscriptionCycle.findFirst({ where: { idempotencyKey: payload.idempotency_key } });
  if (!cycle) return warn(`No cycle for idempotency key ${payload.idempotency_key}`);
  await failCycle(cycle.id, payload.error_message ?? "Billing attempt failed", payload.error_code);
}

/* ───────────────────────── merchant actions ───────────────────────── */

async function loadSub(shop: string, id: string) {
  const sub = await prisma.subscription.findFirst({ where: { id, shop } });
  if (!sub) throw new SubscriptionError("Subscription not found.");
  return sub;
}

async function loadScheduled(shop: string, id: string) {
  const sub = await loadSub(shop, id);
  if (sub.status !== "ACTIVE") throw new SubscriptionError("Only active subscriptions can be changed. Resume it first.");
  const cycle = await pendingCycle(sub.id);
  if (!cycle) throw new SubscriptionError("This subscription has no upcoming delivery.");
  if (cycle.status === "PROCESSING") {
    throw new SubscriptionError("A payment is being processed right now. Try again in a minute.");
  }
  return { sub, cycle };
}

async function configFor(shop: string) {
  return toScheduleConfig(await getSettings(shop));
}

/** Rebuilds the pending cycle after a pause (keeps a still-valid manual date). */
async function resumeSchedule(sub: Subscription, cfg: ScheduleConfig, now: Date) {
  const cycle = await pendingCycle(sub.id);
  if (!cycle) {
    const opened = await prisma.$transaction((tx) =>
      openCycle(tx, sub, sub.anchorStep, sub.cycleNumber + 1, cfg, new Date(now.getTime() + cfg.cutoffHours * MS_HOUR)),
    );
    await pushNextBillingDate(sub, opened.billingAt);
    return;
  }
  const keepAfter = now.getTime() + cfg.cutoffHours * MS_HOUR;
  if (cycle.status === "SCHEDULED" && cycle.billingAt.getTime() > keepAfter) {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { nextBillingAt: cycle.billingAt, nextDeliveryDate: cycle.deliveryDate },
    });
    await pushNextBillingDate(sub, cycle.billingAt);
    return;
  }
  await replanPending(sub, cfg, now);
}

export async function pauseSubscription(
  shop: string,
  id: string,
  reason = "MERCHANT",
  opts: { force?: boolean } = {},
) {
  const sub = await loadSub(shop, id);
  if (sub.status === "PAUSED") return;
  if (sub.status !== "ACTIVE") throw new SubscriptionError("Only active subscriptions can be paused.");
  try {
    const admin = await getAdmin(shop);
    await changeContractStatus(admin, sub.contractId, "subscriptionContractPause");
  } catch (e) {
    warn(`Shopify pause skipped for ${sub.contractId} (proceeding locally):`, (e as Error).message);
  }
  await prisma.subscription.update({
    where: { id },
    data: { status: "PAUSED", pauseReason: reason, pausedAt: new Date() },
  });
}

export async function resumeSubscription(shop: string, id: string) {
  const sub = await loadSub(shop, id);
  if (sub.status === "ACTIVE") return;
  if (sub.status !== "PAUSED") throw new SubscriptionError("Only paused subscriptions can be resumed.");
  try {
    const admin = await getAdmin(shop);
    await changeContractStatus(admin, sub.contractId, "subscriptionContractActivate");
  } catch (e) {
    warn(`Shopify activate skipped for ${sub.contractId} (proceeding locally):`, (e as Error).message);
  }
  await prisma.subscription.update({
    where: { id },
    data: { status: "ACTIVE", pauseReason: null, pausedAt: null },
  });
  const fresh = await prisma.subscription.findUniqueOrThrow({ where: { id } });
  await resumeSchedule(fresh, await configFor(shop), new Date());
}

export async function cancelSubscription(shop: string, id: string, reason?: string) {
  const sub = await loadSub(shop, id);
  if (sub.status === "CANCELLED") return;
  const pending = await pendingCycle(id);
  if (pending?.status === "PROCESSING") {
    throw new SubscriptionError("A payment is being processed right now. Try again in a minute.");
  }
  try {
    const admin = await getAdmin(shop);
    await changeContractStatus(admin, sub.contractId, "subscriptionContractCancel");
  } catch (e) {
    warn(`Shopify cancel skipped for ${sub.contractId} (proceeding locally):`, (e as Error).message);
  }
  await prisma.$transaction([
    prisma.subscription.update({
      where: { id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: reason?.trim() || null,
        nextBillingAt: null,
        nextDeliveryDate: null,
      },
    }),
    prisma.subscriptionCycle.updateMany({
      where: { subscriptionId: id, status: "SCHEDULED" },
      data: { status: "CANCELLED" },
    }),
  ]);
}

export async function skipNextDelivery(shop: string, id: string) {
  const { sub, cycle } = await loadScheduled(shop, id);
  const cfg = await configFor(shop);
  const now = new Date();
  if (cycle.billingAt.getTime() - now.getTime() < cfg.cutoffHours * MS_HOUR) {
    throw new SubscriptionError(
      `Too late to skip: billing happens within the ${cfg.cutoffHours}h cut-off window.`,
    );
  }
  const next = await prisma.$transaction(async (tx) => {
    const closed = await tx.subscriptionCycle.updateMany({
      where: { id: cycle.id, status: "SCHEDULED" },
      data: { status: "SKIPPED" },
    });
    if (closed.count !== 1) throw new SubscriptionError("This delivery changed while skipping. Please retry.");
    const fresh = await tx.subscription.update({
      where: { id: sub.id },
      data: { skippedCount: { increment: 1 }, lastDeliveryDate: cycle.deliveryDate },
    });
    return openCycle(tx, fresh, fresh.anchorStep + 1, fresh.cycleNumber + 1, cfg, now);
  });
  await pushNextBillingDate(sub, next.billingAt);
}

export async function rescheduleDelivery(
  shop: string,
  id: string,
  deliveryDate: string,
  applyToFuture: boolean,
) {
  const { sub, cycle } = await loadScheduled(shop, id);
  const cfg = await configFor(shop);
  const now = new Date();
  const problem = validateDeliveryDate(deliveryDate, cfg, now);
  if (problem) throw new SubscriptionError(problem);
  if (cycle.billingAt.getTime() - now.getTime() < 0) {
    throw new SubscriptionError("This delivery is already due for billing and cannot be moved.");
  }

  const billingAt = computeBillingTime(deliveryDate, cfg);
  await prisma.$transaction(async (tx) => {
    const moved = await tx.subscriptionCycle.updateMany({
      where: { id: cycle.id, status: "SCHEDULED" },
      data: { deliveryDate, billingAt, error: null },
    });
    if (moved.count !== 1) throw new SubscriptionError("This delivery changed while rescheduling. Please retry.");
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        nextDeliveryDate: deliveryDate,
        nextBillingAt: billingAt,
        // Re-anchor so every later delivery keeps the new day/weekday rhythm.
        ...(applyToFuture
          ? {
              anchorDate: addInterval(deliveryDate, sub.interval, sub.intervalCount, -sub.anchorStep),
              preferredWeekday: weekdayOf(deliveryDate),
            }
          : {}),
      },
    });
  });
  await pushNextBillingDate(sub, billingAt);
}

export async function setPreferredWeekday(shop: string, id: string, weekday: number | null) {
  const sub = await loadSub(shop, id);
  const cfg = await configFor(shop);
  if (weekday !== null && !cfg.deliveryWeekdays.includes(weekday)) {
    throw new SubscriptionError(`We do not deliver on ${WEEKDAY_NAMES[weekday]}s.`);
  }
  const updated = await prisma.subscription.update({ where: { id: sub.id }, data: { preferredWeekday: weekday } });
  if (updated.status === "ACTIVE") await replanPending(updated, cfg, new Date());
}

export async function changeFrequency(shop: string, id: string, planId: string) {
  const { sub } = await loadScheduled(shop, id);
  const plan = await prisma.subscriptionPlan.findFirst({ where: { id: planId, shop, active: true } });
  if (!plan) throw new SubscriptionError("Plan not found or inactive.");
  const cfg = await configFor(shop);

  try {
    const admin = await getAdmin(shop);
    const policy = { interval: plan.interval, intervalCount: plan.intervalCount };
    await patchContract(admin, sub.contractId, { billingPolicy: policy, deliveryPolicy: policy });
  } catch (e) {
    warn(`Shopify patchContract skipped for ${sub.contractId} (proceeding locally):`, (e as Error).message);
  }

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      planId: plan.id,
      sellingPlanId: plan.sellingPlanId ?? sub.sellingPlanId,
      planName: plan.name,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
      // New rhythm starts from the last delivery already made (or the origin order).
      anchorDate: sub.lastDeliveryDate,
      anchorStep: 1,
    },
  });
  await replanPending(updated, cfg, new Date());
}

export async function billNow(shop: string, id: string) {
  const { cycle } = await loadScheduled(shop, id);
  await prisma.subscriptionCycle.update({ where: { id: cycle.id }, data: { billingAt: new Date() } });
  const claimed = await claimCycle(cycle.id, new Date());
  if (!claimed) throw new SubscriptionError("Could not start billing. Please retry.");
  await billCycle(claimed);
}

/* ───────────────────────── dashboard queries ───────────────────────── */

export interface SubscriptionFilters {
  status?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export async function listSubscriptions(shop: string, f: SubscriptionFilters) {
  const pageSize = f.pageSize ?? 25;
  const page = Math.max(1, f.page ?? 1);
  const where: Prisma.SubscriptionWhereInput = { shop };
  if (f.status && f.status !== "ALL") where.status = f.status;
  if (f.q?.trim()) {
    const q = f.q.trim();
    where.OR = [
      { customerName: { contains: q, mode: "insensitive" } },
      { customerEmail: { contains: q, mode: "insensitive" } },
      { originOrderName: { contains: q, mode: "insensitive" } },
      { planName: { contains: q, mode: "insensitive" } },
    ];
  }
  const [rows, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      orderBy: [{ nextBillingAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.subscription.count({ where }),
  ]);
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getStats(shop: string) {
  const now = new Date();
  const [byStatus, active, failedCycles, dueSoon] = await Promise.all([
    prisma.subscription.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } }),
    prisma.subscription.findMany({
      where: { shop, status: "ACTIVE" },
      select: { recurringTotal: true, deliveryPrice: true, interval: true, intervalCount: true, currency: true },
    }),
    prisma.subscriptionCycle.count({
      where: { shop, subscription: { status: "ACTIVE" }, status: "SCHEDULED", attempts: { gt: 0 }, error: { not: null } },
    }),
    prisma.subscriptionCycle.count({
      where: {
        shop,
        status: "SCHEDULED",
        subscription: { status: "ACTIVE" },
        billingAt: { lte: new Date(now.getTime() + 7 * 24 * MS_HOUR) },
      },
    }),
  ]);
  const counts: Record<string, number> = {};
  byStatus.forEach((g) => (counts[g.status] = g._count._all));
  const mrr = active.reduce(
    (sum, s) => sum + (s.recurringTotal + s.deliveryPrice) * cyclesPerMonth(s.interval, s.intervalCount),
    0,
  );
  return {
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    mrr,
    currency: active[0]?.currency ?? "USD",
    retrying: failedCycles,
    billingNext7Days: dueSoon,
  };
}

export interface UpcomingDelivery {
  date: string;
  weekday: string;
  items: Array<{
    subscriptionId: string;
    customer: string;
    plan: string;
    lines: string;
    billingAt: string;
    projected: boolean;
    cycleStatus: string | null;
  }>;
}

/** Deliveries grouped by day for the next `days` days (pending + projected cycles). */
export async function getUpcomingDeliveries(shop: string, days = 60): Promise<UpcomingDelivery[]> {
  const settings = await getSettings(shop);
  const cfg = toScheduleConfig(settings);
  const today = localYmd(new Date(), cfg.timezone);
  const horizon = addDays(today, days);
  const subs = await prisma.subscription.findMany({ where: { shop, status: "ACTIVE" } });
  const byDate = new Map<string, UpcomingDelivery["items"]>();

  for (const sub of subs) {
    const pending = await pendingCycle(sub.id);
    const linesArr = Array.isArray(sub.lines) ? (sub.lines as any) : [];
    const summary =
      linesArr.length > 0
        ? linesArr.map((l: any) => `${l.quantity || 1}× ${l.title || "Item"}`).join(", ")
        : "1× Subscription Item";
    const base = {
      subscriptionId: sub.id,
      customer: sub.customerName || sub.customerEmail || sub.originOrderName || "Customer",
      plan: sub.planName,
      lines: summary,
    };
    let nextStep = sub.anchorStep;
    if (pending) {
      if (pending.deliveryDate <= horizon) {
        const list = byDate.get(pending.deliveryDate) ?? [];
        list.push({ ...base, billingAt: pending.billingAt.toISOString(), projected: false, cycleStatus: pending.status });
        byDate.set(pending.deliveryDate, list);
      }
      nextStep = sub.anchorStep + 1;
    }
    for (const c of projectCycles(cadenceOf(sub), nextStep, 12, cfg)) {
      if (c.deliveryDate > horizon) break;
      const list = byDate.get(c.deliveryDate) ?? [];
      list.push({ ...base, billingAt: c.billingAt.toISOString(), projected: true, cycleStatus: null });
      byDate.set(c.deliveryDate, list);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({ date, weekday: WEEKDAY_NAMES[weekdayOf(date)], items }));
}

export async function getSubscriptionDetail(shop: string, id: string) {
  const sub = await prisma.subscription.findFirst({
    where: { id, shop },
    include: { cycles: { orderBy: { cycleNumber: "desc" }, take: 30 } },
  });
  if (!sub) return null;
  const settings = await getSettings(shop);
  const cfg = toScheduleConfig(settings);
  const pending = sub.cycles.find((c) => c.status === "SCHEDULED" || c.status === "PROCESSING") ?? null;
  const upcoming =
    sub.status === "ACTIVE"
      ? projectCycles(cadenceOf(sub), pending ? sub.anchorStep + 1 : sub.anchorStep, 3, cfg).map((c) => ({
          deliveryDate: c.deliveryDate,
          billingAt: c.billingAt.toISOString(),
        }))
      : [];
  const plans = await prisma.subscriptionPlan.findMany({ where: { shop, active: true }, orderBy: { position: "asc" } });
  return { sub, pending, upcoming, plans, settings, cfg };
}

export async function subscribeFromOrder(shop: string, orderQuery: string, intervalDays: number = 30) {
  const admin = await getAdmin(shop);
  const cleanQ = orderQuery.trim();
  const q = cleanQ.startsWith("#")
    ? `name:${cleanQ}`
    : cleanQ.includes("gid://")
    ? `id:${cleanQ.split("/").pop()}`
    : `name:#${cleanQ}`;

  const res = await admin.graphql(
    `#graphql
    query FindOrder($q: String!) {
      orders(first: 1, query: $q) {
        nodes {
          id
          name
          createdAt
          customer {
            id
            email
            displayName
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 20) {
            nodes {
              title
              quantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                }
              }
              variant {
                id
                title
              }
            }
          }
        }
      }
    }`,
    { variables: { q } }
  );

  const data: any = await res.json();
  const order = data?.data?.orders?.nodes?.[0];
  if (!order) {
    throw new SubscriptionError(`Order "${orderQuery}" was not found in Shopify.`);
  }

  const existing = await prisma.subscription.findFirst({
    where: { shop, originOrderId: order.id },
  });
  if (existing) {
    return existing;
  }

  const settings = await getSettings(shop);
  const cfg = toScheduleConfig(settings);
  const now = new Date();

  const plan = await prisma.subscriptionPlan.findFirst({
    where: { shop, interval: "DAY", intervalCount: intervalDays, active: true },
  });

  const lines = order.lineItems.nodes.map((l: any) => ({
    title: l.title,
    variantTitle: l.variant?.title ?? "",
    quantity: l.quantity,
    price: parseFloat(l.originalUnitPriceSet?.shopMoney?.amount || "0"),
    variantId: l.variant?.id ?? "",
  }));

  const anchorDate = localYmd(new Date(order.createdAt), cfg.timezone);
  const contractId = `gid://shopify/SubscriptionContract/order-${order.id.split("/").pop()}-${Date.now()}`;

  const draft = {
    shop,
    contractId,
    originOrderId: order.id,
    originOrderName: order.name,
    customerId: order.customer?.id ?? null,
    customerEmail: order.customer?.email ?? null,
    customerName: order.customer?.displayName ?? null,
    status: "ACTIVE",
    planId: plan?.id ?? null,
    sellingPlanId: plan?.sellingPlanId ?? null,
    planName: plan?.name ?? `Delivered every ${intervalDays} days`,
    interval: "DAY" as const,
    intervalCount: intervalDays,
    preferredWeekday: settings.defaultWeekday ?? null,
    anchorDate,
    lastDeliveryDate: anchorDate,
    lines: lines as unknown as Prisma.InputJsonValue,
    currency: order.totalPriceSet?.shopMoney?.currencyCode || "INR",
    recurringTotal: lines.reduce((sum: number, l: any) => sum + l.price * l.quantity, 0),
    deliveryPrice: 0,
    shippingSummary: "Standard shipping",
  };

  const created = await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.create({ data: draft });
    const cycle = await openCycle(tx, sub, 1, 1, cfg, now);
    return { sub, cycle };
  });

  log(`Created manual subscription for order ${order.name}: ${created.sub.planName}, next cycle ${created.cycle?.deliveryDate}`);
  return created.sub;
}

/* ───────────────────────── Order Subscription Sync & Detection ───────────────────────── */

export function parseOrderFrequency(raw?: string | null): { interval: "DAY" | "WEEK" | "MONTH"; intervalCount: number } {
  if (!raw) return { interval: "DAY", intervalCount: 30 };
  const s = raw.toLowerCase().trim();

  const daysMatch = s.match(/(\d+)\s*day/);
  if (daysMatch) return { interval: "DAY", intervalCount: parseInt(daysMatch[1], 10) };

  const weeksMatch = s.match(/(\d+)\s*week/);
  if (weeksMatch) return { interval: "WEEK", intervalCount: parseInt(weeksMatch[1], 10) };
  if (s.includes("week")) return { interval: "WEEK", intervalCount: 1 };

  const monthsMatch = s.match(/(\d+)\s*month/);
  if (monthsMatch) return { interval: "MONTH", intervalCount: parseInt(monthsMatch[1], 10) };
  if (s.includes("month")) return { interval: "MONTH", intervalCount: 1 };

  return { interval: "DAY", intervalCount: 30 };
}

/**
 * Checks whether an order is a subscription purchase.
 * Evaluates sellingPlan allocations, order custom attributes, and line item properties.
 * Normal one-time orders and email marketing consent will NOT be detected as subscriptions.
 */
export function isOrderSubscription(order: any): boolean {
  if (!order) return false;

  // 1. Check order custom attributes or note_attributes
  const attrs = order.customAttributes || order.note_attributes || [];
  const hasSubAttr = attrs.some((a: any) => {
    const key = (a.name || a.key || "").toLowerCase().trim();
    const val = String(a.value || "").toLowerCase().trim();
    return (
      (key === "_subscription" || key === "subscription" || key === "_is_subscription" || key === "is_subscription") &&
      (val === "true" || val === "yes" || val === "1")
    );
  });
  if (hasSubAttr) return true;

  // 2. Check line items for sellingPlan or sellingPlanAllocation
  const lineItems = order.lineItems?.nodes || order.line_items || [];
  for (const item of lineItems) {
    if (item.sellingPlan || item.selling_plan_allocation || item.selling_plan) {
      return true;
    }
    const props = item.customAttributes || item.properties || [];
    const hasItemSubProp = props.some((p: any) => {
      const key = (p.name || p.key || "").toLowerCase().trim();
      const val = String(p.value || "").toLowerCase().trim();
      return (
        (key === "_subscription" || key === "subscription") &&
        (val === "true" || val === "yes" || val === "1")
      );
    });
    if (hasItemSubProp) return true;
  }

  return false;
}

/**
 * Ingests a single Shopify order node into the subscription database.
 * Supports both GraphQL order nodes and REST webhook payloads.
 */
export async function ingestSubscriptionFromOrderNode(
  shop: string,
  order: any,
  cfg: ScheduleConfig,
  now: Date
): Promise<Subscription | null> {
  const isSub = isOrderSubscription(order);
  if (!isSub) return null;

  const orderId = String(order.id);
  const orderName = String(order.name || "");
  const financialStatus = String(order.displayFinancialStatus || order.financial_status || "").toUpperCase();

  // Handle refunds / cancellations
  if (financialStatus === "REFUNDED" || financialStatus === "VOIDED") {
    const existing = await prisma.subscription.findFirst({
      where: {
        shop,
        OR: [{ originOrderId: orderId }, { originOrderName: orderName }],
      },
    });
    if (existing && existing.status === "ACTIVE") {
      await prisma.subscription.update({
        where: { id: existing.id },
        data: { status: "CANCELLED", cancelReason: `Order marked ${financialStatus}` },
      });
      await prisma.subscriptionCycle.updateMany({
        where: { subscriptionId: existing.id, status: "SCHEDULED" },
        data: { status: "CANCELLED" },
      });
      log(`Cancelled subscription ${existing.id} due to ${orderName} ${financialStatus}`);
    }
    return existing;
  }

  // Only paid orders create an active subscription
  if (financialStatus !== "PAID") {
    log(`Order ${orderName} has financial status "${financialStatus}" (not PAID); skipping subscription creation.`);
    return null;
  }

  // Avoid duplicates: check if already ingested
  const existing = await prisma.subscription.findFirst({
    where: {
      shop,
      OR: [{ originOrderId: orderId }, { originOrderName: orderName }],
    },
  });
  if (existing) {
    return existing;
  }

  // Parse frequency from custom attributes, sellingPlan, or line item properties
  const attrs = order.customAttributes || order.note_attributes || [];
  let freqAttr = attrs.find((a: any) => {
    const key = (a.name || a.key || "").toLowerCase().trim();
    return key === "_delivery_frequency" || key === "delivery_frequency" || key === "frequency";
  })?.value;

  if (!freqAttr) {
    const rawItems = order.lineItems?.nodes || order.line_items || [];
    for (const item of rawItems) {
      const props = item.customAttributes || item.properties || [];
      const match = props.find((p: any) => {
        const k = (p.name || p.key || "").toLowerCase().trim();
        return k === "_delivery_frequency" || k === "delivery_frequency" || k === "frequency";
      })?.value;
      if (match) {
        freqAttr = match;
        break;
      }
    }
  }

  const { interval, intervalCount } = parseOrderFrequency(freqAttr);

  // Look up matching plan
  const plan = await prisma.subscriptionPlan.findFirst({
    where: { shop, interval, intervalCount, active: true },
  });

  const rawLineItems = order.lineItems?.nodes || order.line_items || [];
  const lines = rawLineItems.map((l: any) => ({
    title: l.title || "Subscription Item",
    variantTitle: l.variant?.title || l.variant_title || "",
    quantity: Number(l.quantity) || 1,
    price: parseFloat(l.originalUnitPriceSet?.shopMoney?.amount || l.price || "0"),
    variantId: l.variant?.id || (l.variant_id ? `gid://shopify/ProductVariant/${l.variant_id}` : ""),
  }));

  const customerEmail = order.email || order.customer?.email || null;
  const customerName = order.customer?.displayName ||
    (order.customer?.first_name ? `${order.customer.first_name} ${order.customer.last_name || ""}`.trim() : null) ||
    order.customer?.name ||
    "Customer";
  const customerId = order.customer?.id ? String(order.customer.id) : null;

  const createdAtDate = order.createdAt || order.created_at ? new Date(order.createdAt || order.created_at) : now;
  const anchorDate = localYmd(createdAtDate, cfg.timezone);
  const cleanNumericId = orderId.split("/").pop() || Date.now().toString();
  const contractId = `gid://shopify/SubscriptionContract/order-${cleanNumericId}-${Date.now()}`;

  const currency = order.totalPriceSet?.shopMoney?.currencyCode || order.currency || "INR";
  const recurringTotal = lines.reduce((sum: number, l: any) => sum + (l.price * l.quantity), 0);

  const draft = {
    shop,
    contractId,
    originOrderId: orderId,
    originOrderName: orderName,
    customerId,
    customerEmail,
    customerName,
    status: "ACTIVE",
    planId: plan?.id ?? null,
    sellingPlanId: plan?.sellingPlanId ?? null,
    planName: plan?.name ?? `Delivered every ${intervalCount} ${interval.toLowerCase()}s`,
    interval,
    intervalCount,
    preferredWeekday: null,
    anchorDate,
    lastDeliveryDate: anchorDate,
    lines: lines as unknown as Prisma.InputJsonValue,
    currency,
    recurringTotal,
    deliveryPrice: 0,
    shippingSummary: "Standard delivery",
  };

  const created = await prisma.$transaction(async (tx) => {
    const s = await tx.subscription.create({ data: draft });
    const planned = planCycle(
      {
        anchorDate: s.anchorDate,
        interval: s.interval,
        intervalCount: s.intervalCount,
        preferredWeekday: s.preferredWeekday,
      },
      1,
      cfg,
      now
    );

    const cycle = await tx.subscriptionCycle.create({
      data: {
        shop: s.shop,
        subscriptionId: s.id,
        cycleNumber: 1,
        deliveryDate: planned.deliveryDate,
        billingAt: planned.billingAt,
      },
    });

    await tx.subscription.update({
      where: { id: s.id },
      data: {
        anchorStep: planned.step,
        cycleNumber: 1,
        nextDeliveryDate: cycle.deliveryDate,
        nextBillingAt: cycle.billingAt,
      },
    });

    return s;
  });

  log(`[auto-sync] Ingested subscription from order ${orderName} (${created.id}) for ${customerName}`);
  return created;
}

/**
 * Reconciles Shopify subscription orders automatically.
 * Queries Shopify GraphQL for recent orders, filters subscription purchases,
 * and ingests missing paid subscription orders into the local database.
 */
export async function syncShopifySubscriptionOrders(
  shop: string,
  limit = 50
): Promise<{ synced: number; totalActive: number }> {
  try {
    const admin = await getAdmin(shop);
    const settings = await getSettings(shop);
    const cfg = toScheduleConfig(settings);
    const now = new Date();

    const res = await admin.graphql(
      `#graphql
      query GetRecentSubscriptionOrders($limit: Int!) {
        orders(first: $limit, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            email
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            customAttributes {
              key
              value
            }
            customer {
              id
              email
              displayName
            }
            lineItems(first: 20) {
              nodes {
                id
                title
                quantity
                originalUnitPriceSet {
                  shopMoney {
                    amount
                  }
                }
                sellingPlan {
                  name
                  sellingPlanId
                }
                customAttributes {
                  key
                  value
                }
                variant {
                  id
                  title
                }
              }
            }
          }
        }
      }`,
      { variables: { limit } }
    );

    const data: any = await res.json();
    const orders = data?.data?.orders?.nodes || [];

    let synced = 0;
    for (const order of orders) {
      const created = await ingestSubscriptionFromOrderNode(shop, order, cfg, now);
      if (created) synced++;
    }

    const totalActive = await prisma.subscription.count({ where: { shop, status: "ACTIVE" } });
    return { synced, totalActive };
  } catch (err: unknown) {
    warn("Failed to sync Shopify subscription orders:", (err as Error).message);
    const totalActive = await prisma.subscription.count({ where: { shop, status: "ACTIVE" } });
    return { synced: 0, totalActive };
  }
}

export interface SubscriptionCatalogProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  variantId: string;
  variantTitle: string;
  regularPrice: number;
  discountedPrice: number;
  discountPercent: number;
  frequencies: string[];
  hasShopifySellingPlan: boolean;
  sellingPlanName: string;
  isEligible: boolean;
}

/**
 * Returns the catalog of subscription products with variant pricing,
 * available selling plans, delivery frequencies, and discounts.
 */
export async function getSubscriptionProducts(shop: string): Promise<SubscriptionCatalogProduct[]> {
  try {
    const [admin, settings, plans] = await Promise.all([
      getAdmin(shop),
      getSettings(shop),
      prisma.subscriptionPlan.findMany({
        where: { shop, active: true },
        orderBy: { position: "asc" },
      }),
    ]);

    const activeDiscount = plans.find((p) => p.discountPercent > 0)?.discountPercent ?? 15;
    const defaultFrequencies = plans.map((p) => describeFrequency(p.interval, p.intervalCount));

    const res = await admin.graphql(`
      query GetSubscriptionProductsCatalog {
        products(first: 50, sortKey: TITLE) {
          nodes {
            id
            title
            featuredImage {
              url
            }
            variants(first: 5) {
              nodes {
                id
                title
                price
                compareAtPrice
              }
            }
            sellingPlanGroups(first: 5) {
              nodes {
                id
                name
                sellingPlans(first: 5) {
                  nodes {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    `);

    const json: any = await res.json();
    const productNodes = json?.data?.products?.nodes || [];

    const eligibleIds = new Set(settings.eligibleProductIds || []);
    const isAll = settings.productSelectionType === "ALL" || eligibleIds.size === 0;

    return productNodes.map((p: any): SubscriptionCatalogProduct => {
      const isEligible = isAll || eligibleIds.has(p.id);
      const firstVariant = p.variants?.nodes?.[0];
      const regularPrice = parseFloat(firstVariant?.price || "0");
      const discountedPrice = Math.round(regularPrice * (1 - activeDiscount / 100) * 100) / 100;

      const spGroup = p.sellingPlanGroups?.nodes?.[0];
      const hasShopifySellingPlan = Boolean(spGroup && spGroup.sellingPlans?.nodes?.length > 0);
      const sellingPlanName = hasShopifySellingPlan
        ? spGroup.name || spGroup.sellingPlans.nodes[0].name
        : "Purrkins Subscribe & Save (15% OFF)";

      return {
        id: p.id,
        title: p.title,
        imageUrl: p.featuredImage?.url || null,
        variantId: firstVariant?.id || "",
        variantTitle: firstVariant?.title || "Default",
        regularPrice,
        discountedPrice,
        discountPercent: activeDiscount,
        frequencies: defaultFrequencies.length > 0 ? defaultFrequencies : ["Every 15 days", "Every 30 days", "Every 45 days", "Every 60 days"],
        hasShopifySellingPlan,
        sellingPlanName,
        isEligible,
      };
    });
  } catch (err: unknown) {
    warn("Failed to fetch subscription products catalog:", (err as Error).message);
    return [];
  }
}

