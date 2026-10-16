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

  const statusTones: Record<string, "success" | "warning" | "critical" | "neutral"> = {
    ACTIVE: "success",
    PAUSED: "warning",
    CANCELLED: "neutral",
    FAILED: "critical",
    EXPIRED: "neutral",
  };

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
          <div style={{ background: "#fff", padding: "20px", borderRadius: "10px", border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "#5c5f62", textTransform: "uppercase" }}>Active Subscribers</div>
            <div style={{ fontSize: "30px", fontWeight: "800", color: "#202223", marginTop: "8px" }}>
              {stats.counts["ACTIVE"] || 0}
            </div>
            <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "4px" }}>
              Total subscriptions: {stats.total}
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "10px", border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "#5c5f62", textTransform: "uppercase" }}>Estimated MRR</div>
            <div style={{ fontSize: "30px", fontWeight: "800", color: "#008060", marginTop: "8px" }}>
              ₹{Math.round(stats.mrr).toLocaleString("en-IN")}
            </div>
            <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "4px" }}>
              Monthly recurring revenue
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "10px", border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "#5c5f62", textTransform: "uppercase" }}>Next 7 Days Deliveries</div>
            <div style={{ fontSize: "30px", fontWeight: "800", color: "#2c6ecb", marginTop: "8px" }}>
              {stats.billingNext7Days}
            </div>
            <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "4px" }}>
              Scheduled for charge & delivery
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "10px", border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "#5c5f62", textTransform: "uppercase" }}>Payment Retries</div>
            <div style={{ fontSize: "30px", fontWeight: "800", color: stats.retrying > 0 ? "#d72c0d" : "#6d7175", marginTop: "8px" }}>
              {stats.retrying}
            </div>
            <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "4px" }}>
              {stats.retrying > 0 ? "Attempts pending re-charge" : "All payments up to date"}
            </div>
          </div>
        </div>

        {/* Quick links banner */}
        <div style={{ background: "#f8f9fa", border: "1px solid #dcdce0", borderRadius: "8px", padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", gap: "20px", alignItems: "center" }}>
            <span style={{ fontWeight: "700", fontSize: "14px" }}>Subscription Management:</span>
            <Link to="/app/subscriptions/calendar" style={{ color: "#2c6ecb", textDecoration: "none", fontWeight: "600", fontSize: "13px" }}>📅 Monthly Delivery Calendar</Link>
            <Link to="/app/subscriptions/plans" style={{ color: "#2c6ecb", textDecoration: "none", fontWeight: "600", fontSize: "13px" }}>📦 Subscription Plans & Discounts</Link>
            <Link to="/app/subscriptions/settings" style={{ color: "#2c6ecb", textDecoration: "none", fontWeight: "600", fontSize: "13px" }}>⚙️ Delivery & Billing Rules</Link>
          </div>
          <div style={{ color: "#5c5f62", fontSize: "12px" }}>
            Automated delivery calculations & cut-off protection active
          </div>
        </div>

        {/* Subscriptions Table Section */}
        <s-section heading="All Subscriptions">
          <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #dcdce0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", overflow: "hidden" }}>
            {/* Filter bar */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #ebebeb", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
              {/* Status tabs */}
              <div style={{ display: "flex", gap: "6px" }}>
                {["ALL", "ACTIVE", "PAUSED", "CANCELLED", "FAILED"].map((tab) => {
                  const isActive = status === tab;
                  return (
                    <Link
                      key={tab}
                      to={`?status=${tab}&q=${encodeURIComponent(q)}`}
                      style={{
                        padding: "6px 14px",
                        borderRadius: "20px",
                        fontSize: "13px",
                        fontWeight: "600",
                        textDecoration: "none",
                        background: isActive ? "#121217" : "#f1f2f3",
                        color: isActive ? "#fff" : "#5c5f62",
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
                    border: "1px solid #c9cccf",
                    borderRadius: "6px",
                    fontSize: "13px",
                    minWidth: "240px",
                  }}
                />
                <button
                  type="submit"
                  style={{
                    padding: "8px 16px",
                    background: "#f1f2f3",
                    border: "1px solid #c9cccf",
                    borderRadius: "6px",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  Search
                </button>
              </form>
            </div>

            {/* Table */}
            <div style={{ overflowX: "auto", width: "100%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", minWidth: "950px" }}>
                <thead>
                  <tr style={{ backgroundColor: "#f9fafb", borderBottom: "1px solid #ebebeb" }}>
                    <th style={{ padding: "14px 18px", fontSize: "12px", color: "#5c5f62", fontWeight: "700", textTransform: "uppercase" }}>Subscriber</th>
                    <th style={{ padding: "14px 18px", fontSize: "12px", color: "#5c5f62", fontWeight: "700", textTransform: "uppercase" }}>Items & Recurring Total</th>
                    <th style={{ padding: "14px 18px", fontSize: "12px", color: "#5c5f62", fontWeight: "700", textTransform: "uppercase" }}>Plan Frequency</th>
                    <th style={{ padding: "14px 18px", fontSize: "12px", color: "#5c5f62", fontWeight: "700", textTransform: "uppercase" }}>Next Delivery Date</th>
                    <th style={{ padding: "14px 18px", fontSize: "12px", color: "#5c5f62", fontWeight: "700", textTransform: "uppercase" }}>Next Billing</th>
                    <th style={{ padding: "14px 18px", fontSize: "12px", color: "#5c5f62", fontWeight: "700", textTransform: "uppercase" }}>Status</th>
                    <th style={{ padding: "14px 18px", fontSize: "12px", color: "#5c5f62", fontWeight: "700", textTransform: "uppercase", textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ padding: "48px 20px", textAlign: "center", color: "#6d7175", fontSize: "14px" }}>
                        <div style={{ fontSize: "28px", marginBottom: "8px" }}>📦</div>
                        <strong>No subscriptions found.</strong>
                        <div style={{ marginTop: "4px", fontSize: "13px" }}>
                          When customers purchase products with a &quot;Subscribe &amp; Save&quot; plan, they will automatically appear here.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    list.rows.map((sub) => {
                      const lines = (Array.isArray(sub.lines) ? sub.lines : []) as Array<{ quantity?: number; title?: string }>;
                      const deliveryDay = sub.nextDeliveryDate ? WEEKDAY_NAMES[weekdayOf(sub.nextDeliveryDate)] : null;
                      return (
                        <tr
                          key={sub.id}
                          style={{ borderBottom: "1px solid #ebebeb", transition: "background 0.15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f9fafb")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                        >
                          <td style={{ padding: "16px 18px", fontSize: "14px" }}>
                            <div style={{ fontWeight: "700", color: "#202223" }}>
                              {sub.customerName || "Customer"}
                            </div>
                            <div style={{ color: "#6d7175", fontSize: "12px", marginTop: "2px" }}>
                              {sub.customerEmail || sub.originOrderName || "Online Order"}
                            </div>
                          </td>

                          <td style={{ padding: "16px 18px", fontSize: "14px" }}>
                            <div style={{ fontWeight: "600", color: "#202223" }}>
                              {lines.map((l) => `${l.quantity}× ${l.title}`).join(", ") || "Subscription Item"}
                            </div>
                            <div style={{ color: "#008060", fontSize: "13px", fontWeight: "700", marginTop: "2px" }}>
                              ₹{(sub.recurringTotal + sub.deliveryPrice).toLocaleString("en-IN")}
                              <span style={{ fontSize: "11px", color: "#6d7175", fontWeight: "400", marginLeft: "4px" }}>
                                ({sub.ordersBilled} cycles billed)
                              </span>
                            </div>
                          </td>

                          <td style={{ padding: "16px 18px", fontSize: "14px" }}>
                            <span style={{ background: "#f1f2f3", padding: "4px 10px", borderRadius: "12px", fontSize: "12px", fontWeight: "600" }}>
                              {sub.planName || describeFrequency(sub.interval, sub.intervalCount)}
                            </span>
                          </td>

                          <td style={{ padding: "16px 18px", fontSize: "14px" }}>
                            {sub.nextDeliveryDate ? (
                              <div>
                                <div style={{ fontWeight: "700", color: "#202223" }}>{sub.nextDeliveryDate}</div>
                                <div style={{ fontSize: "12px", color: "#2c6ecb", fontWeight: "600" }}>
                                  {deliveryDay}
                                </div>
                              </div>
                            ) : (
                              <span style={{ color: "#8c8c9a" }}>None</span>
                            )}
                          </td>

                          <td style={{ padding: "16px 18px", fontSize: "13px", color: "#5c5f62" }}>
                            {sub.nextBillingAt ? (
                              <div>{new Date(sub.nextBillingAt).toLocaleDateString("en-IN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                            ) : (
                              "—"
                            )}
                          </td>

                          <td style={{ padding: "16px 18px" }}>
                            <s-badge tone={statusTones[sub.status] || "neutral"}>
                              {sub.status}
                            </s-badge>
                          </td>

                          <td style={{ padding: "16px 18px", textAlign: "right" }}>
                            <Link
                              to={`/app/subscriptions/${sub.id}`}
                              style={{
                                display: "inline-block",
                                padding: "6px 14px",
                                background: "#fff",
                                border: "1px solid #c9cccf",
                                borderRadius: "6px",
                                color: "#202223",
                                fontSize: "13px",
                                fontWeight: "600",
                                textDecoration: "none",
                              }}
                            >
                              Manage →
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {list.pages > 1 && (
              <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #ebebeb", fontSize: "13px", color: "#6d7175" }}>
                <div>Page {list.page} of {list.pages} ({list.total} total subscriptions)</div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {list.page > 1 && (
                    <Link
                      to={`?status=${status}&q=${encodeURIComponent(q)}&page=${list.page - 1}`}
                      style={{ padding: "6px 12px", background: "#f1f2f3", borderRadius: "4px", textDecoration: "none", color: "#202223" }}
                    >
                      ← Previous
                    </Link>
                  )}
                  {list.page < list.pages && (
                    <Link
                      to={`?status=${status}&q=${encodeURIComponent(q)}&page=${list.page + 1}`}
                      style={{ padding: "6px 12px", background: "#f1f2f3", borderRadius: "4px", textDecoration: "none", color: "#202223" }}
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
