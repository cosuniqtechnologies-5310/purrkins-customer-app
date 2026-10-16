import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  billNow,
  cancelSubscription,
  changeFrequency,
  getSubscriptionDetail,
  pauseSubscription,
  rescheduleDelivery,
  resumeSubscription,
  setPreferredWeekday,
  skipNextDelivery,
} from "../utils/subscription.server";
import { describeFrequency, WEEKDAY_NAMES, weekdayOf } from "../utils/subscription-schedule";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id;

  if (!id) {
    throw new Response("Subscription ID required", { status: 400 });
  }

  const detail = await getSubscriptionDetail(shop, id);
  if (!detail) {
    throw new Response("Subscription not found", { status: 404 });
  }

  return { shop, ...detail };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id;

  if (!id) {
    return { success: false, message: "Subscription ID missing" };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    switch (intent) {
      case "skip": {
        await skipNextDelivery(shop, id);
        return { success: true, message: "Next delivery successfully skipped and advanced to next cycle." };
      }
      case "reschedule": {
        const deliveryDate = String(form.get("deliveryDate") || "");
        const applyToFuture = form.get("applyToFuture") === "true";
        if (!deliveryDate) {
          return { success: false, message: "Delivery date is required." };
        }
        await rescheduleDelivery(shop, id, deliveryDate, applyToFuture);
        return {
          success: true,
          message: `Delivery rescheduled to ${deliveryDate}${applyToFuture ? " (and future schedule shifted)" : ""}.`,
        };
      }
      case "set_weekday": {
        const rawWeekday = form.get("weekday");
        const weekday = rawWeekday === "" || rawWeekday === "null" || rawWeekday === null ? null : parseInt(String(rawWeekday), 10);
        await setPreferredWeekday(shop, id, weekday);
        return {
          success: true,
          message: weekday !== null ? `Preferred weekday set to ${WEEKDAY_NAMES[weekday]}.` : "Preferred weekday cleared.",
        };
      }
      case "change_plan": {
        const planId = String(form.get("planId") || "");
        if (!planId) return { success: false, message: "Please select a plan." };
        await changeFrequency(shop, id, planId);
        return { success: true, message: "Subscription frequency plan updated successfully." };
      }
      case "pause": {
        const reason = String(form.get("reason") || "MERCHANT").trim();
        await pauseSubscription(shop, id, reason);
        return { success: true, message: "Subscription paused." };
      }
      case "resume": {
        await resumeSubscription(shop, id);
        return { success: true, message: "Subscription resumed and active." };
      }
      case "cancel": {
        const reason = String(form.get("reason") || "Customer requested via admin");
        await cancelSubscription(shop, id, reason);
        return { success: true, message: "Subscription cancelled." };
      }
      case "bill_now": {
        await billNow(shop, id);
        return {
          success: true,
          message: "Billing attempt executed successfully.",
        };
      }
      default:
        return { success: false, message: `Unknown intent: ${intent}` };
    }
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : "Operation failed" };
  }
};

export default function SubscriptionDetail() {
  const { shop, sub, pending, upcoming, plans, cfg } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const nav = useNavigation();
  const isBusy = nav.state !== "idle";

  // Modal / action state
  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState(pending?.deliveryDate || "");
  const [applyToFuture, setApplyToFuture] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState(sub.planId || "");
  const [selectedWeekday, setSelectedWeekday] = useState<string>(sub.preferredWeekday !== null ? String(sub.preferredWeekday) : "null");
  const [cancelReason, setCancelReason] = useState("");
  const [pauseUntil, setPauseUntil] = useState("");

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.success });
      if (actionData.success) {
        setActiveModal(null);
      }
    }
  }, [actionData, shopify]);

  // Parse lines from Prisma JSON
  interface LineItemData {
    title?: string;
    variantTitle?: string;
    quantity?: number;
    price?: string;
    productId?: string;
    variantId?: string;
    image?: string;
  }
  const lines: LineItemData[] = Array.isArray(sub.lines)
    ? (sub.lines as unknown as LineItemData[])
    : [];

  const statusColors: Record<string, { bg: string; text: string; border: string }> = {
    ACTIVE: { bg: "#000000", text: "#ffffff", border: "#000000" },
    PAUSED: { bg: "#f4f4f5", text: "#000000", border: "#000000" },
    CANCELLED: { bg: "#ffffff", text: "#000000", border: "#000000" },
    FAILED: { bg: "#000000", text: "#ffffff", border: "#000000" },
  };
  const statusStyle = statusColors[sub.status] || statusColors.ACTIVE;

  // Shopify Admin contract URL
  const shopifySubNumericId = sub.contractId?.split("/").pop();
  const shopNameSlug = shop.replace(".myshopify.com", "");
  const shopifyAdminContractUrl = shopifySubNumericId
    ? `https://admin.shopify.com/store/${shopNameSlug}/subscriptions/${shopifySubNumericId}`
    : null;

  return (
    <s-page heading={`Subscription: ${sub.customerName || sub.customerEmail || sub.id}`}>
      <div slot="primary-action" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <s-button href="/app/subscriptions" variant="secondary">
          &larr; Back to Subscriptions
        </s-button>
        {shopifyAdminContractUrl && (
          <s-button href={shopifyAdminContractUrl} target="_blank" variant="secondary">
            View in Shopify Admin &nearr;
          </s-button>
        )}
      </div>

      <s-stack direction="block" gap="base">
        {/* Top Header Card */}
        <div
          style={{
            background: "#fff",
            borderRadius: "12px",
            border: "none",
            padding: "24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
              <h2 style={{ fontSize: "20px", fontWeight: "800", margin: 0, color: "#000000" }}>
                {sub.customerName || "Customer"}
              </h2>
              <span
                style={{
                  background: statusStyle.bg,
                  color: statusStyle.text,
                  border: `1.5px solid ${statusStyle.border}`,
                  padding: "4px 12px",
                  borderRadius: "16px",
                  fontSize: "12px",
                  fontWeight: "800",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                {sub.status}
              </span>
            </div>
            <div style={{ fontSize: "14px", color: "#000000", display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <span>
                <strong>Email:</strong> {sub.customerEmail || "N/A"}
              </span>
              <span>
                <strong>Shopify ID:</strong> #{shopifySubNumericId || sub.contractId}
              </span>
              <span>
                <strong>Frequency:</strong> {describeFrequency(sub.interval, sub.intervalCount)}
              </span>
              <span>
                <strong>Preferred Day:</strong>{" "}
                {sub.preferredWeekday !== null ? WEEKDAY_NAMES[sub.preferredWeekday] : "Any Deliverable Day"}
              </span>
            </div>
          </div>

          {/* Quick Action Buttons */}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {sub.status === "ACTIVE" && (
              <>
                <s-button onClick={() => setActiveModal("reschedule")} variant="secondary">
                  Reschedule
                </s-button>
                <s-button onClick={() => setActiveModal("skip")} variant="secondary">
                  Skip Next
                </s-button>
                <s-button onClick={() => setActiveModal("plan")} variant="secondary">
                  Change Plan
                </s-button>
                <s-button onClick={() => setActiveModal("weekday")} variant="secondary">
                  Set Weekday
                </s-button>
                <s-button onClick={() => setActiveModal("bill_now")} variant="secondary">
                  Bill Now
                </s-button>
                <s-button onClick={() => setActiveModal("pause")} variant="secondary">
                  Pause
                </s-button>
                <s-button onClick={() => setActiveModal("cancel")} tone="critical">
                  Cancel
                </s-button>
              </>
            )}
            {sub.status === "PAUSED" && (
              <>
                <Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value="resume" />
                  <s-button type="submit" variant="primary" loading={isBusy}>
                    Resume Subscription
                  </s-button>
                </Form>
                <s-button onClick={() => setActiveModal("cancel")} tone="critical">
                  Cancel
                </s-button>
              </>
            )}
            {sub.status === "FAILED" && (
              <>
                <s-button onClick={() => setActiveModal("bill_now")} variant="primary">
                  Retry Billing Now
                </s-button>
                <s-button onClick={() => setActiveModal("reschedule")} variant="secondary">
                  Reschedule Delivery
                </s-button>
                <s-button onClick={() => setActiveModal("cancel")} tone="critical">
                  Cancel
                </s-button>
              </>
            )}
          </div>
        </div>

        {/* Next Delivery Highlight Box */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "16px",
          }}
        >
          {/* Card 1: Next Pending Delivery */}
          <div
            style={{
              background: "#fff",
              borderRadius: "12px",
              border: "none",
              borderLeft: "6px solid #000000",
              padding: "20px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
            }}
          >
            <div style={{ fontSize: "12px", fontWeight: "800", color: "#000000", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Next Scheduled Delivery
            </div>
            {pending ? (
              <>
                <div style={{ fontSize: "26px", fontWeight: "900", color: "#000000", marginTop: "8px" }}>
                  {pending.deliveryDate}
                </div>
                <div style={{ fontSize: "14px", color: "#000000", fontWeight: "700", marginTop: "2px" }}>
                  {WEEKDAY_NAMES[weekdayOf(pending.deliveryDate)]} (Cycle #{pending.cycleNumber})
                </div>
                <div style={{ marginTop: "12px", fontSize: "13px", color: "#000000", lineHeight: "1.6" }}>
                  <div>
                    <strong>Billing Scheduled:</strong> {new Date(pending.billingAt).toLocaleString("en-IN")}
                  </div>
                  <div>
                    <strong>Cutoff Window:</strong> {cfg.cutoffHours} hrs prior
                  </div>
                  <div>
                    <strong>Lead Time:</strong> {cfg.leadTimeDays} days before delivery
                  </div>
                  {pending.attempts > 0 && (
                    <div style={{ color: "#000000", fontWeight: "700" }}>
                      Attempts: {pending.attempts} (Last error: {pending.error || "Payment failed"})
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ marginTop: "12px", color: "#000000", fontSize: "14px" }}>
                No active pending cycle ({sub.status.toLowerCase()}).
              </div>
            )}
          </div>

          {/* Card 2: Schedule & Rules */}
          <div
            style={{
              background: "#fff",
              borderRadius: "12px",
              border: "none",
              padding: "20px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
            }}
          >
            <div style={{ fontSize: "12px", fontWeight: "800", color: "#000000", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Subscription Cadence & Anchors
            </div>
            <div style={{ marginTop: "12px", fontSize: "13px", color: "#000000", lineHeight: "1.8" }}>
              <div>
                <strong>Frequency Plan:</strong> {describeFrequency(sub.interval, sub.intervalCount)}
              </div>
              <div>
                <strong>Original Anchor Date:</strong> {sub.anchorDate}
              </div>
              <div>
                <strong>Current Anchor Step:</strong> Cycle {sub.anchorStep}
              </div>
              <div>
                <strong>Timezone:</strong> {cfg.timezone} (Daily billing run at {String(cfg.billingHour).padStart(2, "0")}:00)
              </div>
              <div>
                <strong>Allowed Delivery Days:</strong>{" "}
                {cfg.deliveryWeekdays.map((d: number) => WEEKDAY_NAMES[d].slice(0, 3)).join(", ")}
              </div>
            </div>
          </div>
        </div>

        {/* Subscribed Products */}
        <div style={{ background: "#fff", borderRadius: "12px", border: "none", boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)", padding: "20px" }}>
          <h3 style={{ fontSize: "16px", fontWeight: "800", margin: "0 0 16px 0", color: "#000000" }}>
            Subscribed Line Items
          </h3>
          {lines.length === 0 ? (
            <div style={{ color: "#000000", fontSize: "14px" }}>No line item details saved.</div>
          ) : (
            <div style={{ width: "100%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #e1e3e5", textAlign: "left", color: "#000000", fontSize: "12px", fontWeight: "800" }}>
                    <th style={{ padding: "10px 8px" }}>PRODUCT</th>
                    <th style={{ padding: "10px 8px" }}>VARIANT</th>
                    <th style={{ padding: "10px 8px", textAlign: "center" }}>QUANTITY</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>UNIT PRICE</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: "1px solid #e1e3e5" }}>
                      <td style={{ padding: "12px 8px", fontWeight: "700", color: "#000000" }}>
                        {item.title || "Custom Subscription Item"}
                      </td>
                      <td style={{ padding: "12px 8px", color: "#000000" }}>{item.variantTitle || "Default"}</td>
                      <td style={{ padding: "12px 8px", textAlign: "center", fontWeight: "700", color: "#000000" }}>{item.quantity || 1}</td>
                      <td style={{ padding: "12px 8px", textAlign: "right", fontWeight: "800", color: "#000000" }}>
                        {item.price ? `₹${parseFloat(item.price).toFixed(2)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Projected Future Deliveries */}
        {upcoming.length > 0 && (
          <div style={{ background: "#fff", borderRadius: "12px", border: "none", boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)", padding: "20px" }}>
            <h3 style={{ fontSize: "16px", fontWeight: "800", margin: "0 0 8px 0", color: "#000000" }}>
              Projected Upcoming Delivery Calendar (Next 3 Cycles)
            </h3>
            <p style={{ fontSize: "13px", color: "#000000", margin: "0 0 16px 0" }}>
              Calculated using Purrkins perfect-delivery engine with anchor drift prevention, preferred weekday rules, and courier cutoff.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
              {upcoming.map((u, i: number) => (
                <div
                  key={i}
                  style={{
                    padding: "16px",
                    borderRadius: "8px",
                    background: "#ffffff",
                    border: "1px solid #e1e3e5",
                  }}
                >
                  <div style={{ fontSize: "12px", color: "#000000", fontWeight: "700" }}>Cycle +{i + 1}</div>
                  <div style={{ fontSize: "20px", fontWeight: "900", color: "#000000", marginTop: "4px" }}>
                    {u.deliveryDate}
                  </div>
                  <div style={{ fontSize: "13px", color: "#000000", fontWeight: "700" }}>
                    {WEEKDAY_NAMES[weekdayOf(u.deliveryDate)]}
                  </div>
                  <div style={{ fontSize: "12px", color: "#000000", marginTop: "8px" }}>
                    Billing: {new Date(u.billingAt).toLocaleDateString("en-IN", { month: "short", day: "numeric" })} at{" "}
                    {new Date(u.billingAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cycle History Ledger */}
        <div style={{ background: "#fff", borderRadius: "12px", border: "none", boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)", padding: "20px" }}>
          <h3 style={{ fontSize: "16px", fontWeight: "800", margin: "0 0 16px 0", color: "#000000" }}>
            Delivery & Billing Ledger History
          </h3>
          <div style={{ width: "100%" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #000000", textAlign: "left", color: "#000000", fontSize: "12px", fontWeight: "800" }}>
                  <th style={{ padding: "10px 8px" }}>CYCLE</th>
                  <th style={{ padding: "10px 8px" }}>DELIVERY DATE</th>
                  <th style={{ padding: "10px 8px" }}>BILLING TIME</th>
                  <th style={{ padding: "10px 8px" }}>STATUS</th>
                  <th style={{ padding: "10px 8px" }}>RETRIES</th>
                  <th style={{ padding: "10px 8px" }}>ORDER / DETAILS</th>
                </tr>
              </thead>
              <tbody>
                {sub.cycles.map((c) => {
                  return (
                    <tr key={c.id} style={{ borderBottom: "1px solid #e1e3e5" }}>
                      <td style={{ padding: "12px 8px", fontWeight: "800", color: "#000000" }}>#{c.cycleNumber}</td>
                      <td style={{ padding: "12px 8px", color: "#000000" }}>
                        <div style={{ fontWeight: "700" }}>{c.deliveryDate}</div>
                        <div style={{ fontSize: "11px", color: "#000000" }}>{WEEKDAY_NAMES[weekdayOf(c.deliveryDate)]}</div>
                      </td>
                      <td style={{ padding: "12px 8px", color: "#000000" }}>
                        {new Date(c.billingAt).toLocaleString("en-IN", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td style={{ padding: "12px 8px" }}>
                        <span
                          style={{
                            fontWeight: "800",
                            fontSize: "12px",
                            color: "#000000",
                            border: "1px solid #000000",
                            padding: "2px 8px",
                            borderRadius: "10px",
                            background: "#f4f4f5",
                          }}
                        >
                          {c.status}
                        </span>
                      </td>
                      <td style={{ padding: "12px 8px", fontWeight: "700", color: "#000000" }}>{c.attempts > 0 ? `${c.attempts}` : "0"}</td>
                      <td style={{ padding: "12px 8px", color: "#000000" }}>
                        {c.orderName ? (
                          <span style={{ fontWeight: "800", color: "#000000" }}>{c.orderName}</span>
                        ) : c.error ? (
                          <span style={{ color: "#000000", fontSize: "12px", fontWeight: "600" }}>{c.error}</span>
                        ) : (
                          <span style={{ color: "#000000" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </s-stack>

      {/* --- Action Modals --- */}

      {/* Reschedule Modal */}
      {activeModal === "reschedule" && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", color: "#000000", fontWeight: "800" }}>Reschedule Next Delivery</h3>
            <Form method="post">
              <input type="hidden" name="intent" value="reschedule" />
              <div style={{ marginBottom: "16px" }}>
                <label htmlFor="reschedule-delivery-date" style={{ display: "block", fontSize: "13px", fontWeight: "700", marginBottom: "6px", color: "#000000" }}>
                  New Delivery Date (YYYY-MM-DD):
                </label>
                <input
                  id="reschedule-delivery-date"
                  type="date"
                  name="deliveryDate"
                  value={rescheduleDate}
                  onChange={(e) => setRescheduleDate(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1.5px solid #000000", color: "#000000" }}
                  required
                />
                <div style={{ fontSize: "12px", color: "#000000", marginTop: "6px" }}>
                  Allowed days: {cfg.deliveryWeekdays.map((d: number) => WEEKDAY_NAMES[d]).join(", ")}. Date must be in the future.
                </div>
              </div>
              <div style={{ marginBottom: "20px" }}>
                <label htmlFor="reschedule-apply-future" style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", color: "#000000" }}>
                  <input
                    id="reschedule-apply-future"
                    type="checkbox"
                    name="applyToFuture"
                    value="true"
                    checked={applyToFuture}
                    onChange={(e) => setApplyToFuture(e.target.checked)}
                  />
                  <span>Also move the recurring anchor forward so future cycles stay on this cadence</span>
                </label>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <s-button onClick={() => setActiveModal(null)} variant="secondary">
                  Cancel
                </s-button>
                <s-button type="submit" variant="primary" loading={isBusy}>
                  Confirm Reschedule
                </s-button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Skip Modal */}
      {activeModal === "skip" && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", color: "#000000", fontWeight: "800" }}>Skip Next Delivery</h3>
            <p style={{ fontSize: "14px", color: "#000000", lineHeight: "1.5" }}>
              Are you sure you want to skip delivery for cycle <strong>#{pending?.cycleNumber}</strong> ({pending?.deliveryDate})?
              The subscription will immediately advance to the next frequency interval. No charges will be made for this skipped cycle.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="skip" />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "24px" }}>
                <s-button onClick={() => setActiveModal(null)} variant="secondary">
                  Close
                </s-button>
                <s-button type="submit" variant="primary" loading={isBusy}>
                  Yes, Skip This Delivery
                </s-button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Change Plan Modal */}
      {activeModal === "plan" && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", color: "#000000", fontWeight: "800" }}>Change Subscription Frequency</h3>
            <Form method="post">
              <input type="hidden" name="intent" value="change_plan" />
              <div style={{ marginBottom: "20px" }}>
                <label htmlFor="change-plan-select" style={{ display: "block", fontSize: "13px", fontWeight: "700", marginBottom: "6px", color: "#000000" }}>
                  Select New Frequency Plan:
                </label>
                <select
                  id="change-plan-select"
                  name="planId"
                  value={selectedPlanId}
                  onChange={(e) => setSelectedPlanId(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1.5px solid #000000", color: "#000000" }}
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({describeFrequency(p.interval, p.intervalCount)}) {p.discountPercent > 0 ? `— Save ${p.discountPercent}%` : ""}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: "12px", color: "#000000", marginTop: "6px" }}>
                  The new frequency will apply to all subsequent cycles starting immediately.
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <s-button onClick={() => setActiveModal(null)} variant="secondary">
                  Cancel
                </s-button>
                <s-button type="submit" variant="primary" loading={isBusy}>
                  Update Frequency Plan
                </s-button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Set Weekday Modal */}
      {activeModal === "weekday" && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", color: "#000000", fontWeight: "800" }}>Set Preferred Delivery Weekday</h3>
            <Form method="post">
              <input type="hidden" name="intent" value="set_weekday" />
              <div style={{ marginBottom: "20px" }}>
                <label htmlFor="set-weekday-select" style={{ display: "block", fontSize: "13px", fontWeight: "700", marginBottom: "6px", color: "#000000" }}>
                  Preferred Delivery Day:
                </label>
                <select
                  id="set-weekday-select"
                  name="weekday"
                  value={selectedWeekday}
                  onChange={(e) => setSelectedWeekday(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1.5px solid #000000", color: "#000000" }}
                >
                  <option value="null">No Preference (Any deliverable day)</option>
                  {cfg.deliveryWeekdays.map((d: number) => (
                    <option key={d} value={String(d)}>
                      Every {WEEKDAY_NAMES[d]}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: "12px", color: "#000000", marginTop: "6px" }}>
                  Deliveries will automatically snap to this day of the week while respecting the interval cadence.
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <s-button onClick={() => setActiveModal(null)} variant="secondary">
                  Cancel
                </s-button>
                <s-button type="submit" variant="primary" loading={isBusy}>
                  Save Preferred Day
                </s-button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Bill Now Modal */}
      {activeModal === "bill_now" && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", color: "#000000", fontWeight: "800" }}>Trigger Billing Attempt Now</h3>
            <p style={{ fontSize: "14px", color: "#000000", lineHeight: "1.5" }}>
              This will immediately submit a <strong>subscriptionBillingAttemptCreate</strong> call to Shopify for cycle{" "}
              <strong>#{pending?.cycleNumber}</strong>. If successful, Shopify creates the fulfillment order and advances to the next cycle.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="bill_now" />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "24px" }}>
                <s-button onClick={() => setActiveModal(null)} variant="secondary">
                  Cancel
                </s-button>
                <s-button type="submit" variant="primary" loading={isBusy}>
                  Execute Billing Now
                </s-button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Pause Modal */}
      {activeModal === "pause" && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", color: "#000000", fontWeight: "800" }}>Pause Subscription</h3>
            <Form method="post">
              <input type="hidden" name="intent" value="pause" />
              <div style={{ marginBottom: "20px" }}>
                <label htmlFor="pause-until-date" style={{ display: "block", fontSize: "13px", fontWeight: "700", marginBottom: "6px", color: "#000000" }}>
                  Pause Until Date (Optional):
                </label>
                <input
                  id="pause-until-date"
                  type="date"
                  name="pauseUntil"
                  value={pauseUntil}
                  onChange={(e) => setPauseUntil(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1.5px solid #000000", color: "#000000" }}
                />
                <div style={{ fontSize: "12px", color: "#000000", marginTop: "6px" }}>
                  Leave blank to pause indefinitely until manually resumed.
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <s-button onClick={() => setActiveModal(null)} variant="secondary">
                  Cancel
                </s-button>
                <s-button type="submit" variant="primary" loading={isBusy}>
                  Pause Subscription
                </s-button>
              </div>
            </Form>
          </div>
        </div>
      )}

      {/* Cancel Modal */}
      {activeModal === "cancel" && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", color: "#000000", fontWeight: "800" }}>Cancel Subscription</h3>
            <p style={{ fontSize: "14px", color: "#000000" }}>
              Are you sure you want to cancel this subscription? This will cancel the contract in Shopify and stop all future billings.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="cancel" />
              <div style={{ marginBottom: "20px" }}>
                <label htmlFor="cancel-reason-input" style={{ display: "block", fontSize: "13px", fontWeight: "700", marginBottom: "6px", color: "#000000" }}>
                  Cancellation Reason:
                </label>
                <input
                  id="cancel-reason-input"
                  type="text"
                  name="reason"
                  placeholder="e.g. Customer moved / requested cancellation"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1.5px solid #000000", color: "#000000" }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <s-button onClick={() => setActiveModal(null)} variant="secondary">
                  Keep Subscription
                </s-button>
                <s-button type="submit" tone="critical" loading={isBusy}>
                  Yes, Cancel Contract
                </s-button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </s-page>
  );
}

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "16px",
};

const modalBoxStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: "12px",
  padding: "24px",
  maxWidth: "500px",
  width: "100%",
  boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
};
