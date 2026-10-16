import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSettings, saveSettings, validateSettings } from "../utils/subscription.server";
import { WEEKDAY_NAMES } from "../utils/subscription-schedule";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getSettings(shop);

  return { shop, settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  try {
    const timezone = String(formData.get("timezone") || "Asia/Kolkata").trim();
    const billingHour = parseInt(String(formData.get("billingHour") || "6"), 10);
    const leadTimeDays = parseInt(String(formData.get("leadTimeDays") || "2"), 10);
    const cutoffHours = parseInt(String(formData.get("cutoffHours") || "24"), 10);
    const maxRetries = parseInt(String(formData.get("maxRetries") || "3"), 10);
    const retryIntervalDays = parseInt(String(formData.get("retryIntervalDays") || "2"), 10);

    const weekdaysRaw = formData.getAll("deliveryWeekdays").map((w) => parseInt(String(w), 10));
    const deliveryWeekdays = weekdaysRaw.length > 0 ? weekdaysRaw.sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6];

    const defaultWeekdayRaw = formData.get("defaultWeekday");
    const defaultWeekday =
      defaultWeekdayRaw === "" || defaultWeekdayRaw === "null" || defaultWeekdayRaw === null
        ? null
        : parseInt(String(defaultWeekdayRaw), 10);

    const blackoutDatesRaw = formData.get("blackoutDatesJson");
    let blackoutDates: string[] = [];
    if (blackoutDatesRaw) {
      try {
        blackoutDates = JSON.parse(String(blackoutDatesRaw));
      } catch {
        // fallback
      }
    }

    const input = {
      timezone,
      billingHour,
      leadTimeDays,
      cutoffHours,
      deliveryWeekdays,
      blackoutDates,
      defaultWeekday,
      maxRetries,
      retryIntervalDays,
    };

    const validationError = validateSettings(input);
    if (validationError) {
      return { success: false, message: validationError };
    }

    await saveSettings(shop, input);

    return {
      success: true,
      message: "Delivery and billing rules saved! All pending subscriber cycles have been re-validated.",
    };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : "Failed to save settings." };
  }
};

export default function SubscriptionSettings() {
  const { settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const nav = useNavigation();
  const isBusy = nav.state !== "idle";

  const [timezone, setTimezone] = useState(settings.timezone || "Asia/Kolkata");
  const [billingHour, setBillingHour] = useState(settings.billingHour ?? 6);
  const [leadTimeDays, setLeadTimeDays] = useState(settings.leadTimeDays ?? 2);
  const [cutoffHours, setCutoffHours] = useState(settings.cutoffHours ?? 24);
  const [deliveryWeekdays, setDeliveryWeekdays] = useState<number[]>(
    settings.deliveryWeekdays || [1, 2, 3, 4, 5, 6]
  );
  const [defaultWeekday, setDefaultWeekday] = useState<string>(
    settings.defaultWeekday !== null ? String(settings.defaultWeekday) : "null"
  );
  const [blackoutDates, setBlackoutDates] = useState<string[]>(settings.blackoutDates || []);
  const [newBlackoutDate, setNewBlackoutDate] = useState("");
  const [maxRetries, setMaxRetries] = useState(settings.maxRetries ?? 3);
  const [retryIntervalDays, setRetryIntervalDays] = useState(settings.retryIntervalDays ?? 2);

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.success });
    }
  }, [actionData, shopify]);

  const toggleWeekday = (day: number) => {
    setDeliveryWeekdays((prev) => {
      const exists = prev.includes(day);
      if (exists) {
        if (prev.length === 1) return prev; // Keep at least one
        return prev.filter((d) => d !== day);
      } else {
        return [...prev, day].sort((a, b) => a - b);
      }
    });
  };

  const addBlackoutDate = () => {
    if (!newBlackoutDate) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newBlackoutDate)) return;
    if (!blackoutDates.includes(newBlackoutDate)) {
      setBlackoutDates([...blackoutDates, newBlackoutDate].sort());
    }
    setNewBlackoutDate("");
  };

  const removeBlackoutDate = (d: string) => {
    setBlackoutDates(blackoutDates.filter((x) => x !== d));
  };

  return (
    <s-page heading="Delivery & Billing Rules (Perfect Delivery)">
      <div slot="primary-action">
        <s-button href="/app/subscriptions" variant="secondary">
          &larr; Back to Subscriptions
        </s-button>
      </div>

      <Form method="post">
        <input type="hidden" name="blackoutDatesJson" value={JSON.stringify(blackoutDates)} />

        <s-stack direction="block" gap="base">
          {/* Section 1: Delivery Weekdays & Calendar Planning */}
          <div style={cardStyle}>
            <h3 style={cardTitleStyle}>1. Deliverable Weekdays & Weekly Planning</h3>
            <p style={cardSubtitleStyle}>
              Select which days of the week your fulfillment warehouse and courier partners deliver orders. Deliveries
              will only be scheduled on these days.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "10px", marginTop: "16px" }}>
              {WEEKDAY_NAMES.map((name: string, idx: number) => {
                const checked = deliveryWeekdays.includes(idx);
                return (
                  <label
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "10px 14px",
                      borderRadius: "8px",
                      background: checked ? "#f9fafb" : "#fff",
                      border: `1.5px solid ${checked ? "#000" : "#d1d5db"}`,
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      name="deliveryWeekdays"
                      value={idx}
                      checked={checked}
                      onChange={() => toggleWeekday(idx)}
                      style={{ accentColor: "#000" }}
                    />
                    <span style={{ fontSize: "14px", fontWeight: checked ? "800" : "500", color: "#000" }}>
                      {name}
                    </span>
                  </label>
                );
              })}
            </div>

            <div style={{ marginTop: "20px" }}>
              <label htmlFor="settings-default-weekday" style={labelStyle}>Default Preferred Weekday for New Subscribers:</label>
              <select
                id="settings-default-weekday"
                name="defaultWeekday"
                value={defaultWeekday}
                onChange={(e) => setDefaultWeekday(e.target.value)}
                style={inputStyle}
              >
                <option value="null">No Preference (First Deliverable Day)</option>
                {deliveryWeekdays.map((idx) => (
                  <option key={idx} value={String(idx)}>
                    Every {WEEKDAY_NAMES[idx]}
                  </option>
                ))}
              </select>
              <span style={hintStyle}>
                If selected, subscribers will default to receiving packages on this day of the week.
              </span>
            </div>
          </div>

          {/* Section 2: Timing, Lead Times & Cutoffs */}
          <div style={cardStyle}>
            <h3 style={cardTitleStyle}>2. Billing Hours, Lead Time & Modification Cutoff</h3>
            <p style={cardSubtitleStyle}>
              Ensure zero delivery delays and zero missed shipments with automated lead times and modification locks.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginTop: "16px" }}>
              <div>
                <label htmlFor="settings-timezone" style={labelStyle}>Timezone (IANA):</label>
                <input
                  id="settings-timezone"
                  type="text"
                  name="timezone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  style={inputStyle}
                  required
                />
                <span style={hintStyle}>e.g. Asia/Kolkata (IST), Asia/Dubai, America/New_York</span>
              </div>

              <div>
                <label htmlFor="settings-billing-hour" style={labelStyle}>Daily Automated Billing Hour:</label>
                <select
                  id="settings-billing-hour"
                  name="billingHour"
                  value={billingHour}
                  onChange={(e) => setBillingHour(parseInt(e.target.value, 10))}
                  style={inputStyle}
                >
                  {Array.from({ length: 24 }).map((_, h) => {
                    const ampm = h >= 12 ? "PM" : "AM";
                    const displayH = h % 12 === 0 ? 12 : h % 12;
                    return (
                      <option key={h} value={h}>
                        {String(displayH).padStart(2, "0")}:00 {ampm} ({String(h).padStart(2, "0")}:00 local)
                      </option>
                    );
                  })}
                </select>
                <span style={hintStyle}>When recurring billing attempts execute each day.</span>
              </div>

              <div>
                <label htmlFor="settings-lead-time-days" style={labelStyle}>Fulfillment Lead Time (Days):</label>
                <input
                  id="settings-lead-time-days"
                  type="number"
                  name="leadTimeDays"
                  min="0"
                  max="14"
                  value={leadTimeDays}
                  onChange={(e) => setLeadTimeDays(parseInt(e.target.value, 10) || 0)}
                  style={inputStyle}
                  required
                />
                <span style={hintStyle}>Days required between billing and delivery to pack and ship.</span>
              </div>

              <div>
                <label htmlFor="settings-cutoff-hours" style={labelStyle}>Cutoff Window Before Billing (Hours):</label>
                <input
                  id="settings-cutoff-hours"
                  type="number"
                  name="cutoffHours"
                  min="0"
                  max="168"
                  value={cutoffHours}
                  onChange={(e) => setCutoffHours(parseInt(e.target.value, 10) || 0)}
                  style={inputStyle}
                  required
                />
                <span style={hintStyle}>Hours before billing when skips/changes are locked.</span>
              </div>
            </div>
          </div>

          {/* Section 3: Holiday & Blackout Dates */}
          <div style={cardStyle}>
            <h3 style={cardTitleStyle}>3. Holiday & Courier Blackout Dates</h3>
            <p style={cardSubtitleStyle}>
              Deliveries will never be scheduled on blackout dates (e.g. national holidays, courier off-days). The engine
              automatically moves deliveries to the next deliverable day.
            </p>

            <div style={{ display: "flex", gap: "10px", marginTop: "16px", maxWidth: "400px" }}>
              <input
                type="date"
                value={newBlackoutDate}
                onChange={(e) => setNewBlackoutDate(e.target.value)}
                style={inputStyle}
              />
              <button
                type="button"
                onClick={addBlackoutDate}
                style={{
                  background: "#008060",
                  color: "#fff",
                  border: "none",
                  borderRadius: "8px",
                  padding: "0 16px",
                  fontSize: "14px",
                  fontWeight: "600",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                + Add Date
              </button>
            </div>

            <div style={{ marginTop: "16px" }}>
              {blackoutDates.length === 0 ? (
                <div style={{ fontSize: "13px", color: "#6d7175" }}>No blackout dates registered.</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {blackoutDates.map((dateStr) => (
                    <span
                      key={dateStr}
                      style={{
                        background: "#fef2f2",
                        border: "1px solid #fecaca",
                        color: "#991b1b",
                        padding: "6px 12px",
                        borderRadius: "16px",
                        fontSize: "13px",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <strong>{dateStr}</strong>
                      <button
                        type="button"
                        onClick={() => removeBlackoutDate(dateStr)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#dc2626",
                          cursor: "pointer",
                          fontSize: "14px",
                          lineHeight: 1,
                          padding: 0,
                        }}
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Section 4: Payment Retries & Delivery Date Protection */}
          <div style={cardStyle}>
            <h3 style={cardTitleStyle}>4. Failed Payment Retries & Delivery Preservation</h3>
            <p style={cardSubtitleStyle}>
              When a subscriber&apos;s credit card or UPI fails, the engine automatically retries payment and pushes the
              delivery date forward by the exact number of retry days to maintain your lead time.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginTop: "16px" }}>
              <div>
                <label htmlFor="settings-max-retries" style={labelStyle}>Max Payment Retries:</label>
                <input
                  id="settings-max-retries"
                  type="number"
                  name="maxRetries"
                  min="0"
                  max="10"
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(parseInt(e.target.value, 10) || 0)}
                  style={inputStyle}
                  required
                />
                <span style={hintStyle}>After this many failures, subscription is paused.</span>
              </div>

              <div>
                <label htmlFor="settings-retry-interval-days" style={labelStyle}>Retry Interval (Days):</label>
                <input
                  id="settings-retry-interval-days"
                  type="number"
                  name="retryIntervalDays"
                  min="1"
                  max="7"
                  value={retryIntervalDays}
                  onChange={(e) => setRetryIntervalDays(parseInt(e.target.value, 10) || 1)}
                  style={inputStyle}
                  required
                />
                <span style={hintStyle}>Days to wait between successive retry attempts.</span>
              </div>
            </div>
          </div>

          {/* Save Button Bar */}
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "16px 0" }}>
            <s-button type="submit" variant="primary" loading={isBusy}>
              Save Delivery Rules & Re-evaluate Schedules
            </s-button>
          </div>
        </s-stack>
      </Form>
    </s-page>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: "10px",
  border: "1.5px solid #000",
  padding: "24px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: "900",
  margin: "0 0 6px 0",
  color: "#000",
};

const cardSubtitleStyle: React.CSSProperties = {
  fontSize: "13px",
  color: "#000",
  margin: 0,
  lineHeight: "1.5",
  fontWeight: "500",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "13px",
  fontWeight: "800",
  marginBottom: "6px",
  color: "#000",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: "6px",
  border: "1.5px solid #000",
  fontSize: "14px",
  color: "#000",
  fontWeight: "600",
  outline: "none",
};

const hintStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  color: "#000",
  marginTop: "4px",
  fontWeight: "500",
};
