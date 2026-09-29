import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const session = await prisma.session.findFirst({
    where: { shop: 'purrkins-mhrlfymw.myshopify.com', isOnline: false }
  });

  if (!session) {
    throw new Error('Session not found');
  }

  const customerId = "gid://shopify/Customer/10673120641271";

  const query = `
          query($id: ID!) {
            customer(id: $id) {
              wishlist: metafield(namespace: "custom", key: "wishlist") {
                references(first: 10) {
                  nodes {
                    ... on Product {
                      id
                      title
                      handle
                      productType
                      description
                      featuredImage { url altText }
                      priceRange { minVariantPrice { amount currencyCode } }
                    }
                  }
                }
              }
            }
          }
        `;

  const response = await fetch('https://purrkins-mhrlfymw.myshopify.com/admin/api/2026-07/graphql.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': session.accessToken
    },
    body: JSON.stringify({ query, variables: { id: customerId } })
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

run();
