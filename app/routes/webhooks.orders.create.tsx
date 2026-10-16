import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSettings, ingestSubscriptionFromOrderNode, toScheduleConfig } from "../utils/subscription.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`[webhooks] Received ${topic} webhook for ${shop}: order ${payload?.name || payload?.id}`);

  try {
    const settings = await getSettings(shop);
    const cfg = toScheduleConfig(settings);
    const sub = await ingestSubscriptionFromOrderNode(shop, payload, cfg, new Date());
    if (sub) {
      console.log(`[webhooks.orders.create] Successfully processed subscription for order ${payload.name} (${sub.id}) - ${sub.customerEmail}`);
    }
  } catch (err) {
    console.error(`[webhooks.orders.create] Error processing order ${payload?.name}:`, err);
  }

  return new Response();
};
