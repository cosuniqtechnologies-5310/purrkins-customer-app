import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import { getUpcomingDeliveries, type UpcomingDelivery } from "../utils/subscription.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "30", 10), 7), 90);

  const deliveries = await getUpcomingDeliveries(shop, days);

  return { shop, deliveries, days };
};

export default function SubscriptionsCalendar() {
  const { deliveries, days } = useLoaderData<typeof loader>();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<"all" | "confirmed" | "projected">("all");

  const totalDeliveriesCount = useMemo(() => {
    return deliveries.reduce((acc: number, d: UpcomingDelivery) => acc + d.items.length, 0);
  }, [deliveries]);

  // Filter deliveries based on search query and status type
  const filteredDeliveries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deliveries
      .map((day: UpcomingDelivery) => {
        const matchingItems = day.items.filter((item: UpcomingDelivery["items"][0]) => {
          if (filterType === "confirmed" && item.projected) return false;
          if (filterType === "projected" && !item.projected) return false;
          if (!q) return true;
          return (
            item.customer.toLowerCase().includes(q) ||
            item.plan.toLowerCase().includes(q) ||
            item.lines.toLowerCase().includes(q) ||
            item.subscriptionId.toLowerCase().includes(q)
          );
        });
        return {
          ...day,
          items: matchingItems,
        };
      })
      .filter((day: UpcomingDelivery) => day.items.length > 0);
  }, [deliveries, search, filterType]);

  const displayedDeliveriesCount = useMemo(() => {
    return filteredDeliveries.reduce((acc: number, d: UpcomingDelivery) => acc + d.items.length, 0);
  }, [filteredDeliveries]);

  return (
    <s-page heading="Upcoming Delivery Schedule Calendar">
      <div slot="primary-action" style={{ display: "flex", gap: "8px" }}>
        <s-button href="/app/subscriptions" variant="secondary">
          &larr; All Subscriptions
        </s-button>
        <s-button href="/app/subscriptions/settings" variant="secondary">
          Configure Delivery Rules
        </s-button>
      </div>

      <s-stack direction="block" gap="base">
        {/* KPI Summary Row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Upcoming Deliveries</div>
            <div style={kpiValueStyle}>{totalDeliveriesCount}</div>
            <div style={kpiSubStyle}>
              {search || filterType !== "all" ? `Showing ${displayedDeliveriesCount} filtered` : `Next ${days} days total`}
            </div>
          </div>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Active Delivery Dates</div>
            <div style={kpiValueStyle}>{deliveries.length}</div>
            <div style={kpiSubStyle}>Dispatches scheduled</div>
          </div>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Viewing Horizon</div>
            <div style={{ ...kpiValueStyle, color: "#000" }}>{days} Days</div>
            <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
              <s-button href="?days=14" variant={days === 14 ? "primary" : "secondary"}>
                14d
              </s-button>
              <s-button href="?days=30" variant={days === 30 ? "primary" : "secondary"}>
                30d
              </s-button>
              <s-button href="?days=60" variant={days === 60 ? "primary" : "secondary"}>
                60d
              </s-button>
            </div>
          </div>
        </div>

        {/* Search & Filter Toolbar */}
        <div
          style={{
            background: "#fff",
            borderRadius: "10px",
            border: "1.5px solid #000",
            padding: "16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flex: 1, minWidth: "240px" }}>
            <input
              type="text"
              placeholder="Search by customer name, item or plan..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1.5px solid #000",
                fontSize: "14px",
                color: "#000",
                outline: "none",
              }}
            />
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: "13px", fontWeight: "800", color: "#000" }}>Filter:</span>
            <button
              onClick={() => setFilterType("all")}
              style={{
                ...pillButtonStyle,
                background: filterType === "all" ? "#000" : "#fff",
                color: filterType === "all" ? "#fff" : "#000",
                border: "1.5px solid #000",
              }}
            >
              All Deliveries
            </button>
            <button
              onClick={() => setFilterType("confirmed")}
              style={{
                ...pillButtonStyle,
                background: filterType === "confirmed" ? "#000" : "#fff",
                color: filterType === "confirmed" ? "#fff" : "#000",
                border: "1.5px solid #000",
              }}
            >
              Next Scheduled Cycle Only
            </button>
            <button
              onClick={() => setFilterType("projected")}
              style={{
                ...pillButtonStyle,
                background: filterType === "projected" ? "#000" : "#fff",
                color: filterType === "projected" ? "#fff" : "#000",
                border: "1.5px solid #000",
              }}
            >
              Projected Cycles Only
            </button>
          </div>
        </div>

        {/* Deliveries Timeline List */}
        {filteredDeliveries.length === 0 ? (
          <div
            style={{
              background: "#fff",
              borderRadius: "12px",
              border: "1px solid #e1e3e5",
              padding: "48px 24px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "36px", marginBottom: "12px" }}>📅</div>
            <h3 style={{ fontSize: "18px", fontWeight: "700", color: "#202223", margin: "0 0 8px 0" }}>
              No deliveries found for this period
            </h3>
            <p style={{ fontSize: "14px", color: "#6d7175", maxWidth: "450px", margin: "0 auto" }}>
              {search
                ? `No upcoming deliveries match "${search}". Try clearing your search.`
                : "Active subscriptions will populate your delivery calendar based on their recurrence schedule and deliverable weekdays."}
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {filteredDeliveries.map((group: UpcomingDelivery) => {
              const formattedDate = new Date(`${group.date}T00:00:00`).toLocaleDateString("en-IN", {
                weekday: "long",
                month: "short",
                day: "numeric",
                year: "numeric",
              });

              return (
                <div
                  key={group.date}
                  style={{
                    background: "#fff",
                    borderRadius: "12px",
                    border: "1px solid #e1e3e5",
                    overflow: "hidden",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
                  }}
                >
                  {/* Date Header Banner */}
                  <div
                    style={{
                    background: "#f9fafb",
                    borderBottom: "1px solid #e1e3e5",
                    padding: "12px 20px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <span
                      style={{
                        background: "#008060",
                        color: "#fff",
                        fontWeight: "700",
                        fontSize: "12px",
                        padding: "4px 10px",
                        borderRadius: "12px",
                        textTransform: "uppercase",
                      }}
                    >
                      {group.weekday}
                    </span>
                    <span style={{ fontSize: "16px", fontWeight: "700", color: "#202223" }}>{formattedDate}</span>
                  </div>
                  <span
                    style={{
                      background: "#f1f2f3",
                      color: "#5c5f62",
                      fontSize: "12px",
                      fontWeight: "700",
                      padding: "3px 8px",
                      borderRadius: "10px",
                    }}
                  >
                    {group.items.length} {group.items.length === 1 ? "delivery" : "deliveries"}
                  </span>
                </div>

                {/* Delivery Items List */}
                <div style={{ padding: "8px 20px" }}>
                  {group.items.map((item: UpcomingDelivery["items"][0], idx: number) => (
                      <div
                        key={idx}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "12px 0",
                          borderBottom: idx === group.items.length - 1 ? "none" : "1px solid #f1f2f3",
                          flexWrap: "wrap",
                          gap: "12px",
                        }}
                      >
                        <div style={{ flex: "1 1 300px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <Link
                              to={`/app/subscriptions/${item.subscriptionId}`}
                              style={{
                                color: "#008060",
                                fontWeight: "700",
                                fontSize: "14px",
                                textDecoration: "none",
                              }}
                            >
                              {item.customer}
                            </Link>
                            <span
                              style={{
                                background: item.projected ? "#e4e5e7" : "#cbf4c9",
                                color: item.projected ? "#4a4c4e" : "#0e6251",
                                fontSize: "11px",
                                fontWeight: "700",
                                padding: "2px 6px",
                                borderRadius: "8px",
                                textTransform: "uppercase",
                              }}
                            >
                              {item.projected ? "Projected" : item.cycleStatus || "Pending"}
                            </span>
                          </div>
                          <div style={{ fontSize: "13px", color: "#6d7175", marginTop: "3px" }}>{item.lines}</div>
                        </div>

                        <div style={{ textAlign: "right", fontSize: "12px", color: "#5c5f62" }}>
                          <div style={{ fontWeight: "600", color: "#202223" }}>{item.plan}</div>
                          <div style={{ marginTop: "2px" }}>
                            Billing: {new Date(item.billingAt).toLocaleDateString("en-IN", { month: "short", day: "numeric" })} at{" "}
                            {new Date(item.billingAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                          </div>
                        </div>

                        <div>
                          <s-button href={`/app/subscriptions/${item.subscriptionId}`} variant="secondary">
                            View Details
                          </s-button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </s-stack>
    </s-page>
  );
}

const kpiCardStyle: React.CSSProperties = {
  background: "#fff",
  padding: "20px",
  borderRadius: "10px",
  border: "1.5px solid #000",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

const kpiLabelStyle: React.CSSProperties = {
  fontSize: "13px",
  fontWeight: "800",
  color: "#000",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const kpiValueStyle: React.CSSProperties = {
  fontSize: "28px",
  fontWeight: "900",
  color: "#000",
  marginTop: "8px",
};

const kpiSubStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#000",
  marginTop: "4px",
  fontWeight: "500",
};

const pillButtonStyle: React.CSSProperties = {
  border: "1.5px solid #000",
  borderRadius: "16px",
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: "800",
  cursor: "pointer",
  transition: "all 0.15s ease",
};
