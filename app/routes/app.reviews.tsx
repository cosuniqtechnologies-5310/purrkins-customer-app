import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [reviews, settingsRaw] = await Promise.all([
    prisma.review.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
    }),
    prisma.storeSetting.findUnique({
      where: { shop },
    }),
  ]);

  const settings = settingsRaw || (await prisma.storeSetting.create({
    data: { shop, autoApproveReviews: true },
  }));

  return { reviews, settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = String(formData.get("actionType") || "");

  if (actionType === "toggle_auto_approve") {
    const current = formData.get("current") === "true";
    await prisma.storeSetting.update({
      where: { shop },
      data: { autoApproveReviews: !current },
    });
    return { success: true, message: "Review approval settings updated" };
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
    const status = String(formData.get("status") || "published");

    await prisma.review.create({
      data: {
        shop,
        productId,
        title,
        author,
        rating,
        body,
        status,
        isVerified: true,
      },
    });
    return { success: true, message: "Review added successfully" };
  }

  return { success: false, message: "Unknown action" };
};

export default function ReviewsManagement() {
  const { reviews, settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.success });
      if (fetcher.data.success && isAddModalOpen) {
        setIsAddModalOpen(false);
      }
    }
  }, [fetcher.data, shopify, isAddModalOpen]);

  const publishedCount = reviews.filter((r) => r.status === "published").length;
  const pendingCount = reviews.filter((r) => r.status === "pending").length;
  const avgRating =
    reviews.length > 0
      ? (reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length).toFixed(1)
      : "5.0";

  return (
    <s-page heading="Customer Reviews Management">
      <div slot="primary-action" style={{ display: "flex", gap: "8px" }}>
        <s-button onClick={() => setIsAddModalOpen(true)} variant="primary">
          + Add Review
        </s-button>
      </div>

      <s-stack direction="block" gap="base">
        {/* KPI Row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
          <div style={kpiBoxStyle}>
            <div style={kpiLabelStyle}>Total Reviews</div>
            <div style={kpiValueStyle}>{reviews.length}</div>
            <div style={kpiSubStyle}>Customer submissions</div>
          </div>

          <div style={kpiBoxStyle}>
            <div style={kpiLabelStyle}>Average Rating</div>
            <div style={kpiValueStyle}>★ {avgRating}</div>
            <div style={kpiSubStyle}>Out of 5 stars</div>
          </div>

          <div style={kpiBoxStyle}>
            <div style={kpiLabelStyle}>Published</div>
            <div style={kpiValueStyle}>{publishedCount}</div>
            <div style={kpiSubStyle}>Visible on storefront</div>
          </div>

          <div style={kpiBoxStyle}>
            <div style={kpiLabelStyle}>Pending Moderation</div>
            <div style={kpiValueStyle}>{pendingCount}</div>
            <div style={kpiSubStyle}>Awaiting review</div>
          </div>
        </div>

        {/* Auto-Approve Setting Card */}
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <strong style={{ fontSize: "15px", color: "#000000", fontWeight: "800" }}>Automatic Review Publishing</strong>
              <p style={{ margin: "4px 0 0 0", fontSize: "13px", color: "#000000" }}>
                When enabled, new customer reviews submitted from product pages are immediately published without manual approval.
              </p>
            </div>
            <div>
              <fetcher.Form method="post" style={{ margin: 0 }}>
                <input type="hidden" name="actionType" value="toggle_auto_approve" />
                <input type="hidden" name="current" value={String(settings.autoApproveReviews)} />
                <s-button type="submit" variant={settings.autoApproveReviews ? "primary" : "secondary"} loading={isBusy}>
                  {settings.autoApproveReviews ? "Auto-Approve: Enabled" : "Auto-Approve: Disabled"}
                </s-button>
              </fetcher.Form>
            </div>
          </div>
        </div>

        {/* Reviews Table Card */}
        <div style={cardStyle}>
          <h3 style={{ fontSize: "16px", fontWeight: "800", margin: "0 0 16px 0", color: "#000000" }}>
            Customer Reviews ({reviews.length})
          </h3>

          {reviews.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 16px", color: "#000000" }}>
              No reviews received yet. Reviews submitted by customers or added manually will appear here.
            </div>
          ) : (
            <div style={{ width: "100%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #000000", textAlign: "left", color: "#000000", fontSize: "12px", fontWeight: "800" }}>
                    <th style={{ padding: "10px 8px" }}>RATING</th>
                    <th style={{ padding: "10px 8px" }}>AUTHOR</th>
                    <th style={{ padding: "10px 8px" }}>TITLE & FEEDBACK</th>
                    <th style={{ padding: "10px 8px" }}>DATE</th>
                    <th style={{ padding: "10px 8px", textAlign: "center" }}>STATUS</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {reviews.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid #e1e3e5" }}>
                      <td style={{ padding: "12px 8px", whiteSpace: "nowrap" }}>
                        <span style={{ color: "#000000", fontWeight: "800", fontSize: "14px" }}>
                          {"★".repeat(r.rating)}
                          {"☆".repeat(Math.max(0, 5 - r.rating))}
                        </span>
                      </td>
                      <td style={{ padding: "12px 8px", fontWeight: "700", color: "#000000" }}>
                        {r.author}
                        {r.isVerified && (
                          <div style={{ fontSize: "11px", color: "#000000", fontWeight: "800" }}>✓ Verified Buyer</div>
                        )}
                      </td>
                      <td style={{ padding: "12px 8px", maxWidth: "320px" }}>
                        <div style={{ fontWeight: "800", color: "#000000" }}>{r.title}</div>
                        <div style={{ color: "#000000", fontSize: "12px", marginTop: "2px" }}>{r.body}</div>
                      </td>
                      <td style={{ padding: "12px 8px", color: "#000000", whiteSpace: "nowrap" }}>
                        {new Date(r.createdAt).toLocaleDateString("en-IN", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </td>
                      <td style={{ padding: "12px 8px", textAlign: "center" }}>
                        <span
                          style={{
                            background: r.status === "published" ? "#000000" : "#ffffff",
                            color: r.status === "published" ? "#ffffff" : "#000000",
                            border: "1px solid #000000",
                            padding: "3px 10px",
                            borderRadius: "12px",
                            fontSize: "11px",
                            fontWeight: "800",
                            textTransform: "uppercase",
                          }}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td style={{ padding: "12px 8px", textAlign: "right", whiteSpace: "nowrap" }}>
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
        </div>
      </s-stack>

      {/* Add Review Modal */}
      {isAddModalOpen && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "18px", fontWeight: "800", color: "#000000" }}>Add Customer Review</h3>
            <fetcher.Form method="post">
              <input type="hidden" name="actionType" value="add_review" />

              <div style={{ marginBottom: "12px" }}>
                <label htmlFor="review-author" style={labelStyle}>
                  Customer Name:
                </label>
                <input id="review-author" type="text" name="author" placeholder="e.g. Priya S." style={inputStyle} required />
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label htmlFor="review-rating" style={labelStyle}>
                  Rating (1-5 Stars):
                </label>
                <select id="review-rating" name="rating" style={inputStyle} defaultValue="5">
                  <option value="5">★★★★★ (5 Stars - Excellent)</option>
                  <option value="4">★★★★☆ (4 Stars - Very Good)</option>
                  <option value="3">★★★☆☆ (3 Stars - Average)</option>
                  <option value="2">★★☆☆☆ (2 Stars - Poor)</option>
                  <option value="1">★☆☆☆☆ (1 Star - Bad)</option>
                </select>
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label htmlFor="review-title" style={labelStyle}>
                  Review Title:
                </label>
                <input id="review-title" type="text" name="title" placeholder="e.g. My kitten devoured this!" style={inputStyle} required />
              </div>

              <div style={{ marginBottom: "12px" }}>
                <label htmlFor="review-body" style={labelStyle}>
                  Review Content:
                </label>
                <textarea
                  id="review-body"
                  name="body"
                  rows={4}
                  placeholder="Share details of the experience..."
                  style={{ ...inputStyle, resize: "vertical" }}
                  required
                />
              </div>

              <div style={{ marginBottom: "16px" }}>
                <label htmlFor="review-product" style={labelStyle}>
                  Product ID (Shopify Product GID or handle):
                </label>
                <input id="review-product" type="text" name="productId" placeholder="e.g. kitten-fresh-salmon" style={inputStyle} required />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <s-button type="button" onClick={() => setIsAddModalOpen(false)} variant="secondary">
                  Cancel
                </s-button>
                <s-button type="submit" variant="primary" loading={isBusy}>
                  Save & Publish Review
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
  borderRadius: "12px",
  border: "1.5px solid #000000",
  padding: "20px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

const kpiBoxStyle: React.CSSProperties = {
  background: "#fff",
  padding: "20px",
  borderRadius: "10px",
  border: "1.5px solid #000000",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

const kpiLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: "800",
  color: "#000000",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const kpiValueStyle: React.CSSProperties = {
  fontSize: "26px",
  fontWeight: "900",
  color: "#000000",
  marginTop: "6px",
};

const kpiSubStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#000000",
  marginTop: "4px",
  fontWeight: "500",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "13px",
  fontWeight: "700",
  marginBottom: "4px",
  color: "#000000",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: "8px",
  border: "1.5px solid #000000",
  fontSize: "14px",
  boxSizing: "border-box",
  color: "#000000",
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
  border: "1.5px solid #000000",
  padding: "24px",
  maxWidth: "500px",
  width: "100%",
  boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
};
