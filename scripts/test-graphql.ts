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
  console.log("Found session for shop:", shop);

  const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        query {
          shop {
            name
            myshopifyDomain
            ianaTimezone
          }
          sellingPlanGroups(first: 10) {
            nodes {
              id
              name
              sellingPlans(first: 10) {
                nodes {
                  id
                  name
                  options
                }
              }
            }
          }
        }
      `,
    }),
  });

  const json = await res.json();
  console.log("Shopify GraphQL response:", JSON.stringify(json, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
