const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const session = await prisma.session.findFirst({ where: { shop: 'purrkins-mhrlfymw.myshopify.com', isOnline: false } });
  
  const vQuery = `
    query {
      p1: product(id: "gid://shopify/Product/10097392943351") { title variants(first: 1) { edges { node { id price } } } }
      p2: product(id: "gid://shopify/Product/10097353162999") { title variants(first: 1) { edges { node { id price } } } }
    }
  `;

  const vRes = await fetch('https://purrkins-mhrlfymw.myshopify.com/admin/api/2026-07/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': session.accessToken },
    body: JSON.stringify({ query: vQuery })
  });

  const vData = await vRes.json();
  console.log(JSON.stringify(vData, null, 2));
}

run();
