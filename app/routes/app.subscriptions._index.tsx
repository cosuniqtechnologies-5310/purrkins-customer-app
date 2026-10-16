import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getStats, listSubscriptions, runSchedulerTick, subscribeFromOrder } from "../utils/subscription.server";
import { describeFrequency } from "../utils/subscription-schedule";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const status = url.searchParams.get("status") || "ALL";
  const q = url.searchParams.get("q") || "";
  const page = parseInt(url.searchParams.get("page") || "1", 10);

  const [stats, list] = await Promise.all([
    getStats(shop),
    listSubscriptions(shop, { status, q, page, pageSize: 20 }),
  ]);

  return { shop, stats, list, status, q, page };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "run_scheduler") {
    try {
      const res = await runSchedulerTick();
      return {
        success: true,
        message: `Scheduler ran successfully: ${res.processed} of ${res.due} due cycles processed.`,
      };
    } catch (e: unknown) {
      return { success: false, message: `Scheduler error: ${e instanceof Error ? e.message : "Run failed"}` };
    }
  }

  if (intent === "subscribe_order") {
    const orderName = String(formData.get("orderName") || "").trim();
    const days = parseInt(String(formData.get("days") || "30"), 10);
    if (!orderName) {
      return { success: false, message: "Please enter an order number (e.g. #1004)" };
    }
    try {
      const sub = await subscribeFromOrder(shop, orderName, days);
      return {
        success: true,
        message: `Subscribed ${sub.customerName || sub.customerEmail || "customer"} from order ${sub.originOrderName || orderName}!`,
      };
    } catch (e: unknown) {
      return {
        success: false,
        message: `Could not subscribe order: ${e instanceof Error ? e.message : "Order not found or already subscribed"}`,
      };
    }
  }

  return { success: false, message: "Unknown action" };
};

export default function SubscriptionsIndex() {
  const { stats, list, status, q } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const nav = useNavigation();
  const isBusy = nav.state !== "idle";
  const [isSubscribeModalOpen, setIsSubscribeModalOpen] = useState(false);
  const [orderQuery, setOrderQuery] = useState("");
  const [frequencyDays, setFrequencyDays] = useState("30");

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.success });
      if (actionData.success) {
        setIsSubscribeModalOpen(false);
        setOrderQuery("");
      }
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Subscriptions & Recurring Orders">
      <div slot="primary-action" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => {
            setOrderQuery("#1004");
            setIsSubscribeModalOpen(true);
          }}
          style={{
            background: "#0F172A",
            color: "#FFFFFF",
            border: "none",
            borderRadius: "8px",
            padding: "8px 16px",
            fontSize: "13px",
            fontWeight: "700",
            cursor: "pointer",
            boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
          }}
        >
          + Subscribe Order
        </button>
        <Form method="post">
          <input type="hidden" name="intent" value="run_scheduler" />
          <s-button type="submit" loading={isBusy} variant="secondary">
            Run Billing Check Now
          </s-button>
        </Form>
        <s-button href="/app/subscriptions/plans" variant="primary">
          Manage Plans &amp; Discounts
        </s-button>
      </div>

      <s-stack direction="block" gap="base">
        {/* KPI Metrics row - borderless cards with solid black titles and reduced opacity subtitles */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
          <div style={{ background: "#fff", padding: "20px", borderRadius: "12px", border: "none", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: "12px", fontWeight: "800", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>Active Subscribers</div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#000", marginTop: "8px", lineHeight: "1" }}>
              {stats.counts["ACTIVE"] || 0}
            </div>
            <div style={{ fontSize: "12px", color: "rgba(0, 0, 0, 0.55)", marginTop: "6px", fontWeight: "400" }}>
              Total subscriptions: {stats.total}
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "12px", border: "none", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: "12px", fontWeight: "800", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>Estimated MRR</div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#000", marginTop: "8px", lineHeight: "1" }}>
              ₹{Math.round(stats.mrr).toLocaleString("en-IN")}
            </div>
            <div style={{ fontSize: "12px", color: "rgba(0, 0, 0, 0.55)", marginTop: "6px", fontWeight: "400" }}>
              Monthly recurring revenue
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "12px", border: "none", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: "12px", fontWeight: "800", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>Renewals (Next 7 Days)</div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#000", marginTop: "8px", lineHeight: "1" }}>
              {stats.billingNext7Days}
            </div>
            <div style={{ fontSize: "12px", color: "rgba(0, 0, 0, 0.55)", marginTop: "6px", fontWeight: "400" }}>
              Scheduled recurring billing cycles
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "12px", border: "none", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: "12px", fontWeight: "800", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>Payment Retries</div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#000", marginTop: "8px", lineHeight: "1" }}>
              {stats.retrying}
            </div>
            <div style={{ fontSize: "12px", color: "rgba(0, 0, 0, 0.55)", marginTop: "6px", fontWeight: "400" }}>
              {stats.retrying > 0 ? "Attempts pending re-charge" : "All payments up to date"}
            </div>
          </div>
        </div>

        {/* Quick links banner - borderless */}
        <div style={{ background: "#fafafa", border: "none", borderRadius: "12px", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontWeight: "800", fontSize: "14px", color: "#000" }}>Subscription Management:</span>
            <Link to="/app/subscriptions/plans" style={{ color: "#000", textDecoration: "underline", fontWeight: "700", fontSize: "13px" }}>📦 Subscription Plans &amp; Discounts</Link>
          </div>
          <div style={{ color: "rgba(0, 0, 0, 0.55)", fontSize: "12px", fontWeight: "500" }}>
            🚚 Shipping &amp; fulfillment are automatically handled by <strong style={{ color: "#000" }}>NimbusPost</strong> on created Shopify orders
          </div>
        </div>

        {/* Subscriptions Table Section */}
        <s-section heading="All Subscriptions">
          <div style={{ background: "#fff", borderRadius: "12px", border: "none", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            {/* Filter bar */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #f3f4f6", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
              {/* Status tabs */}
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {["ALL", "ACTIVE", "PAUSED", "CANCELLED", "FAILED"].map((tab) => {
                  const isActive = status === tab;
                  return (
                    <Link
                      key={tab}
                      to={`?status=${tab}&q=${encodeURIComponent(q)}`}
                      style={{
                        padding: "7px 16px",
                        borderRadius: "20px",
                        fontSize: "13px",
                        fontWeight: "800",
                        textDecoration: "none",
                        background: isActive ? "#000" : "#f4f4f5",
                        color: isActive ? "#fff" : "rgba(0, 0, 0, 0.7)",
                        border: "none",
                        transition: "0.15s",
                      }}
                    >
                      {tab === "ALL" ? `All (${stats.total})` : `${tab} (${stats.counts[tab] || 0})`}
                    </Link>
                  );
                })}
              </div>

              {/* Search form */}
              <form method="get" style={{ display: "flex", gap: "8px" }}>
                <input type="hidden" name="status" value={status} />
                <input
                  type="text"
                  name="q"
                  placeholder="Search customer, email, plan..."
                  defaultValue={q}
                  style={{
                    padding: "8px 14px",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    fontSize: "13px",
                    color: "#000",
                    background: "#fafafa",
                    minWidth: "220px",
                    outline: "none",
                  }}
                />
                <button
                  type="submit"
                  style={{
                    padding: "8px 18px",
                    background: "#000",
                    color: "#fff",
                    border: "none",
                    borderRadius: "8px",
                    fontSize: "13px",
                    fontWeight: "800",
                    cursor: "pointer",
                  }}
                >
                  Search
                </button>
              </form>
            </div>

            {/* Table or Clean Empty State */}
            {list.rows.length === 0 ? (
              <div style={{ padding: "56px 20px", textAlign: "center", width: "100%" }}>
                <div style={{ fontSize: "36px", marginBottom: "10px" }}>📦</div>
                <div style={{ fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>No subscriptions found yet.</div>
                <div style={{ marginTop: "6px", fontSize: "13px", color: "#64748B", maxWidth: "460px", margin: "6px auto 16px", fontWeight: "400" }}>
                  When customers purchase products with a &quot;Subscribe &amp; Save&quot; plan, they will automatically appear here. You can also activate a subscription for an existing order.
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setOrderQuery("#1004");
                    setIsSubscribeModalOpen(true);
                  }}
                  style={{
                    background: "#0F172A",
                    color: "#FFFFFF",
                    border: "none",
                    borderRadius: "8px",
                    padding: "9px 20px",
                    fontSize: "13px",
                    fontWeight: "700",
                    cursor: "pointer",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                    transition: "all 0.15s ease",
                  }}
                >
                  + Subscribe Customer from Order (e.g. #1004)
                </button>
              </div>
            ) : (
              <div style={{ width: "100%", overflowX: "auto", borderRadius: "10px", border: "1px solid #E2E8F0" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                      <th style={{ padding: "12px 16px", fontSize: "11px", color: "#64748B", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.05em" }}>Subscriber</th>
                      <th style={{ padding: "12px 16px", fontSize: "11px", color: "#64748B", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.05em" }}>Items &amp; Recurring Total</th>
                      <th style={{ padding: "12px 16px", fontSize: "11px", color: "#64748B", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.05em" }}>Plan Frequency</th>
                      <th style={{ padding: "12px 16px", fontSize: "11px", color: "#64748B", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.05em" }}>Next Renewal Billing</th>
                      <th style={{ padding: "12px 16px", fontSize: "11px", color: "#64748B", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.05em" }}>Status</th>
                      <th style={{ padding: "12px 16px", fontSize: "11px", color: "#64748B", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((sub) => {
                      const lines = (Array.isArray(sub.lines) ? sub.lines : []) as Array<{ quantity?: number; title?: string }>;
                      return (
                        <tr
                          key={sub.id}
                          style={{ borderBottom: "1px solid #F1F5F9", transition: "background 0.15s ease" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#F8FAFC")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                        >
                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            <div style={{ fontWeight: "700", color: "#0F172A" }}>
                              {sub.customerName || "Customer"}
                            </div>
                            <div style={{ color: "#64748B", fontSize: "12px", marginTop: "2px", fontWeight: "400" }}>
                              {sub.customerEmail || sub.originOrderName || "Online Order"}
                            </div>
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            <div style={{ fontWeight: "600", color: "#0F172A" }}>
                              {lines.map((l) => `${l.quantity}× ${l.title}`).join(", ") || "Subscription Item"}
                            </div>
                            <div style={{ color: "#0F172A", fontSize: "13px", fontWeight: "700", marginTop: "2px" }}>
                              ₹{(sub.recurringTotal + sub.deliveryPrice).toLocaleString("en-IN")}
                              <span style={{ fontSize: "11px", color: "#64748B", fontWeight: "400", marginLeft: "4px" }}>
                                ({sub.ordersBilled} cycles billed)
                              </span>
                            </div>
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            <span style={{ background: "#F1F5F9", color: "#334155", border: "1px solid #E2E8F0", padding: "4px 10px", borderRadius: "12px", fontSize: "12px", fontWeight: "600" }}>
                              {sub.planName || describeFrequency(sub.interval, sub.intervalCount)}
                            </span>
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "13px", color: "#0F172A" }}>
                            {sub.nextBillingAt ? (
                              <div>
                                <div style={{ fontWeight: "700", color: "#0F172A" }}>
                                  {new Date(sub.nextBillingAt).toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })}
                                </div>
                                <div style={{ fontSize: "11px", color: "#64748B", fontWeight: "400" }}>
                                  Auto-bills to Shopify order
                                </div>
                              </div>
                            ) : (
                              <span style={{ color: "#94A3B8" }}>—</span>
                            )}
                          </td>

                          <td style={{ padding: "14px 16px" }}>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "4px 12px",
                                borderRadius: "12px",
                                fontSize: "11px",
                                fontWeight: "700",
                                color: sub.status === "ACTIVE" ? "#065F46" : "#92400E",
                                background: sub.status === "ACTIVE" ? "#ECFDF5" : "#FFFBEB",
                                border: sub.status === "ACTIVE" ? "1px solid #A7F3D0" : "1px solid #FDE68A",
                              }}
                            >
                              {sub.status}
                            </span>
                          </td>

                          <td style={{ padding: "14px 16px", textAlign: "right" }}>
                            <Link
                              to={`/app/subscriptions/${sub.id}`}
                              style={{
                                display: "inline-block",
                                padding: "6px 14px",
                                background: "#0F172A",
                                border: "none",
                                borderRadius: "6px",
                                color: "#fff",
                                fontSize: "12px",
                                fontWeight: "600",
                                textDecoration: "none",
                                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                                transition: "all 0.15s ease",
                              }}
                            >
                              Manage →
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {list.pages > 1 && (
              <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #f3f4f6", fontSize: "13px", color: "#000", fontWeight: "700" }}>
                <div style={{ color: "rgba(0, 0, 0, 0.55)", fontWeight: "400" }}>Page {list.page} of {list.pages} ({list.total} total subscriptions)</div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {list.page > 1 && (
                    <Link
                      to={`?status=${status}&q=${encodeURIComponent(q)}&page=${list.page - 1}`}
                      style={{ padding: "6px 14px", background: "#f4f4f5", border: "none", borderRadius: "6px", textDecoration: "none", color: "#000", fontWeight: "700" }}
                    >
                      ← Previous
                    </Link>
                  )}
                  {list.page < list.pages && (
                    <Link
                      to={`?status=${status}&q=${encodeURIComponent(q)}&page=${list.page + 1}`}
                      style={{ padding: "6px 14px", background: "#000", border: "none", borderRadius: "6px", textDecoration: "none", color: "#fff", fontWeight: "800" }}
                    >
                      Next →
                    </Link>
                  )}
                </div>
              </div>
            )}
          </div>
        </s-section>
      </s-stack>

      {/* Modal to subscribe from order */}
      {isSubscribeModalOpen && (
        <div
          style={{
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
          }}
        >
          <div
            style={{
              background: "#FFFFFF",
              borderRadius: "16px",
              padding: "24px",
              maxWidth: "480px",
              width: "100%",
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
            }}
          >
            <h3 style={{ margin: "0 0 8px 0", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>
              Subscribe Customer from Order
            </h3>
            <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "#64748B" }}>
              Register a customer checkout order as an active recurring subscription with scheduled delivery cycles.
            </p>

            <Form method="post">
              <input type="hidden" name="intent" value="subscribe_order" />

              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: "600", marginBottom: "6px", color: "#0F172A" }}>
                  Shopify Order Number:
                </label>
                <input
                  type="text"
                  name="orderName"
                  value={orderQuery}
                  onChange={(e) => setOrderQuery(e.target.value)}
                  placeholder="e.g. #1004"
                  required
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    background: "#FFFFFF",
                    fontSize: "14px",
                    color: "#0F172A",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ marginBottom: "20px" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: "600", marginBottom: "6px", color: "#0F172A" }}>
                  Delivery Frequency:
                </label>
                <select
                  name="days"
                  value={frequencyDays}
                  onChange={(e) => setFrequencyDays(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    background: "#FFFFFF",
                    fontSize: "14px",
                    color: "#0F172A",
                    boxSizing: "border-box",
                  }}
                >
                  <option value="15">Every 15 days (Save 15%)</option>
                  <option value="30">Every 30 days (Save 15%)</option>
                  <option value="45">Every 45 days (Save 15%)</option>
                  <option value="60">Every 60 days (Save 15%)</option>
                </select>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => setIsSubscribeModalOpen(false)}
                  style={{
                    padding: "9px 16px",
                    background: "#F1F5F9",
                    border: "1px solid #E2E8F0",
                    borderRadius: "8px",
                    color: "#334155",
                    fontWeight: "600",
                    fontSize: "13px",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isBusy}
                  style={{
                    padding: "9px 20px",
                    background: "#0F172A",
                    border: "none",
                    borderRadius: "8px",
                    color: "#FFFFFF",
                    fontWeight: "700",
                    fontSize: "13px",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  }}
                >
                  {isBusy ? "Subscribing..." : "Activate Subscription"}
                </button>
              </div>
            </Form>
          </div>
        </div>
      )}
    </s-page>
  );
}
