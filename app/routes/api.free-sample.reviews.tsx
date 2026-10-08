import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";

// Helper to verify if customer has actually purchased a product in Shopify orders
async function getCustomerPurchasedProductIds(
  admin: any,
  customerId?: string | null,
  email?: string | null
): Promise<Set<string>> {
  const purchasedIds = new Set<string>();
  if (!admin || (!customerId && !email)) return purchasedIds;

  try {
    let orders: any[] = [];

    // 1. If customer ID is provided, query customer orders
    if (customerId) {
      const cleanCustomerId = customerId.replace(/^gid:\/\/shopify\/Customer\//, "");
      const customerGid = `gid://shopify/Customer/${cleanCustomerId}`;

      try {
        const res = await admin.graphql(
          `#graphql
          query getCustomerOrders($id: ID!) {
            customer(id: $id) {
              orders(first: 50, sortKey: CREATED_AT, reverse: true) {
                edges {
                  node {
                    cancelledAt
                    financialStatus
                    lineItems(first: 50) {
                      edges {
                        node {
                          product {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
          { variables: { id: customerGid } }
        );
        const data = (await res.json()) as any;
        const edges = data?.data?.customer?.orders?.edges || [];
        orders.push(...edges.map((e: any) => e.node));
      } catch (err) {
        console.error("Error querying customer orders by ID:", err);
      }
    }

    // 2. Query orders by email
    if (email && email.includes("@")) {
      try {
        const res = await admin.graphql(
          `#graphql
          query getOrdersByEmail($query: String!) {
            orders(first: 30, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  cancelledAt
                  financialStatus
                  lineItems(first: 50) {
                    edges {
                      node {
                        product {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
          { variables: { query: `email:${email.trim()}` } }
        );
        const data = (await res.json()) as any;
        const edges = data?.data?.orders?.edges || [];
        orders.push(...edges.map((e: any) => e.node));
      } catch (err) {
        console.error("Error querying orders by email:", err);
      }
    }

    // Extract product IDs from all valid (non-cancelled, non-voided) orders
    for (const order of orders) {
      if (order.cancelledAt || order.financialStatus === "VOIDED") continue;
      for (const itemEdge of order.lineItems?.edges || []) {
        const prodId = itemEdge.node?.product?.id;
        if (prodId) {
          const rawId = prodId.replace(/^gid:\/\/shopify\/Product\//, "");
          purchasedIds.add(rawId);
          purchasedIds.add(prodId);
        }
      }
    }
  } catch (err) {
    console.error("Error in getCustomerPurchasedProductIds:", err);
  }

  return purchasedIds;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  // Note: the shop is automatically appended to proxy requests by Shopify.
  const shop = url.searchParams.get("shop") || "purrkins.myshopify.com";

  try {
    const whereClause: any = {
      shop,
      status: "published",
    };

    if (productId) {
      const cleanProductId = productId.replace(/^gid:\/\/shopify\/Product\//, "");
      whereClause.OR = [
        { productId: cleanProductId },
        { productId: `gid://shopify/Product/${cleanProductId}` },
      ];
    }

    let reviews = await prisma.review.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
    });

    // If no reviews found for this specific productId, fallback to all published reviews for shop
    if (reviews.length === 0 && productId) {
      reviews = await prisma.review.findMany({
        where: { shop, status: "published" },
        orderBy: { createdAt: "desc" },
      });
    }

    // Dynamically verify purchase status using Shopify Admin API
    let admin: any = null;
    try {
      const authResult = await authenticate.public.appProxy(request);
      admin = authResult.admin;
    } catch (e) {
      // appProxy auth failed
    }

    if (!admin && shop) {
      try {
        const unauth = await unauthenticated.admin(shop);
        admin = unauth.admin;
      } catch (e) {
        console.error("Failed to get unauthenticated admin in loader:", e);
      }
    }

    if (admin && reviews.length > 0) {
      const emailPurchasesMap = new Map<string, Set<string>>();
      const emails = [...new Set(reviews.map((r) => r.email).filter(Boolean))];

      await Promise.all(
        emails.map(async (email) => {
          if (!email) return;
          const purchasedSet = await getCustomerPurchasedProductIds(admin, null, email);
          emailPurchasesMap.set(email.toLowerCase(), purchasedSet);
        })
      );

      for (const review of reviews) {
        if (review.email) {
          const cleanProdId = review.productId.replace(/^gid:\/\/shopify\/Product\//, "");
          const purchasedSet = emailPurchasesMap.get(review.email.toLowerCase());
          const actuallyPurchased = purchasedSet
            ? purchasedSet.has(cleanProdId) || purchasedSet.has(`gid://shopify/Product/${cleanProdId}`)
            : false;

          // Dynamically enforce isVerified based on actual purchase
          if (review.isVerified !== actuallyPurchased) {
            review.isVerified = actuallyPurchased;
            prisma.review
              .update({
                where: { id: review.id },
                data: { isVerified: actuallyPurchased },
              })
              .catch((e) => console.error("Failed to update review verified status:", e));
          }
        } else {
          if (review.isVerified) {
            review.isVerified = false;
            prisma.review
              .update({
                where: { id: review.id },
                data: { isVerified: false },
              })
              .catch((e) => console.error("Failed to update review verified status:", e));
          }
        }
      }
    }

    // Calculate average rating
    const stats = await prisma.review.aggregate({
      where: whereClause,
      _avg: { rating: true },
      _count: { id: true },
    });

    return {
      reviews,
      averageRating: stats._avg.rating || 0,
      totalCount: stats._count.id || 0,
    };
  } catch (err) {
    console.error("Failed to load reviews", err);
    return Response.json({ error: "Failed to load reviews", details: (err as Error).message }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const formData = await request.formData();
  const rawProductId = formData.get("productId")?.toString();
  const rating = Number(formData.get("rating"));
  const title = formData.get("title")?.toString() || "";
  const body = formData.get("body")?.toString() || "";
  const author = formData.get("author")?.toString() || "Anonymous";
  const email = formData.get("email")?.toString()?.trim() || "";
  const customerId =
    formData.get("customerId")?.toString() ||
    new URL(request.url).searchParams.get("logged_in_customer_id");

  // Parse images array if present
  const images = formData.getAll("images[]").map((img) => img.toString());

  // App proxy adds shop query parameter automatically
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "purrkins.myshopify.com";

  if (!rawProductId || !rating) {
    return Response.json({ error: "Product ID and rating are required" }, { status: 400 });
  }

  const productId = rawProductId.replace(/^gid:\/\/shopify\/Product\//, "");

  // Check auto-approve setting
  let settings = await prisma.storeSetting.findUnique({ where: { shop } });
  if (!settings) {
    settings = await prisma.storeSetting.create({ data: { shop, autoApproveReviews: true } });
  }

  // Obtain admin client
  let admin: any = null;
  try {
    const authResult = await authenticate.public.appProxy(request);
    admin = authResult.admin;
  } catch (e) {
    // appProxy auth failed
  }

  if (!admin && shop) {
    try {
      const { admin: unauthAdmin } = await unauthenticated.admin(shop);
      admin = unauthAdmin;
    } catch (e) {
      console.error("Failed to get unauthenticated admin in action:", e);
    }
  }

  // DYNAMIC VERIFICATION: Verify if customer has actually bought this product
  let isVerified = false;
  if (admin && (customerId || email)) {
    const purchasedIds = await getCustomerPurchasedProductIds(admin, customerId, email);
    isVerified = purchasedIds.has(productId) || purchasedIds.has(`gid://shopify/Product/${productId}`);
  }

  try {
    const review = await prisma.review.create({
      data: {
        shop,
        productId,
        rating,
        title,
        body,
        author,
        email,
        images,
        isVerified,
        status: "published", // Auto-approve all reviews as requested
      },
    });

    if (admin) {
      try {
        // Calculate new average rating for the whole shop
        const stats = await prisma.review.aggregate({
          where: { shop, status: "published" },
          _avg: { rating: true },
          _count: { id: true },
        });

        const shopResponse = await admin.graphql(
          `#graphql
          query {
            shop {
              id
            }
          }`
        );
        const shopData = await shopResponse.json();
        const shopId = shopData.data.shop.id;

        await admin.graphql(
          `#graphql
          mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors {
                message
              }
            }
          }`,
          {
            variables: {
              metafields: [
                {
                  key: "global_reviews_count",
                  namespace: "purrkins",
                  ownerId: shopId,
                  type: "number_integer",
                  value: String(stats._count.id || 0),
                },
                {
                  key: "global_reviews_rating",
                  namespace: "purrkins",
                  ownerId: shopId,
                  type: "number_decimal",
                  value: String(stats._avg.rating || 5.0),
                },
              ],
            },
          }
        );
      } catch (metafieldErr) {
        console.error("Failed to sync shop metafields", metafieldErr);
      }
    }

    return { success: true, review };
  } catch (err) {
    console.error("Failed to create review", err);
    return Response.json({ error: "Failed to create review", details: (err as Error).message }, { status: 500 });
  }
}
