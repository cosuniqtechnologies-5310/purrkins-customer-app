import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";

export const loader = async () => {
  return Response.json(
    { success: false, message: "This endpoint only accepts POST requests. Please submit the form." },
    { status: 405 }
  );
};

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

    const body = await request.json();
    console.log("[FreeSample] Received payload:", JSON.stringify(body));

    const { name, phone, tag, email, accepts_marketing, note } = body;

    if (!phone) {
      return Response.json({ success: false, message: "Phone number is required" }, { status: 400 });
    }

    const customerTag = tag || "free-sample-claim";
    const nameParts = name ? name.trim().split(" ") : ["Customer"];
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : ".";

    // Always generate a safe email (required for email marketing subscription)
    const safeEmail =
      email && email.trim() !== "" && !email.includes("noemail")
        ? email.trim()
        : `lead-${Date.now()}@noemail.purrkins.com`;

    console.log(`[FreeSample] Processing: name=${name}, phone=${phone}, email=${safeEmail}, accepts_marketing=${accepts_marketing}`);

    // Marketing consent — CONFIRMED_OPT_IN bypasses double opt-in requirement
    const emailMarketingConsent = {
      marketingState: "SUBSCRIBED",
      marketingOptInLevel: "CONFIRMED_OPT_IN",
      consentUpdatedAt: new Date().toISOString(),
    };

    // Search by phone to find existing customer
    const searchResponse = await admin.graphql(
      `#graphql
      query findCustomerByPhone($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              phone
              email
              tags
              emailMarketingConsent {
                marketingState
              }
            }
          }
        }
      }`,
      { variables: { query: `phone:${phone}` } }
    );

    const searchData = await searchResponse.json();
    console.log("[FreeSample] Search result:", JSON.stringify(searchData?.data?.customers?.edges));
    const existingCustomer = searchData.data?.customers?.edges?.[0]?.node;

    let customerId: string;

    if (existingCustomer) {
      console.log("[FreeSample] Existing customer found:", existingCustomer.id);
      const existingTags: string[] = existingCustomer.tags || [];
      const updatedTags = existingTags.includes(customerTag)
        ? existingTags
        : [...existingTags, customerTag];

      // Update existing customer — include phone to ensure it's set
      const updateResponse = await admin.graphql(
        `#graphql
        mutation customerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer {
              id
              phone
              email
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              id: existingCustomer.id,
              phone,
              email: existingCustomer.email || safeEmail,
              firstName,
              lastName,
              tags: updatedTags,
              ...(note ? { note } : {}),
            },
          },
        }
      );

      const updateData = await updateResponse.json();
      console.log("[FreeSample] Customer update result:", JSON.stringify(updateData?.data?.customerUpdate));

      if (updateData.data?.customerUpdate?.userErrors?.length > 0) {
        throw new Error(updateData.data.customerUpdate.userErrors[0].message);
      }

      customerId = existingCustomer.id;

    } else {
      console.log("[FreeSample] No existing customer — creating new one");

      const createInput: any = {
        firstName,
        lastName,
        phone,
        email: safeEmail,
        tags: [customerTag],
        emailMarketingConsent,
        ...(note ? { note } : {}),
      };

      const createResponse = await admin.graphql(
        `#graphql
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer {
              id
              phone
              email
              emailMarketingConsent {
                marketingState
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
        { variables: { input: createInput } }
      );

      const createData = await createResponse.json();
      console.log("[FreeSample] Customer create result:", JSON.stringify(createData?.data?.customerCreate));

      if (createData.data?.customerCreate?.userErrors?.length > 0) {
        throw new Error(createData.data.customerCreate.userErrors[0].message);
      }

      customerId = createData.data?.customerCreate?.customer?.id;
    }

    // Always run email marketing consent update to ensure Subscribed status
    if (customerId && accepts_marketing) {
      const consentResponse = await admin.graphql(
        `#graphql
        mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) {
            customer {
              id
              emailMarketingConsent {
                marketingState
                marketingOptInLevel
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              customerId,
              emailMarketingConsent,
            },
          },
        }
      );

      const consentData = await consentResponse.json();
      console.log("[FreeSample] Email consent update result:", JSON.stringify(consentData?.data?.customerEmailMarketingConsentUpdate));
    }

    return Response.json({ success: true, message: "Free sample registered successfully." });

  } catch (error: any) {
    if (error instanceof Response) return error;

    console.error("[FreeSample] API Error:", error);
    return Response.json(
      { success: false, message: String(error) + " | Stack: " + (error.stack || "") },
      { status: 200 }
    );
  }
};
