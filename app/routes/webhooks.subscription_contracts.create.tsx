import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { ingestContract } from "../utils/subscription.server";

// Shopify creates the contract at checkout and tells us here. We mirror it and
// compute the first renewal. Errors -> 500 so Shopify redelivers the webhook.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const contractId: string | undefined = payload?.admin_graphql_api_id;
  if (!contractId) return new Response();

  await ingestContract(shop, contractId);
  return new Response();
};
