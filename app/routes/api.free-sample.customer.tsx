import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async () => {
  return Response.json(
    { success: false, message: "This endpoint only accepts POST requests from the frontend form. Please submit the form." },
    { status: 405 }
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // Only allow POST requests
  if (request.method !== "POST") {
    return Response.json({ success: false, message: "Method not allowed" }, { status: 405 });
  }

  try {
    // 1. Authenticate the App Proxy request
    const { admin } = await authenticate.public.appProxy(request);

    if (!admin) {
      return Response.json({ success: false, message: "Unauthorized access" }, { status: 401 });
    }

    // 2. Parse the incoming JSON payload from the frontend
    const body = await request.json();
    const { name, phone, tag, email, accepts_marketing } = body;

    if (!phone) {
      return Response.json({ success: false, message: "Phone number is required" }, { status: 400 });
    }

    const customerTag = tag || "free-sample-claim";

    // Split name into first and last name
    const nameParts = name ? name.trim().split(" ") : ["Customer"];
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : ".";

    // Email is REQUIRED to set email marketing subscription in Shopify
    const safeEmail =
      email && email.trim() !== ""
        ? email.trim()
        : `lead-${Date.now()}-${Math.floor(Math.random() * 1000)}@noemail.purrkins.com`;

    // Marketing consent object for Shopify GraphQL
    const emailMarketingConsent = {
      marketingState: "SUBSCRIBED",
      marketingOptInLevel: "CONFIRMED_OPT_IN",
      consentUpdatedAt: new Date().toISOString(),
    };

    // 3. Check if a customer with this phone number already exists
    const searchResponse = await admin.graphql(
      `#graphql
      query findCustomerByPhone($query: String!) {
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
      {
        variables: {
          query: `phone:${phone}`,
        },
      }
    );

    const searchData = await searchResponse.json();
    const existingCustomer = searchData.data?.customers?.edges?.[0]?.node;

    if (existingCustomer) {
      // 4a. Update existing customer — add tag + email
      const existingTags = existingCustomer.tags || [];
      const updatedTags = existingTags.includes(customerTag)
        ? existingTags
        : [...existingTags, customerTag];

      const updateResponse = await admin.graphql(
        `#graphql
        mutation customerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer {
              id
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
              tags: updatedTags,
              email: safeEmail,
            },
          },
        }
      );

      const updateData = await updateResponse.json();
      if (updateData.data?.customerUpdate?.userErrors?.length > 0) {
        throw new Error(updateData.data.customerUpdate.userErrors[0].message);
      }

      // 4a-ii. Update email marketing consent via dedicated mutation
      if (accepts_marketing) {
        const consentResponse = await admin.graphql(
          `#graphql
          mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
            customerEmailMarketingConsentUpdate(input: $input) {
              customer {
                id
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
          {
            variables: {
              input: {
                customerId: existingCustomer.id,
                emailMarketingConsent,
              },
            },
          }
        );

        const consentData = await consentResponse.json();
        console.log("Consent update result:", JSON.stringify(consentData?.data?.customerEmailMarketingConsentUpdate, null, 2));

        if (consentData.data?.customerEmailMarketingConsentUpdate?.userErrors?.length > 0) {
          console.error("Consent update error:", consentData.data.customerEmailMarketingConsentUpdate.userErrors);
        }
      }
    } else {
      // 4b. Create a new customer with emailMarketingConsent inline
      const createInput: any = {
        firstName,
        lastName,
        phone,
        email: safeEmail,
        tags: [customerTag],
      };

      if (accepts_marketing) {
        createInput.emailMarketingConsent = emailMarketingConsent;
      }

      const createResponse = await admin.graphql(
        `#graphql
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer {
              id
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
        {
          variables: {
            input: createInput,
          },
        }
      );

      const createData = await createResponse.json();
      console.log("Customer create result:", JSON.stringify(createData?.data?.customerCreate, null, 2));

      if (createData.data?.customerCreate?.userErrors?.length > 0) {
        throw new Error(createData.data.customerCreate.userErrors[0].message);
      }
    }

    // 5. Return success response to the frontend
    return Response.json({
      success: true,
      message: "Free sample registered successfully.",
    });
  } catch (error: any) {
    if (error instanceof Response) {
      return error;
    }

    console.error("Free Sample API Error:", error);
    return Response.json(
      {
        success: false,
        message: String(error) + " | Stack: " + (error.stack || ""),
      },
      { status: 200 }
    );
  }
};
