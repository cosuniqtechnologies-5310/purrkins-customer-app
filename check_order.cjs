const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const session = await prisma.session.findFirst({ where: { shop: 'purrkins-mhrlfymw.myshopify.com', isOnline: false } });
  
  const query = `
    query {
      orders(first: 1) {
        edges {
          node {
            totalPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  `;

  const response = await fetch('https://purrkins-mhrlfymw.myshopify.com/admin/api/2026-07/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': session.accessToken },
    body: JSON.stringify({ query })
  });

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

run();
