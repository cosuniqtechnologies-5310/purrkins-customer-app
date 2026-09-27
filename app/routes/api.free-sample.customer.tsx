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
    // This ensures the request is legitimately coming from Shopify
    const { admin } = await authenticate.public.appProxy(request);

    if (!admin) {
      return Response.json({ success: false, message: "Unauthorized access" }, { status: 401 });
    }

    // 2. Parse the incoming JSON payload from the frontend
    const body = await request.json();
    const { name, phone, tag } = body;

    if (!phone) {
      return Response.json({ success: false, message: "Phone number is required" }, { status: 400 });
    }

    const customerTag = tag || "free-sample-claim";
    
    // Split name into first and last name
    const nameParts = name ? name.trim().split(" ") : ["Customer"];
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : ".";

    // 3. Check if a customer with this phone number already exists
    const searchResponse = await admin.graphql(
      `#graphql
      query findCustomerByPhone($query: String!) {
        customers(first: 1, query: $query) {
          edges {
            node {
              id
              tags
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
      // 4a. Update existing customer
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
              tags
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
            },
          },
        }
      );

      const updateData = await updateResponse.json();
      
      if (updateData.data?.customerUpdate?.userErrors?.length > 0) {
        throw new Error(updateData.data.customerUpdate.userErrors[0].message);
      }

    } else {
      // 4b. Create a new customer
      const createResponse = await admin.graphql(
        `#graphql
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
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
              firstName,
              lastName,
              phone,
              tags: [customerTag]
            },
          },
        }
      );

      const createData = await createResponse.json();

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
      // Shopify's authenticate threw a Response (e.g. 401 Unauthorized for invalid signature). Return it directly.
      return error;
    }
    
    console.error("Free Sample API Error:", error);
    return Response.json(
      {
        success: false,
        message: String(error) + " | Stack: " + (error.stack || ""),
      },
      { status: 200 } // Use 200 so Shopify App Proxy forwards the JSON to the frontend instead of an HTML error page
    );
  }
};
