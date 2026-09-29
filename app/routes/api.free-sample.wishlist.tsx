import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async () => {
  return Response.json(
    { success: false, message: "This endpoint only accepts POST requests." },
    { status: 405 }
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ success: false, message: "Method not allowed" }, { status: 405 });
  }

  try {
    const { admin, session } = await authenticate.public.appProxy(request);

    if (!admin) {
      return Response.json({ success: false, message: "Unauthorized access" }, { status: 401 });
    }

    const url = new URL(request.url);
    const customerIdStr = url.searchParams.get("logged_in_customer_id");
    
    if (!customerIdStr) {
      return Response.json({ success: false, message: "Customer must be logged in" }, { status: 401 });
    }

    const customerGid = `gid://shopify/Customer/${customerIdStr}`;
    const body = await request.json();
    const { product_id, action } = body;

    if (!product_id) {
      return Response.json({ success: false, message: "Product ID is required" }, { status: 400 });
    }

    // Format product ID to GID if it isn't already
    const productGid = product_id.includes("gid://shopify/Product/") 
      ? product_id 
      : `gid://shopify/Product/${product_id}`;

    // 1. Fetch current wishlist
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

    // 2. Modify wishlist array
    const exists = wishlist.includes(productGid);
    if (action === "add" && !exists) {
      wishlist.push(productGid);
    } else if (action === "remove" && exists) {
      wishlist = wishlist.filter(id => id !== productGid);
    } else {
      // No changes needed
      return Response.json({ success: true, action: "none", wishlist });
    }

    // 3. Save wishlist back to metafield
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
            },
          ],
        },
      }
    );

    const setMetafieldData = await setMetafieldResponse.json();
    if (setMetafieldData.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error("[Wishlist] User errors:", setMetafieldData.data.metafieldsSet.userErrors);
      return Response.json({ success: false, message: "Failed to update wishlist" }, { status: 500 });
    }

    return Response.json({ success: true, action, wishlist });

  } catch (error: any) {
    console.error("[Wishlist] Error updating wishlist:", error);
    return Response.json(
      { success: false, message: "Internal server error", error: error.message },
      { status: 500 }
    );
  }
};
