import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const session = await prisma.session.findFirst({
    where: { shop: 'purrkins-mhrlfymw.myshopify.com', isOnline: false }
  });

  if (!session) {
    console.log("No session found");
    return;
  }

  const query = `
    query {
      customers(first: 10) {
        nodes {
          firstName
          pets: metafield(namespace: "custom", key: "pets") {
            references(first: 5) {
              nodes {
                ... on Metaobject {
                  id
                  type
                  fields {
                    key
                    value
                    reference {
                      ... on Metaobject { id handle type }
                      ... on MediaImage { id image { url } }
                    }
                  }
                }
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
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

run();
