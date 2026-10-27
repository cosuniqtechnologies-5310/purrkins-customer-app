import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import jwt from "jsonwebtoken";
import { appCache } from "../cache.server";

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

// Helper: extract numeric id from a Shopify gid (strips any "?model_name=..." suffix)
function parseGid(id?: string | null): string {
  if (!id) return "";
  return String(id).split("?")[0].split("/").pop() || "";
}

// Helper: turn a Shopify REST `errors` payload into a readable message
function formatErrors(errors: any): string {
  if (!errors) return "Unknown error";
  if (typeof errors === "string") return errors;
  return Object.entries(errors)
    .map(([key, val]) => `${key} ${Array.isArray(val) ? val.join(", ") : val}`)
    .join("; ");
}

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" }
  });
}

// Helper: Upload a file to Shopify Files and retrieve the public CDN URL and file ID
async function uploadFileToShopify(accessToken: string, file: File, filename: string, alt: string) {
  const mime = file.type || "image/jpeg";
  const stagedRes = await shopifyGql(accessToken, `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `, {
    input: [{
      filename: filename || "upload.jpg",
      mimeType: mime,
      resource: "IMAGE",
      httpMethod: "POST"
    }]
  });

  const target = stagedRes.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    throw new Error("Failed to create staged upload target in Shopify");
  }

  const uploadForm = new FormData();
  target.parameters.forEach((p: any) => uploadForm.append(p.name, p.value));
  uploadForm.append("file", file);
  const uploadRes = await fetch(target.url, { method: "POST", body: uploadForm });
  if (!uploadRes.ok) {
    throw new Error("Failed to upload image file to Shopify staging bucket");
  }

  // Create permanent file in Shopify Files
  const fileCreateRes = await shopifyGql(accessToken, `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          alt
          ... on MediaImage {
            image {
              url
            }
          }
        }
        userErrors { field message }
      }
    }
  `, {
    files: [{
      alt: alt || "Uploaded Image",
      contentType: "IMAGE",
      originalSource: target.resourceUrl
    }]
  });

  const newFile = fileCreateRes.data?.fileCreate?.files?.[0];
  const newFileId = newFile?.id;
  let cdnUrl = newFile?.image?.url || "";

  // Poll for MediaImage URL if not immediately ready
  if (!cdnUrl && newFileId) {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 600));
      const nodeRes = await shopifyGql(accessToken, `
        query getMediaUrl($id: ID!) {
          node(id: $id) {
            ... on MediaImage {
              image { url }
            }
          }
        }
      `, { id: newFileId });
      const u = nodeRes.data?.node?.image?.url;
      if (u) {
        cdnUrl = u;
        break;
      }
    }
  }

  return { fileId: newFileId, cdnUrl: cdnUrl || target.resourceUrl };
}

async function handleRequest(request: Request) {
  const url = new URL(request.url);
  const intent = url.searchParams.get("intent");
  
  const cookieHeader = request.headers.get("Cookie");
  const cookieMatch = cookieHeader ? cookieHeader.match(/pk_session=([^;]+)/) : null;
  const cookieToken = cookieMatch ? cookieMatch[1] : null;
  const token = url.searchParams.get("session") || cookieToken;
  
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

  // GET PROFILE
  if (intent === "get_profile") {
    const custRes = await shopifyRest(accessToken, `/customers/${numericId}.json`, "GET");
    if (custRes?.customer) {
      const c = custRes.customer;
      return json({
        success: true,
        customer: {
          id: customerId,
          email: c.email,
          firstName: c.first_name || "",
          lastName: c.last_name || "",
          name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim(),
          phone: c.phone || ""
        }
      });
    }
    return json({ success: false, error: "Customer not found" }, 404);
  }

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

  // UPDATE BILLING (username + phone on the customer, and the default billing address)
  if (intent === "update_billing") {
    const body = await request.json();
    const username = String(body.username || "").trim();
    const phone = String(body.phone || "").trim();
    if (!username) return json({ success: false, error: "Username is required." }, 400);

    // 1. Customer: username (first name) + phone
    const customerRes = await shopifyRest(accessToken, `/customers/${numericId}.json`, "PUT", {
      customer: { id: numericId, first_name: username, phone: phone || null }
    });
    if (!customerRes.customer) {
      return json({ success: false, error: formatErrors(customerRes.errors) }, 422);
    }

    // 2. Default billing address
    const addressFields = {
      first_name: String(body.firstName || "").trim(),
      last_name: String(body.lastName || "").trim(),
      address1: String(body.address1 || "").trim(),
      address2: String(body.address2 || "").trim(),
      city: String(body.city || "").trim(),
      province: String(body.province || "").trim(),
      zip: String(body.zip || "").trim(),
      country: String(body.country || "").trim() || "India",
      phone
    };
    const hasAddress = !!(addressFields.first_name || addressFields.address1 || addressFields.city || addressFields.zip);
    const defaultId = customerRes.customer.default_address?.id;

    if (hasAddress) {
      if (defaultId) {
        const addrRes = await shopifyRest(accessToken, `/customers/${numericId}/addresses/${defaultId}.json`, "PUT", {
          address: addressFields
        });
        if (!addrRes.customer_address) {
          return json({ success: false, error: formatErrors(addrRes.errors) }, 422);
        }
      } else {
        const addrRes = await shopifyRest(accessToken, `/customers/${numericId}/addresses.json`, "POST", {
          address: addressFields
        });
        if (!addrRes.customer_address) {
          return json({ success: false, error: formatErrors(addrRes.errors) }, 422);
        }
        await shopifyRest(accessToken, `/customers/${numericId}/addresses/${addrRes.customer_address.id}/default.json`, "PUT");
      }
    }

    // 3. Customer Avatar Metafield
    const avatar = String(body.avatar || "").trim();
    if (avatar) {
      try {
        await shopifyGql(accessToken, `
          mutation setCustomerAvatar($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id value }
              userErrors { field message }
            }
          }
        `, {
          metafields: [{
            ownerId: `gid://shopify/Customer/${numericId}`,
            namespace: "custom",
            key: "avatar",
            type: "single_line_text_field",
            value: avatar
          }]
        });
      } catch (err) {
        console.warn("Could not save customer avatar metafield:", err);
      }
    }

    appCache.delPrefix("customer:");
    return json({ success: true });
  }

  // UPLOAD AVATAR (Customer Profile Image)
  if (intent === "upload_avatar") {
    try {
      const formData = await request.formData();
      const file = formData.get("avatar") as File | null;
      const filename = (formData.get("filename") as string) || file?.name || "profile.jpg";

      if (!file) {
        return json({ success: false, error: "No file provided" }, 400);
      }

      const { fileId, cdnUrl } = await uploadFileToShopify(accessToken, file, filename, "Customer Profile Photo");

      // Save CDN URL into customer metafield custom.avatar
      await shopifyGql(accessToken, `
        mutation setCustomerAvatar($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id value }
            userErrors { field message }
          }
        }
      `, {
        metafields: [{
          ownerId: `gid://shopify/Customer/${numericId}`,
          namespace: "custom",
          key: "avatar",
          type: "single_line_text_field",
          value: cdnUrl
        }]
      });

      appCache.delPrefix("customer:");
      return json({ success: true, avatarUrl: cdnUrl, fileId });
    } catch (err: any) {
      console.error("Error in upload_avatar:", err);
      return json({ success: false, error: err.message || "Failed to upload avatar" }, 500);
    }
  }

  // UPLOAD PET AVATAR (Kitten Profile Image)
  if (intent === "upload_pet_avatar") {
    try {
      const formData = await request.formData();
      const file = formData.get("avatar") as File | null;
      let petId = (formData.get("pet_id") as string) || "";
      const filename = (formData.get("filename") as string) || file?.name || "kitten.jpg";

      if (!file) {
        return json({ success: false, error: "No file provided" }, 400);
      }
      if (!petId) {
        return json({ success: false, error: "Pet ID is required" }, 400);
      }
      if (!petId.includes("gid://shopify/Metaobject/")) {
        petId = `gid://shopify/Metaobject/${petId.split("/").pop()}`;
      }

      const { fileId, cdnUrl } = await uploadFileToShopify(accessToken, file, filename, "Pet Profile Photo");

      if (fileId) {
        // Link file reference to the pet_profile metaobject's "profile" field
        const moUpdateRes = await shopifyGql(accessToken, `
          mutation UpdatePetImage($id: ID!, $metaobject: MetaobjectUpdateInput!) {
            metaobjectUpdate(id: $id, metaobject: $metaobject) {
              metaobject { id }
              userErrors { field message }
            }
          }
        `, {
          id: petId,
          metaobject: {
            fields: [{ key: "profile", value: fileId }]
          }
        });

        const moErrors = moUpdateRes.data?.metaobjectUpdate?.userErrors;
        if (moErrors && moErrors.length > 0) {
          throw new Error("Failed to update pet profile image: " + JSON.stringify(moErrors));
        }
      }

      appCache.delPrefix("customer:");
      return json({ success: true, avatarUrl: cdnUrl, fileId });
    } catch (err: any) {
      console.error("Error in upload_pet_avatar:", err);
      return json({ success: false, error: err.message || "Failed to upload kitten photo" }, 500);
    }
  }

  // UPDATE PET PROFILE (Details)
  if (intent === "update_pet") {
    try {
      const body = await request.json();
      let petId = body.pet_id;
      if (!petId) {
        return json({ success: false, error: "Pet ID is required" }, 400);
      }
      if (!petId.includes("gid://shopify/Metaobject/")) {
        petId = `gid://shopify/Metaobject/${petId.split("/").pop()}`;
      }

      const fieldsToSet: any[] = [];
      const allowedKeys = ["name", "age", "weight", "gender", "neutered", "body", "activity", "focus", "allergies"];
      for (const k of allowedKeys) {
        if (body[k] !== undefined && body[k] !== null) {
          fieldsToSet.push({
            key: k,
            value: String(body[k]).trim()
          });
        }
      }

      if (body.profileFileId) {
        fieldsToSet.push({
          key: "profile",
          value: body.profileFileId
        });
      }

      if (fieldsToSet.length > 0) {
        const moRes = await shopifyGql(accessToken, `
          mutation UpdatePetDetails($id: ID!, $metaobject: MetaobjectUpdateInput!) {
            metaobjectUpdate(id: $id, metaobject: $metaobject) {
              metaobject { id }
              userErrors { field message }
            }
          }
        `, {
          id: petId,
          metaobject: { fields: fieldsToSet }
        });

        const errs = moRes.data?.metaobjectUpdate?.userErrors;
        if (errs && errs.length > 0) {
          return json({ success: false, error: formatErrors(errs) }, 400);
        }
      }

      appCache.delPrefix("customer:");
      return json({ success: true, message: "Pet profile updated successfully" });
    } catch (err: any) {
      console.error("Error in update_pet:", err);
      return json({ success: false, error: err.message || "Failed to update pet" }, 500);
    }
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
      appCache.delPrefix("customer:");
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
    const addressId = parseGid(body.addressId);
    await shopifyRest(accessToken, `/customers/${numericId}/addresses/${addressId}.json`, "DELETE");
    appCache.delPrefix("customer:");
    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
  }

  // SET DEFAULT ADDRESS
  if (intent === "set_default_address") {
    const body = await request.json();
    const addressId = parseGid(body.addressId);
    await shopifyRest(accessToken, `/customers/${numericId}/addresses/${addressId}/default.json`, "PUT");
    appCache.delPrefix("customer:");
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
    appCache.delPrefix("customer:");
    return new Response(JSON.stringify({ success: true, data: data?.data?.metafieldsSet }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ error: "Unknown intent" }), {
    status: 400, headers: { "Content-Type": "application/json" }
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return handleRequest(request);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return handleRequest(request);
};
