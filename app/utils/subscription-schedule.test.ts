import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SCHEDULE_CONFIG,
  addInterval,
  addMonths,
  computeBillingTime,
  computeDeliveryDate,
  cyclesPerMonth,
  localYmd,
  nextDeliverableDate,
  parseWeekday,
  planCycle,
  projectCycles,
  validateDeliveryDate,
  weekdayOf,
  zonedTimeToUtc,
  type ScheduleConfig,
} from "./subscription-schedule";

const cfg = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  ...DEFAULT_SCHEDULE_CONFIG,
  ...over,
});

describe("calendar math", () => {
  it("clamps month-end and does not drift when computed from the anchor", () => {
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addInterval("2026-01-31", "MONTH", 1, 2), "2026-03-31");
    assert.equal(addInterval("2026-01-31", "MONTH", 1, 3), "2026-04-30");
  });

  it("handles leap years and year rollover", () => {
    assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
    assert.equal(addMonths("2026-11-15", 3), "2027-02-15");
    assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  });

  it("adds weekly intervals", () => {
    assert.equal(addInterval("2026-10-16", "WEEK", 2, 1), "2026-10-30");
    assert.equal(weekdayOf("2026-10-16"), 5); // Friday
  });
});

describe("timezones", () => {
  it("converts local wall time to UTC (Asia/Kolkata, UTC+5:30)", () => {
    assert.equal(zonedTimeToUtc("2026-11-03", 6, "Asia/Kolkata").toISOString(), "2026-11-03T00:30:00.000Z");
  });

  it("respects DST (America/New_York)", () => {
    assert.equal(zonedTimeToUtc("2026-03-07", 9, "America/New_York").toISOString(), "2026-03-07T14:00:00.000Z");
    assert.equal(zonedTimeToUtc("2026-03-09", 9, "America/New_York").toISOString(), "2026-03-09T13:00:00.000Z");
  });

  it("returns the local calendar date for an instant", () => {
    // 20:00Z is already the next day in Kolkata
    assert.equal(localYmd(new Date("2026-10-16T20:00:00Z"), "Asia/Kolkata"), "2026-10-17");
    assert.equal(localYmd(new Date("2026-10-16T20:00:00Z"), "America/New_York"), "2026-10-16");
  });
});

describe("delivery rules", () => {
  it("skips weekdays the shop does not deliver on (Sunday)", () => {
    assert.equal(weekdayOf("2026-11-01"), 0);
    assert.equal(nextDeliverableDate("2026-11-01", cfg()), "2026-11-02");
  });

  it("skips blackout dates", () => {
    assert.equal(nextDeliverableDate("2026-11-02", cfg({ blackoutDates: ["2026-11-02"] })), "2026-11-03");
  });

  it("moves forward to the preferred weekday, never backwards", () => {
    assert.equal(nextDeliverableDate("2026-11-02", cfg(), 5), "2026-11-06"); // Mon -> Fri
    assert.equal(nextDeliverableDate("2026-11-06", cfg(), 5), "2026-11-06"); // already Fri
  });

  it("ignores a preferred weekday the shop cannot deliver on", () => {
    assert.equal(nextDeliverableDate("2026-11-02", cfg(), 0), "2026-11-02");
  });

  it("never loops forever when delivery is impossible", () => {
    assert.equal(nextDeliverableDate("2026-11-02", cfg({ deliveryWeekdays: [] })), "2026-11-02");
  });

  it("combines cadence, weekday and blackout for a monthly plan", () => {
    const cadence = { anchorDate: "2026-10-16", interval: "MONTH", intervalCount: 1, preferredWeekday: 3 };
    // 16 Nov (Mon) -> Wednesday 18 Nov
    assert.equal(computeDeliveryDate(cadence, 1, cfg()), "2026-11-18");
    assert.equal(computeDeliveryDate(cadence, 1, cfg({ blackoutDates: ["2026-11-18"] })), "2026-11-25");
  });
});

describe("billing time", () => {
  it("charges lead-time days before delivery at the billing hour (local)", () => {
    const at = computeBillingTime("2026-11-18", cfg({ leadTimeDays: 2, billingHour: 6 }));
    assert.equal(at.toISOString(), "2026-11-16T00:30:00.000Z"); // 16 Nov 06:00 IST
  });
});

describe("planCycle", () => {
  const cadence = { anchorDate: "2026-10-16", interval: "MONTH", intervalCount: 1 };

  it("plans the first renewal one interval after the anchor", () => {
    const p = planCycle(cadence, 1, cfg(), new Date("2026-10-16T05:00:00Z"));
    assert.equal(p.step, 1);
    assert.equal(p.deliveryDate, "2026-11-16");
    assert.equal(p.billingAt.toISOString(), "2026-11-14T00:30:00.000Z");
    assert.equal(p.skippedSteps, 0);
  });

  it("skips cycles whose billing time already elapsed (e.g. resume after a long pause)", () => {
    const p = planCycle(cadence, 1, cfg(), new Date("2027-01-20T00:00:00Z"));
    assert.equal(p.step, 4); // Feb 16 2027
    assert.equal(p.deliveryDate, "2027-02-16");
    assert.equal(p.skippedSteps, 3);
  });

  it("projects consecutive cycles", () => {
    const list = projectCycles(cadence, 1, 3, cfg());
    assert.deepEqual(
      list.map((c) => c.deliveryDate),
      ["2026-11-16", "2026-12-16", "2027-01-16"],
    );
  });
});

describe("validateDeliveryDate", () => {
  const now = new Date("2026-10-16T05:00:00Z");

  it("accepts a valid future date", () => {
    assert.equal(validateDeliveryDate("2026-11-18", cfg(), now), null);
  });

  it("rejects malformed dates, blocked weekdays and holidays", () => {
    assert.match(validateDeliveryDate("18/11/2026", cfg(), now) ?? "", /valid date/);
    assert.match(validateDeliveryDate("2026-11-01", cfg(), now) ?? "", /Sunday/);
    assert.match(validateDeliveryDate("2026-11-18", cfg({ blackoutDates: ["2026-11-18"] }), now) ?? "", /holiday/);
  });

  it("rejects dates whose charge would fall inside the cut-off window", () => {
    // Delivery Mon 19 Oct -> billed 17 Oct 06:00 IST = 16 Oct 00:30Z... in the past
    assert.match(validateDeliveryDate("2026-10-19", cfg(), now) ?? "", /Too soon/);
  });
});

describe("helpers", () => {
  it("parses weekdays", () => {
    assert.equal(parseWeekday("3"), 3);
    assert.equal(parseWeekday("Friday"), 5);
    assert.equal(parseWeekday("sun"), 0);
    assert.equal(parseWeekday(""), null);
    assert.equal(parseWeekday("xyz"), null);
  });

  it("estimates deliveries per month", () => {
    assert.ok(Math.abs(cyclesPerMonth("MONTH", 1) - 1) < 0.001);
    assert.ok(Math.abs(cyclesPerMonth("WEEK", 2) - 2.17) < 0.01);
  });
});
