import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import jwt from "jsonwebtoken";

// Helper: get shop session
async function getShopSession() {
  return prisma.session.findFirst({
    where: { shop: "purrkins-mhrlfymw.myshopify.com", isOnline: false }
  });
}

// Helper: verify JWT and get customerId
function verifyToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.SHOPIFY_API_SECRET || "s3cr3t") as any;
    return decoded.customerId;
  } catch { return null; }
}

// Helper: call Shopify Admin REST
async function shopifyRest(accessToken: string, path: string, method: string, body?: object) {
  const res = await fetch(`https://purrkins-mhrlfymw.myshopify.com/admin/api/2026-07${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: body ? JSON.stringify(body) : undefined
  });
  if (method === "DELETE") return {};
  return res.json();
}

// Helper: call Shopify Admin GraphQL
async function shopifyGql(accessToken: string, query: string, variables?: object) {
  const res = await fetch("https://purrkins-mhrlfymw.myshopify.com/admin/api/2026-07/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

export const loader = async () => {
  return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const intent = url.searchParams.get("intent");
  const token = url.searchParams.get("session");
  
  const customerId = verifyToken(token);
  if (!customerId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }

  const shopSession = await getShopSession();
  if (!shopSession?.accessToken) {
    return new Response(JSON.stringify({ success: false, error: "Shop session not found" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
  const accessToken = shopSession.accessToken;
  const numericId = customerId.split("/").pop();

  // UPDATE PROFILE
  if (intent === "update_profile") {
    const body = await request.json();
    const data = await shopifyRest(accessToken, `/customers/${numericId}.json`, "PUT", {
      customer: {
        id: numericId,
        first_name: body.firstName || "",
        last_name: body.lastName || "",
        phone: body.phone || ""
      }
    });
    return new Response(JSON.stringify({ success: true, customer: data.customer }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // ADD ADDRESS
  if (intent === "add_address") {
    const body = await request.json();
    const data = await shopifyRest(accessToken, `/customers/${numericId}/addresses.json`, "POST", {
      address: {
        first_name: body.firstName || "",
        last_name: body.lastName || "",
        address1: body.address1 || "",
        address2: body.address2 || "",
        city: body.city || "",
        province: body.province || "",
        zip: body.zip || "",
        country: body.country || "India",
        phone: body.phone || ""
      }
    });
    if (data.customer_address) {
      return new Response(JSON.stringify({ success: true, address: data.customer_address }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ success: false, error: JSON.stringify(data.errors || data) }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // DELETE ADDRESS
  if (intent === "delete_address") {
    const body = await request.json();
    const addressId = body.addressId?.split("/").pop();
    await shopifyRest(accessToken, `/customers/${numericId}/addresses/${addressId}.json`, "DELETE");
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  // SET DEFAULT ADDRESS
  if (intent === "set_default_address") {
    const body = await request.json();
    const addressId = body.addressId?.split("/").pop();
    await shopifyRest(accessToken, `/customers/${numericId}/addresses/${addressId}/default.json`, "PUT");
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  // UPDATE WISHLIST (add/remove product)
  if (intent === "update_wishlist") {
    const body = await request.json();
    const { productIds } = body;
    const data = await shopifyGql(accessToken, `
      mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value }
          userErrors { field message }
        }
      }
    `, {
      metafields: [{
        ownerId: customerId,
        namespace: "custom",
        key: "wishlist",
        type: "list.product_reference",
        value: JSON.stringify(productIds)
      }]
    });
    return new Response(JSON.stringify({ success: true, data: data?.data?.metafieldsSet }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ error: "Unknown intent" }), {
    status: 400, headers: { "Content-Type": "application/json" }
  });
};
