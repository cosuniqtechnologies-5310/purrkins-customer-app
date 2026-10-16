import { PrismaClient } from "@prisma/client";
import { savePlan, syncSellingPlans } from "../app/utils/subscription.server";

const prisma = new PrismaClient();
const shop = "purrkins-mhrlfymw.myshopify.com";

async function main() {
  console.log("Starting day plans sync for shop:", shop);
  // Delete older test plans so we have clean 15, 30, 45, 60 days
  await prisma.subscriptionPlan.deleteMany({ where: { shop } });

  const days = [15, 30, 45, 60];
  for (const d of days) {
    const plan = await savePlan(shop, {
      name: `Delivered every ${d} days (Save 15%)`,
      interval: "DAY",
      intervalCount: d,
      discountPercent: 15,
    });
    console.log("Saved plan:", plan.label, plan.id);
  }

  console.log("Calling syncSellingPlans...");
  const res = await syncSellingPlans(shop);
  console.log("Sync result:", res);

  const updatedPlans = await prisma.subscriptionPlan.findMany({ where: { shop } });
  console.log(
    "Updated plans:",
    updatedPlans.map((p) => ({ label: p.label, sellingPlanId: p.sellingPlanId, active: p.active }))
  );
}

main()
  .catch((err) => {
    console.error("Error running sync-plans:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
