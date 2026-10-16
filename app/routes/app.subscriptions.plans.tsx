import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getSettings,
  savePlan,
  setEligibleScope,
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

  let products: Array<{ id: string; title: string; imageUrl: string | null }> = [];
  let collections: Array<{ id: string; title: string; imageUrl: string | null; productIds: string[]; count: number }> = [];

  try {
    const res = await admin.graphql(`
      query getCatalog {
        products(first: 250, sortKey: TITLE) {
          nodes {
            id
            title
            featuredImage {
              url
            }
          }
        }
        collections(first: 50, sortKey: TITLE) {
          nodes {
            id
            title
            image {
              url
            }
            products(first: 250) {
              nodes {
                id
              }
            }
          }
        }
      }
    `);
    const json = await res.json();
    const prodNodes = (json.data?.products?.nodes || []) as Array<{
      id: string;
      title: string;
      featuredImage?: { url: string } | null;
    }>;
    products = prodNodes.map((p) => ({
      id: p.id,
      title: p.title,
      imageUrl: p.featuredImage?.url || null,
    }));

    const collNodes = (json.data?.collections?.nodes || []) as Array<{
      id: string;
      title: string;
      image?: { url: string } | null;
      products?: { nodes: Array<{ id: string }> };
    }>;
    collections = collNodes.map((c) => {
      const pIds = (c.products?.nodes || []).map((p) => p.id);
      return {
        id: c.id,
        title: c.title,
        imageUrl: c.image?.url || null,
        productIds: pIds,
        count: pIds.length,
      };
    });
  } catch (e) {
    console.error("Could not fetch catalog for subscription plans", e);
  }

  return { shop, settings, plans, products, collections };
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
        const discountPercent = parseFloat(String(formData.get("discountPercent") || "15"));
        const name = String(formData.get("name") || "").trim() || undefined;

        await savePlan(shop, { id, interval, intervalCount, discountPercent, name });
        await syncSellingPlans(shop);

        return {
          success: true,
          message: id ? "Subscription plan updated and synced to Shopify." : "New plan created with discount and synced to Shopify.",
        };
      }

      case "seed_default_plans": {
        await savePlan(shop, {
          name: "Delivered Every Month (Save 15%)",
          interval: "MONTH",
          intervalCount: 1,
          discountPercent: 15,
        });
        await savePlan(shop, {
          name: "Delivered Every 2 Weeks (Save 15%)",
          interval: "WEEK",
          intervalCount: 2,
          discountPercent: 15,
        });
        await syncSellingPlans(shop);
        return {
          success: true,
          message: "Standard default subscription plans created with 15% discount.",
        };
      }

      case "toggle_active": {
        const id = String(formData.get("id") || "");
        const active = formData.get("active") === "true";
        await setPlanActive(shop, id, active);
        await syncSellingPlans(shop);
        return {
          success: true,
          message: active ? "Plan activated and synced." : "Plan deactivated.",
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

      case "save_eligible_scope": {
        const selectionType = String(formData.get("selectionType") || "ALL") as "ALL" | "COLLECTIONS" | "PRODUCTS";
        let targetProductIds: string[] = [];
        const collectionIds = formData.getAll("collectionIds").map(String);

        if (selectionType === "ALL") {
          targetProductIds = formData.getAll("allProductIds").map(String);
        } else if (selectionType === "COLLECTIONS") {
          targetProductIds = formData.getAll("collectionProductIds").map(String);
        } else {
          targetProductIds = formData.getAll("productIds").map(String);
        }

        await setEligibleScope(shop, {
          productSelectionType: selectionType,
          productIds: targetProductIds,
          collectionIds,
        });

        return {
          success: true,
          message: `Subscription eligibility saved (${selectionType === "ALL" ? "All Products" : selectionType === "COLLECTIONS" ? `${collectionIds.length} Collection(s)` : `${targetProductIds.length} Product(s)`}).`,
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
  const { settings, plans, products, collections } = useLoaderData<typeof loader>();
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

  // Eligibility Scope: default is ALL
  const [selectionType, setSelectionType] = useState<"ALL" | "COLLECTIONS" | "PRODUCTS">(
    (settings.productSelectionType as "ALL" | "COLLECTIONS" | "PRODUCTS") || "ALL"
  );
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>(
    settings.eligibleCollectionIds || []
  );
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>(
    settings.eligibleProductIds && settings.eligibleProductIds.length > 0
      ? settings.eligibleProductIds
      : products.map((p) => p.id)
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
    setName("Delivered every month (Save 15%)");
    setInterval("MONTH");
    setIntervalCount(1);
    setDiscountPercent(15); // Default 15% discount offer
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

  const toggleCollection = (id: string) => {
    setSelectedCollectionIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

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

  // Products belonging to currently selected collections
  const collectionProductIds = Array.from(
    new Set(
      collections
        .filter((c) => selectedCollectionIds.includes(c.id))
        .flatMap((c) => c.productIds)
    )
  );

  const filteredProducts = products.filter((p) =>
    p.title.toLowerCase().includes(productSearch.toLowerCase())
  );

  return (
    <s-page heading="Subscription Plans & Frequencies">
      <div slot="primary-action" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
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
            background: "#fff",
            border: "1.5px solid #000",
            borderRadius: "10px",
            padding: "18px 22px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "14px",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "18px" }}>{settings.sellingPlanGroupId ? "✅" : "⚠️"}</span>
              <strong style={{ fontSize: "15px", color: "#000", fontWeight: "900" }}>
                {settings.sellingPlanGroupId
                  ? "Shopify Selling Plan Group Connected"
                  : "Selling Plans Not Synced Yet"}
              </strong>
            </div>
            <div style={{ fontSize: "13px", color: "#000", marginTop: "4px", fontWeight: "500" }}>
              {settings.sellingPlanGroupId
                ? `Group ID: ${settings.sellingPlanGroupId} • Active in online store checkout and customer portal.`
                : "Create your plans below, then click 'Sync with Shopify' to publish them to checkout."}
            </div>
          </div>
          <div>
            <span
              style={{
                fontSize: "12px",
                fontWeight: "800",
                background: "#000",
                color: "#fff",
                padding: "6px 14px",
                borderRadius: "20px",
                border: "1.5px solid #000",
              }}
            >
              {plans.filter((p) => p.active).length} Active Plans Synced
            </span>
          </div>
        </div>

        {/* Plans Table Card (No Horizontal Scroll) */}
        <div style={{ background: "#fff", borderRadius: "10px", border: "1.5px solid #000", padding: "22px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
            <h3 style={{ fontSize: "16px", fontWeight: "900", margin: 0, color: "#000" }}>
              Configured Plans
            </h3>
            {plans.length === 0 && (
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="seed_default_plans" />
                <button
                  type="submit"
                  disabled={isBusy}
                  style={{
                    background: "#000",
                    color: "#fff",
                    border: "1.5px solid #000",
                    borderRadius: "6px",
                    padding: "8px 16px",
                    fontSize: "13px",
                    fontWeight: "800",
                    cursor: "pointer",
                  }}
                >
                  + Create Default Discount Plans (Save 15%)
                </button>
              </Form>
            )}
          </div>

          {plans.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 16px", color: "#000" }}>
              <div style={{ fontSize: "32px", marginBottom: "8px" }}>📦</div>
              <div style={{ fontSize: "15px", fontWeight: "800", color: "#000" }}>
                No subscription plans configured yet.
              </div>
              <p style={{ margin: "6px 0 16px 0", fontSize: "13px", color: "#000" }}>
                Click below to auto-create standard monthly &amp; bi-weekly plans with 15% discount, or create a custom plan.
              </p>
              <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
                <Form method="post" style={{ display: "inline" }}>
                  <input type="hidden" name="intent" value="seed_default_plans" />
                  <button
                    type="submit"
                    disabled={isBusy}
                    style={{
                      background: "#000",
                      color: "#fff",
                      border: "1.5px solid #000",
                      borderRadius: "6px",
                      padding: "8px 18px",
                      fontSize: "13px",
                      fontWeight: "800",
                      cursor: "pointer",
                    }}
                  >
                    Create Default Discount Plans (Save 15%)
                  </button>
                </Form>
                <s-button onClick={openCreateModal} variant="secondary">
                  + Add Custom Plan
                </s-button>
              </div>
            </div>
          ) : (
            <div style={{ width: "100%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                <thead>
                  <tr style={{ borderBottom: "1.5px solid #000", textAlign: "left", color: "#000", fontSize: "12px", backgroundColor: "#f9fafb" }}>
                    <th style={{ padding: "12px 10px", fontWeight: "900", textTransform: "uppercase" }}>PLAN NAME</th>
                    <th style={{ padding: "12px 10px", fontWeight: "900", textTransform: "uppercase" }}>FREQUENCY</th>
                    <th style={{ padding: "12px 10px", fontWeight: "900", textTransform: "uppercase" }}>DISCOUNT</th>
                    <th style={{ padding: "12px 10px", fontWeight: "900", textTransform: "uppercase" }}>SHOPIFY SELLING PLAN</th>
                    <th style={{ padding: "12px 10px", textAlign: "center", fontWeight: "900", textTransform: "uppercase" }}>STATUS</th>
                    <th style={{ padding: "12px 10px", textAlign: "right", fontWeight: "900", textTransform: "uppercase" }}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                      <td style={{ padding: "14px 10px", fontWeight: "800", color: "#000" }}>
                        {p.name}
                        <div style={{ fontSize: "12px", fontWeight: "500", color: "#000" }}>
                          Storefront label: &ldquo;{p.label}&rdquo;
                        </div>
                      </td>
                      <td style={{ padding: "14px 10px", color: "#000", fontWeight: "700" }}>
                        {describeFrequency(p.interval, p.intervalCount)}
                      </td>
                      <td style={{ padding: "14px 10px", fontWeight: "900", color: "#000" }}>
                        {p.discountPercent > 0 ? `${p.discountPercent}% OFF (Default)` : "No Discount"}
                      </td>
                      <td style={{ padding: "14px 10px", fontSize: "12px", color: "#000", fontWeight: "600" }}>
                        {p.sellingPlanId ? (
                          <span style={{ background: "#fff", border: "1px solid #000", padding: "3px 8px", borderRadius: "6px" }}>
                            #{p.sellingPlanId.split("/").pop()}
                          </span>
                        ) : (
                          <span style={{ fontWeight: "700", color: "#000" }}>Pending Sync</span>
                        )}
                      </td>
                      <td style={{ padding: "14px 10px", textAlign: "center" }}>
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="toggle_active" />
                          <input type="hidden" name="id" value={p.id} />
                          <input type="hidden" name="active" value={p.active ? "false" : "true"} />
                          <button
                            type="submit"
                            disabled={isBusy}
                            style={{
                              background: p.active ? "#000" : "#fff",
                              color: p.active ? "#fff" : "#000",
                              border: "1.5px solid #000",
                              padding: "4px 12px",
                              borderRadius: "14px",
                              fontSize: "12px",
                              fontWeight: "800",
                              cursor: "pointer",
                            }}
                          >
                            {p.active ? "Active" : "Disabled"}
                          </button>
                        </Form>
                      </td>
                      <td style={{ padding: "14px 10px", textAlign: "right" }}>
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

        {/* Eligible Products Section: Scope Selector (ALL products by default) */}
        <div style={{ background: "#fff", borderRadius: "10px", border: "1.5px solid #000", padding: "22px" }}>
          <div style={{ marginBottom: "16px" }}>
            <h3 style={{ fontSize: "16px", fontWeight: "900", margin: "0 0 4px 0", color: "#000" }}>
              Product Eligibility for Subscriptions
            </h3>
            <p style={{ fontSize: "13px", color: "#000", margin: 0, fontWeight: "500" }}>
              Control which products are enabled for Subscribe &amp; Save recurring deliveries. Default is <strong>All Products</strong>.
            </p>
          </div>

          <Form method="post">
            <input type="hidden" name="intent" value="save_eligible_scope" />
            <input type="hidden" name="selectionType" value={selectionType} />

            {/* Hidden inputs to pass full product arrays depending on mode */}
            {products.map((p) => (
              <input key={`all-${p.id}`} type="hidden" name="allProductIds" value={p.id} />
            ))}
            {collectionProductIds.map((id) => (
              <input key={`coll-p-${id}`} type="hidden" name="collectionProductIds" value={id} />
            ))}

            {/* Mode selection radio tabs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px", marginBottom: "20px" }}>
              <button
                type="button"
                onClick={() => setSelectionType("ALL")}
                style={{
                  border: selectionType === "ALL" ? "2px solid #000" : "1px solid #d1d5db",
                  background: selectionType === "ALL" ? "#f9fafb" : "#fff",
                  borderRadius: "8px",
                  padding: "16px",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <input
                    type="radio"
                    name="scope_radio"
                    checked={selectionType === "ALL"}
                    onChange={() => setSelectionType("ALL")}
                    style={{ accentColor: "#000", width: "18px", height: "18px" }}
                  />
                  <div>
                    <div style={{ fontWeight: "900", fontSize: "14px", color: "#000" }}>
                      All Products (Default)
                    </div>
                    <div style={{ fontSize: "12px", color: "#000", marginTop: "2px" }}>
                      Every product in your catalog automatically gets subscription enabled.
                    </div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSelectionType("COLLECTIONS")}
                style={{
                  border: selectionType === "COLLECTIONS" ? "2px solid #000" : "1px solid #d1d5db",
                  background: selectionType === "COLLECTIONS" ? "#f9fafb" : "#fff",
                  borderRadius: "8px",
                  padding: "16px",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <input
                    type="radio"
                    name="scope_radio"
                    checked={selectionType === "COLLECTIONS"}
                    onChange={() => setSelectionType("COLLECTIONS")}
                    style={{ accentColor: "#000", width: "18px", height: "18px" }}
                  />
                  <div>
                    <div style={{ fontWeight: "900", fontSize: "14px", color: "#000" }}>
                      Specific Collections
                    </div>
                    <div style={{ fontSize: "12px", color: "#000", marginTop: "2px" }}>
                      Enable subscriptions for all products in chosen collections.
                    </div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSelectionType("PRODUCTS")}
                style={{
                  border: selectionType === "PRODUCTS" ? "2px solid #000" : "1px solid #d1d5db",
                  background: selectionType === "PRODUCTS" ? "#f9fafb" : "#fff",
                  borderRadius: "8px",
                  padding: "16px",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <input
                    type="radio"
                    name="scope_radio"
                    checked={selectionType === "PRODUCTS"}
                    onChange={() => setSelectionType("PRODUCTS")}
                    style={{ accentColor: "#000", width: "18px", height: "18px" }}
                  />
                  <div>
                    <div style={{ fontWeight: "900", fontSize: "14px", color: "#000" }}>
                      Specific Products
                    </div>
                    <div style={{ fontSize: "12px", color: "#000", marginTop: "2px" }}>
                      Manually check individual products one by one.
                    </div>
                  </div>
                </div>
              </button>
            </div>

            {/* Sub-view: ALL products */}
            {selectionType === "ALL" && (
              <div
                style={{
                  padding: "20px",
                  background: "#f9fafb",
                  border: "1.5px solid #000",
                  borderRadius: "8px",
                  marginBottom: "20px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ fontSize: "22px" }}>🌟</span>
                  <div>
                    <strong style={{ fontSize: "15px", color: "#000", fontWeight: "900" }}>
                      All {products.length} Products in Store Included
                    </strong>
                    <div style={{ fontSize: "13px", color: "#000", marginTop: "4px" }}>
                      All existing products and future products will automatically offer recurring subscription delivery with the configured discount offer.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Sub-view: COLLECTIONS selection */}
            {selectionType === "COLLECTIONS" && (
              <div style={{ marginBottom: "20px" }}>
                <div style={{ marginBottom: "12px", fontSize: "13px", color: "#000", fontWeight: "700" }}>
                  Select collections to include ({selectedCollectionIds.length} collections selected, {collectionProductIds.length} products total):
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                    gap: "10px",
                  }}
                >
                  {collections.map((c) => {
                    const isChecked = selectedCollectionIds.includes(c.id);
                    const inputId = `coll-${c.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
                    return (
                      <label
                        key={c.id}
                        htmlFor={inputId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          padding: "10px 14px",
                          borderRadius: "8px",
                          background: isChecked ? "#f9fafb" : "#fff",
                          border: `1.5px solid ${isChecked ? "#000" : "#d1d5db"}`,
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        <input
                          id={inputId}
                          type="checkbox"
                          name="collectionIds"
                          value={c.id}
                          checked={isChecked}
                          onChange={() => toggleCollection(c.id)}
                          aria-label={c.title}
                          style={{ accentColor: "#000" }}
                        />
                        <span>
                          <span style={{ fontSize: "13px", fontWeight: "800", color: "#000", display: "block" }}>
                            {c.title}
                          </span>
                          <span style={{ fontSize: "11px", color: "#000", fontWeight: "500", display: "block" }}>
                            {c.count} products
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sub-view: PRODUCTS selection */}
            {selectionType === "PRODUCTS" && (
              <div style={{ marginBottom: "20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "10px" }}>
                  <input
                    type="text"
                    placeholder="Filter products..."
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    style={{ padding: "8px 12px", borderRadius: "6px", border: "1.5px solid #000", fontSize: "13px", minWidth: "240px", color: "#000" }}
                  />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={selectAllProducts}
                      style={{ ...pillButtonStyle, background: "#fff", border: "1.5px solid #000", color: "#000" }}
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={clearAllProducts}
                      style={{ ...pillButtonStyle, background: "#fff", border: "1.5px solid #000", color: "#000" }}
                    >
                      Clear All
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    maxHeight: "360px",
                    overflowY: "auto",
                    border: "1.5px solid #000",
                    borderRadius: "8px",
                    padding: "10px",
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                    gap: "8px",
                  }}
                >
                  {filteredProducts.map((p) => {
                    const isSelected = selectedProductIds.includes(p.id);
                    const inputId = `prod-${p.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
                    return (
                      <label
                        key={p.id}
                        htmlFor={inputId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          background: isSelected ? "#f9fafb" : "#fff",
                          border: `1.5px solid ${isSelected ? "#000" : "#e5e7eb"}`,
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        <input
                          id={inputId}
                          type="checkbox"
                          name="productIds"
                          value={p.id}
                          checked={isSelected}
                          onChange={() => toggleProduct(p.id)}
                          style={{ accentColor: "#000" }}
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
                              background: "#f1f2f3",
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
                        <span style={{ fontSize: "13px", fontWeight: isSelected ? "800" : "500", color: "#000" }}>
                          {p.title}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="submit"
                disabled={isBusy}
                style={{
                  background: "#000",
                  color: "#fff",
                  border: "1.5px solid #000",
                  borderRadius: "6px",
                  padding: "10px 22px",
                  fontSize: "14px",
                  fontWeight: "800",
                  cursor: "pointer",
                }}
              >
                {selectionType === "ALL"
                  ? `Save Scope: All Products (${products.length} Products)`
                  : selectionType === "COLLECTIONS"
                  ? `Save Scope: ${selectedCollectionIds.length} Collection(s) (${collectionProductIds.length} Products)`
                  : `Save Scope: ${selectedProductIds.length} Product(s)`}
              </button>
            </div>
          </Form>
        </div>
      </s-stack>

      {/* Add / Edit Plan Modal (Defaults with 15% discount offer) */}
      {modalOpen && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "18px", fontWeight: "900", color: "#000" }}>
              {editingPlan ? "Edit Subscription Plan" : "Create New Subscription Plan (With Discount)"}
            </h3>
            <Form method="post">
              <input type="hidden" name="intent" value="save_plan" />
              {editingPlan && <input type="hidden" name="id" value={editingPlan.id} />}

              <div style={{ marginBottom: "16px" }}>
                <label htmlFor="plan-name-input" style={{ display: "block", fontSize: "13px", fontWeight: "800", marginBottom: "6px", color: "#000" }}>
                  Plan Name (shown to merchant and customer):
                </label>
                <input
                  id="plan-name-input"
                  type="text"
                  name="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Delivered every month (Save 15%)"
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1.5px solid #000", color: "#000" }}
                  required
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                <div>
                  <label htmlFor="plan-interval-select" style={{ display: "block", fontSize: "13px", fontWeight: "800", marginBottom: "6px", color: "#000" }}>
                    Interval Unit:
                  </label>
                  <select
                    id="plan-interval-select"
                    name="interval"
                    value={interval}
                    onChange={(e) => setInterval(e.target.value as "WEEK" | "MONTH")}
                    style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1.5px solid #000", color: "#000" }}
                  >
                    <option value="MONTH">Month(s)</option>
                    <option value="WEEK">Week(s)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="plan-interval-count-input" style={{ display: "block", fontSize: "13px", fontWeight: "800", marginBottom: "6px", color: "#000" }}>
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
                    style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1.5px solid #000", color: "#000" }}
                    required
                  />
                </div>
              </div>

              <div style={{ marginBottom: "20px" }}>
                <label htmlFor="plan-discount-input" style={{ display: "block", fontSize: "13px", fontWeight: "800", marginBottom: "6px", color: "#000" }}>
                  Discount Offer Percentage (%):
                </label>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <input
                    id="plan-discount-input"
                    type="number"
                    name="discountPercent"
                    min="0"
                    max="90"
                    step="0.5"
                    value={discountPercent}
                    onChange={(e) => setDiscountPercent(parseFloat(e.target.value) || 0)}
                    style={{ width: "120px", padding: "10px", borderRadius: "8px", border: "1.5px solid #000", color: "#000", fontWeight: "800" }}
                    required
                  />
                  <span style={{ fontSize: "14px", fontWeight: "800", color: "#000" }}>
                    {discountPercent > 0 ? `Subscribers save ${discountPercent}% every recurring order` : "No discount"}
                  </span>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  style={{
                    padding: "8px 16px",
                    background: "#fff",
                    border: "1.5px solid #000",
                    borderRadius: "6px",
                    color: "#000",
                    fontWeight: "700",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isBusy}
                  style={{
                    padding: "8px 18px",
                    background: "#000",
                    border: "1.5px solid #000",
                    borderRadius: "6px",
                    color: "#fff",
                    fontWeight: "800",
                    cursor: "pointer",
                  }}
                >
                  {editingPlan ? "Update Plan" : "Create Plan"}
                </button>
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
  maxWidth: "520px",
  width: "100%",
  border: "2px solid #000",
  boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
};

const pillButtonStyle: React.CSSProperties = {
  borderRadius: "16px",
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: "800",
  cursor: "pointer",
};
