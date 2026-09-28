import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ success: false, message: "Method not allowed" }, { status: 405 });
  }

  try {
    const { admin } = await authenticate.public.appProxy(request);
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

    // 2. HANDLE IMAGE UPLOAD
    const file = formData.get("profile_image") as File;
    if (file && file.size > 0 && file.name) {
      try {
        const stagedResponse = await admin.graphql(
          `#graphql
          mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
              stagedTargets {
                url
                resourceUrl
                parameters { name value }
              }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              input: [{
                filename: file.name,
                mimeType: file.type || "image/jpeg",
                resource: "IMAGE",
                httpMethod: "POST"
              }]
            }
          }
        );
        const stagedData = await stagedResponse.json();
        const stagedErrors = stagedData.data?.stagedUploadsCreate?.userErrors;
        if (stagedErrors && stagedErrors.length > 0) {
           return Response.json({ success: false, message: "Staged upload failed", errors: stagedErrors }, { status: 400 });
        }
        
        const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];

        if (target) {
          const uploadForm = new FormData();
          for (const param of target.parameters) {
            uploadForm.append(param.name, param.value);
          }
          uploadForm.append("file", file);

          const uploadRes = await fetch(target.url, {
            method: "POST",
            body: uploadForm as any
          });

          if (!uploadRes.ok) {
             const upText = await uploadRes.text();
             return Response.json({ success: false, message: "Upload to bucket failed", text: upText, url: target.url }, { status: 400 });
          }

          if (uploadRes.ok) {
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
                    originalSource: target.resourceUrl
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
              // Note: Shopify's file processing takes a few seconds, but we can assign the ID immediately.
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
            }
          }
        }
      } catch (err: any) {
        console.error("Image upload error:", err);
        return Response.json({ success: false, message: "Fatal Image Upload Error", error: err.message || String(err) }, { status: 500 });
      }
    }

    // Redirect back to the kitten page
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/apps/purrkins/kitten",
      },
    });

  } catch (error: any) {
    console.error("[Update Pet] API Error:", error.message || error);
    if (error.response) {
       console.error("GraphQL Errors:", await error.response.text().catch(()=>""));
    }
    return Response.json({ success: false, message: String(error.message || error) }, { status: 500 });
  }
};
