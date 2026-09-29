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
      products(first: 3) {
        nodes {
          id
          title
          description
          featuredImage { url }
          tags
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
