import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "purrkins-mhrlfymw.myshopify.com";

  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { shop, active: true },
      orderBy: { position: "asc" },
    });

    const firstDiscount = plans.find((p) => p.discountPercent > 0)?.discountPercent ?? 15;

    return new Response(
      JSON.stringify({
        success: true,
        discountPercent: firstDiscount,
        plans: plans.map((p) => ({
          id: p.id,
          sellingPlanId: p.sellingPlanId,
          name: p.name,
          label: p.label,
          interval: p.interval,
          intervalCount: p.intervalCount,
          discountPercent: p.discountPercent,
        })),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60",
        },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: err.message,
        discountPercent: 15,
        plans: [],
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
};
