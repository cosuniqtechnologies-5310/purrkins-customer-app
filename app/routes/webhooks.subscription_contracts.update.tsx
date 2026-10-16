import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncContractStatus } from "../utils/subscription.server";

// Keeps our mirror in step with changes made outside this app (Shopify admin, etc.).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const contractId: string | undefined = payload?.admin_graphql_api_id;
  const status: string | undefined = payload?.status;
  if (!contractId || !status) return new Response();

  await syncContractStatus(shop, contractId, status);
  return new Response();
};
