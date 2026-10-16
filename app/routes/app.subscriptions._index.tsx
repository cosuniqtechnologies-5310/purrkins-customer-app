import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getStats, listSubscriptions, runSchedulerTick } from "../utils/subscription.server";
import { describeFrequency, WEEKDAY_NAMES, weekdayOf } from "../utils/subscription-schedule";

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
  await authenticate.admin(request);
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

  return { success: false, message: "Unknown action" };
};

export default function SubscriptionsIndex() {
  const { stats, list, status, q } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const nav = useNavigation();
  const isBusy = nav.state !== "idle";

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.success });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Subscriptions & Delivery Management">
      <div slot="primary-action" style={{ display: "flex", gap: "8px" }}>
        <Form method="post">
          <input type="hidden" name="intent" value="run_scheduler" />
          <s-button type="submit" loading={isBusy} variant="secondary">
            Run Billing Check Now
          </s-button>
        </Form>
        <s-button href="/app/subscriptions/calendar" variant="primary">
          View Delivery Calendar
        </s-button>
      </div>

      <s-stack direction="block" gap="base">
        {/* KPI Metrics row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
          <div style={{ background: "#fff", padding: "20px", borderRadius: "10px", border: "1.5px solid #000", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: "13px", fontWeight: "800", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>Active Subscribers</div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#000", marginTop: "8px", lineHeight: "1" }}>
              {stats.counts["ACTIVE"] || 0}
            </div>
            <div style={{ fontSize: "12px", color: "#000", marginTop: "6px", fontWeight: "500" }}>
              Total subscriptions: {stats.total}
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "10px", border: "1.5px solid #000", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: "13px", fontWeight: "800", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>Estimated MRR</div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#000", marginTop: "8px", lineHeight: "1" }}>
              ₹{Math.round(stats.mrr).toLocaleString("en-IN")}
            </div>
            <div style={{ fontSize: "12px", color: "#000", marginTop: "6px", fontWeight: "500" }}>
              Monthly recurring revenue
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "10px", border: "1.5px solid #000", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: "13px", fontWeight: "800", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>Next 7 Days Deliveries</div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#000", marginTop: "8px", lineHeight: "1" }}>
              {stats.billingNext7Days}
            </div>
            <div style={{ fontSize: "12px", color: "#000", marginTop: "6px", fontWeight: "500" }}>
              Scheduled for charge & delivery
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "10px", border: "1.5px solid #000", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            <div style={{ fontSize: "13px", fontWeight: "800", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>Payment Retries</div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#000", marginTop: "8px", lineHeight: "1" }}>
              {stats.retrying}
            </div>
            <div style={{ fontSize: "12px", color: "#000", marginTop: "6px", fontWeight: "500" }}>
              {stats.retrying > 0 ? "Attempts pending re-charge" : "All payments up to date"}
            </div>
          </div>
        </div>

        {/* Quick links banner */}
        <div style={{ background: "#f8f9fa", border: "1.5px solid #000", borderRadius: "8px", padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontWeight: "800", fontSize: "14px", color: "#000" }}>Subscription Management:</span>
            <Link to="/app/subscriptions/calendar" style={{ color: "#000", textDecoration: "underline", fontWeight: "700", fontSize: "13px" }}>📅 Monthly Delivery Calendar</Link>
            <Link to="/app/subscriptions/plans" style={{ color: "#000", textDecoration: "underline", fontWeight: "700", fontSize: "13px" }}>📦 Subscription Plans & Discounts</Link>
            <Link to="/app/subscriptions/settings" style={{ color: "#000", textDecoration: "underline", fontWeight: "700", fontSize: "13px" }}>⚙️ Delivery & Billing Rules</Link>
          </div>
          <div style={{ color: "#000", fontSize: "12px", fontWeight: "600" }}>
            Automated delivery calculations & cut-off protection active
          </div>
        </div>

        {/* Subscriptions Table Section */}
        <s-section heading="All Subscriptions">
          <div style={{ background: "#fff", borderRadius: "10px", border: "1.5px solid #000", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
            {/* Filter bar */}
            <div style={{ padding: "16px 20px", borderBottom: "1.5px solid #000", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
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
                        background: isActive ? "#000" : "#fff",
                        color: isActive ? "#fff" : "#000",
                        border: "1.5px solid #000",
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
                    border: "1.5px solid #000",
                    borderRadius: "6px",
                    fontSize: "13px",
                    color: "#000",
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
                    border: "1.5px solid #000",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "700",
                    cursor: "pointer",
                  }}
                >
                  Search
                </button>
              </form>
            </div>

            {/* Table or Clean Empty State (Zero horizontal scroll) */}
            {list.rows.length === 0 ? (
              <div style={{ padding: "56px 20px", textAlign: "center", color: "#000", width: "100%" }}>
                <div style={{ fontSize: "36px", marginBottom: "10px" }}>📦</div>
                <div style={{ fontSize: "16px", fontWeight: "900", color: "#000" }}>No subscriptions found.</div>
                <div style={{ marginTop: "6px", fontSize: "13px", color: "#000", maxWidth: "460px", margin: "6px auto 0" }}>
                  When customers purchase products with a &quot;Subscribe &amp; Save&quot; plan, they will automatically appear here.
                </div>
              </div>
            ) : (
              <div style={{ width: "100%" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#f9fafb", borderBottom: "1.5px solid #000" }}>
                      <th style={{ padding: "14px 16px", fontSize: "12px", color: "#000", fontWeight: "900", textTransform: "uppercase" }}>Subscriber</th>
                      <th style={{ padding: "14px 16px", fontSize: "12px", color: "#000", fontWeight: "900", textTransform: "uppercase" }}>Items & Recurring Total</th>
                      <th style={{ padding: "14px 16px", fontSize: "12px", color: "#000", fontWeight: "900", textTransform: "uppercase" }}>Plan Frequency</th>
                      <th style={{ padding: "14px 16px", fontSize: "12px", color: "#000", fontWeight: "900", textTransform: "uppercase" }}>Next Delivery Date</th>
                      <th style={{ padding: "14px 16px", fontSize: "12px", color: "#000", fontWeight: "900", textTransform: "uppercase" }}>Next Billing</th>
                      <th style={{ padding: "14px 16px", fontSize: "12px", color: "#000", fontWeight: "900", textTransform: "uppercase" }}>Status</th>
                      <th style={{ padding: "14px 16px", fontSize: "12px", color: "#000", fontWeight: "900", textTransform: "uppercase", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((sub) => {
                      const lines = (Array.isArray(sub.lines) ? sub.lines : []) as Array<{ quantity?: number; title?: string }>;
                      const deliveryDay = sub.nextDeliveryDate ? WEEKDAY_NAMES[weekdayOf(sub.nextDeliveryDate)] : null;
                      return (
                        <tr
                          key={sub.id}
                          style={{ borderBottom: "1px solid #e5e7eb", transition: "background 0.15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f9fafb")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                        >
                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            <div style={{ fontWeight: "800", color: "#000" }}>
                              {sub.customerName || "Customer"}
                            </div>
                            <div style={{ color: "#000", fontSize: "12px", marginTop: "2px", fontWeight: "500" }}>
                              {sub.customerEmail || sub.originOrderName || "Online Order"}
                            </div>
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            <div style={{ fontWeight: "700", color: "#000" }}>
                              {lines.map((l) => `${l.quantity}× ${l.title}`).join(", ") || "Subscription Item"}
                            </div>
                            <div style={{ color: "#000", fontSize: "13px", fontWeight: "800", marginTop: "2px" }}>
                              ₹{(sub.recurringTotal + sub.deliveryPrice).toLocaleString("en-IN")}
                              <span style={{ fontSize: "11px", color: "#000", fontWeight: "500", marginLeft: "4px" }}>
                                ({sub.ordersBilled} cycles billed)
                              </span>
                            </div>
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            <span style={{ background: "#fff", border: "1.5px solid #000", color: "#000", padding: "4px 10px", borderRadius: "12px", fontSize: "12px", fontWeight: "700" }}>
                              {sub.planName || describeFrequency(sub.interval, sub.intervalCount)}
                            </span>
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            {sub.nextDeliveryDate ? (
                              <div>
                                <div style={{ fontWeight: "800", color: "#000" }}>{sub.nextDeliveryDate}</div>
                                <div style={{ fontSize: "12px", color: "#000", fontWeight: "600" }}>
                                  {deliveryDay}
                                </div>
                              </div>
                            ) : (
                              <span style={{ color: "#000" }}>None</span>
                            )}
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "13px", color: "#000", fontWeight: "600" }}>
                            {sub.nextBillingAt ? (
                              <div>{new Date(sub.nextBillingAt).toLocaleDateString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                            ) : (
                              "—"
                            )}
                          </td>

                          <td style={{ padding: "14px 16px" }}>
                            <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: "800", border: "1.5px solid #000", color: "#000", background: "#fff" }}>
                              {sub.status}
                            </span>
                          </td>

                          <td style={{ padding: "14px 16px", textAlign: "right" }}>
                            <Link
                              to={`/app/subscriptions/${sub.id}`}
                              style={{
                                display: "inline-block",
                                padding: "6px 14px",
                                background: "#000",
                                border: "1.5px solid #000",
                                borderRadius: "6px",
                                color: "#fff",
                                fontSize: "13px",
                                fontWeight: "700",
                                textDecoration: "none",
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
              <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1.5px solid #000", fontSize: "13px", color: "#000", fontWeight: "700" }}>
                <div>Page {list.page} of {list.pages} ({list.total} total subscriptions)</div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {list.page > 1 && (
                    <Link
                      to={`?status=${status}&q=${encodeURIComponent(q)}&page=${list.page - 1}`}
                      style={{ padding: "6px 14px", background: "#fff", border: "1.5px solid #000", borderRadius: "4px", textDecoration: "none", color: "#000", fontWeight: "700" }}
                    >
                      ← Previous
                    </Link>
                  )}
                  {list.page < list.pages && (
                    <Link
                      to={`?status=${status}&q=${encodeURIComponent(q)}&page=${list.page + 1}`}
                      style={{ padding: "6px 14px", background: "#000", border: "1.5px solid #000", borderRadius: "4px", textDecoration: "none", color: "#fff", fontWeight: "700" }}
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
    </s-page>
  );
}
