import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getStats,
  getSubscriptionProducts,
  listSubscriptions,
  runSchedulerTick,
  subscribeFromOrder,
  syncShopifySubscriptionOrders,
} from "../utils/subscription.server";
import { describeFrequency } from "../utils/subscription-schedule";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const status = url.searchParams.get("status") || "ALL";
  const q = url.searchParams.get("q") || "";
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const activeTab = url.searchParams.get("tab") || "subscribers";

  // Reconcile any recent paid subscription orders from Shopify automatically
  try {
    await syncShopifySubscriptionOrders(shop);
  } catch (err) {
    console.warn("Shopify subscription order auto-sync in dashboard loader warning:", err);
  }

  const [stats, list, subscriptionProducts] = await Promise.all([
    getStats(shop),
    listSubscriptions(shop, { status, q, page, pageSize: 20 }),
    getSubscriptionProducts(shop),
  ]);

  return { shop, stats, list, status, q, page, activeTab, subscriptionProducts };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync_orders") {
    try {
      const res = await syncShopifySubscriptionOrders(shop);
      return {
        success: true,
        message: `Synced with Shopify: ${res.synced} new subscription order(s) processed. Total active subscriptions: ${res.totalActive}.`,
      };
    } catch (e: unknown) {
      return { success: false, message: `Sync error: ${e instanceof Error ? e.message : "Sync failed"}` };
    }
  }

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
      return { success: false, message: "Please enter an order number (e.g. #1006)" };
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

// Helper to extract clean initials for avatar
function getInitials(name?: string | null, email?: string | null) {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  }
  if (email && email.trim()) {
    return email.substring(0, 2).toUpperCase();
  }
  return "CU";
}

// Helper to format plan frequency into clean main text + discount badge
function parsePlanFrequency(rawPlan?: string | null) {
  if (!rawPlan) return { text: "Every 30 days", discount: null };
  const discountMatch = rawPlan.match(/\(Save[^)]+\)/i) || rawPlan.match(/\([^)]*%\s*off\)/i);
  const discount = discountMatch ? discountMatch[0].replace(/[()]/g, "").trim() : null;
  const text = rawPlan
    .replace(/\(Save[^)]+\)/gi, "")
    .replace(/\([^)]*%\s*off\)/gi, "")
    .replace(/^Delivered\s+/i, "")
    .trim() || rawPlan;
  return { text: text.charAt(0).toUpperCase() + text.slice(1), discount };
}

export default function SubscriptionsIndex() {
  const { stats, list, status, q, activeTab, subscriptionProducts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const nav = useNavigation();
  const isBusy = nav.state !== "idle";
  const [currentTab, setCurrentTab] = useState(activeTab);
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

  const eligibleProducts = subscriptionProducts.filter((p) => p.isEligible);

  return (
    <s-page heading="Subscriptions & Recurring Orders">
      <div slot="primary-action" style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <Form method="post" style={{ display: "inline" }}>
          <input type="hidden" name="intent" value="sync_orders" />
          <button
            type="submit"
            disabled={isBusy}
            style={{
              background: "#F1F5F9",
              color: "#0F172A",
              border: "1px solid #CBD5E1",
              borderRadius: "8px",
              padding: "8px 14px",
              fontSize: "13px",
              fontWeight: "700",
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
          >
            🔄 Sync Shopify Orders
          </button>
        </Form>
        <button
          type="button"
          onClick={() => {
            setOrderQuery("#1006");
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
        <Form method="post" style={{ display: "inline" }}>
          <input type="hidden" name="intent" value="run_scheduler" />
          <button
            type="submit"
            disabled={isBusy}
            style={{
              background: "#FFFFFF",
              color: "#0F172A",
              border: "1px solid #E2E8F0",
              borderRadius: "8px",
              padding: "8px 14px",
              fontSize: "13px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Run Billing Check Now
          </button>
        </Form>
        <Link
          to="/app/subscriptions/plans"
          style={{
            background: "#0F172A",
            color: "#FFFFFF",
            border: "none",
            borderRadius: "8px",
            padding: "8px 16px",
            fontSize: "13px",
            fontWeight: "700",
            textDecoration: "none",
            display: "inline-block",
          }}
        >
          Manage Plans &amp; Discounts
        </Link>
      </div>

      <s-stack direction="block" gap="base">
        {/* KPI Metrics row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
          <div style={{ background: "#fff", padding: "20px", borderRadius: "14px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: "11.5px", fontWeight: "800", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>Active Subscribers</div>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10B981", display: "inline-block" }}></span>
            </div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#0F172A", marginTop: "8px", lineHeight: "1" }}>
              {stats.counts["ACTIVE"] || 0}
            </div>
            <div style={{ fontSize: "12px", color: "#64748B", marginTop: "6px", fontWeight: "500" }}>
              Total subscriptions: <strong style={{ color: "#0F172A" }}>{stats.total}</strong>
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "14px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: "11.5px", fontWeight: "800", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>Estimated MRR</div>
              <span style={{ fontSize: "13px" }}>💰</span>
            </div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#0F172A", marginTop: "8px", lineHeight: "1" }}>
              ₹{Math.round(stats.mrr).toLocaleString("en-IN")}
            </div>
            <div style={{ fontSize: "12px", color: "#64748B", marginTop: "6px", fontWeight: "500" }}>
              Monthly recurring revenue
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "14px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: "11.5px", fontWeight: "800", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>Renewals (Next 7 Days)</div>
              <span style={{ fontSize: "13px" }}>📅</span>
            </div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: "#0F172A", marginTop: "8px", lineHeight: "1" }}>
              {stats.billingNext7Days}
            </div>
            <div style={{ fontSize: "12px", color: "#64748B", marginTop: "6px", fontWeight: "500" }}>
              Scheduled recurring billing cycles
            </div>
          </div>

          <div style={{ background: "#fff", padding: "20px", borderRadius: "14px", border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: "11.5px", fontWeight: "800", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>Payment Retries</div>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: stats.retrying > 0 ? "#EF4444" : "#10B981", display: "inline-block" }}></span>
            </div>
            <div style={{ fontSize: "32px", fontWeight: "900", color: stats.retrying > 0 ? "#DC2626" : "#0F172A", marginTop: "8px", lineHeight: "1" }}>
              {stats.retrying}
            </div>
            <div style={{ fontSize: "12px", color: "#64748B", marginTop: "6px", fontWeight: "500" }}>
              {stats.retrying > 0 ? "Attempts pending re-charge" : "All payments up to date"}
            </div>
          </div>
        </div>

        {/* Top View Toggle: Modern Segmented Switcher */}
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          background: "#F1F5F9",
          padding: "4px",
          borderRadius: "12px",
          border: "1px solid #E2E8F0",
          boxShadow: "inset 0 1px 2px rgba(0,0,0,0.03)",
          width: "fit-content",
        }}>
          <button
            type="button"
            onClick={() => setCurrentTab("subscribers")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "9px 20px",
              borderRadius: "9px",
              fontSize: "13px",
              fontWeight: currentTab === "subscribers" ? "800" : "600",
              cursor: "pointer",
              border: "none",
              background: currentTab === "subscribers" ? "#0F172A" : "transparent",
              color: currentTab === "subscribers" ? "#FFFFFF" : "#475569",
              boxShadow: currentTab === "subscribers" ? "0 2px 6px rgba(15, 23, 42, 0.15)" : "none",
              transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
          >
            <span>Subscribers &amp; Recurring Orders</span>
            <span style={{
              background: currentTab === "subscribers" ? "rgba(255,255,255,0.2)" : "#E2E8F0",
              color: currentTab === "subscribers" ? "#FFFFFF" : "#475569",
              padding: "2px 8px",
              borderRadius: "999px",
              fontSize: "11px",
              fontWeight: "800",
            }}>
              {stats.total}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setCurrentTab("products")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "9px 20px",
              borderRadius: "9px",
              fontSize: "13px",
              fontWeight: currentTab === "products" ? "800" : "600",
              cursor: "pointer",
              border: "none",
              background: currentTab === "products" ? "#0F172A" : "transparent",
              color: currentTab === "products" ? "#FFFFFF" : "#475569",
              boxShadow: currentTab === "products" ? "0 2px 6px rgba(15, 23, 42, 0.15)" : "none",
              transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
          >
            <span>Subscription Products &amp; Frequencies</span>
            <span style={{
              background: currentTab === "products" ? "rgba(255,255,255,0.2)" : "#E2E8F0",
              color: currentTab === "products" ? "#FFFFFF" : "#475569",
              padding: "2px 8px",
              borderRadius: "999px",
              fontSize: "11px",
              fontWeight: "800",
            }}>
              {eligibleProducts.length}
            </span>
          </button>
        </div>

        {/* View 1: Subscribers & Recurring Orders (Screenshot 1) */}
        {currentTab === "subscribers" && (
          <div style={{ background: "#fff", borderRadius: "16px", border: "1px solid #E2E8F0", boxShadow: "0 2px 8px rgba(0,0,0,0.04)", overflow: "hidden" }}>
            {/* Header Title */}
            <div style={{ padding: "20px 24px 14px", borderBottom: "1px solid #F1F5F9" }}>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "800", color: "#0F172A" }}>All Subscriptions</h2>
            </div>

            {/* Filter toolbar: Status pills + Search bar */}
            <div style={{ padding: "16px 24px", borderBottom: "1px solid #F1F5F9", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px", background: "#FAFBFD" }}>
              {/* Status filter pills */}
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                {["ALL", "ACTIVE", "PAUSED", "CANCELLED", "FAILED"].map((tab) => {
                  const isActive = status === tab;
                  const count = tab === "ALL" ? stats.total : stats.counts[tab] || 0;
                  const label = tab === "ALL" ? "All" : tab;
                  return (
                    <Link
                      key={tab}
                      to={`?status=${tab}&q=${encodeURIComponent(q)}&tab=subscribers`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "7px 16px",
                        borderRadius: "999px",
                        fontSize: "12.5px",
                        fontWeight: isActive ? "800" : "600",
                        textDecoration: "none",
                        background: isActive ? "#0F172A" : "#FFFFFF",
                        color: isActive ? "#FFFFFF" : "#475569",
                        border: isActive ? "1.5px solid #0F172A" : "1px solid #E2E8F0",
                        boxShadow: isActive ? "0 2px 4px rgba(15, 23, 42, 0.15)" : "0 1px 2px rgba(0,0,0,0.02)",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <span>{label}</span>
                      <span style={{
                        opacity: isActive ? 1 : count > 0 ? 0.9 : 0.5,
                        fontSize: "12px",
                        fontWeight: "700",
                      }}>
                        ({count})
                      </span>
                    </Link>
                  );
                })}
              </div>

              {/* Modern Search bar */}
              <form method="get" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <input type="hidden" name="status" value={status} />
                <input type="hidden" name="tab" value="subscribers" />
                <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                  <svg
                    style={{ position: "absolute", left: "12px", width: "15px", height: "15px", fill: "none", stroke: "#94A3B8", strokeWidth: "2", pointerEvents: "none" }}
                    viewBox="0 0 24 24"
                  >
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                  <input
                    type="text"
                    name="q"
                    placeholder="Search customer, email, plan..."
                    defaultValue={q}
                    style={{
                      padding: "8px 14px 8px 36px",
                      border: "1.5px solid #E2E8F0",
                      borderRadius: "10px",
                      fontSize: "13px",
                      color: "#0F172A",
                      background: "#FFFFFF",
                      minWidth: "240px",
                      outline: "none",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                      transition: "border-color 0.15s ease, box-shadow 0.15s ease",
                    }}
                  />
                </div>
                <button
                  type="submit"
                  style={{
                    padding: "8px 18px",
                    background: "#0F172A",
                    color: "#FFFFFF",
                    border: "none",
                    borderRadius: "10px",
                    fontSize: "13px",
                    fontWeight: "800",
                    cursor: "pointer",
                    boxShadow: "0 1px 3px rgba(15, 23, 42, 0.12)",
                    transition: "all 0.15s ease",
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
                  When customers purchase products with a &quot;Subscribe &amp; Save&quot; option at checkout, they will automatically appear here.
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setOrderQuery("#1006");
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
                  + Subscribe Customer from Order (e.g. #1006)
                </button>
              </div>
            ) : (
              <div style={{ width: "100%", overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1.5px solid #E2E8F0" }}>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "22%" }}>Subscriber</th>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "23%" }}>Items &amp; Recurring Total</th>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "20%" }}>Plan Frequency</th>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "17%" }}>Next Renewal Billing</th>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "10%" }}>Status</th>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "right", width: "8%" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.rows.map((sub, rowIdx) => {
                      const lines = (Array.isArray(sub.lines) ? sub.lines : []) as Array<{ quantity?: number; title?: string }>;
                      const initials = getInitials(sub.customerName, sub.customerEmail);
                      const parsedFreq = parsePlanFrequency(sub.planName || describeFrequency(sub.interval, sub.intervalCount));
                      const avatarColors = [
                        { bg: "#EEF2FF", text: "#4F46E5" },
                        { bg: "#ECFDF5", text: "#059669" },
                        { bg: "#FEF3C7", text: "#D97706" },
                        { bg: "#F3E8FF", text: "#9333EA" },
                      ];
                      const avatarTheme = avatarColors[rowIdx % avatarColors.length];

                      return (
                        <tr
                          key={sub.id}
                          style={{ borderBottom: "1px solid #F1F5F9", transition: "background 0.15s ease" }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#F8FAFC")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                        >
                          {/* Subscriber */}
                          <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                              <div style={{
                                width: "38px",
                                height: "38px",
                                borderRadius: "50%",
                                background: avatarTheme.bg,
                                color: avatarTheme.text,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontWeight: "800",
                                fontSize: "13px",
                                flexShrink: 0,
                                border: "1px solid rgba(0,0,0,0.06)",
                              }}>
                                {initials}
                              </div>
                              <div>
                                <div style={{ fontWeight: "800", color: "#0F172A", fontSize: "14px", lineHeight: "1.3" }}>
                                  {sub.customerName || "Customer"}
                                </div>
                                <div style={{ color: "#64748B", fontSize: "12px", marginTop: "3px", fontWeight: "500" }}>
                                  {sub.customerEmail || sub.originOrderName || "Online Order"}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Items & Total */}
                          <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                            <div style={{ fontWeight: "700", color: "#0F172A", fontSize: "13.5px" }}>
                              {lines.map((l) => `${l.quantity}× ${l.title}`).join(", ") || "Subscription Item"}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
                              <span style={{ color: "#0F172A", fontSize: "14px", fontWeight: "800" }}>
                                ₹{(sub.recurringTotal + sub.deliveryPrice).toLocaleString("en-IN")}
                              </span>
                              <span style={{
                                background: "#F1F5F9",
                                color: "#64748B",
                                padding: "2px 7px",
                                borderRadius: "6px",
                                fontSize: "11px",
                                fontWeight: "600",
                              }}>
                                {sub.ordersBilled} cycles billed
                              </span>
                            </div>
                          </td>

                          {/* Plan Frequency (Screenshot 1 fix: clean tag + discount pill) */}
                          <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: "5px", alignItems: "flex-start" }}>
                              <span style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                background: "#F8FAFC",
                                color: "#1E293B",
                                border: "1.5px solid #E2E8F0",
                                padding: "5px 12px",
                                borderRadius: "8px",
                                fontSize: "12.5px",
                                fontWeight: "700",
                                whiteSpace: "nowrap",
                              }}>
                                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#3B82F6" }}></span>
                                {parsedFreq.text}
                              </span>
                              {parsedFreq.discount && (
                                <span style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                  background: "#DCFCE7",
                                  color: "#166534",
                                  border: "1px solid #BBF7D0",
                                  padding: "2px 8px",
                                  borderRadius: "6px",
                                  fontSize: "11px",
                                  fontWeight: "700",
                                  whiteSpace: "nowrap",
                                }}>
                                  🏷️ {parsedFreq.discount}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Next Renewal Billing */}
                          <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                            {sub.nextBillingAt ? (
                              <div>
                                <div style={{ fontWeight: "800", color: "#0F172A", fontSize: "13.5px" }}>
                                  {new Date(sub.nextBillingAt).toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })}
                                </div>
                                <div style={{ fontSize: "11.5px", color: "#64748B", fontWeight: "500", marginTop: "3px" }}>
                                  Next delivery: {sub.nextDeliveryDate || "Scheduled"}
                                </div>
                              </div>
                            ) : (
                              <span style={{ color: "#94A3B8" }}>—</span>
                            )}
                          </td>

                          {/* Status */}
                          <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "4px 12px",
                                borderRadius: "20px",
                                fontSize: "11.5px",
                                fontWeight: "800",
                                color: sub.status === "ACTIVE" ? "#047857" : sub.status === "PAUSED" ? "#B45309" : "#B91C1C",
                                background: sub.status === "ACTIVE" ? "#ECFDF5" : sub.status === "PAUSED" ? "#FFFBEB" : "#FEF2F2",
                                border: sub.status === "ACTIVE" ? "1.5px solid #A7F3D0" : sub.status === "PAUSED" ? "1.5px solid #FDE68A" : "1.5px solid #FECACA",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <span style={{
                                width: "6px",
                                height: "6px",
                                borderRadius: "50%",
                                background: sub.status === "ACTIVE" ? "#10B981" : sub.status === "PAUSED" ? "#F59E0B" : "#EF4444",
                              }}></span>
                              {sub.status}
                            </span>
                          </td>

                          {/* Actions */}
                          <td style={{ padding: "16px 20px", verticalAlign: "middle", textAlign: "right" }}>
                            <Link
                              to={`/app/subscriptions/${sub.id}`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                padding: "7px 16px",
                                background: "#0F172A",
                                border: "none",
                                borderRadius: "8px",
                                color: "#FFFFFF",
                                fontSize: "12.5px",
                                fontWeight: "700",
                                textDecoration: "none",
                                boxShadow: "0 1px 3px rgba(15,23,42,0.12)",
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
              <div style={{ padding: "16px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #F1F5F9", fontSize: "13px", color: "#0F172A", fontWeight: "700", background: "#FAFBFD" }}>
                <div style={{ color: "#64748B", fontWeight: "500" }}>Page {list.page} of {list.pages} ({list.total} total subscriptions)</div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {list.page > 1 && (
                    <Link
                      to={`?status=${status}&q=${encodeURIComponent(q)}&tab=subscribers&page=${list.page - 1}`}
                      style={{ padding: "6px 14px", background: "#FFFFFF", border: "1px solid #CBD5E1", borderRadius: "8px", textDecoration: "none", color: "#0F172A", fontWeight: "700" }}
                    >
                      ← Previous
                    </Link>
                  )}
                  {list.page < list.pages && (
                    <Link
                      to={`?status=${status}&q=${encodeURIComponent(q)}&tab=subscribers&page=${list.page + 1}`}
                      style={{ padding: "6px 14px", background: "#0F172A", border: "none", borderRadius: "8px", textDecoration: "none", color: "#FFFFFF", fontWeight: "800" }}
                    >
                      Next →
                    </Link>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* View 2: Subscription Products & Delivery Frequencies (Screenshot 2) */}
        {currentTab === "products" && (
          <div style={{ background: "#fff", borderRadius: "16px", border: "1px solid #E2E8F0", boxShadow: "0 2px 8px rgba(0,0,0,0.04)", overflow: "hidden" }}>
            {/* Header Banner */}
            <div style={{ padding: "24px", borderBottom: "1px solid #F1F5F9", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px", background: "linear-gradient(to right, #FFFFFF, #FAFBFD)" }}>
              <div>
                <h3 style={{ fontSize: "18px", fontWeight: "800", margin: "0 0 5px 0", color: "#0F172A" }}>
                  Eligible Products for Subscribe &amp; Save
                </h3>
                <p style={{ fontSize: "13px", color: "#64748B", margin: 0, fontWeight: "500" }}>
                  Products currently available for subscription delivery in storefront cart drawer and checkout.
                </p>
              </div>
              <Link
                to="/app/subscriptions/plans"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "#0F172A",
                  color: "#FFFFFF",
                  padding: "9px 18px",
                  borderRadius: "10px",
                  fontSize: "13px",
                  fontWeight: "700",
                  textDecoration: "none",
                  boxShadow: "0 1px 3px rgba(15,23,42,0.12)",
                }}
              >
                Configure Eligible Products &amp; Discounts →
              </Link>
            </div>

            {eligibleProducts.length === 0 ? (
              <div style={{ padding: "48px 20px", textAlign: "center", color: "#64748B" }}>
                No subscription products configured. Visit <Link to="/app/subscriptions/plans" style={{ color: "#0F172A", fontWeight: "700" }}>Plans &amp; Discounts</Link> to enable products.
              </div>
            ) : (
              <div style={{ width: "100%", overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#F8FAFC", borderBottom: "1.5px solid #E2E8F0" }}>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "24%" }}>Product</th>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "18%" }}>Variant &amp; One-Time Price</th>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "20%" }}>Subscription Price (Save 15%)</th>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "20%" }}>Delivery Frequencies</th>
                      <th style={{ padding: "14px 20px", fontSize: "11.5px", color: "#64748B", fontWeight: "800", textTransform: "uppercase", letterSpacing: "0.06em", width: "18%" }}>Purchase Option Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eligibleProducts.map((p) => (
                      <tr
                        key={p.id}
                        style={{ borderBottom: "1px solid #F1F5F9", transition: "background 0.15s ease" }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#F8FAFC")}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                      >
                        {/* Product */}
                        <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                            {p.imageUrl ? (
                              <img
                                src={p.imageUrl}
                                alt={p.title}
                                style={{ width: "46px", height: "46px", objectFit: "cover", borderRadius: "10px", border: "1.5px solid #E2E8F0", flexShrink: 0 }}
                              />
                            ) : (
                              <div
                                style={{
                                  width: "46px",
                                  height: "46px",
                                  background: "#F1F5F9",
                                  borderRadius: "10px",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  fontSize: "20px",
                                  flexShrink: 0,
                                }}
                              >
                                🐱
                              </div>
                            )}
                            <div>
                              <div style={{ fontWeight: "800", color: "#0F172A", fontSize: "14px", lineHeight: "1.3" }}>{p.title}</div>
                              <div style={{ fontSize: "11.5px", color: "#64748B", marginTop: "3px", fontWeight: "500" }}>Shopify Product</div>
                            </div>
                          </div>
                        </td>

                        {/* Variant & One-time price */}
                        <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                          <div style={{ fontWeight: "700", color: "#0F172A", fontSize: "13.5px" }}>{p.variantTitle}</div>
                          <div style={{ color: "#64748B", fontSize: "13px", marginTop: "3px", fontWeight: "500" }}>₹{p.regularPrice.toFixed(2)}</div>
                        </td>

                        {/* Subscription Price (Save 15%) */}
                        <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                          <div style={{ fontWeight: "900", color: "#047857", fontSize: "15px" }}>
                            ₹{p.discountedPrice.toFixed(2)}
                          </div>
                          <div style={{ marginTop: "4px" }}>
                            <span style={{
                              display: "inline-block",
                              background: "#DCFCE7",
                              color: "#166534",
                              border: "1px solid #BBF7D0",
                              padding: "2px 8px",
                              borderRadius: "6px",
                              fontSize: "11px",
                              fontWeight: "700",
                            }}>
                              {p.discountPercent}% OFF applied
                            </span>
                          </div>
                        </td>

                        {/* Delivery Frequencies */}
                        <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", maxWidth: "260px" }}>
                            {p.frequencies.map((freq) => (
                              <span
                                key={freq}
                                style={{
                                  background: "#F8FAFC",
                                  color: "#334155",
                                  border: "1.5px solid #E2E8F0",
                                  padding: "4px 9px",
                                  borderRadius: "6px",
                                  fontSize: "11.5px",
                                  fontWeight: "700",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {freq}
                              </span>
                            ))}
                          </div>
                        </td>

                        {/* Purchase Option Status */}
                        <td style={{ padding: "16px 20px", verticalAlign: "middle" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              padding: "6px 14px",
                              borderRadius: "999px",
                              fontSize: "12px",
                              fontWeight: "800",
                              background: "#ECFDF5",
                              color: "#065F46",
                              border: "1.5px solid #A7F3D0",
                              whiteSpace: "nowrap",
                            }}
                          >
                            ✓ {p.sellingPlanName}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
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
                  placeholder="e.g. #1006"
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
