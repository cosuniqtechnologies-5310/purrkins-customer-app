import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncContractStatus } from "../utils/subscription.server";

// Keeps our mirror in step with changes made outside this app (Shopify admin, etc.).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}:`, JSON.stringify(payload));

  const rawId = payload?.admin_graphql_api_id || payload?.id;
  const contractId: string | undefined = rawId
    ? (String(rawId).startsWith("gid://") ? String(rawId) : `gid://shopify/SubscriptionContract/${rawId}`)
    : undefined;
  const status: string | undefined = payload?.status;

  if (!contractId || !status) {
    console.warn(`[subscription_contracts.update] Missing contractId or status in payload for ${shop}`);
    return new Response();
  }

  try {
    await syncContractStatus(shop, contractId, status);
    console.log(`[subscription_contracts.update] Synced status ${status} for contract ${contractId}`);
  } catch (err) {
    console.error(`[subscription_contracts.update] Error syncing contract ${contractId}:`, err);
    throw err;
  }

  return new Response();
};
