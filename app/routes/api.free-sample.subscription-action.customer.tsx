import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import jwt from "jsonwebtoken";
import prisma from "../db.server";
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
    const sub = await prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        OR: [
          { customerId },
          ...(numericId ? [{ customerId: { endsWith: numericId } }] : []),
        ],
      },
    });

    if (!sub) {
      return Response.json({ success: false, message: "Subscription not found or unauthorized" }, { status: 404 });
    }

    const shop = sub.shop;

    switch (actionType) {
      case "skip": {
        await skipNextDelivery(shop, sub.id);
        return Response.json({ success: true, message: "Next delivery skipped successfully." });
      }

      case "reschedule": {
        if (!deliveryDate) {
          return Response.json({ success: false, message: "Delivery date is required." }, { status: 400 });
        }
        await rescheduleDelivery(shop, sub.id, deliveryDate, Boolean(applyToFuture));
        return Response.json({ success: true, message: "Delivery date updated successfully." });
      }

      case "change_frequency": {
        if (!planId) {
          return Response.json({ success: false, message: "Plan is required." }, { status: 400 });
        }
        await changeFrequency(shop, sub.id, planId);
        return Response.json({ success: true, message: "Subscription delivery frequency updated." });
      }

      case "set_weekday": {
        const day = preferredWeekday === null || preferredWeekday === undefined || preferredWeekday === "" ? null : Number(preferredWeekday);
        await setPreferredWeekday(shop, sub.id, day);
        return Response.json({ success: true, message: "Preferred delivery day updated." });
      }

      case "pause": {
        await pauseSubscription(shop, sub.id, reason || "CUSTOMER");
        return Response.json({ success: true, message: "Subscription paused. You can resume anytime." });
      }

      case "resume": {
        await resumeSubscription(shop, sub.id);
        return Response.json({ success: true, message: "Subscription resumed successfully!" });
      }

      case "cancel": {
        await cancelSubscription(shop, sub.id, reason || "Customer requested cancellation");
        return Response.json({ success: true, message: "Subscription cancelled." });
      }

      default:
        return Response.json({ success: false, message: `Unknown action: ${actionType}` }, { status: 400 });
    }
  } catch (error: any) {
    console.error("[SubscriptionAction] Error:", error);
    const message = error instanceof SubscriptionError ? error.message : (error?.message || "Internal server error");
    return Response.json({ success: false, message }, { status: 500 });
  }
};
