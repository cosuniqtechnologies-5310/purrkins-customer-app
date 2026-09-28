import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import fs from "fs";
import path from "path";

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
    const { admin } = await authenticate.public.appProxy(request);

    if (!admin) {
      return Response.json({ success: false, message: "Unauthorized access" }, { status: 401 });
    }

    const body = await request.json();
    const { customerId: rawCustomerId, quiz_data } = body;

    if (!rawCustomerId) {
      return Response.json({ success: false, message: "Customer ID is required" }, { status: 400 });
    }

    let customerId = rawCustomerId;
    if (!customerId.includes("gid://shopify/Customer/")) {
      customerId = `gid://shopify/Customer/${customerId}`;
    }

    // 1. Fetch existing pets list from the customer
    const searchResponse = await admin.graphql(
      `#graphql
      query getCustomer($id: ID!) {
        customer(id: $id) {
          petsMetafield: metafield(namespace: "custom", key: "pets") {
            value
          }
        }
      }`,
      { variables: { id: customerId } }
    );
    const searchData = await searchResponse.json();
    const existingCustomer = searchData.data?.customer;

    if (!existingCustomer) {
      return Response.json({ success: false, message: "Customer not found" }, { status: 404 });
    }

    // 2. Prepare metaobject fields
    const fieldsToSet = Object.entries(quiz_data || {}).map(([key, value]) => ({
      key: key,
      value: String(value).substring(0, 5000)
    }));

    if (fieldsToSet.length > 0) {
      // 3. Create Pet Profile Metaobject
      const moResponse = await admin.graphql(
        `#graphql
        mutation CreateMetaobject($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            metaobject: {
              type: "pet_profile",
              capabilities: {
                publishable: {
                  status: "ACTIVE"
                }
              },
              fields: fieldsToSet
            }
          }
        }
      );
      const moData = await moResponse.json();
      
      const moErrors = moData.data?.metaobjectCreate?.userErrors;
      if (moErrors && moErrors.length > 0) {
        // Debug: fetch available types
        const defResponse = await admin.graphql(`
          query {
            metaobjectDefinitions(first: 20) {
              edges { node { type name } }
            }
          }
        `);
        const defData = await defResponse.json();
        const availableTypes = defData.data?.metaobjectDefinitions?.edges.map((e: any) => e.node.type).join(", ");
        
        return Response.json({ success: false, message: "Failed to create. Available types in your store: [" + availableTypes + "]. Error: " + JSON.stringify(moErrors) }, { status: 400 });
      }

      const metaobjectId = moData.data?.metaobjectCreate?.metaobject?.id;

      // 4. Append to customer's custom.pets
      if (metaobjectId) {
        let existingPetsList: string[] = [];
        if (existingCustomer.petsMetafield?.value) {
          try {
            existingPetsList = JSON.parse(existingCustomer.petsMetafield.value);
            if (!Array.isArray(existingPetsList)) existingPetsList = [];
          } catch(e) {
            existingPetsList = [];
          }
        }
        
        existingPetsList.push(metaobjectId);

        const mfResponse = await admin.graphql(
          `#graphql
          mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { key value }
              userErrors { field message }
            }
          }`,
          {
            variables: { 
              metafields: [{
                ownerId: customerId,
                namespace: "custom",
                key: "pets",
                type: "list.metaobject_reference",
                value: JSON.stringify(existingPetsList)
              }] 
            },
          }
        );
        const mfData = await mfResponse.json();
        const mfErrors = mfData.data?.metafieldsSet?.userErrors;
        if (mfErrors && mfErrors.length > 0) {
          return Response.json({ success: false, message: "Failed to link pet to customer: " + JSON.stringify(mfErrors) }, { status: 400 });
        }
      }
    }

    return Response.json({ success: true, message: "Quiz saved successfully" });
  } catch (error: any) {
    console.error("[BYOB] API Error:", error);
    return Response.json({ success: false, message: String(error) }, { status: 500 });
  }
};

