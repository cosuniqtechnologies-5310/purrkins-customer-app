import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { checkCustomerConflict, normalizePhone } from "../utils/customer-conflict.server";

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
    console.log("[ContactUs] Received payload:", JSON.stringify(body));

    const { name, email, topic, message, tag, accepts_marketing } = body;
    const phone = body.phone ? normalizePhone(String(body.phone)) : "";

    if (!phone) {
      return Response.json({ success: false, message: "Phone number is required" }, { status: 400 });
    }
    if (!email || !email.includes("@")) {
      return Response.json({ success: false, message: "A valid email is required" }, { status: 400 });
    }

    const customerTag = tag || "Contact Form";
    const nameParts = name ? name.trim().split(" ") : ["Customer"];
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : ".";

    // Store topic + message as a customer note
    const noteContent = [
      topic ? `Topic: ${topic}` : "",
      message ? `Message: ${message}` : "",
      `Submitted: ${new Date().toISOString()}`,
    ].filter(Boolean).join("\n");

    console.log(`[ContactUs] Processing: name=${name}, phone=${phone}, email=${email}, topic=${topic}`);

    const emailMarketingConsent = {
      marketingState: "SUBSCRIBED",
      marketingOptInLevel: "CONFIRMED_OPT_IN",
      consentUpdatedAt: new Date().toISOString(),
    };

    // Same phone + same name => allowed unlimited times. Different name / email owner => rejected.
    const { phoneCustomer, emailCustomer, conflictMessage } =
      await checkCustomerConflict(admin, { name, phone, email });

    if (conflictMessage) {
      return Response.json({ success: false, message: conflictMessage }, { status: 409 });
    }
    const existingCustomer = phoneCustomer ?? emailCustomer;

    let customerId: string;

    if (existingCustomer) {
      console.log("[ContactUs] Existing customer found:", existingCustomer.id);

      const existingTags: string[] = existingCustomer.tags || [];
      const updatedTags = existingTags.includes(customerTag)
        ? existingTags
        : [...existingTags, customerTag];

      const resolvedEmail = existingCustomer.email?.includes("noemail")
        ? email
        : existingCustomer.email;

      const existingNote = existingCustomer.note || "";
      const updatedNote = existingNote
        ? `${existingNote}\n\n---\n${noteContent}`
        : noteContent;

      const updateResponse = await admin.graphql(
        `#graphql
        mutation customerUpdate($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id phone email note }
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
              note: updatedNote,
            },
          },
        }
      );

      const updateData = (await updateResponse.json()) as any;
      if (updateData.errors?.length) {
        throw new Error("Update Error: " + JSON.stringify(updateData.errors));
      }
      
      console.log("[ContactUs] Customer update result:", JSON.stringify(updateData?.data?.customerUpdate));

      if (updateData.data?.customerUpdate?.userErrors?.length > 0) {
        throw new Error(
          updateData.data.customerUpdate.userErrors
            .map((e: any) => e.message)
            .join(", ")
        );
      }
      
      if (!updateData.data?.customerUpdate?.customer?.id) {
        throw new Error("Shopify customerUpdate did not return a customer ID");
      }

      customerId = updateData.data.customerUpdate.customer.id;

    } else {
      console.log("[ContactUs] Creating customer");

      const createResponse = await admin.graphql(
        `#graphql
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer {
              id phone email note
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
              note: noteContent,
              tags: [customerTag],
              emailMarketingConsent,
            },
          },
        }
      );

      const createData = (await createResponse.json()) as any;
      if (createData.errors?.length) {
        throw new Error("Create Error: " + JSON.stringify(createData.errors));
      }

      console.log("[ContactUs] Customer create result:", JSON.stringify(createData?.data?.customerCreate));

      if (createData.data?.customerCreate?.userErrors?.length > 0) {
        throw new Error(
          createData.data.customerCreate.userErrors
            .map((e: any) => e.message)
            .join(", ")
        );
      }
      
      if (!createData.data?.customerCreate?.customer?.id) {
        throw new Error("Shopify customerCreate did not return a customer ID");
      }

      customerId = createData.data.customerCreate.customer.id;
    }

    console.log("[ContactUs] Final customer ID:", customerId);

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

      const consentData = (await consentResponse.json()) as any;
      if (consentData.errors?.length) {
        throw new Error("Consent Error: " + JSON.stringify(consentData.errors));
      }
      
      console.log("[ContactUs] Marketing consent result:", JSON.stringify(consentData?.data?.customerEmailMarketingConsentUpdate));
      
      if (consentData.data?.customerEmailMarketingConsentUpdate?.userErrors?.length > 0) {
        throw new Error(
          consentData.data.customerEmailMarketingConsentUpdate.userErrors
            .map((e: any) => e.message)
            .join(", ")
        );
      }
    }

    return Response.json({
      success: true,
      already_customer: Boolean(phoneCustomer),
      message: phoneCustomer
        ? "You are already a customer with us. We've received your message and will be in touch soon!"
        : "Contact message received. We'll be in touch soon!",
    });

  } catch (error: any) {
    if (error instanceof Response) return error;
    console.error("[ContactUs] API Error:", error);
    return Response.json({ success: false, message: String(error) }, { status: 500 });
  }
};
