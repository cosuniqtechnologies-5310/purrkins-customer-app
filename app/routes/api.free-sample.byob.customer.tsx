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
    console.log("[BYOB] Received payload:", JSON.stringify(body));

    const { name, phone, email, tag, quiz_data, accepts_marketing } = body;

    if (!phone && !email) {
      return Response.json({ success: false, message: "Phone or email is required" }, { status: 400 });
    }

    const customerTag = tag || "byob-lead";
    const nameParts = name ? name.trim().split(" ") : ["Customer"];
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : ".";

    const emailMarketingConsent = accepts_marketing ? {
      marketingState: "SUBSCRIBED",
      marketingOptInLevel: "CONFIRMED_OPT_IN",
      consentUpdatedAt: new Date().toISOString(),
    } : undefined;

    let customerId: string | undefined;
    
    // Prepare metafields array
    const metafieldsToSet = Object.entries(quiz_data || {}).map(([key, value]) => ({
      namespace: "custom",
      key: `custom_quiz_${key}`,
      value: String(value).substring(0, 5000), // Protect against too long strings
      type: "single_line_text_field"
    }));

    // Try to find the customer first
    const searchParams = phone ? `phone:${phone}` : `email:${email}`;
    const searchResponse = await admin.graphql(
      `#graphql
      query findCustomer($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              tags
              emailMarketingConsent {
                marketingState
              }
            }
          }
        }
      }`,
      { variables: { query: searchParams } }
    );

    const searchData = await searchResponse.json();
    const existingCustomer = searchData.data?.customers?.edges?.[0]?.node;

    if (existingCustomer) {
      const existingTags: string[] = existingCustomer.tags || [];
      const updatedTags = existingTags.includes(customerTag)
        ? existingTags
        : [...existingTags, customerTag];

      const updateResponse = await admin.graphql(
        `#graphql
        mutation customerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id tags }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              id: existingCustomer.id,
              tags: updatedTags
            },
          },
        }
      );
      const updateData = await updateResponse.json();
      console.log("[BYOB] Update customer result:", JSON.stringify(updateData));
      
      try {
        fs.appendFileSync(
          path.join(process.cwd(), "byob-debug.log"),
          new Date().toISOString() + " UPDATE: " + JSON.stringify(updateData) + "\n"
        );
      } catch(e) {}
      
      customerId = existingCustomer.id;

    } else {
      const createResponse = await admin.graphql(
        `#graphql
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              firstName,
              lastName,
              ...(phone && { phone }),
              ...(email && { email }),
              tags: [customerTag],
              ...(emailMarketingConsent && { emailMarketingConsent }),
            },
          },
        }
      );

      const createData = await createResponse.json();
      console.log("[BYOB] Create result:", JSON.stringify(createData));

      try {
        fs.appendFileSync(
          path.join(process.cwd(), "byob-debug.log"),
          new Date().toISOString() + " CREATE: " + JSON.stringify(createData) + "\n"
        );
      } catch(e) {}

      customerId = createData.data?.customerCreate?.customer?.id;
    }

    if (customerId && metafieldsToSet.length > 0) {
      const setMetafields = metafieldsToSet.map(mf => ({
        ownerId: customerId,
        namespace: mf.namespace,
        key: mf.key,
        type: mf.type,
        value: mf.value
      }));

      const mfResponse = await admin.graphql(
        `#graphql
        mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { key value }
            userErrors { field message }
          }
        }`,
        {
          variables: { metafields: setMetafields },
        }
      );
      const mfData = await mfResponse.json();
      console.log("[BYOB] Metafields Set Result:", JSON.stringify(mfData));
      
      try {
        fs.appendFileSync(
          path.join(process.cwd(), "byob-debug.log"),
          new Date().toISOString() + " METAFIELDS: " + JSON.stringify(mfData) + "\n"
        );
      } catch(e) {}
    }

    if (customerId && accepts_marketing && emailMarketingConsent) {
      await admin.graphql(
        `#graphql
        mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) {
            customer { id }
          }
        }`,
        {
          variables: {
            input: { customerId, emailMarketingConsent },
          },
        }
      );
    }

    return Response.json({ success: true, message: "Customer tagged and quiz saved for BYOB" });

  } catch (error: any) {
    if (error instanceof Response) return error;
    console.error("[BYOB] API Error:", error);
    return Response.json({ success: false, message: String(error) }, { status: 200 });
  }
};
