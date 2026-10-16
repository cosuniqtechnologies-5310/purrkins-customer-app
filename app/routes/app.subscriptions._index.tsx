import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getStats, listSubscriptions, runSchedulerTick } from "../utils/subscription.server";
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
    <s-page heading="Subscriptions & Recurring Orders">
      <div slot="primary-action" style={{ display: "flex", gap: "8px" }}>
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
                <div style={{ fontSize: "16px", fontWeight: "800", color: "#000" }}>No subscriptions found.</div>
                <div style={{ marginTop: "6px", fontSize: "13px", color: "rgba(0, 0, 0, 0.55)", maxWidth: "460px", margin: "6px auto 0", fontWeight: "400" }}>
                  When customers purchase products with a &quot;Subscribe &amp; Save&quot; plan, they will automatically appear here.
                </div>
              </div>
            ) : (
              <div style={{ width: "100%", overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#fafafa", borderBottom: "1px solid #f3f4f6" }}>
                      <th style={{ padding: "14px 16px", fontSize: "11px", color: "#000", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.5px" }}>Subscriber</th>
                      <th style={{ padding: "14px 16px", fontSize: "11px", color: "#000", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.5px" }}>Items &amp; Recurring Total</th>
                      <th style={{ padding: "14px 16px", fontSize: "11px", color: "#000", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.5px" }}>Plan Frequency</th>
                      <th style={{ padding: "14px 16px", fontSize: "11px", color: "#000", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.5px" }}>Next Renewal Billing</th>
                      <th style={{ padding: "14px 16px", fontSize: "11px", color: "#000", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.5px" }}>Status</th>
                      <th style={{ padding: "14px 16px", fontSize: "11px", color: "#000", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.5px", textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((sub) => {
                      const lines = (Array.isArray(sub.lines) ? sub.lines : []) as Array<{ quantity?: number; title?: string }>;
                      return (
                        <tr
                          key={sub.id}
                          style={{ borderBottom: "1px solid #f9fafb", transition: "background 0.15s" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#fafafa")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                        >
                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            <div style={{ fontWeight: "800", color: "#000" }}>
                              {sub.customerName || "Customer"}
                            </div>
                            <div style={{ color: "rgba(0, 0, 0, 0.5)", fontSize: "12px", marginTop: "2px", fontWeight: "400" }}>
                              {sub.customerEmail || sub.originOrderName || "Online Order"}
                            </div>
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            <div style={{ fontWeight: "700", color: "#000" }}>
                              {lines.map((l) => `${l.quantity}× ${l.title}`).join(", ") || "Subscription Item"}
                            </div>
                            <div style={{ color: "#000", fontSize: "13px", fontWeight: "800", marginTop: "2px" }}>
                              ₹{(sub.recurringTotal + sub.deliveryPrice).toLocaleString("en-IN")}
                              <span style={{ fontSize: "11px", color: "rgba(0, 0, 0, 0.5)", fontWeight: "400", marginLeft: "4px" }}>
                                ({sub.ordersBilled} cycles billed)
                              </span>
                            </div>
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "14px" }}>
                            <span style={{ background: "#f4f4f5", color: "#000", padding: "4px 10px", borderRadius: "12px", fontSize: "12px", fontWeight: "700" }}>
                              {sub.planName || describeFrequency(sub.interval, sub.intervalCount)}
                            </span>
                          </td>

                          <td style={{ padding: "14px 16px", fontSize: "13px", color: "#000" }}>
                            {sub.nextBillingAt ? (
                              <div>
                                <div style={{ fontWeight: "800" }}>
                                  {new Date(sub.nextBillingAt).toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })}
                                </div>
                                <div style={{ fontSize: "11px", color: "rgba(0, 0, 0, 0.5)", fontWeight: "400" }}>
                                  Auto-bills to Shopify order
                                </div>
                              </div>
                            ) : (
                              "—"
                            )}
                          </td>

                          <td style={{ padding: "14px 16px" }}>
                            <span style={{ display: "inline-block", padding: "4px 12px", borderRadius: "12px", fontSize: "11px", fontWeight: "800", color: sub.status === "ACTIVE" ? "#0d6832" : "rgba(0, 0, 0, 0.6)", background: sub.status === "ACTIVE" ? "#e6f7ee" : "#f4f4f5" }}>
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
                                border: "none",
                                borderRadius: "6px",
                                color: "#fff",
                                fontSize: "12px",
                                fontWeight: "800",
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
    </s-page>
  );
}
