import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleBillingSuccess } from "../utils/subscription.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  await handleBillingSuccess(payload);
  return new Response();
};
