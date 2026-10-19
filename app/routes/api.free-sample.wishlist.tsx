import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import jwt from "jsonwebtoken";
import { unauthenticated } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const url = new URL(request.url);
    const sessionToken = url.searchParams.get("session");
    let customerIdStr = url.searchParams.get("logged_in_customer_id");

    if (!customerIdStr && sessionToken) {
      try {
        const decoded = jwt.verify(sessionToken, process.env.SHOPIFY_API_SECRET || "s3cr3t") as any;
        customerIdStr = decoded.customerId;
      } catch (e) {
        console.error("Wishlist JWT verification failed", e);
      }
    }

    if (!customerIdStr) {
      // Guest mode: return empty wishlist with isGuest flag
      return Response.json({ success: true, wishlist: [], isGuest: true });
    }

    const customerGid = customerIdStr.includes("gid://shopify/Customer/") 
      ? customerIdStr 
      : `gid://shopify/Customer/${customerIdStr}`;

    const { admin } = await unauthenticated.admin("purrkins-mhrlfymw.myshopify.com");
    if (!admin) {
      return Response.json({ success: false, wishlist: [] }, { status: 500 });
    }

    const getMetafieldResponse = await admin.graphql(
      `#graphql
      query getCustomerWishlist($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "custom", key: "wishlist") {
            value
          }
        }
      }`,
      { variables: { id: customerGid } }
    );

    const getMetafieldData = await getMetafieldResponse.json();
    const metafield = getMetafieldData?.data?.customer?.metafield;
    let currentWishlist: string[] = [];
    
    if (metafield?.value) {
      try {
        currentWishlist = JSON.parse(metafield.value);
        if (!Array.isArray(currentWishlist)) currentWishlist = [];
      } catch (e) {
        currentWishlist = [];
      }
    }

    return Response.json({ success: true, wishlist: currentWishlist });
  } catch (error) {
    console.error("Error fetching wishlist", error);
    return Response.json({ success: false, wishlist: [] }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ success: false, message: "Method not allowed" }, { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const sessionToken = url.searchParams.get("session");
    let customerIdStr = url.searchParams.get("logged_in_customer_id");

    if (!customerIdStr && sessionToken) {
      try {
        const decoded = jwt.verify(sessionToken, process.env.SHOPIFY_API_SECRET || "s3cr3t") as any;
        customerIdStr = decoded.customerId;
      } catch (e) {
        console.error("Wishlist JWT verification failed", e);
      }
    }

    const body = await request.json().catch(() => ({}));
    const { product_id, product_ids, action: wishlistAction } = body;

    // If guest attempts to post without session, acknowledge success so client keeps in session
    if (!customerIdStr) {
      return Response.json({
        success: true,
        session: true,
        message: "Saved in session storage",
        wishlist: Array.isArray(product_ids) ? product_ids : product_id ? [product_id] : []
      });
    }

    const customerGid = customerIdStr.includes("gid://shopify/Customer/") 
      ? customerIdStr 
      : `gid://shopify/Customer/${customerIdStr}`;

    const { admin } = await unauthenticated.admin("purrkins-mhrlfymw.myshopify.com");
    if (!admin) {
      return Response.json({ success: false, message: "Shop admin access denied" }, { status: 500 });
    }

    // 1. Fetch current customer wishlist
    const getMetafieldResponse = await admin.graphql(
      `#graphql
      query getCustomerWishlist($id: ID!) {
        customer(id: $id) {
          metafield(namespace: "custom", key: "wishlist") {
            id
            value
          }
        }
      }`,
      { variables: { id: customerGid } }
    );

    const getMetafieldData = await getMetafieldResponse.json();
    const metafield = getMetafieldData.data?.customer?.metafield;
    
    let wishlist: string[] = [];
    if (metafield && metafield.value) {
      try {
        wishlist = JSON.parse(metafield.value);
        if (!Array.isArray(wishlist)) wishlist = [];
      } catch (e) {
        wishlist = [];
      }
    }

    // Handle Merge/Sync of session wishlist items into customer storage
    if (wishlistAction === "merge" || wishlistAction === "sync") {
      const idsToAdd: string[] = Array.isArray(product_ids)
        ? product_ids
        : product_id
        ? [product_id]
        : [];

      let changed = false;
      for (const rawId of idsToAdd) {
        if (!rawId) continue;
        const gid = String(rawId).includes("gid://shopify/Product/")
          ? String(rawId)
          : `gid://shopify/Product/${rawId}`;
        if (!wishlist.includes(gid)) {
          wishlist.push(gid);
          changed = true;
        }
      }

      if (changed) {
        const setMetafieldResponse = await admin.graphql(
          `#graphql
          mutation setCustomerMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
                value
              }
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              metafields: [
                {
                  ownerId: customerGid,
                  namespace: "custom",
                  key: "wishlist",
                  type: "list.product_reference",
                  value: JSON.stringify(wishlist),
                }
              ]
            }
          }
        );

        const setMetafieldData = await setMetafieldResponse.json();
        if (setMetafieldData.data?.metafieldsSet?.userErrors?.length > 0) {
          console.error("[Wishlist] User errors on merge:", setMetafieldData.data.metafieldsSet.userErrors);
          return Response.json({ success: false, message: "Failed to update wishlist" }, { status: 500 });
        }
      }

      return Response.json({ success: true, action: "merge", wishlist });
    }

    // Handle single product add/remove
    if (!product_id) {
      return Response.json({ success: false, message: "Product ID is required" }, { status: 400 });
    }

    const productGid = product_id.includes("gid://shopify/Product/") 
      ? product_id 
      : `gid://shopify/Product/${product_id}`;

    const exists = wishlist.includes(productGid);
    if (wishlistAction === "add" && !exists) {
      wishlist.push(productGid);
    } else if (wishlistAction === "remove" && exists) {
      wishlist = wishlist.filter(id => id !== productGid);
    } else {
      return Response.json({ success: true, action: "none", wishlist });
    }

    // Save wishlist back to metafield
    const setMetafieldResponse = await admin.graphql(
      `#graphql
      mutation setCustomerMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            value
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: customerGid,
              namespace: "custom",
              key: "wishlist",
              type: "list.product_reference",
              value: JSON.stringify(wishlist),
            }
          ]
        }
      }
    );

    const setMetafieldData = await setMetafieldResponse.json();
    if (setMetafieldData.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error("[Wishlist] User errors:", setMetafieldData.data.metafieldsSet.userErrors);
      return Response.json({ success: false, message: "Failed to update wishlist" }, { status: 500 });
    }

    return Response.json({ success: true, action: wishlistAction, wishlist });

  } catch (error: any) {
    console.error("[Wishlist] Error updating wishlist:", error);
    return Response.json(
      { success: false, message: "Internal server error", error: error.message },
      { status: 500 }
    );
  }
};
