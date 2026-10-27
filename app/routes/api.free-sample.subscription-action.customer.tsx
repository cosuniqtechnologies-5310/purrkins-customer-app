import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import jwt from "jsonwebtoken";
import prisma from "../db.server";
import { appCache } from "../cache.server";
import {
  cancelSubscription,
  changeFrequency,
  pauseSubscription,
  rescheduleDelivery,
  resumeSubscription,
  setPreferredWeekday,
  skipNextDelivery,
  SubscriptionError,
} from "../utils/subscription.server";

function getCustomerId(request: Request): string | null {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("Cookie");
  const cookieMatch = cookieHeader ? cookieHeader.match(/pk_session=([^;]+)/) : null;
  const token = url.searchParams.get("session") || (cookieMatch ? cookieMatch[1] : null);

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.SHOPIFY_API_SECRET || "s3cr3t") as any;
      if (decoded?.customerId) return String(decoded.customerId);
    } catch {
      // invalid token
    }
  }

  const loggedIn = url.searchParams.get("logged_in_customer_id");
  if (loggedIn) {
    return loggedIn.startsWith("gid://shopify/Customer/") ? loggedIn : `gid://shopify/Customer/${loggedIn}`;
  }

  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const customerId = getCustomerId(request);
  if (!customerId) {
    return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "purrkins-mhrlfymw.myshopify.com";

  const numericId = customerId.split("/").pop();
  const subs = await prisma.subscription.findMany({
    where: {
      shop,
      OR: [
        { customerId },
        ...(numericId ? [{ customerId: { endsWith: numericId } }] : []),
      ],
    },
    include: {
      cycles: {
        orderBy: { cycleNumber: "desc" },
        take: 10,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const plans = await prisma.subscriptionPlan.findMany({
    where: { shop, active: true },
    orderBy: { position: "asc" },
  });

  const settings = await prisma.subscriptionSetting.findUnique({ where: { shop } });

  return Response.json({
    success: true,
    subscriptions: subs,
    plans,
    settings,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ success: false, message: "Method not allowed" }, { status: 405 });
  }

  const customerId = getCustomerId(request);
  if (!customerId) {
    return Response.json({ success: false, message: "Customer must be logged in" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { action: actionType, subscriptionId, deliveryDate, applyToFuture, planId, preferredWeekday, reason } = body;

    if (!subscriptionId) {
      return Response.json({ success: false, message: "Subscription ID is required" }, { status: 400 });
    }

    const numericId = customerId.split("/").pop();
    const idList = String(subscriptionId).split(",").map((s) => s.trim()).filter(Boolean);
    const subs = await prisma.subscription.findMany({
      where: {
        id: { in: idList },
        OR: [
          { customerId },
          ...(numericId ? [{ customerId: { endsWith: numericId } }] : []),
        ],
      },
    }); 

    if (subs.length === 0) {
      return Response.json({ success: false, message: "Subscription not found or unauthorized" }, { status: 404 });
    }

    for (const sub of subs) {
      const shop = sub.shop;
      switch (actionType) {
        case "skip": {
          await skipNextDelivery(shop, sub.id);
          break;
        }

        case "reschedule": {
          if (!deliveryDate) {
            return Response.json({ success: false, message: "Delivery date is required." }, { status: 400 });
          }
          await rescheduleDelivery(shop, sub.id, deliveryDate, Boolean(applyToFuture));
          break;
        }

        case "change_frequency": {
          if (!planId) {
            return Response.json({ success: false, message: "Plan is required." }, { status: 400 });
          }
          await changeFrequency(shop, sub.id, planId);
          break;
        }

        case "set_weekday": {
          const day = preferredWeekday === null || preferredWeekday === undefined || preferredWeekday === "" ? null : Number(preferredWeekday);
          await setPreferredWeekday(shop, sub.id, day);
          break;
        }

        case "pause": {
          await pauseSubscription(shop, sub.id, reason || "CUSTOMER");
          break;
        }

        case "resume": {
          await resumeSubscription(shop, sub.id);
          break;
        }

        case "cancel": {
          await cancelSubscription(shop, sub.id, reason || "Customer requested cancellation");
          break;
        }

        default:
          return Response.json({ success: false, message: `Unknown action: ${actionType}` }, { status: 400 });
      }
    }

    appCache.delPrefix("customer:");

    if (actionType === "skip") return Response.json({ success: true, message: "Next delivery skipped successfully." });
    if (actionType === "reschedule") return Response.json({ success: true, message: "Delivery date updated successfully." });
    if (actionType === "change_frequency") return Response.json({ success: true, message: "Subscription delivery frequency updated." });
    if (actionType === "set_weekday") return Response.json({ success: true, message: "Preferred delivery day updated." });
    if (actionType === "pause") return Response.json({ success: true, message: "Subscription paused. You can resume anytime." });
    if (actionType === "resume") return Response.json({ success: true, message: "Subscription resumed successfully!" });
    if (actionType === "cancel") return Response.json({ success: true, message: "Subscription cancelled." });
  } catch (error: any) {
    console.error("[SubscriptionAction] Error:", error);
    const message = error instanceof SubscriptionError ? error.message : (error?.message || "Internal server error");
    return Response.json({ success: false, message }, { status: 500 });
  }
};
