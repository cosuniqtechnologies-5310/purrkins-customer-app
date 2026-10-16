import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getSettings,
  savePlan,
  setEligibleProducts,
  setPlanActive,
  syncSellingPlans,
} from "../utils/subscription.server";
import { describeFrequency } from "../utils/subscription-schedule";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, plans] = await Promise.all([
    getSettings(shop),
    prisma.subscriptionPlan.findMany({
      where: { shop },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  // Fetch shop products for the eligible products selector
  let products: Array<{ id: string; title: string; imageUrl: string | null }> = [];
  try {
    const res = await admin.graphql(`
      query getProducts {
        products(first: 50, sortKey: TITLE) {
          nodes {
            id
            title
            featuredImage {
              url
            }
          }
        }
      }
    `);
    interface ShopifyProductNode {
      id: string;
      title: string;
      featuredImage?: { url: string } | null;
    }
    const json = await res.json();
    products = ((json.data?.products?.nodes || []) as ShopifyProductNode[]).map((p) => ({
      id: p.id,
      title: p.title,
      imageUrl: p.featuredImage?.url || null,
    }));
  } catch (e) {
    console.error("Could not fetch products for subscription plans", e);
  }

  return { shop, settings, plans, products };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    switch (intent) {
      case "save_plan": {
        const id = formData.get("id") ? String(formData.get("id")) : undefined;
        const interval = String(formData.get("interval")) as "WEEK" | "MONTH";
        const intervalCount = parseInt(String(formData.get("intervalCount") || "1"), 10);
        const discountPercent = parseFloat(String(formData.get("discountPercent") || "0"));
        const name = String(formData.get("name") || "").trim() || undefined;

        await savePlan(shop, { id, interval, intervalCount, discountPercent, name });
        // Automatically sync with Shopify to keep storefront updated
        await syncSellingPlans(shop);

        return {
          success: true,
          message: id ? "Subscription plan updated and synced to Shopify." : "New plan created and synced to Shopify.",
        };
      }

      case "toggle_active": {
        const id = String(formData.get("id") || "");
        const active = formData.get("active") === "true";
        await setPlanActive(shop, id, active);
        await syncSellingPlans(shop);
        return {
          success: true,
          message: active ? "Plan activated and synced." : "Plan deactivated and removed from storefront.",
        };
      }

      case "delete_plan": {
        const id = String(formData.get("id") || "");
        await prisma.subscriptionPlan.delete({ where: { id, shop } });
        await syncSellingPlans(shop);
        return { success: true, message: "Plan deleted." };
      }

      case "sync_shopify": {
        const res = await syncSellingPlans(shop);
        return {
          success: true,
          message: res.groupId
            ? "Successfully synced all active plans to Shopify Selling Plan Group!"
            : "No active plans to sync. Selling plan group cleared.",
        };
      }

      case "save_eligible_products": {
        const productIds = formData.getAll("productIds").map(String);
        await setEligibleProducts(shop, productIds);
        return {
          success: true,
          message: `Updated eligible products (${productIds.length} products linked to subscriptions).`,
        };
      }

      default:
        return { success: false, message: `Unknown intent: ${intent}` };
    }
  } catch (e: unknown) {
    return { success: false, message: e instanceof Error ? e.message : "Plan operation failed." };
  }
};

export default function SubscriptionPlans() {
  const { settings, plans, products } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const nav = useNavigation();
  const isBusy = nav.state !== "idle";

  const [modalOpen, setModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<typeof plans[0] | null>(null);
  const [name, setName] = useState("");
  const [interval, setInterval] = useState<"WEEK" | "MONTH">("MONTH");
  const [intervalCount, setIntervalCount] = useState(1);
  const [discountPercent, setDiscountPercent] = useState(15);

  const [selectedProductIds, setSelectedProductIds] = useState<string[]>(
    settings.eligibleProductIds || []
  );
  const [productSearch, setProductSearch] = useState("");

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.success });
      if (actionData.success) {
        setModalOpen(false);
        setEditingPlan(null);
      }
    }
  }, [actionData, shopify]);

  const openCreateModal = () => {
    setEditingPlan(null);
    setName("Delivered every month");
    setInterval("MONTH");
    setIntervalCount(1);
    setDiscountPercent(15);
    setModalOpen(true);
  };

  const openEditModal = (p: typeof plans[0]) => {
    setEditingPlan(p);
    setName(p.name);
    setInterval(p.interval as "WEEK" | "MONTH");
    setIntervalCount(p.intervalCount);
    setDiscountPercent(p.discountPercent);
    setModalOpen(true);
  };

  const filteredProducts = products.filter((p) =>
    p.title.toLowerCase().includes(productSearch.toLowerCase())
  );

  const toggleProduct = (id: string) => {
    setSelectedProductIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const selectAllProducts = () => {
    setSelectedProductIds(products.map((p) => p.id));
  };

  const clearAllProducts = () => {
    setSelectedProductIds([]);
  };

  return (
    <s-page heading="Subscription Plans & Frequencies">
      <div slot="primary-action" style={{ display: "flex", gap: "8px" }}>
        <Form method="post" style={{ display: "inline" }}>
          <input type="hidden" name="intent" value="sync_shopify" />
          <s-button type="submit" variant="primary" loading={isBusy}>
            Sync with Shopify
          </s-button>
        </Form>
        <s-button onClick={openCreateModal} variant="secondary">
          + Add New Plan
        </s-button>
      </div>

      <s-stack direction="block" gap="base">
        {/* Shopify Status Banner */}
        <div
          style={{
            background: settings.sellingPlanGroupId ? "#f0fdf4" : "#fefce8",
            border: `1px solid ${settings.sellingPlanGroupId ? "#bbf7d0" : "#fef08a"}`,
            borderRadius: "10px",
            padding: "16px 20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "18px" }}>{settings.sellingPlanGroupId ? "✅" : "⚠️"}</span>
              <strong style={{ fontSize: "14px", color: "#166534" }}>
                {settings.sellingPlanGroupId
                  ? "Shopify Selling Plan Group Connected"
                  : "Selling Plans Not Synced Yet"}
              </strong>
            </div>
            <div style={{ fontSize: "13px", color: "#4b5563", marginTop: "4px" }}>
              {settings.sellingPlanGroupId
                ? `Group ID: ${settings.sellingPlanGroupId} • Active in online store checkout and customer portal.`
                : "Create your plans below, then click 'Sync with Shopify' to publish them to checkout."}
            </div>
          </div>
          <div>
            <span
              style={{
                fontSize: "12px",
                fontWeight: "700",
                background: settings.sellingPlanGroupId ? "#15803d" : "#ca8a04",
                color: "#fff",
                padding: "4px 10px",
                borderRadius: "12px",
              }}
            >
              {plans.filter((p) => p.active).length} Active Plans Synced
            </span>
          </div>
        </div>

        {/* Plans Table Card */}
        <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e1e3e5", padding: "20px" }}>
          <h3 style={{ fontSize: "16px", fontWeight: "700", margin: "0 0 16px 0", color: "#202223" }}>
            Configured Plans
          </h3>

          {plans.length === 0 ? (
            <div style={{ textAlign: "center", padding: "32px 16px", color: "#6d7175" }}>
              No subscription plans configured yet. Click <strong>+ Add New Plan</strong> above to create your first monthly or weekly plan.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e1e3e5", textAlign: "left", color: "#5c5f62", fontSize: "12px" }}>
                    <th style={{ padding: "10px 8px" }}>PLAN NAME</th>
                    <th style={{ padding: "10px 8px" }}>FREQUENCY</th>
                    <th style={{ padding: "10px 8px" }}>DISCOUNT</th>
                    <th style={{ padding: "10px 8px" }}>SHOPIFY SELLING PLAN</th>
                    <th style={{ padding: "10px 8px", textAlign: "center" }}>STATUS</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
                      <td style={{ padding: "14px 8px", fontWeight: "700", color: "#202223" }}>
                        {p.name}
                        <div style={{ fontSize: "12px", fontWeight: "400", color: "#6d7175" }}>
                          Storefront label: &ldquo;{p.label}&rdquo;
                        </div>
                      </td>
                      <td style={{ padding: "14px 8px", color: "#202223" }}>
                        {describeFrequency(p.interval, p.intervalCount)}
                      </td>
                      <td style={{ padding: "14px 8px", fontWeight: "700", color: "#008060" }}>
                        {p.discountPercent > 0 ? `${p.discountPercent}% OFF` : "No Discount"}
                      </td>
                      <td style={{ padding: "14px 8px", fontSize: "12px", color: "#6d7175" }}>
                        {p.sellingPlanId ? (
                          <span style={{ background: "#f1f2f3", padding: "3px 8px", borderRadius: "6px" }}>
                            #{p.sellingPlanId.split("/").pop()}
                          </span>
                        ) : (
                          <span style={{ color: "#d97706" }}>Pending Sync</span>
                        )}
                      </td>
                      <td style={{ padding: "14px 8px", textAlign: "center" }}>
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="toggle_active" />
                          <input type="hidden" name="id" value={p.id} />
                          <input type="hidden" name="active" value={p.active ? "false" : "true"} />
                          <button
                            type="submit"
                            disabled={isBusy}
                            style={{
                              background: p.active ? "#e3f1df" : "#f1f2f3",
                              color: p.active ? "#108043" : "#6d7175",
                              border: `1px solid ${p.active ? "#aee9d1" : "#d2d5d8"}`,
                              padding: "4px 10px",
                              borderRadius: "12px",
                              fontSize: "12px",
                              fontWeight: "700",
                              cursor: "pointer",
                            }}
                          >
                            {p.active ? "Active" : "Disabled"}
                          </button>
                        </Form>
                      </td>
                      <td style={{ padding: "14px 8px", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                          <s-button onClick={() => openEditModal(p)} variant="secondary">
                            Edit
                          </s-button>
                          <Form method="post" style={{ display: "inline" }}>
                            <input type="hidden" name="intent" value="delete_plan" />
                            <input type="hidden" name="id" value={p.id} />
                            <s-button type="submit" tone="critical" loading={isBusy}>
                              Delete
                            </s-button>
                          </Form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Eligible Products Section */}
        <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e1e3e5", padding: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <h3 style={{ fontSize: "16px", fontWeight: "700", margin: "0 0 4px 0", color: "#202223" }}>
                Eligible Products for Subscription
              </h3>
              <p style={{ fontSize: "13px", color: "#6d7175", margin: 0 }}>
                Select which products can be purchased as a recurring subscription with these plans.
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                onClick={selectAllProducts}
                style={{ ...pillButtonStyle, background: "#f1f2f3", color: "#202223" }}
              >
                Select All
              </button>
              <button
                type="button"
                onClick={clearAllProducts}
                style={{ ...pillButtonStyle, background: "#f1f2f3", color: "#202223" }}
              >
                Clear All
              </button>
            </div>
          </div>

          <div style={{ marginBottom: "16px" }}>
            <input
              type="text"
              placeholder="Filter products..."
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              style={{ width: "100%", padding: "8px 12px", borderRadius: "8px", border: "1px solid #c9cccf", fontSize: "14px" }}
            />
          </div>

          <Form method="post">
            <input type="hidden" name="intent" value="save_eligible_products" />
            <div
              style={{
                maxHeight: "360px",
                overflowY: "auto",
                border: "1px solid #e1e3e5",
                borderRadius: "8px",
                padding: "8px",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: "8px",
              }}
            >
              {filteredProducts.map((p) => {
                const isSelected = selectedProductIds.includes(p.id);
                return (
                  <label
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      background: isSelected ? "#f0fdf4" : "#fff",
                      border: `1px solid ${isSelected ? "#86efac" : "#e5e7eb"}`,
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      name="productIds"
                      value={p.id}
                      checked={isSelected}
                      onChange={() => toggleProduct(p.id)}
                    />
                    {p.imageUrl ? (
                      <img
                        src={p.imageUrl}
                        alt=""
                        style={{ width: "36px", height: "36px", objectFit: "cover", borderRadius: "4px" }}
                      />
                    ) : (
                      <div
                        style={{
                          width: "36px",
                          height: "36px",
                          background: "#e5e7eb",
                          borderRadius: "4px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "16px",
                        }}
                      >
                        📦
                      </div>
                    )}
                    <span style={{ fontSize: "13px", fontWeight: isSelected ? "600" : "400", color: "#202223" }}>
                      {p.title}
                    </span>
                  </label>
                );
              })}
            </div>

            <div style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end" }}>
              <s-button type="submit" variant="primary" loading={isBusy}>
                Save Eligible Products ({selectedProductIds.length} Selected)
              </s-button>
            </div>
          </Form>
        </div>
      </s-stack>

      {/* Add / Edit Plan Modal */}
      {modalOpen && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "18px" }}>
              {editingPlan ? "Edit Subscription Plan" : "Create New Subscription Plan"}
            </h3>
            <Form method="post">
              <input type="hidden" name="intent" value="save_plan" />
              {editingPlan && <input type="hidden" name="id" value={editingPlan.id} />}

              <div style={{ marginBottom: "16px" }}>
                <label htmlFor="plan-name-input" style={{ display: "block", fontSize: "13px", fontWeight: "600", marginBottom: "6px" }}>
                  Plan Name (shown to merchant and customer):
                </label>
                <input
                  id="plan-name-input"
                  type="text"
                  name="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Delivered every month"
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #c9cccf" }}
                  required
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                <div>
                  <label htmlFor="plan-interval-select" style={{ display: "block", fontSize: "13px", fontWeight: "600", marginBottom: "6px" }}>
                    Interval Unit:
                  </label>
                  <select
                    id="plan-interval-select"
                    name="interval"
                    value={interval}
                    onChange={(e) => setInterval(e.target.value as "WEEK" | "MONTH")}
                    style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #c9cccf" }}
                  >
                    <option value="MONTH">Month(s)</option>
                    <option value="WEEK">Week(s)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="plan-interval-count-input" style={{ display: "block", fontSize: "13px", fontWeight: "600", marginBottom: "6px" }}>
                    Interval Count:
                  </label>
                  <input
                    id="plan-interval-count-input"
                    type="number"
                    name="intervalCount"
                    min="1"
                    max="12"
                    value={intervalCount}
                    onChange={(e) => setIntervalCount(parseInt(e.target.value, 10) || 1)}
                    style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #c9cccf" }}
                    required
                  />
                </div>
              </div>

              <div style={{ marginBottom: "20px" }}>
                <label htmlFor="plan-discount-input" style={{ display: "block", fontSize: "13px", fontWeight: "600", marginBottom: "6px" }}>
                  Discount Percentage (%):
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    id="plan-discount-input"
                    type="number"
                    name="discountPercent"
                    min="0"
                    max="90"
                    step="0.5"
                    value={discountPercent}
                    onChange={(e) => setDiscountPercent(parseFloat(e.target.value) || 0)}
                    style={{ width: "120px", padding: "10px", borderRadius: "8px", border: "1px solid #c9cccf" }}
                    required
                  />
                  <span style={{ fontSize: "14px", fontWeight: "600", color: "#008060" }}>
                    {discountPercent > 0 ? `Customers save ${discountPercent}% on recurring orders` : "No discount"}
                  </span>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <s-button type="button" onClick={() => setModalOpen(false)} variant="secondary">
                  Cancel
                </s-button>
                <s-button type="submit" variant="primary" loading={isBusy}>
                  {editingPlan ? "Update Plan" : "Create Plan"}
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

const pillButtonStyle: React.CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: "16px",
  padding: "5px 12px",
  fontSize: "12px",
  fontWeight: "600",
  cursor: "pointer",
};
