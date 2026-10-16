import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const shop = "purrkins-mhrlfymw.myshopify.com";

async function main() {
  const session = await prisma.session.findUnique({
    where: { id: `offline_${shop}` },
  });
  if (!session || !session.accessToken) {
    throw new Error("No offline access token found!");
  }

  async function gql(query: string, variables?: any) {
    const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session!.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map((e: any) => e.message).join("; "));
    }
    return json.data;
  }

  // 1. Fetch all products to attach to selling plan group
  console.log("Fetching products from Shopify...");
  const catalogData = await gql(`
    query {
      products(first: 250) {
        nodes {
          id
          title
        }
      }
      sellingPlanGroups(first: 10) {
        nodes {
          id
          name
        }
      }
    }
  `);

  const allProductIds = catalogData.products.nodes.map((p: any) => p.id);
  console.log(`Found ${allProductIds.length} products to attach.`);

  // 2. Clean up any existing selling plan groups if needed
  for (const group of catalogData.sellingPlanGroups.nodes) {
    console.log("Deleting old selling plan group:", group.id, group.name);
    await gql(
      `mutation DeleteGroup($id: ID!) {
        sellingPlanGroupDelete(id: $id) {
          deletedSellingPlanGroupId
          userErrors { field message }
        }
      }`,
      { id: group.id }
    );
  }

  // 3. Create the new Selling Plan Group with 15, 30, 45, 60 days plans (15% discount)
  console.log("Creating new Selling Plan Group with 15, 30, 45, 60 days plans...");
  const dayFrequencies = [15, 30, 45, 60];
  const plansToCreate = dayFrequencies.map((days, idx) => ({
    name: `Delivered every ${days} days (Save 15%)`,
    options: [`${days} days`],
    position: idx + 1,
    category: "SUBSCRIPTION",
    billingPolicy: { recurring: { interval: "DAY", intervalCount: days } },
    deliveryPolicy: {
      recurring: {
        interval: "DAY",
        intervalCount: days,
        preAnchorBehavior: "ASAP",
        cutoff: 0,
        intent: "FULFILLMENT_BEGIN",
      },
    },
    pricingPolicies: [
      {
        fixed: {
          adjustmentType: "PERCENTAGE",
          adjustmentValue: { percentage: 15 },
        },
      },
    ],
  }));

  const createResult = await gql(
    `mutation CreateGroup($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
      sellingPlanGroupCreate(input: $input, resources: $resources) {
        sellingPlanGroup {
          id
          sellingPlans(first: 50) {
            nodes {
              id
              name
              options
            }
          }
        }
        userErrors { field message code }
      }
    }`,
    {
      input: {
        name: "Subscribe & Save",
        merchantCode: "purrkins-subscribe-and-save",
        options: ["Delivers every"],
        position: 1,
        sellingPlansToCreate: plansToCreate,
      },
      resources: {
        productIds: allProductIds,
        productVariantIds: [],
      },
    }
  );

  const errors = createResult.sellingPlanGroupCreate.userErrors;
  if (errors && errors.length > 0) {
    throw new Error("Shopify error creating group: " + JSON.stringify(errors));
  }

  const createdGroup = createResult.sellingPlanGroupCreate.sellingPlanGroup;
  console.log("Successfully created group in Shopify:", createdGroup.id);
  console.log("Created selling plans in Shopify:", createdGroup.sellingPlans.nodes);

  // 4. Update the database models: SubscriptionPlan and SubscriptionSetting
  await prisma.subscriptionPlan.deleteMany({ where: { shop } });

  for (const node of createdGroup.sellingPlans.nodes) {
    const label = node.options[0]; // e.g. "15 days"
    const count = parseInt(label.replace(/[^0-9]/g, ""), 10) || 30;
    await prisma.subscriptionPlan.create({
      data: {
        shop,
        name: node.name,
        label,
        interval: "DAY",
        intervalCount: count,
        discountPercent: 15,
        position: count,
        active: true,
        sellingPlanId: node.id,
      },
    });
  }

  await prisma.subscriptionSetting.upsert({
    where: { shop },
    update: {
      sellingPlanGroupId: createdGroup.id,
      eligibleProductIds: allProductIds,
      productSelectionType: "ALL",
    },
    create: {
      shop,
      sellingPlanGroupId: createdGroup.id,
      eligibleProductIds: allProductIds,
      productSelectionType: "ALL",
    },
  });

  console.log("Database successfully updated with new sellingPlanGroupId and sellingPlanIds!");
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
