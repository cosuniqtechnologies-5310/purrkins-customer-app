import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";

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
    console.log("[UnlockBenefit] Received payload:", JSON.stringify(body));

    const { name, phone, email, tag, accepts_marketing } = body;

    if (!phone) {
      return Response.json({ success: false, message: "Phone number is required" }, { status: 400 });
    }
    if (!email || !email.includes("@")) {
      return Response.json({ success: false, message: "A valid email is required" }, { status: 400 });
    }

    const customerTag = tag || "unlock-benefit";
    const nameParts = name ? name.trim().split(" ") : ["Customer"];
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : ".";

    console.log(`[UnlockBenefit] Processing: name=${name}, phone=${phone}, email=${email}`);

    // CONFIRMED_OPT_IN bypasses double opt-in → immediately green "Subscribed"
    const emailMarketingConsent = {
      marketingState: "SUBSCRIBED",
      marketingOptInLevel: "CONFIRMED_OPT_IN",
      consentUpdatedAt: new Date().toISOString(),
    };

    // Search existing customer by phone
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
    console.log("[UnlockBenefit] Search result:", JSON.stringify(searchData?.data?.customers?.edges));
    const existingCustomer = searchData.data?.customers?.edges?.[0]?.node;

    let customerId: string;

    if (existingCustomer) {
      console.log("[UnlockBenefit] Existing customer found:", existingCustomer.id);

      const existingTags: string[] = existingCustomer.tags || [];
      const updatedTags = existingTags.includes(customerTag)
        ? existingTags
        : [...existingTags, customerTag];

      // Upgrade noemail → real email if customer had a placeholder
      const resolvedEmail = existingCustomer.email?.includes("noemail")
        ? email
        : existingCustomer.email;

      const updateResponse = await admin.graphql(
        `#graphql
        mutation customerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id phone email }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              id: existingCustomer.id,
              phone,
              email: resolvedEmail,
              firstName,
              lastName,
              tags: updatedTags,
            },
          },
        }
      );

      const updateData = await updateResponse.json();
      console.log("[UnlockBenefit] Update result:", JSON.stringify(updateData?.data?.customerUpdate));

      if (updateData.data?.customerUpdate?.userErrors?.length > 0) {
        throw new Error(updateData.data.customerUpdate.userErrors[0].message);
      }

      customerId = existingCustomer.id;

    } else {
      console.log("[UnlockBenefit] No existing customer — creating new");

      const createResponse = await admin.graphql(
        `#graphql
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer {
              id phone email
              emailMarketingConsent { marketingState }
            }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              firstName,
              lastName,
              phone,
              email,
              tags: [customerTag],
              emailMarketingConsent,
            },
          },
        }
      );

      const createData = await createResponse.json();
      console.log("[UnlockBenefit] Create result:", JSON.stringify(createData?.data?.customerCreate));

      if (createData.data?.customerCreate?.userErrors?.length > 0) {
        throw new Error(createData.data.customerCreate.userErrors[0].message);
      }

      customerId = createData.data?.customerCreate?.customer?.id;
    }

    // Always force subscription to Subscribed (green badge)
    if (customerId && accepts_marketing) {
      const consentResponse = await admin.graphql(
        `#graphql
        mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) {
            customer {
              id
              emailMarketingConsent { marketingState marketingOptInLevel }
            }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: { customerId, emailMarketingConsent },
          },
        }
      );

      const consentData = await consentResponse.json();
      console.log("[UnlockBenefit] Consent result:", JSON.stringify(consentData?.data?.customerEmailMarketingConsentUpdate));
    }

    return Response.json({ success: true, message: "Unlock benefit registered successfully." });

  } catch (error: any) {
    if (error instanceof Response) return error;
    console.error("[UnlockBenefit] API Error:", error);
    return Response.json({ success: false, message: String(error) }, { status: 200 });
  }
};
