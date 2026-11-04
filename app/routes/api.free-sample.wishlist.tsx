import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import jwt from "jsonwebtoken";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { appCache } from "../cache.server";

// Helper: extract customer ID from token or cookies
function extractCustomerId(request: Request, url: URL): string | null {
  const cookieHeader = request.headers.get("Cookie");
  const cookieMatch = cookieHeader ? cookieHeader.match(/pk_session=([^;]+)/) : null;
  const cookieToken = cookieMatch ? cookieMatch[1] : null;
  const sessionToken = url.searchParams.get("session") || cookieToken;
  let customerIdStr = url.searchParams.get("logged_in_customer_id");

  if (!customerIdStr && sessionToken) {
    const secrets = [
      process.env.SHOPIFY_API_SECRET,
      "s3cr3t",
      "c48f3f570d623330d23274556ccc823f",
    ].filter(Boolean) as string[];

    for (const secret of secrets) {
      try {
        const decoded = jwt.verify(sessionToken, secret) as any;
        if (decoded && decoded.customerId) {
          customerIdStr = String(decoded.customerId);
          break;
        }
      } catch {}
    }
  }

  return customerIdStr;
}

// Helper: execute GraphQL query or mutation against Shopify Admin
async function executeShopifyGql(query: string, variables: any = {}) {
  try {
    const { admin } = await unauthenticated.admin("purrkins-mhrlfymw.myshopify.com");
    if (admin) {
      const res = await admin.graphql(query, { variables });
      return await res.json();
    }
  } catch (e) {
    console.warn("[Wishlist] unauthenticated.admin failed, falling back to direct shop session:", e);
  }

  // Fallback to offline session stored in Prisma
  const session = await prisma.session.findFirst({
    where: { shop: "purrkins-mhrlfymw.myshopify.com", isOnline: false },
  });
  if (!session?.accessToken) {
    throw new Error("No offline shop session available for Shopify Admin API");
  }

  const res = await fetch("https://purrkins-mhrlfymw.myshopify.com/admin/api/2026-07/graphql.json", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  return await res.json();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const url = new URL(request.url);
    const customerIdStr = extractCustomerId(request, url);

    if (!customerIdStr) {
      // Guest mode: return empty wishlist with isGuest flag
      return Response.json({ success: true, wishlist: [], isGuest: true });
    }

    const customerGid = customerIdStr.includes("gid://shopify/Customer/")
      ? customerIdStr
      : `gid://shopify/Customer/${customerIdStr}`;

    const getMetafieldData = await executeShopifyGql(
      `#graphql
      query getCustomerWishlist($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "custom", key: "wishlist") {
            value
          }
        }
      }`,
      { id: customerGid }
    );

    const metafield = getMetafieldData?.data?.customer?.metafield;
    let currentWishlist: string[] = [];

    if (metafield?.value) {
      try {
        const parsed = JSON.parse(metafield.value);
        if (Array.isArray(parsed)) {
          currentWishlist = parsed.map((id: any) => {
            const s = String(id);
            const clean = s.split("/").pop();
            return s.includes("gid://shopify/Product/") ? s : `gid://shopify/Product/${clean}`;
          });
        }
      } catch (e) {
        currentWishlist = [];
      }
    }

    return Response.json({ success: true, wishlist: currentWishlist });
  } catch (error) {
    console.error("[Wishlist] Error fetching wishlist", error);
    return Response.json({ success: false, wishlist: [] }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ success: false, message: "Method not allowed" }, { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const customerIdStr = extractCustomerId(request, url);
    const body = await request.json().catch(() => ({}));
    const { product_id, product_ids, action: wishlistAction, remaining_ids } = body;

    // If guest attempts to post without session, acknowledge success so client keeps in session
    if (!customerIdStr) {
      return Response.json({
        success: true,
        session: true,
        message: "Saved in session storage",
        wishlist: Array.isArray(product_ids) ? product_ids : product_id ? [product_id] : [],
      });
    }

    const customerGid = customerIdStr.includes("gid://shopify/Customer/")
      ? customerIdStr
      : `gid://shopify/Customer/${customerIdStr}`;

    // 1. Fetch current customer wishlist
    const getMetafieldData = await executeShopifyGql(
      `#graphql
      query getCustomerWishlist($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "custom", key: "wishlist") {
            id
            value
          }
        }
      }`,
      { id: customerGid }
    );

    const metafield = getMetafieldData?.data?.customer?.metafield;
    const hasExistingMetafield = !!(metafield && typeof metafield.value === "string");

    let wishlist: string[] = [];
    if (hasExistingMetafield) {
      try {
        const parsed = JSON.parse(metafield.value);
        if (Array.isArray(parsed)) {
          wishlist = parsed.map((id: any) => {
            const s = String(id);
            const clean = s.split("/").pop();
            return s.includes("gid://shopify/Product/") ? s : `gid://shopify/Product/${clean}`;
          });
        }
      } catch (e) {
        wishlist = [];
      }
    }

    // 2. Handle Merge/Sync of session wishlist items into customer storage
    if (wishlistAction === "merge" || wishlistAction === "sync") {
      const idsToAdd: string[] = Array.isArray(product_ids)
        ? product_ids
        : product_id
        ? [product_id]
        : [];

      let changed = false;
      for (const rawId of idsToAdd) {
        if (!rawId) continue;
        const cleanId = String(rawId).split("/").pop();
        const gid = String(rawId).includes("gid://shopify/Product/")
          ? String(rawId)
          : `gid://shopify/Product/${cleanId}`;

        const alreadyExists = wishlist.some((item) => {
          return item === gid || item.split("/").pop() === cleanId;
        });

        if (!alreadyExists) {
          wishlist.push(gid);
          changed = true;
        }
      }

      if (changed || !hasExistingMetafield) {
        const setMetafieldData = await executeShopifyGql(
          `#graphql
          mutation setCustomerMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id value }
              userErrors { field message }
            }
          }`,
          {
            metafields: [
              {
                ownerId: customerGid,
                namespace: "custom",
                key: "wishlist",
                type: "list.product_reference",
                value: JSON.stringify(wishlist),
              },
            ],
          }
        );

        if (setMetafieldData?.data?.metafieldsSet?.userErrors?.length > 0) {
          console.error("[Wishlist] User errors on merge:", setMetafieldData.data.metafieldsSet.userErrors);
          return Response.json({ success: false, message: "Failed to update wishlist" }, { status: 500 });
        }

        appCache.delPrefix("dashboard:cust:");
        appCache.delPrefix("dashboard:");
        appCache.delPrefix("customer:");
      }

      return Response.json({ success: true, action: "merge", wishlist });
    }

    // 3. Handle single product remove
    if (wishlistAction === "remove") {
      const cleanTargetId = String(product_id || "").split("/").pop();
      const targetGid = product_id
        ? String(product_id).includes("gid://shopify/Product/")
          ? String(product_id)
          : `gid://shopify/Product/${cleanTargetId}`
        : "";

      let updatedWishlist: string[] = [];

      if (hasExistingMetafield && wishlist.length > 0) {
        // Filter out matching ID flexibly (checking numeric ID, GID, or raw product_id)
        updatedWishlist = wishlist.filter((item) => {
          const itemClean = String(item).split("/").pop();
          return itemClean !== cleanTargetId && item !== targetGid && item !== product_id;
        });
      } else if (Array.isArray(remaining_ids)) {
        // Customer was viewing default catalog items, client passed explicit remaining cards
        updatedWishlist = remaining_ids
          .map((id: any) => {
            const s = String(id);
            const clean = s.split("/").pop();
            return s.includes("gid://shopify/Product/") ? s : `gid://shopify/Product/${clean}`;
          })
          .filter((item: string) => {
            const itemClean = item.split("/").pop();
            return itemClean !== cleanTargetId && item !== targetGid && item !== product_id;
          });
      }

      // Format clean GIDs
      const formattedWishlist = updatedWishlist.map((id) => {
        const clean = id.split("/").pop();
        return id.includes("gid://shopify/Product/") ? id : `gid://shopify/Product/${clean}`;
      });

      // Save to customer metafield (creates the metafield even if empty so default items never reappear)
      const setMetafieldData = await executeShopifyGql(
        `#graphql
        mutation setCustomerMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id value }
            userErrors { field message }
          }
        }`,
        {
          metafields: [
            {
              ownerId: customerGid,
              namespace: "custom",
              key: "wishlist",
              type: "list.product_reference",
              value: JSON.stringify(formattedWishlist),
            },
          ],
        }
      );

      if (setMetafieldData?.data?.metafieldsSet?.userErrors?.length > 0) {
        console.error("[Wishlist] User errors on remove:", setMetafieldData.data.metafieldsSet.userErrors);
        return Response.json({ success: false, message: "Failed to update wishlist" }, { status: 500 });
      }

      appCache.delPrefix("dashboard:cust:");
      appCache.delPrefix("dashboard:");
      appCache.delPrefix("customer:");

      return Response.json({ success: true, action: "remove", wishlist: formattedWishlist });
    }

    // 4. Handle single product add
    if (wishlistAction === "add") {
      if (!product_id) {
        return Response.json({ success: false, message: "Product ID is required" }, { status: 400 });
      }

      const cleanTargetId = String(product_id).split("/").pop();
      const productGid = product_id.includes("gid://shopify/Product/")
        ? product_id
        : `gid://shopify/Product/${cleanTargetId}`;

      const exists = wishlist.some((item) => {
        return item === productGid || item.split("/").pop() === cleanTargetId;
      });

      if (!exists) {
        wishlist.push(productGid);
      }

      const formattedWishlist = wishlist.map((id) => {
        const clean = id.split("/").pop();
        return id.includes("gid://shopify/Product/") ? id : `gid://shopify/Product/${clean}`;
      });

      const setMetafieldData = await executeShopifyGql(
        `#graphql
        mutation setCustomerMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id value }
            userErrors { field message }
          }
        }`,
        {
          metafields: [
            {
              ownerId: customerGid,
              namespace: "custom",
              key: "wishlist",
              type: "list.product_reference",
              value: JSON.stringify(formattedWishlist),
            },
          ],
        }
      );

      if (setMetafieldData?.data?.metafieldsSet?.userErrors?.length > 0) {
        console.error("[Wishlist] User errors on add:", setMetafieldData.data.metafieldsSet.userErrors);
        return Response.json({ success: false, message: "Failed to update wishlist" }, { status: 500 });
      }

      appCache.delPrefix("dashboard:cust:");
      appCache.delPrefix("dashboard:");
      appCache.delPrefix("customer:");

      return Response.json({ success: true, action: "add", wishlist: formattedWishlist });
    }

    return Response.json({ success: true, action: "none", wishlist });
  } catch (error: any) {
    console.error("[Wishlist] Error updating wishlist:", error);
    return Response.json(
      { success: false, message: "Internal server error", error: error.message },
      { status: 500 }
    );
  }
};
