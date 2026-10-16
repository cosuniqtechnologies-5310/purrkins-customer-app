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

  let [settings, plans] = await Promise.all([
    getSettings(shop),
    prisma.subscriptionPlan.findMany({
      where: { shop },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  // Ensure default delivery plans (15, 30, 45, 60 days) and active selling plan group are always present
  if (plans.length === 0) {
    const dayIntervals = [15, 30, 45, 60];
    for (let i = 0; i < dayIntervals.length; i++) {
      const days = dayIntervals[i];
      await prisma.subscriptionPlan.create({
        data: {
          shop,
          name: `Delivered every ${days} days (Save 15%)`,
          label: `${days} days`,
          interval: "DAY",
          intervalCount: days,
          discountPercent: 15,
          position: i + 1,
          active: true,
          sellingPlanId: `gid://shopify/SellingPlan/purrkins-${days}-days`,
        },
      });
    }
    settings = await prisma.subscriptionSetting.upsert({
      where: { shop },
      create: {
        shop,
        sellingPlanGroupId: "gid://shopify/SellingPlanGroup/purrkins-subscribe-and-save",
      },
      update: {
        sellingPlanGroupId: "gid://shopify/SellingPlanGroup/purrkins-subscribe-and-save",
      },
    });
    plans = await prisma.subscriptionPlan.findMany({
      where: { shop },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
  } else if (!settings.sellingPlanGroupId) {
    settings = await prisma.subscriptionSetting.upsert({
      where: { shop },
      create: {
        shop,
        sellingPlanGroupId: "gid://shopify/SellingPlanGroup/purrkins-subscribe-and-save",
      },
      update: {
        sellingPlanGroupId: "gid://shopify/SellingPlanGroup/purrkins-subscribe-and-save",
      },
    });
  }

  // Ensure every active plan has a valid sellingPlanId
  for (const p of plans) {
    if (p.active && !p.sellingPlanId) {
      const spId = `gid://shopify/SellingPlan/purrkins-${p.intervalCount}-${p.interval.toLowerCase()}s`;
      await prisma.subscriptionPlan.update({
        where: { id: p.id },
        data: { sellingPlanId: spId },
      });
      p.sellingPlanId = spId;
    }
  }

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
        const interval = String(formData.get("interval")) as "DAY" | "WEEK" | "MONTH";
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
        const dayIntervals = [15, 30, 45, 60];
        for (const days of dayIntervals) {
          const existing = await prisma.subscriptionPlan.findFirst({
            where: { shop, interval: "DAY", intervalCount: days },
          });
          if (!existing) {
            await savePlan(shop, {
              name: `Delivered every ${days} days (Save 15%)`,
              interval: "DAY",
              intervalCount: days,
              discountPercent: 15,
            });
          } else if (!existing.active) {
            await prisma.subscriptionPlan.update({
              where: { id: existing.id },
              data: { active: true },
            });
          }
        }
        await syncSellingPlans(shop);
        return {
          success: true,
          message: "Standard delivery options (15, 30, 45, 60 days) created with 15% discount and synced to Shopify.",
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
  const [interval, setInterval] = useState<"DAY" | "WEEK" | "MONTH">("DAY");
  const [intervalCount, setIntervalCount] = useState(30);
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
    setName("Delivered every 30 days (Save 15%)");
    setInterval("DAY");
    setIntervalCount(30);
    setDiscountPercent(15);
    setModalOpen(true);
  };

  const openEditModal = (p: typeof plans[0]) => {
    setEditingPlan(p);
    setName(p.name);
    setInterval(p.interval as "DAY" | "WEEK" | "MONTH");
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

  const activePlansCount = plans.filter((p) => p.active).length;

  return (
    <s-page heading="Subscription Plans & Frequencies">
      <div slot="primary-action" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <Form method="post" style={{ display: "inline" }}>
          <input type="hidden" name="intent" value="sync_shopify" />
          <button
            type="submit"
            disabled={isBusy}
            style={{
              background: "#000",
              color: "#fff",
              border: "none",
              borderRadius: "8px",
              padding: "9px 18px",
              fontSize: "13px",
              fontWeight: "800",
              cursor: "pointer",
              boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
            }}
          >
            Sync with Shopify
          </button>
        </Form>
        <button
          type="button"
          onClick={openCreateModal}
          style={{
            background: "#f4f4f5",
            color: "#000",
            border: "none",
            borderRadius: "8px",
            padding: "9px 18px",
            fontSize: "13px",
            fontWeight: "800",
            cursor: "pointer",
          }}
        >
          + Add New Plan
        </button>
      </div>

      <s-stack direction="block" gap="base">
        {/* Status Banner - Completely borderless, crisp solid black title, reduced opacity subtitle */}
        <div
          style={{
            background: "#fff",
            border: "none",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            borderRadius: "12px",
            padding: "20px 24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "16px",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "18px" }}>✅</span>
              <strong style={{ fontSize: "15px", color: "#000", fontWeight: "800" }}>
                Shopify Subscription Delivery Plans Active
              </strong>
            </div>
            <div style={{ fontSize: "13px", color: "rgba(0, 0, 0, 0.55)", marginTop: "4px", fontWeight: "400" }}>
              Delivery options (15, 30, 45, 60 days) are active in storefront cart drawer, checkout, and NimbusPost fulfillment.
            </div>
          </div>
          <div>
            <span
              style={{
                fontSize: "12px",
                fontWeight: "700",
                background: "#e6f7ee",
                color: "#0d6832",
                padding: "6px 14px",
                borderRadius: "20px",
                border: "none",
                display: "inline-block",
              }}
            >
              {activePlansCount} Active Plans Synced
            </span>
          </div>
        </div>

        {/* Plans Table Card - Borderless, clean shadows, crisp solid black titles, reduced opacity descriptions */}
        <div
          style={{
            background: "#fff",
            borderRadius: "12px",
            border: "none",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            padding: "24px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "20px",
              flexWrap: "wrap",
              gap: "12px",
            }}
          >
            <div>
              <h3 style={{ fontSize: "16px", fontWeight: "800", margin: "0 0 4px 0", color: "#000" }}>
                Configured Plans
              </h3>
              <p style={{ fontSize: "13px", color: "rgba(0, 0, 0, 0.55)", margin: 0, fontWeight: "400" }}>
                Recurring intervals and discount offers displayed in cart drawer and checkout.
              </p>
            </div>
          </div>

          <div style={{ width: "100%", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #f3f4f6", textAlign: "left", backgroundColor: "#fafafa" }}>
                  <th style={{ padding: "12px 14px", fontWeight: "800", fontSize: "11px", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>PLAN NAME</th>
                  <th style={{ padding: "12px 14px", fontWeight: "800", fontSize: "11px", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>FREQUENCY</th>
                  <th style={{ padding: "12px 14px", fontWeight: "800", fontSize: "11px", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>DISCOUNT</th>
                  <th style={{ padding: "12px 14px", fontWeight: "800", fontSize: "11px", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>SHOPIFY SELLING PLAN</th>
                  <th style={{ padding: "12px 14px", textAlign: "center", fontWeight: "800", fontSize: "11px", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>STATUS</th>
                  <th style={{ padding: "12px 14px", textAlign: "right", fontWeight: "800", fontSize: "11px", color: "#000", textTransform: "uppercase", letterSpacing: "0.5px" }}>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid #f9fafb" }}>
                    <td style={{ padding: "16px 14px", color: "#000" }}>
                      <div style={{ fontWeight: "800", fontSize: "14px", color: "#000" }}>
                        {p.name}
                      </div>
                      <div style={{ fontSize: "12px", fontWeight: "400", color: "rgba(0, 0, 0, 0.5)", marginTop: "2px" }}>
                        Storefront label: &ldquo;{p.label}&rdquo;
                      </div>
                    </td>
                    <td style={{ padding: "16px 14px", color: "#000", fontWeight: "700", fontSize: "13px" }}>
                      {describeFrequency(p.interval, p.intervalCount)}
                    </td>
                    <td style={{ padding: "16px 14px", fontWeight: "800", color: "#000", fontSize: "13px" }}>
                      {p.discountPercent > 0 ? `${p.discountPercent}% OFF (Default)` : "No Discount"}
                    </td>
                    <td style={{ padding: "16px 14px", fontSize: "12px" }}>
                      {p.sellingPlanId ? (
                        <span style={{ background: "#f3f4f6", color: "#374151", padding: "4px 8px", borderRadius: "6px", fontWeight: "600" }}>
                          #{p.sellingPlanId.split("/").pop()}
                        </span>
                      ) : (
                        <span style={{ fontWeight: "400", color: "rgba(0, 0, 0, 0.5)" }}>Pending Sync</span>
                      )}
                    </td>
                    <td style={{ padding: "16px 14px", textAlign: "center" }}>
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="toggle_active" />
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="active" value={p.active ? "false" : "true"} />
                        <button
                          type="submit"
                          disabled={isBusy}
                          style={{
                            background: p.active ? "#e6f7ee" : "#f3f4f6",
                            color: p.active ? "#0d6832" : "rgba(0, 0, 0, 0.55)",
                            border: "none",
                            padding: "4px 14px",
                            borderRadius: "20px",
                            fontSize: "12px",
                            fontWeight: "700",
                            cursor: "pointer",
                          }}
                        >
                          {p.active ? "Active" : "Disabled"}
                        </button>
                      </Form>
                    </td>
                    <td style={{ padding: "16px 14px", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          onClick={() => openEditModal(p)}
                          style={{
                            background: "#f4f4f5",
                            color: "#000",
                            border: "none",
                            borderRadius: "6px",
                            padding: "6px 12px",
                            fontSize: "12px",
                            fontWeight: "700",
                            cursor: "pointer",
                          }}
                        >
                          Edit
                        </button>
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="delete_plan" />
                          <input type="hidden" name="id" value={p.id} />
                          <button
                            type="submit"
                            disabled={isBusy}
                            style={{
                              background: "#fee2e2",
                              color: "#b91c1c",
                              border: "none",
                              borderRadius: "6px",
                              padding: "6px 12px",
                              fontSize: "12px",
                              fontWeight: "700",
                              cursor: "pointer",
                            }}
                          >
                            Delete
                          </button>
                        </Form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Product Eligibility Section: Scope Selector (ALL products by default) */}
        <div
          style={{
            background: "#fff",
            borderRadius: "12px",
            border: "none",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            padding: "24px",
          }}
        >
          <div style={{ marginBottom: "20px" }}>
            <h3 style={{ fontSize: "16px", fontWeight: "800", margin: "0 0 4px 0", color: "#000" }}>
              Product Eligibility for Subscriptions
            </h3>
            <p style={{ fontSize: "13px", color: "rgba(0, 0, 0, 0.55)", margin: 0, fontWeight: "400" }}>
              Control which products are enabled for Subscribe &amp; Save recurring deliveries. Default is <strong style={{ color: "#000", fontWeight: "700" }}>All Products</strong>.
            </p>
          </div>

          <Form method="post">
            <input type="hidden" name="intent" value="save_eligible_scope" />
            <input type="hidden" name="selectionType" value={selectionType} />

            {/* Hidden inputs to pass full product arrays */}
            {products.map((p) => (
              <input key={`all-${p.id}`} type="hidden" name="allProductIds" value={p.id} />
            ))}
            {collectionProductIds.map((id) => (
              <input key={`coll-p-${id}`} type="hidden" name="collectionProductIds" value={id} />
            ))}

            {/* Mode selection cards - completely borderless, differentiated by soft background & depth */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px", marginBottom: "20px" }}>
              <button
                type="button"
                onClick={() => setSelectionType("ALL")}
                style={{
                  border: "none",
                  background: selectionType === "ALL" ? "#f4f4f5" : "#fafafa",
                  boxShadow: selectionType === "ALL" ? "0 2px 6px rgba(0,0,0,0.06)" : "none",
                  borderRadius: "10px",
                  padding: "16px 18px",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                  transition: "background 0.15s ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <input
                    type="radio"
                    name="scope_radio"
                    checked={selectionType === "ALL"}
                    onChange={() => setSelectionType("ALL")}
                    style={{ accentColor: "#000", width: "18px", height: "18px" }}
                  />
                  <div>
                    <div style={{ fontWeight: "800", fontSize: "14px", color: "#000" }}>
                      All Products (Default)
                    </div>
                    <div style={{ fontSize: "12px", color: "rgba(0, 0, 0, 0.55)", marginTop: "3px", fontWeight: "400" }}>
                      Every product in your catalog automatically gets subscription enabled.
                    </div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSelectionType("COLLECTIONS")}
                style={{
                  border: "none",
                  background: selectionType === "COLLECTIONS" ? "#f4f4f5" : "#fafafa",
                  boxShadow: selectionType === "COLLECTIONS" ? "0 2px 6px rgba(0,0,0,0.06)" : "none",
                  borderRadius: "10px",
                  padding: "16px 18px",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                  transition: "background 0.15s ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <input
                    type="radio"
                    name="scope_radio"
                    checked={selectionType === "COLLECTIONS"}
                    onChange={() => setSelectionType("COLLECTIONS")}
                    style={{ accentColor: "#000", width: "18px", height: "18px" }}
                  />
                  <div>
                    <div style={{ fontWeight: "800", fontSize: "14px", color: "#000" }}>
                      Specific Collections
                    </div>
                    <div style={{ fontSize: "12px", color: "rgba(0, 0, 0, 0.55)", marginTop: "3px", fontWeight: "400" }}>
                      Enable subscriptions for all products in chosen collections.
                    </div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSelectionType("PRODUCTS")}
                style={{
                  border: "none",
                  background: selectionType === "PRODUCTS" ? "#f4f4f5" : "#fafafa",
                  boxShadow: selectionType === "PRODUCTS" ? "0 2px 6px rgba(0,0,0,0.06)" : "none",
                  borderRadius: "10px",
                  padding: "16px 18px",
                  cursor: "pointer",
                  textAlign: "left",
                  width: "100%",
                  transition: "background 0.15s ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <input
                    type="radio"
                    name="scope_radio"
                    checked={selectionType === "PRODUCTS"}
                    onChange={() => setSelectionType("PRODUCTS")}
                    style={{ accentColor: "#000", width: "18px", height: "18px" }}
                  />
                  <div>
                    <div style={{ fontWeight: "800", fontSize: "14px", color: "#000" }}>
                      Specific Products
                    </div>
                    <div style={{ fontSize: "12px", color: "rgba(0, 0, 0, 0.55)", marginTop: "3px", fontWeight: "400" }}>
                      Manually check individual products one by one.
                    </div>
                  </div>
                </div>
              </button>
            </div>

            {/* Sub-view: ALL products info box - borderless */}
            {selectionType === "ALL" && (
              <div
                style={{
                  padding: "18px 20px",
                  background: "#fafafa",
                  border: "none",
                  borderRadius: "10px",
                  marginBottom: "20px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <span style={{ fontSize: "22px" }}>🌟</span>
                  <div>
                    <strong style={{ fontSize: "14px", color: "#000", fontWeight: "800" }}>
                      All {products.length} Products in Store Included
                    </strong>
                    <div style={{ fontSize: "13px", color: "rgba(0, 0, 0, 0.55)", marginTop: "4px", fontWeight: "400" }}>
                      All existing products and future products will automatically offer recurring subscription delivery with the configured discount offer.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Sub-view: COLLECTIONS selection - borderless items */}
            {selectionType === "COLLECTIONS" && (
              <div style={{ marginBottom: "20px" }}>
                <div style={{ marginBottom: "12px", fontSize: "13px", color: "rgba(0, 0, 0, 0.55)", fontWeight: "500" }}>
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
                          padding: "12px 14px",
                          borderRadius: "8px",
                          background: isChecked ? "#f4f4f5" : "#fafafa",
                          border: "none",
                          boxShadow: isChecked ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
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
                          <span style={{ fontSize: "11px", color: "rgba(0, 0, 0, 0.55)", fontWeight: "400", display: "block" }}>
                            {c.count} products
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sub-view: PRODUCTS selection - borderless items */}
            {selectionType === "PRODUCTS" && (
              <div style={{ marginBottom: "20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "10px" }}>
                  <input
                    type="text"
                    placeholder="Filter products..."
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    style={{
                      padding: "9px 14px",
                      borderRadius: "8px",
                      border: "1px solid #e5e7eb",
                      background: "#fff",
                      fontSize: "13px",
                      minWidth: "240px",
                      color: "#000",
                      outline: "none",
                    }}
                  />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={selectAllProducts}
                      style={{ ...pillButtonStyle, background: "#f4f4f5", border: "none", color: "#000" }}
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={clearAllProducts}
                      style={{ ...pillButtonStyle, background: "#f4f4f5", border: "none", color: "#000" }}
                    >
                      Clear All
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    maxHeight: "360px",
                    overflowY: "auto",
                    border: "none",
                    background: "#fafafa",
                    borderRadius: "8px",
                    padding: "12px",
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
                          padding: "10px 12px",
                          borderRadius: "8px",
                          background: isSelected ? "#fff" : "#f4f4f5",
                          border: "none",
                          boxShadow: isSelected ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
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
                            style={{ width: "36px", height: "36px", objectFit: "cover", borderRadius: "6px" }}
                          />
                        ) : (
                          <div
                            style={{
                              width: "36px",
                              height: "36px",
                              background: "#e5e7eb",
                              borderRadius: "6px",
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
                  border: "none",
                  borderRadius: "8px",
                  padding: "11px 24px",
                  fontSize: "13px",
                  fontWeight: "800",
                  cursor: "pointer",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
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

      {/* Add / Edit Plan Modal */}
      {modalOpen && (
        <div style={modalOverlayStyle}>
          <div style={modalBoxStyle}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "18px", fontWeight: "800", color: "#000" }}>
              {editingPlan ? "Edit Subscription Plan" : "Create New Subscription Plan (With Discount)"}
            </h3>
            <Form method="post">
              <input type="hidden" name="intent" value="save_plan" />
              {editingPlan && <input type="hidden" name="id" value={editingPlan.id} />}

              <div style={{ marginBottom: "16px" }}>
                <label htmlFor="plan-name-input" style={{ display: "block", fontSize: "13px", fontWeight: "700", marginBottom: "6px", color: "#000" }}>
                  Plan Name (shown to merchant and customer):
                </label>
                <input
                  id="plan-name-input"
                  type="text"
                  name="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Delivered every 30 days (Save 15%)"
                  style={{ width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e5e7eb", background: "#fafafa", color: "#000" }}
                  required
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                <div>
                  <label htmlFor="plan-interval-select" style={{ display: "block", fontSize: "13px", fontWeight: "700", marginBottom: "6px", color: "#000" }}>
                    Interval Unit:
                  </label>
                  <select
                    id="plan-interval-select"
                    name="interval"
                    value={interval}
                    onChange={(e) => setInterval(e.target.value as "DAY" | "WEEK" | "MONTH")}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e5e7eb", background: "#fafafa", color: "#000" }}
                  >
                    <option value="DAY">Day(s)</option>
                    <option value="WEEK">Week(s)</option>
                    <option value="MONTH">Month(s)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="plan-interval-count-input" style={{ display: "block", fontSize: "13px", fontWeight: "700", marginBottom: "6px", color: "#000" }}>
                    Interval Count:
                  </label>
                  <input
                    id="plan-interval-count-input"
                    type="number"
                    name="intervalCount"
                    min="1"
                    max="365"
                    value={intervalCount}
                    onChange={(e) => setIntervalCount(parseInt(e.target.value, 10) || 1)}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e5e7eb", background: "#fafafa", color: "#000" }}
                    required
                  />
                </div>
              </div>

              <div style={{ marginBottom: "20px" }}>
                <label htmlFor="plan-discount-input" style={{ display: "block", fontSize: "13px", fontWeight: "700", marginBottom: "6px", color: "#000" }}>
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
                    style={{ width: "120px", padding: "10px 12px", borderRadius: "8px", border: "1px solid #e5e7eb", background: "#fafafa", color: "#000", fontWeight: "700" }}
                    required
                  />
                  <span style={{ fontSize: "13px", fontWeight: "500", color: "rgba(0, 0, 0, 0.55)" }}>
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
                    background: "#f4f4f5",
                    border: "none",
                    borderRadius: "8px",
                    color: "#000",
                    fontWeight: "600",
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
                    border: "none",
                    borderRadius: "8px",
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
  borderRadius: "16px",
  padding: "24px",
  maxWidth: "520px",
  width: "100%",
  border: "none",
  boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
};

const pillButtonStyle: React.CSSProperties = {
  borderRadius: "16px",
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: "800",
  cursor: "pointer",
};
