import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ success: false, message: "Method not allowed" }, { status: 405 });
  }

  try {
    const authResult = await authenticate.public.appProxy(request);
    let admin = authResult.admin;

    if (!admin) {
      const url = new URL(request.url);
      const shop = url.searchParams.get("shop");
      if (shop) {
        try {
          const { admin: unauthAdmin } = await unauthenticated.admin(shop);
          admin = unauthAdmin;
        } catch (e) {
          console.error("Failed to get unauthenticated admin:", e);
        }
      }
    }

    if (!admin) {
      return Response.json({ success: false, message: "Unauthorized access" }, { status: 401 });
    }

    // In React Router v7, we can just use the standard Web API
    const formData = await request.formData();

    let petId = formData.get("pet_id") as string;
    if (!petId) {
      return Response.json({ success: false, message: "Pet ID is required" }, { status: 400 });
    }
    if (!petId.includes("gid://shopify/Metaobject/")) {
      petId = `gid://shopify/Metaobject/${petId.split("/").pop()}`;
    }

    // Extract basic fields
    const fieldsToSet: any[] = [];
    const textFields = ["name", "age", "weight", "gender", "neutered", "body", "activity", "focus", "allergies"];
    
    for (const key of textFields) {
      const val = formData.get(key);
      if (val !== null && val !== undefined) {
        fieldsToSet.push({
          key: key,
          value: String(val).substring(0, 5000)
        });
      }
    }

    // 1. UPDATE TEXT FIELDS FIRST
    if (fieldsToSet.length > 0) {
      const moResponse = await admin.graphql(
        `#graphql
        mutation UpdateMetaobject($id: ID!, $metaobject: MetaobjectUpdateInput!) {
          metaobjectUpdate(id: $id, metaobject: $metaobject) {
            metaobject { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            id: petId,
            metaobject: { fields: fieldsToSet }
          }
        }
      );
      const moData = await moResponse.json();
      const moErrors = moData.data?.metaobjectUpdate?.userErrors;
      if (moErrors && moErrors.length > 0) {
        return Response.json({ success: false, message: "Failed to update text fields: " + JSON.stringify(moErrors) }, { status: 400 });
      }
    }

    // 2. HANDLE IMAGE UPLOAD (From direct cloud URL)
    const profileImageUrl = formData.get("profile_image_url") as string;
    
    if (profileImageUrl && profileImageUrl.trim() !== "") {
      try {
        const fileCreateRes = await admin.graphql(
          `#graphql
          mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
              files { id }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              files: [{
                alt: "Profile Image",
                contentType: "IMAGE",
                originalSource: profileImageUrl
              }]
            }
          }
        );
        const fileCreateData = await fileCreateRes.json();
        const fcErrors = fileCreateData.data?.fileCreate?.userErrors;
        if (fcErrors && fcErrors.length > 0) {
           return Response.json({ success: false, message: "File Create failed", errors: fcErrors }, { status: 400 });
        }
        
        const newFileId = fileCreateData.data?.fileCreate?.files?.[0]?.id;

        if (newFileId) {
          const moUpdateRes = await admin.graphql(
            `#graphql
            mutation UpdateMetaobject($id: ID!, $metaobject: MetaobjectUpdateInput!) {
              metaobjectUpdate(id: $id, metaobject: $metaobject) {
                metaobject { id }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                id: petId,
                metaobject: { fields: [{ key: "profile", value: newFileId }] }
              }
            }
          );
          const moUpdateData = await moUpdateRes.json();
          const moUpErrors = moUpdateData.data?.metaobjectUpdate?.userErrors;
          if (moUpErrors && moUpErrors.length > 0) {
             return Response.json({ success: false, message: "Metaobject Image Update failed", errors: moUpErrors }, { status: 400 });
          }
          
          return Response.json({ success: true, message: "Image updated successfully! New File ID: " + newFileId + ". Please go back and hard refresh to clear Shopify's cache." });
        }
      } catch (err: any) {
        console.error("Image upload error:", err);
        return Response.json({ success: false, message: "Fatal Image Upload Error", error: err.message || String(err) }, { status: 500 });
      }
    }

    return Response.json({ success: true, message: "Profile updated successfully!" });

  } catch (error: any) {
    console.error("[Update Pet] API Error:", error.message || error);
    let details = "";
    if (error.response && error.response.errors) {
       details = JSON.stringify(error.response.errors);
    } else if (error.response) {
       details = JSON.stringify(error.response);
    }
    // Return 200 so App Proxy doesn't block the JSON message!
    return Response.json({ success: false, message: String(error.message || error), details }, { status: 200 });
  }
};
