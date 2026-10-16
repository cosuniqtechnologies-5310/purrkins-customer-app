import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getStats, getUpcomingDeliveries, listSubscriptions, runSchedulerTick } from "../utils/subscription.server";
import { describeFrequency, WEEKDAY_NAMES, weekdayOf } from "../utils/subscription-schedule";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [reviews, storeSettingRaw, subStats, activeSubsList, upcomingDeliveries] = await Promise.all([
    prisma.review.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.storeSetting.findUnique({
      where: { shop },
    }),
    getStats(shop),
    listSubscriptions(shop, { status: "ACTIVE", page: 1, pageSize: 5 }),
    getUpcomingDeliveries(shop, 14),
  ]);

  const storeSetting = storeSettingRaw || (await prisma.storeSetting.create({
    data: { shop, autoApproveReviews: true },
  }));

  const allReviewsCount = await prisma.review.count({ where: { shop } });
  const publishedReviewsCount = await prisma.review.count({ where: { shop, status: "published" } });
  const pendingReviewsCount = await prisma.review.count({ where: { shop, status: "pending" } });

  const aggregate = await prisma.review.aggregate({
    where: { shop },
    _avg: { rating: true },
  });

  return {
    shop,
    reviews,
    allReviewsCount,
    publishedReviewsCount,
    pendingReviewsCount,
    avgRating: (aggregate._avg.rating || 5.0).toFixed(1),
    storeSetting,
    subStats,
    activeSubsList,
    upcomingDeliveries,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = String(formData.get("actionType") || "");

  if (actionType === "run_scheduler") {
    try {
      const res = await runSchedulerTick();
      return {
        success: true,
        message: `Scheduler tick completed: ${res.processed} of ${res.due} due cycles processed.`,
      };
    } catch (e: unknown) {
      const err = e as Error;
      return { success: false, message: `Scheduler error: ${err.message}` };
    }
  }

  if (actionType === "toggle_auto_approve") {
    const current = formData.get("current") === "true";
    await prisma.storeSetting.update({
      where: { shop },
      data: { autoApproveReviews: !current },
    });
    return { success: true, message: "Review approval setting updated" };
  }

  if (actionType === "approve_review" || actionType === "unapprove_review") {
    const id = String(formData.get("id") || "");
    const status = actionType === "approve_review" ? "published" : "pending";
    await prisma.review.update({
      where: { id, shop },
      data: { status },
    });
    return { success: true, message: `Review set to ${status}` };
  }

  if (actionType === "delete_review") {
    const id = String(formData.get("id") || "");
    await prisma.review.delete({
      where: { id, shop },
    });
    return { success: true, message: "Review deleted" };
  }

  if (actionType === "add_review") {
    const title = String(formData.get("title") || "").trim();
    const author = String(formData.get("author") || "").trim();
    const rating = Number(formData.get("rating")) || 5;
    const body = String(formData.get("body") || "").trim();
    const productId = String(formData.get("productId") || "").trim();

    await prisma.review.create({
      data: {
        shop,
        productId,
        title,
        author,
        rating,
        body,
        status: "published",
        isVerified: true,
      },
    });
    return { success: true, message: "Review added successfully" };
  }

  return { success: false, message: "Unknown action" };
};

export default function HomeDashboard() {
  const {
    reviews,
    allReviewsCount,
    publishedReviewsCount,
    pendingReviewsCount,
    avgRating,
    storeSetting,
    subStats,
    activeSubsList,
    upcomingDeliveries,
  } = useLoaderData<typeof loader>();

  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [isAddReviewModalOpen, setIsAddReviewModalOpen] = useState(false);
  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.success });
      if (fetcher.data.success && isAddReviewModalOpen) {
        setIsAddReviewModalOpen(false);
      }
    }
  }, [fetcher.data, shopify, isAddReviewModalOpen]);

  const upcomingDeliveriesCount = upcomingDeliveries.reduce((acc, d) => acc + d.items.length, 0);

  return (
    <s-page heading="Purrkins Store Command Center">
      <div slot="primary-action" style={{ display: "flex", gap: "8px" }}>
        <fetcher.Form method="post" style={{ margin: 0 }}>
          <input type="hidden" name="actionType" value="run_scheduler" />
          <s-button type="submit" variant="secondary" loading={isBusy}>
            Run Billing Check Now
          </s-button>
        </fetcher.Form>
        <s-button href="/app/subscriptions" variant="primary">
          Manage Subscriptions
        </s-button>
      </div>

      <s-stack direction="block" gap="base">
        {/* Top Analytics Metrics Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "16px" }}>
          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Active Subscribers</div>
            <div style={{ ...kpiValueStyle, color: "#000" }}>{subStats.counts["ACTIVE"] || 0}</div>
            <div style={kpiSubStyle}>Total subscriptions: {subStats.total}</div>
          </div>

          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Estimated MRR</div>
            <div style={{ ...kpiValueStyle, color: "#000" }}>
              ₹{Math.round(subStats.mrr).toLocaleString("en-IN")}
            </div>
            <div style={kpiSubStyle}>Monthly recurring revenue</div>
          </div>

          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Upcoming Renewals</div>
            <div style={{ ...kpiValueStyle, color: "#000" }}>{upcomingDeliveriesCount}</div>
            <div style={kpiSubStyle}>Next 14 days billing cycles</div>
          </div>

          <div style={kpiCardStyle}>
            <div style={kpiLabelStyle}>Customer Reviews</div>
            <div style={{ ...kpiValueStyle, color: "#000" }}>★ {avgRating}</div>
            <div style={kpiSubStyle}>
              {allReviewsCount} total ({publishedReviewsCount} published, {pendingReviewsCount} pending)
            </div>
          </div>
        </div>

        {/* SECTION 1: Subscription Management & Recurring Orders */}
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
            <div>
              <h2 style={{ fontSize: "17px", fontWeight: "700", margin: "0 0 4px 0", color: "#202223" }}>
                Subscriptions &amp; Recurring Billing
              </h2>
              <p style={{ fontSize: "13px", color: "#6d7175", margin: 0 }}>
                Manage recurring customer orders and billing. Orders automatically sync to Shopify for NimbusPost fulfillment.
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <s-button href="/app/subscriptions" variant="secondary">
                Manage Subscriptions
              </s-button>
              <s-button href="/app/subscriptions/plans" variant="primary">
                Configure Plans
              </s-button>
            </div>
          </div>

          {/* Quick status pill counters */}
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "20px" }}>
            <span style={{ ...statusPillStyle, background: "#e3f1df", color: "#108043", border: "1px solid #aee9d1" }}>
              ● {subStats.counts["ACTIVE"] || 0} Active
            </span>
            <span style={{ ...statusPillStyle, background: "#fef3d6", color: "#916a00", border: "1px solid #fbd88f" }}>
              ● {subStats.counts["PAUSED"] || 0} Paused
            </span>
            <span style={{ ...statusPillStyle, background: "#fedcd9", color: "#bf0711", border: "1px solid #fca39d" }}>
              ● {subStats.counts["FAILED"] || 0} Failed / Needs Attention
            </span>
            <span style={{ ...statusPillStyle, background: "#f1f2f3", color: "#6d7175", border: "1px solid #d2d5d8" }}>
              ● {subStats.counts["CANCELLED"] || 0} Cancelled
            </span>
          </div>

          {/* Active Subscriptions Snapshot Table */}
          <h3 style={{ fontSize: "14px", fontWeight: "700", color: "#5c5f62", textTransform: "uppercase", marginBottom: "12px" }}>
            Recent Active Subscribers
          </h3>

          {activeSubsList.rows.length === 0 ? (
            <div style={{ textAlign: "center", padding: "32px 16px", color: "#6d7175", background: "#f9fafb", borderRadius: "8px" }}>
              No active subscriptions found yet. Subscriptions created at storefront checkout will populate here automatically.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e1e3e5", textAlign: "left", color: "#5c5f62", fontSize: "12px" }}>
                    <th style={{ padding: "10px 8px" }}>CUSTOMER</th>
                    <th style={{ padding: "10px 8px" }}>FREQUENCY</th>
                    <th style={{ padding: "10px 8px" }}>NEXT RENEWAL</th>
                    <th style={{ padding: "10px 8px" }}>STATUS</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>RECURRING VALUE</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSubsList.rows.map((sub) => (
                    <tr key={sub.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                      <td style={{ padding: "12px 8px" }}>
                        <Link to={`/app/subscriptions/${sub.id}`} style={{ color: "#008060", fontWeight: "700", textDecoration: "none" }}>
                          {sub.customerName || sub.customerEmail || "Subscriber"}
                        </Link>
                        <div style={{ fontSize: "12px", color: "#6d7175" }}>{sub.customerEmail}</div>
                      </td>
                      <td style={{ padding: "12px 8px", color: "#202223" }}>
                        {describeFrequency(sub.interval, sub.intervalCount)}
                      </td>
                      <td style={{ padding: "12px 8px" }}>
                        <div style={{ fontWeight: "700", color: "#202223" }}>
                          {sub.nextBillingAt
                            ? new Date(sub.nextBillingAt).toLocaleDateString("en-IN", { month: "short", day: "numeric" })
                            : (sub.nextDeliveryDate || "Scheduled")}
                        </div>
                      </td>
                      <td style={{ padding: "12px 8px" }}>
                        <span style={{ ...statusPillStyle, background: "#e3f1df", color: "#108043", border: "1px solid #aee9d1", padding: "2px 8px", fontSize: "11px" }}>
                          ● Active
                        </span>
                      </td>
                      <td style={{ padding: "12px 8px", textAlign: "right", fontWeight: "700", color: "#008060" }}>
                        ₹{Math.round(sub.recurringTotal).toLocaleString("en-IN")}
                      </td>
                      <td style={{ padding: "12px 8px", textAlign: "right" }}>
                        <Link
                          to={`/app/subscriptions/${sub.id}`}
                          style={{
                            color: "#2c6ecb",
                            fontSize: "13px",
                            fontWeight: "600",
                            textDecoration: "none",
                          }}
                        >
                          View &rarr;
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: "14px", textAlign: "right" }}>
            <Link to="/app/subscriptions" style={{ fontSize: "13px", fontWeight: "600", color: "#008060", textDecoration: "none" }}>
              View all {subStats.total} subscriptions &rarr;
            </Link>
          </div>
        </div>

        {/* SECTION 2: Customer Reviews & Social Proof Analytics */}
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
            <div>
              <h2 style={{ fontSize: "17px", fontWeight: "700", margin: "0 0 4px 0", color: "#202223" }}>
                Customer Reviews & Ratings
              </h2>
              <p style={{ fontSize: "13px", color: "#6d7175", margin: 0 }}>
                Storefront customer reviews, star ratings, and publication controls.
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <fetcher.Form method="post" style={{ margin: 0 }}>
                <input type="hidden" name="actionType" value="toggle_auto_approve" />
                <input type="hidden" name="current" value={String(storeSetting.autoApproveReviews)} />
                <s-button type="submit" variant="secondary" loading={isBusy}>
                  {storeSetting.autoApproveReviews ? "Auto-Publish: ON" : "Auto-Publish: OFF"}
                </s-button>
              </fetcher.Form>

              <s-button onClick={() => setIsAddReviewModalOpen(true)} variant="secondary">
                + Add Review
              </s-button>

              <s-button href="/app/reviews" variant="primary">
                Manage All Reviews &rarr;
              </s-button>
            </div>
          </div>

          {/* Reviews List */}
          {reviews.length === 0 ? (
            <div style={{ textAlign: "center", padding: "32px 16px", color: "#6d7175", background: "#f9fafb", borderRadius: "8px" }}>
              No reviews yet. As customers review products on your store, they will appear here.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e1e3e5", textAlign: "left", color: "#5c5f62", fontSize: "12px" }}>
                    <th style={{ padding: "10px 8px" }}>RATING</th>
                    <th style={{ padding: "10px 8px" }}>CUSTOMER</th>
                    <th style={{ padding: "10px 8px" }}>REVIEW</th>
                    <th style={{ padding: "10px 8px" }}>STATUS</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {reviews.slice(0, 5).map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                      <td style={{ padding: "12px 8px", whiteSpace: "nowrap" }}>
                        <span style={{ color: "#d97706", fontWeight: "700" }}>
                          {"★".repeat(r.rating)}
                          {"☆".repeat(Math.max(0, 5 - r.rating))}
                        </span>
                      </td>
                      <td style={{ padding: "12px 8px", fontWeight: "600", color: "#202223" }}>
                        {r.author}
                        {r.isVerified && (
                          <span style={{ display: "block", fontSize: "11px", color: "#008060", fontWeight: "700" }}>
                            ✓ Verified
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "12px 8px", maxWidth: "340px" }}>
                        <div style={{ fontWeight: "700", color: "#202223" }}>{r.title}</div>
                        <div style={{ color: "#6d7175", fontSize: "12px", marginTop: "2px" }}>
                          {r.body ? (r.body.length > 80 ? `${r.body.slice(0, 77)}...` : r.body) : ""}
                        </div>
                      </td>
                      <td style={{ padding: "12px 8px" }}>
                        <span
                          style={{
                            background: r.status === "published" ? "#e3f1df" : "#fef3d6",
                            color: r.status === "published" ? "#108043" : "#916a00",
                            padding: "2px 8px",
                            borderRadius: "10px",
                            fontSize: "11px",
                            fontWeight: "700",
                            textTransform: "uppercase",
                          }}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td style={{ padding: "12px 8px", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                          <fetcher.Form method="post" style={{ margin: 0 }}>
                            <input
                              type="hidden"
                              name="actionType"
                              value={r.status === "published" ? "unapprove_review" : "approve_review"}
                            />
                            <input type="hidden" name="id" value={r.id} />
                            <s-button type="submit" variant="secondary" loading={isBusy}>
                              {r.status === "published" ? "Unpublish" : "Publish"}
                            </s-button>
                          </fetcher.Form>

                          <fetcher.Form method="post" style={{ margin: 0 }}>
                            <input type="hidden" name="actionType" value="delete_review" />
                            <input type="hidden" name="id" value={r.id} />
                            <s-button type="submit" tone="critical" loading={isBusy}>
                              Delete
                            </s-button>
                          </fetcher.Form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: "14px", textAlign: "right" }}>
            <Link to="/app/reviews" style={{ fontSize: "13px", fontWeight: "600", color: "#008060", textDecoration: "none" }}>
              View all reviews & moderation settings &rarr;
            </Link>
          </div>
        </div>
      </s-stack>

      {/* Add Review Modal */}
      {isAddReviewModalOpen && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "18px" }}>Add Customer Review</h3>
            <fetcher.Form method="post">
              <input type="hidden" name="actionType" value="add_review" />

              <div style={{ marginBottom: "12px" }}>
                <label htmlFor="home-review-author" style={labelStyle}>
                  Customer Name:
                </label>
                <input id="home-review-author" type="text" name="author" placeholder="e.g. Rahul K." style={inputStyle} required />
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label htmlFor="home-review-rating" style={labelStyle}>
                  Rating:
                </label>
                <select id="home-review-rating" name="rating" style={inputStyle} defaultValue="5">
                  <option value="5">★★★★★ (5 Stars)</option>
                  <option value="4">★★★★☆ (4 Stars)</option>
                  <option value="3">★★★☆☆ (3 Stars)</option>
                  <option value="2">★★☆☆☆ (2 Stars)</option>
                  <option value="1">★☆☆☆☆ (1 Star)</option>
                </select>
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label htmlFor="home-review-title" style={labelStyle}>
                  Review Title:
                </label>
                <input id="home-review-title" type="text" name="title" placeholder="e.g. Best cat food ever" style={inputStyle} required />
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label htmlFor="home-review-body" style={labelStyle}>
                  Review Feedback:
                </label>
                <textarea id="home-review-body" name="body" rows={4} placeholder="Feedback..." style={{ ...inputStyle, resize: "vertical" }} required />
              </div>

              <div style={{ marginBottom: "16px" }}>
                <label htmlFor="home-review-product" style={labelStyle}>
                  Product ID or Handle:
                </label>
                <input id="home-review-product" type="text" name="productId" placeholder="e.g. kitten-fresh-salmon" style={inputStyle} required />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <s-button type="button" onClick={() => setIsAddReviewModalOpen(false)} variant="secondary">
                  Cancel
                </s-button>
                <s-button type="submit" variant="primary" loading={isBusy}>
                  Save & Publish
                </s-button>
              </div>
            </fetcher.Form>
          </div>
        </div>
      )}
    </s-page>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#fff",
  borderRadius: "10px",
  border: "none",
  padding: "20px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
};

const kpiCardStyle: React.CSSProperties = {
  background: "#fff",
  padding: "20px",
  borderRadius: "10px",
  border: "none",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(77, 76, 76, 0.04)",
};

const kpiLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: "800",
  color: "#000",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const kpiValueStyle: React.CSSProperties = {
  fontSize: "28px",
  fontWeight: "900",
  color: "#000",
  marginTop: "6px",
};

const kpiSubStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#000",
  marginTop: "4px",
  fontWeight: "500",
};

const statusPillStyle: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: "16px",
  fontSize: "12px",
  fontWeight: "800",
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  border: "1.5px solid #000",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "13px",
  fontWeight: "800",
  marginBottom: "4px",
  color: "#000",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: "6px",
  border: "1.5px solid #000",
  fontSize: "14px",
  color: "#000",
  boxSizing: "border-box",
  outline: "none",
};

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
