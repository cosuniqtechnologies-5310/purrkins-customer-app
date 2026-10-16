import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestContract } from "../utils/subscription.server";

// Shopify creates the contract at checkout and tells us here. We mirror it and
// compute the first renewal. Errors -> 500 so Shopify redelivers the webhook.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}:`, JSON.stringify(payload));

  const rawId = payload?.admin_graphql_api_id || payload?.id;
  const contractId: string | undefined = rawId
    ? (String(rawId).startsWith("gid://") ? String(rawId) : `gid://shopify/SubscriptionContract/${rawId}`)
    : undefined;

  if (!contractId) {
    console.warn(`[subscription_contracts.create] No contract ID found in webhook payload for ${shop}`);
    return new Response();
  }

  try {
    const sub = await ingestContract(shop, contractId);
    console.log(`[subscription_contracts.create] Successfully ingested contract ${contractId} (${sub.id}) for customer ${sub.customerEmail}`);
  } catch (err) {
    console.error(`[subscription_contracts.create] Error ingesting contract ${contractId}:`, err);
    throw err; // Let Shopify retry webhook
  }

  return new Response();
};
