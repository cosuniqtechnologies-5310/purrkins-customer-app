import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleBillingFailure } from "../utils/subscription.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  await handleBillingFailure(payload);
  return new Response();
};
