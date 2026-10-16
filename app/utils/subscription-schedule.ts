/**
 * Subscription scheduling engine.
 *
 * Pure functions only (no DB, no Shopify, no `Date.now()`), so every rule that
 * decides *when a customer is charged* and *when it is delivered* is
 * deterministic and unit-testable.
 *
 * Vocabulary
 *  - "ymd"        a calendar date string `YYYY-MM-DD` (no timezone, no time).
 *  - delivery date the calendar day the parcel should arrive.
 *  - billing time  the UTC instant the card is charged:
 *                  (delivery date - leadTimeDays) at `billingHour` in the shop timezone.
 *
 * Rules (applied in this order)
 *  1. Base date  = anchorDate + step * interval. Always computed from the anchor
 *                  so "31 Jan + 1 month" gives 28 Feb, then 31 Mar (not 28 Mar).
 *  2. Weekday    = if the customer has a preferred weekday (and the shop can deliver
 *                  on it) move forward to the next such weekday on/after the base date.
 *  3. Deliverable= skip forward past weekdays the shop does not deliver on and
 *                  past blackout (holiday) dates.
 *  4. Billing    = delivery date minus lead time, at billingHour local time.
 */

export type Interval = "DAY" | "WEEK" | "MONTH" | "YEAR";

export interface ScheduleConfig {
  /** IANA timezone, e.g. "Asia/Kolkata". */
  timezone: string;
  /** Local hour (0-23) at which renewals are charged. */
  billingHour: number;
  /** Charge this many whole days before delivery. */
  leadTimeDays: number;
  /** Changes must be requested at least this many hours before the billing time. */
  cutoffHours: number;
  /** Weekdays (0=Sun..6=Sat) the shop delivers on. */
  deliveryWeekdays: number[];
  /** `YYYY-MM-DD` dates that are never delivered on (holidays). */
  blackoutDates: string[];
}

export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  timezone: "Asia/Kolkata",
  billingHour: 6,
  leadTimeDays: 2,
  cutoffHours: 24,
  deliveryWeekdays: [1, 2, 3, 4, 5, 6],
  blackoutDates: [],
};

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MS_HOUR = 3_600_000;
/** Upper bound for every search loop so a bad config can never hang the server. */
const MAX_SEARCH_DAYS = 400;
const MAX_SEARCH_STEPS = 1000;

/* ───────────────────────── calendar helpers ───────────────────────── */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidYmd(value: unknown): value is string {
  if (typeof value !== "string" || !YMD_RE.test(value)) return false;
  const d = parseYmd(value);
  return !Number.isNaN(d.getTime()) && formatYmd(d) === value;
}

export function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return formatYmd(d);
}

/** Adds calendar months, clamping to the last day of the target month. */
export function addMonths(ymd: string, months: number): string {
  const d = parseYmd(ymd);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const daysInMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, daysInMonth));
  return formatYmd(target);
}

/** `anchor + steps * (count * interval)`. `steps` may be negative. */
export function addInterval(
  anchor: string,
  interval: Interval | string,
  count: number,
  steps: number,
): string {
  const n = count * steps;
  switch (interval) {
    case "DAY":
      return addDays(anchor, n);
    case "WEEK":
      return addDays(anchor, 7 * n);
    case "MONTH":
      return addMonths(anchor, n);
    case "YEAR":
      return addMonths(anchor, 12 * n);
    default:
      throw new Error(`Unsupported interval: ${interval}`);
  }
}

/** Day of week (0=Sun..6=Sat) of a calendar date. */
export function weekdayOf(ymd: string): number {
  return parseYmd(ymd).getUTCDay();
}

export function diffDays(fromYmd: string, toYmd: string): number {
  return Math.round((parseYmd(toYmd).getTime() - parseYmd(fromYmd).getTime()) / 86_400_000);
}

/* ───────────────────────── timezone helpers ───────────────────────── */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timezone, f);
  }
  return f;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date: Date, timezone: string) {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timezone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset (ms) of `timezone` from UTC at the given instant (east = positive). */
function tzOffsetMs(date: Date, timezone: string): number {
  const p = zonedParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The calendar date at `instant` in the given timezone. */
export function localYmd(instant: Date, timezone: string): string {
  const p = zonedParts(instant, timezone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The local clock hour (0-23) at `instant` in the given timezone. */
export function localHour(instant: Date, timezone: string): number {
  return zonedParts(instant, timezone).hour;
}

/**
 * Converts a local wall-clock time (`ymd` + `hour`:00) in `timezone` to the UTC
 * instant. Handles DST transitions by re-checking the offset at the candidate.
 */
export function zonedTimeToUtc(ymd: string, hour: number, timezone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hour, 0, 0);
  let result = wallAsUtc - tzOffsetMs(new Date(wallAsUtc), timezone);
  // Offset may differ at the corrected instant (DST boundary): re-evaluate once.
  const adjusted = wallAsUtc - tzOffsetMs(new Date(result), timezone);
  if (adjusted !== result) result = adjusted;
  return new Date(result);
}

/* ───────────────────────── delivery rules ───────────────────────── */

function usablePreferredWeekday(
  preferred: number | null | undefined,
  cfg: ScheduleConfig,
): number | null {
  if (preferred === null || preferred === undefined) return null;
  return cfg.deliveryWeekdays.includes(preferred) ? preferred : null;
}

/** True when the shop can deliver on this calendar day. */
export function isDeliverable(ymd: string, cfg: ScheduleConfig): boolean {
  return cfg.deliveryWeekdays.includes(weekdayOf(ymd)) && !cfg.blackoutDates.includes(ymd);
}

/**
 * First date on/after `fromYmd` that is deliverable and (when given) falls on the
 * customer's preferred weekday. Never moves backwards. If the configuration makes
 * delivery impossible (e.g. every weekday disabled) it falls back to `fromYmd`.
 */
export function nextDeliverableDate(
  fromYmd: string,
  cfg: ScheduleConfig,
  preferredWeekday?: number | null,
): string {
  const preferred = usablePreferredWeekday(preferredWeekday, cfg);
  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const candidate = addDays(fromYmd, i);
    if (!isDeliverable(candidate, cfg)) continue;
    if (preferred !== null && weekdayOf(candidate) !== preferred) continue;
    return candidate;
  }
  return fromYmd;
}

export interface CadenceInput {
  anchorDate: string;
  interval: Interval | string;
  intervalCount: number;
  preferredWeekday?: number | null;
}

/** Delivery date for cycle `step` (1 = first renewal after the anchor). */
export function computeDeliveryDate(
  cadence: CadenceInput,
  step: number,
  cfg: ScheduleConfig,
): string {
  const base = addInterval(cadence.anchorDate, cadence.interval, cadence.intervalCount, step);
  return nextDeliverableDate(base, cfg, cadence.preferredWeekday);
}

/** The UTC instant at which a delivery on `deliveryYmd` must be charged. */
export function computeBillingTime(deliveryYmd: string, cfg: ScheduleConfig): Date {
  const billDate = addDays(deliveryYmd, -Math.max(0, cfg.leadTimeDays));
  return zonedTimeToUtc(billDate, cfg.billingHour, cfg.timezone);
}

export interface PlannedCycle {
  step: number;
  deliveryDate: string;
  billingAt: Date;
  /** How many cadence steps were passed over because their billing time already elapsed. */
  skippedSteps: number;
}

/**
 * Finds the first cycle at or after `fromStep` whose billing time is still in the
 * future. Used after a cycle completes/is skipped and when a paused subscription
 * resumes (missed cycles are skipped, never charged retroactively).
 */
export function planCycle(
  cadence: CadenceInput,
  fromStep: number,
  cfg: ScheduleConfig,
  now: Date,
): PlannedCycle {
  let last: PlannedCycle | null = null;
  for (let i = 0; i < MAX_SEARCH_STEPS; i++) {
    const step = fromStep + i;
    const deliveryDate = computeDeliveryDate(cadence, step, cfg);
    const billingAt = computeBillingTime(deliveryDate, cfg);
    last = { step, deliveryDate, billingAt, skippedSteps: i };
    if (billingAt.getTime() > now.getTime()) return last;
  }
  return last as PlannedCycle;
}

/** The next `count` cycles from `fromStep` (for calendars / previews). */
export function projectCycles(
  cadence: CadenceInput,
  fromStep: number,
  count: number,
  cfg: ScheduleConfig,
): Array<{ step: number; deliveryDate: string; billingAt: Date }> {
  const out = [];
  for (let i = 0; i < count; i++) {
    const step = fromStep + i;
    const deliveryDate = computeDeliveryDate(cadence, step, cfg);
    out.push({ step, deliveryDate, billingAt: computeBillingTime(deliveryDate, cfg) });
  }
  return out;
}

/**
 * Validates a manual change of the next delivery date. Returns an error message,
 * or `null` when the date is acceptable.
 */
export function validateDeliveryDate(
  deliveryYmd: string,
  cfg: ScheduleConfig,
  now: Date,
): string | null {
  if (!isValidYmd(deliveryYmd)) return "Enter a valid date (YYYY-MM-DD).";
  if (cfg.blackoutDates.includes(deliveryYmd)) {
    return `${deliveryYmd} is a blocked holiday. Choose another date.`;
  }
  if (!cfg.deliveryWeekdays.includes(weekdayOf(deliveryYmd))) {
    return `We do not deliver on ${WEEKDAY_NAMES[weekdayOf(deliveryYmd)]}s.`;
  }
  const billingAt = computeBillingTime(deliveryYmd, cfg);
  const earliestBilling = now.getTime() + cfg.cutoffHours * MS_HOUR;
  if (billingAt.getTime() < earliestBilling) {
    const earliest = nextDeliverableDate(
      addDays(localYmd(new Date(earliestBilling), cfg.timezone), cfg.leadTimeDays + 1),
      cfg,
    );
    return `Too soon: this delivery would be charged ${cfg.cutoffHours}h or less from now. The earliest date is ${earliest}.`;
  }
  return null;
}

/* ───────────────────────── misc helpers ───────────────────────── */

/** Parses "1", "mon", "Monday" into 0-6, or null. */
export function parseWeekday(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim().toLowerCase();
  if (/^[0-6]$/.test(s)) return Number(s);
  const idx = WEEKDAY_NAMES.findIndex((n) => n.toLowerCase().startsWith(s.slice(0, 3)));
  return s.length >= 3 && idx >= 0 ? idx : null;
}

/** Human label such as "Every 2 weeks" / "Every month". */
export function describeFrequency(interval: string, count: number): string {
  const unit = interval.toLowerCase();
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

/** Approximate number of deliveries per 30 days, for MRR estimates. */
export function cyclesPerMonth(interval: string, count: number): number {
  const days: Record<string, number> = { DAY: 1, WEEK: 7, MONTH: 30.4375, YEAR: 365.25 };
  const length = (days[interval] ?? 30.4375) * Math.max(1, count);
  return 30.4375 / length;
}
